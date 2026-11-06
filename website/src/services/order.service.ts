// AventasPay - Order Service
// Handles order creation with unique decimal allocation, UPI QR/intent generation, and lifecycle management.

import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { db, type IDatabaseClient } from './database/client.ts';
import type { OrderRecord, OrderStatus } from './database/types.ts';
import { getActiveUpiConfig } from '../config/accounts.ts';
import { sqlite } from './database/sqlite.ts';

export interface CreateOrderParams {
  baseAmount: number; // e.g. 499
  currency?: string;
  productName?: string;
  redirectUrl?: string;
  metadata?: Record<string, unknown>;
  token?: string; // Optional link to website checkout token
}

export interface CreatedOrderResponse {
  paymentId: string;
  amount: number;
  qrCode: string;
  upiIntent: string;
  status: OrderStatus;
  productName?: string;
  redirectUrl?: string;
  createdAt: string;
  expiresAt: string;
}

export interface PublicOrderResponse {
  paymentId: string;
  amount: number;
  baseAmount?: number;
  productName?: string;
  redirectUrl?: string;
  status: OrderStatus;
  createdAt: string;
  expiresAt: string;
  paidAt: string | null;
  rrn: string | null;
  senderName: string | null;
  /** upi:// link for the CONFIGURED VPA; only present while the order is still payable. */
  upiIntent?: string;
}

export class OrderService {
  private client: IDatabaseClient;
  private merchantVpaOverride?: string;
  private merchantName: string;
  private maxDecimalOffset: number;

  constructor(
    customDb?: IDatabaseClient,
    merchantVpa?: string,
    merchantName: string = process.env.AVENTAS_MERCHANT_NAME || 'Aventas Technologies',
    maxDecimalOffset: number = 49
  ) {
    this.client = customDb || db;
    this.merchantVpaOverride = merchantVpa;
    this.merchantName = merchantName;
    this.maxDecimalOffset = maxDecimalOffset;
  }

  public getEffectiveVpa(): string {
    return this.merchantVpaOverride || getActiveUpiConfig().upiId;
  }

  /**
   * Allocates a deterministic, collision-free decimal offset (1 to maxDecimalOffset)
   * across concurrent orders for the same base amount.
   */
  public async allocateDecimalOffset(baseAmount: number, now: Date = new Date()): Promise<number> {
    const activeOffsets = await this.client.order.findActiveDecimalOffsets(baseAmount, now);

    for (let offset = 1; offset <= this.maxDecimalOffset; offset++) {
      if (!activeOffsets.has(offset)) {
        return offset;
      }
    }

    // Fallback: random offset within range
    return Math.floor(Math.random() * this.maxDecimalOffset) + 1;
  }

  /**
   * Generates standard NPCI UPI Intent URI
   */
  public generateUpiIntentUri(amount: number, vpa: string, merchantName: string, orderId: string): string {
    const formattedAmount = amount.toFixed(2);
    const encName = encodeURIComponent(merchantName);
    const encNote = encodeURIComponent(`Order ${orderId}`);
    return `upi://pay?pa=${vpa}&pn=${encName}&am=${formattedAmount}&cu=INR&tn=${encNote}`;
  }

  /**
   * Generates Base64 Data URL QR Code
   */
  public async generateQrCodeDataUrl(intentUri: string): Promise<string> {
    try {
      return await QRCode.toDataURL(intentUri, {
        width: 320,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#ffffff',
        },
        errorCorrectionLevel: 'M',
      });
    } catch (err) {
      console.error('[OrderService] QR Generation failed:', err);
      return '';
    }
  }

  /**
   * Creates a new pending order with an active unique decimal offset.
   */
  public async createOrder(params: CreateOrderParams): Promise<CreatedOrderResponse> {
    const baseAmount = Math.floor(params.baseAmount);
    if (baseAmount <= 0) {
      throw new Error(`Invalid baseAmount: ${params.baseAmount}. Must be greater than 0.`);
    }

    const now = new Date();
    const ttlMinutes = parseInt(sqlite.getSetting('payment_ttl_minutes', '10'), 10) || 10;
    const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);
    const decimalOffset = await this.allocateDecimalOffset(baseAmount, now);
    const totalAmount = Math.round((baseAmount + decimalOffset / 100) * 100) / 100;
    const paymentId = `pay_${crypto.randomBytes(8).toString('hex')}`;
    const vpa = this.getEffectiveVpa();

    const upiIntent = this.generateUpiIntentUri(totalAmount, vpa, this.merchantName, paymentId);
    const qrCode = await this.generateQrCodeDataUrl(upiIntent);

    const record = await this.client.order.create({
      data: {
        id: paymentId,
        baseAmount,
        decimalOffset,
        amount: totalAmount,
        currency: params.currency || 'INR',
        status: 'PENDING',
        productName: params.productName,
        redirectUrl: params.redirectUrl,
        expiresAt,
        createdAt: now,
        token: params.token,
      },
    });

    return {
      paymentId: record.id,
      amount: record.amount,
      qrCode,
      upiIntent,
      status: record.status,
      productName: record.productName,
      redirectUrl: record.redirectUrl,
      createdAt: record.createdAt.toISOString(),
      expiresAt: record.expiresAt.toISOString(),
    };
  }

  /**
   * Public Order Lookup
   */
  public async getOrder(paymentId: string): Promise<PublicOrderResponse | null> {
    const record = await this.client.order.findUnique({
      where: { id: paymentId },
    });

    if (!record) return null;

    // Check if expired at lookup time
    let status = record.status;
    if (status === 'PENDING' && new Date().getTime() >= record.expiresAt.getTime()) {
      status = 'EXPIRED';
      await this.client.order.update({
        where: { id: record.id },
        data: { status: 'EXPIRED' },
      });
    }

    const payable = status === 'PENDING';
    return {
      paymentId: record.id,
      amount: record.amount,
      baseAmount: record.baseAmount,
      productName: record.productName,
      redirectUrl: record.redirectUrl,
      status,
      createdAt: record.createdAt.toISOString(),
      expiresAt: record.expiresAt.toISOString(),
      paidAt: record.paidAt ? record.paidAt.toISOString() : null,
      rrn: record.rrn,
      senderName: record.senderName,
      ...(payable
        ? { upiIntent: this.generateUpiIntentUri(record.amount, this.getEffectiveVpa(), this.merchantName, record.id) }
        : {}),
    };
  }

  /**
   * Sweeps overdue orders and marks them EXPIRED
   */
  public async expireOverdueOrders(now: Date = new Date()): Promise<number> {
    const overdue = await this.client.order.findMany({
      where: {
        status: 'PENDING',
        expiresAt: { lte: now },
      },
    });

    for (const order of overdue) {
      await this.client.order.update({
        where: { id: order.id },
        data: { status: 'EXPIRED' },
      });
    }

    return overdue.length;
  }
}

export const orderService = new OrderService();
