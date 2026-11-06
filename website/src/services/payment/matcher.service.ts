// AventasPay - Payment Matcher Service
// Matches incoming Slice Bank payments to pending orders by exact unique amount & strict time window.

import { db, type IDatabaseClient } from '../database/client.ts';
import type { IncomingPaymentRecord, OrderRecord } from '../database/types.ts';

export interface MatchResult {
  matched: boolean;
  order?: OrderRecord;
  payment?: IncomingPaymentRecord;
  reason?: string;
}

export class MatcherService {
  private client: IDatabaseClient;

  constructor(customDb?: IDatabaseClient) {
    this.client = customDb || db;
  }

  /**
   * Matches an incoming payment to a pending order.
   * MATCHING RULES:
   * 1. order.status == PENDING
   * 2. order.amount == payment.amount
   * 3. payment.receivedAt >= order.createdAt
   * 4. payment.receivedAt <= order.expiresAt
   * 5. order.expiresAt > now
   */
  public async matchPayment(
    paymentId: string,
    now: Date = new Date()
  ): Promise<MatchResult> {
    const payment = await this.client.incomingPayment.findUnique({
      where: { id: paymentId },
    });

    if (!payment) {
      return { matched: false, reason: `Incoming payment ${paymentId} not found` };
    }

    if (payment.status === 'VERIFIED') {
      return { matched: false, reason: 'Payment is already verified' };
    }

    // 1. Fetch pending orders with the exact same amount
    const candidateOrders = await this.client.order.findMany({
      where: {
        status: 'PENDING',
        amount: payment.amount,
      },
    });

    // 2. Filter candidate orders by strict time window and expiry
    const matchedOrder = candidateOrders.find((order) => {
      const receivedTime = payment.receivedAt.getTime();
      const createdTime = order.createdAt.getTime();
      const expiresTime = order.expiresAt.getTime();
      const currentTime = now.getTime();

      const isAfterCreated = receivedTime >= createdTime - 60000; // 1 min clock drift allowance
      const isBeforeExpired = receivedTime <= expiresTime;
      const isNotYetExpired = expiresTime > currentTime;

      return isAfterCreated && isBeforeExpired && isNotYetExpired;
    });

    if (!matchedOrder) {
      // Check if candidate order exists but payment arrived late
      const lateOrder = candidateOrders.find((order) => {
        return payment.receivedAt.getTime() > order.expiresAt.getTime();
      });

      const nextStatus = lateOrder ? 'LATE' : 'UNMATCHED';
      const updatedPayment = await this.client.incomingPayment.update({
        where: { id: payment.id },
        data: { status: nextStatus },
      });

      return {
        matched: false,
        payment: updatedPayment,
        reason: lateOrder
          ? 'Payment arrived after order expiration (LATE)'
          : 'No pending order found matching exact amount and valid time window (UNMATCHED)',
      };
    }

    // 3. Order found! Attach payment and mark payment as MATCHED
    const updatedPayment = await this.client.incomingPayment.update({
      where: { id: payment.id },
      data: {
        status: 'MATCHED',
        matchedOrderId: matchedOrder.id,
      },
    });

    const updatedOrder = await this.client.order.update({
      where: { id: matchedOrder.id },
      data: { status: 'MATCHED' },
    });

    return {
      matched: true,
      order: updatedOrder,
      payment: updatedPayment,
    };
  }
}

export const matcherService = new MatcherService();
