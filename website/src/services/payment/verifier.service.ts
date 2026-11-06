// AventasPay - Payment Verifier Service
// Runs 5 mandatory verification checks before allowing an order to be confirmed.

import { db, type IDatabaseClient } from '../database/client.ts';
import type { IncomingPaymentRecord, OrderRecord } from '../database/types.ts';
import { SliceEmailParser } from '../gmail/parser.service.ts';

export interface VerificationResult {
  isValid: boolean;
  errors: string[];
}

export class VerifierService {
  private client: IDatabaseClient;

  constructor(customDb?: IDatabaseClient) {
    this.client = customDb || db;
  }

  /**
   * Performs the 5 strict verification checks required before confirming payment:
   * 1. Email sender must be noreply@slice.bank.in
   * 2. RRN has never been processed before
   * 3. Gmail Message ID has never been processed before
   * 4. Order still PENDING (or MATCHED)
   * 5. Current time is before expiresAt
   */
  public async verifyPayment(
    payment: IncomingPaymentRecord,
    order: OrderRecord,
    senderEmail: string = SliceEmailParser.ALLOWED_SENDER,
    now: Date = new Date()
  ): Promise<VerificationResult> {
    const errors: string[] = [];

    // CHECK 1: Email sender must be noreply@slice.bank.in
    const normalizedSender = senderEmail.toLowerCase().trim();
    if (
      normalizedSender !== SliceEmailParser.ALLOWED_SENDER &&
      !normalizedSender.includes(`<${SliceEmailParser.ALLOWED_SENDER}>`)
    ) {
      errors.push(`Check 1 Failed: Invalid sender '${senderEmail}'. Expected '${SliceEmailParser.ALLOWED_SENDER}'`);
    }

    // CHECK 2: RRN has never been processed before
    const existingOrderByRrn = await this.client.order.findUnique({
      where: { rrn: payment.rrn },
    });
    if (existingOrderByRrn && existingOrderByRrn.id !== order.id) {
      errors.push(`Check 2 Failed: RRN '${payment.rrn}' has already been processed on Order ${existingOrderByRrn.id}`);
    }

    const allVerifiedPayments = await this.client.incomingPayment.findMany({
      where: { status: 'VERIFIED' },
    });
    const duplicateVerifiedRrn = allVerifiedPayments.find(
      (p) => p.rrn === payment.rrn && p.id !== payment.id
    );
    if (duplicateVerifiedRrn) {
      errors.push(`Check 2 Failed: RRN '${payment.rrn}' was already verified on Payment ${duplicateVerifiedRrn.id}`);
    }

    // CHECK 3: Gmail Message ID has never been processed before
    const duplicateVerifiedMsg = allVerifiedPayments.find(
      (p) => p.gmailMessageId === payment.gmailMessageId && p.id !== payment.id
    );
    if (duplicateVerifiedMsg) {
      errors.push(
        `Check 3 Failed: Gmail Message ID '${payment.gmailMessageId}' was already verified on Payment ${duplicateVerifiedMsg.id}`
      );
    }

    // CHECK 4: Order still PENDING (or MATCHED)
    if (order.status !== 'PENDING' && order.status !== 'MATCHED') {
      errors.push(
        `Check 4 Failed: Order ${order.id} is in status '${order.status}', expected PENDING or MATCHED`
      );
    }

    // CHECK 5: Current time is before expiresAt
    if (now.getTime() >= order.expiresAt.getTime()) {
      errors.push(
        `Check 5 Failed: Order ${order.id} expired at ${order.expiresAt.toISOString()}. Current time is ${now.toISOString()}`
      );
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }
}

export const verifierService = new VerifierService();
