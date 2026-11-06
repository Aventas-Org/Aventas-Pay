// AventasPay - Payment Confirmation Service
// Strictly internal confirmation service. Executes atomic state updates and duplicate prevention.

import { db, type IDatabaseClient } from '../database/client.ts';
import type { IncomingPaymentRecord, OrderRecord } from '../database/types.ts';

export interface ConfirmationResult {
  order: OrderRecord;
  payment: IncomingPaymentRecord;
}

export class ConfirmationService {
  private client: IDatabaseClient;

  constructor(customDb?: IDatabaseClient) {
    this.client = customDb || db;
  }

  /**
   * Internal confirmation method.
   * Atomic database transaction confirming order to SUCCESS and payment to VERIFIED.
   */
  public async confirm(
    orderId: string,
    paymentId: string,
    now: Date = new Date()
  ): Promise<ConfirmationResult> {
    // 1. Pre-transaction check: if expired, persist EXPIRED status immediately
    const preCheck = await this.client.order.findUnique({ where: { id: orderId } });
    if (!preCheck) {
      throw new Error(`Order ${orderId} not found`);
    }

    if (now.getTime() >= preCheck.expiresAt.getTime()) {
      await this.client.order.update({
        where: { id: orderId },
        data: { status: 'EXPIRED' },
      });
      throw new Error(`Cannot confirm expired order ${orderId}`);
    }

    // 2. Execute confirmation under transaction
    return await this.client.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) {
        throw new Error(`Order ${orderId} not found`);
      }

      // Check if order already confirmed
      if (order.status === 'SUCCESS') {
        throw new Error(`Order ${orderId} has already been confirmed`);
      }

      // Check if order has expired
      if (now.getTime() >= order.expiresAt.getTime()) {
        await tx.order.update({
          where: { id: orderId },
          data: { status: 'EXPIRED' },
        });
        throw new Error(`Cannot confirm expired order ${orderId}`);
      }

      // Order must be in PENDING, MATCHED, or VERIFIED state
      if (order.status !== 'PENDING' && order.status !== 'MATCHED' && order.status !== 'VERIFIED') {
        throw new Error(`Order ${orderId} is in invalid status '${order.status}' for confirmation`);
      }

      // Fetch payment under transaction
      const payment = await tx.incomingPayment.findUnique({ where: { id: paymentId } });
      if (!payment) {
        throw new Error(`Incoming payment ${paymentId} not found`);
      }

      // Payment must not already be verified or duplicate
      if (payment.status === 'VERIFIED') {
        throw new Error(`Payment ${paymentId} is already marked VERIFIED`);
      }
      if (payment.status === 'DUPLICATE' || payment.status === 'REJECTED') {
        throw new Error(`Cannot confirm payment with invalid status '${payment.status}'`);
      }

      // 3. Mark incoming payment as VERIFIED
      const updatedPayment = await tx.incomingPayment.update({
        where: { id: payment.id },
        data: {
          status: 'VERIFIED',
          matchedOrderId: order.id,
        },
      });

      // 4. Update order: status = SUCCESS, save RRN, Sender Name, Payment Time
      const updatedOrder = await tx.order.update({
        where: { id: order.id },
        data: {
          status: 'SUCCESS',
          rrn: payment.rrn,
          senderName: payment.senderName,
          paidAt: payment.receivedAt,
        },
      });

      return {
        order: updatedOrder,
        payment: updatedPayment,
      };
    });
  }
}

export const confirmationService = new ConfirmationService();
