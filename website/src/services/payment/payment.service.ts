// AventasPay - Internal Payment Service Orchestrator
// Coordinates Order creation, incoming payment ingestion, matching, verification, and confirmation.

import { db, type IDatabaseClient } from '../database/client.ts';
import type { OrderRecord, IncomingPaymentRecord } from '../database/types.ts';
import { OrderService, orderService, type CreateOrderParams, type CreatedOrderResponse } from '../order.service.ts';
import { MatcherService, matcherService } from './matcher.service.ts';
import { VerifierService, verifierService, type VerificationResult } from './verifier.service.ts';
import { ConfirmationService, confirmationService, type ConfirmationResult } from './confirmation.service.ts';
import { sliceParser, SliceEmailParser, type RawEmailInput } from '../gmail/parser.service.ts';

export interface IngestionResult {
  payment: IncomingPaymentRecord;
  matchedOrder?: OrderRecord;
  verification?: VerificationResult;
  confirmed: boolean;
  reason?: string;
}

export class PaymentService {
  public orders: OrderService;
  public matcher: MatcherService;
  public verifier: VerifierService;
  public confirmation: ConfirmationService;
  private client: IDatabaseClient;

  constructor(
    customDb?: IDatabaseClient,
    customOrders?: OrderService,
    customMatcher?: MatcherService,
    customVerifier?: VerifierService,
    customConfirmation?: ConfirmationService
  ) {
    this.client = customDb || db;
    this.orders = customOrders || orderService;
    this.matcher = customMatcher || matcherService;
    this.verifier = customVerifier || verifierService;
    this.confirmation = customConfirmation || confirmationService;
  }

  public async createOrder(params: CreateOrderParams): Promise<CreatedOrderResponse> {
    return await this.orders.createOrder(params);
  }

  public async confirm(
    orderId: string,
    paymentId: string,
    now: Date = new Date()
  ): Promise<ConfirmationResult> {
    return await this.confirmation.confirm(orderId, paymentId, now);
  }

  /**
   * Ingests a raw Slice email from Gmail Worker or Simulator, parses it, persists it,
   * matches it against active pending orders, runs 5 verification checks,
   * and confirms the order atomically.
   */
  public async ingestSliceEmail(
    rawEmail: RawEmailInput,
    now: Date = new Date()
  ): Promise<IngestionResult> {
    // 1. Verify sender against BANK_FROM_ALLOWLIST
    if (!sliceParser.isSliceSender(rawEmail.from)) {
      throw new Error(`Rejected email: sender '${rawEmail.from}' is not in BANK_FROM_ALLOWLIST`);
    }

    // 1b. Verify DKIM / SPF if REQUIRE_DKIM is enabled
    if (!sliceParser.isDkimValid(rawEmail.authResults)) {
      throw new Error(`Rejected email: Authentication-Results failed (dkim=pass or spf=pass required)`);
    }

    // 2. Verify subject begins with "Received"
    if (!sliceParser.hasReceivedSubject(rawEmail.subject)) {
      throw new Error(`Rejected email: subject '${rawEmail.subject}' does not begin with 'Received'`);
    }

    // 3. Check for existing Gmail Message ID
    const existingMsg = await this.client.incomingPayment.findUnique({
      where: { gmailMessageId: rawEmail.gmailMessageId },
    });
    if (existingMsg) {
      return {
        payment: existingMsg,
        confirmed: false,
        reason: 'DUPLICATE_MESSAGE_ID',
      };
    }

    // 4. Parse Slice Email
    const parsed = sliceParser.parseEmail(rawEmail);

    // 5. UTR Uniqueness (Rule 4): Check if RRN already exists. Duplicate goes to Manual Review, never auto-approves
    const existingRrn = await this.client.incomingPayment.findUnique({
      where: { rrn: parsed.rrn },
    });
    if (existingRrn) {
      console.warn(`[PaymentService] Duplicate UTR detected: ${parsed.rrn}. Routing to Manual Review.`);
      try {
        const { sqlite } = await import('../database/sqlite.ts');
        const rawDb = sqlite.getRawDb();
        const revId = `rev_dup_${Date.now()}`;
        const nowIso = now.toISOString();
        rawDb.prepare(`
          INSERT OR IGNORE INTO manual_reviews (id, orderId, customerName, amount, expected, issue, priority, status, reportedUtr, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          revId,
          existingRrn.matchedOrderId || `dup_${parsed.gmailMessageId}`,
          parsed.senderName,
          parsed.amount,
          parsed.amount,
          `Duplicate UTR submission detected: ${parsed.rrn} already registered.`,
          'High',
          'Pending',
          parsed.rrn,
          nowIso,
          nowIso
        );
      } catch (err) {
        console.warn('[PaymentService] Error recording duplicate UTR to manual review:', err);
      }
      return {
        payment: existingRrn,
        confirmed: false,
        reason: 'DUPLICATE_RRN',
      };
    }

    // 6. Persist initial payment record as NEW
    const initialPayment = await this.client.incomingPayment.create({
      data: {
        gmailMessageId: parsed.gmailMessageId,
        rrn: parsed.rrn,
        senderName: parsed.senderName,
        amount: parsed.amount,
        receivedAt: parsed.receivedAt,
        status: 'NEW',
      },
    });

    // 7. Match against active pending orders
    const match = await this.matcher.matchPayment(initialPayment.id, now);
    if (!match.matched || !match.order || !match.payment) {
      return {
        payment: match.payment || initialPayment,
        confirmed: false,
        reason: match.reason || 'UNMATCHED',
      };
    }

    // 8. Run 5 mandatory verification checks
    const verification = await this.verifier.verifyPayment(
      match.payment,
      match.order,
      rawEmail.from,
      now
    );

    if (!verification.isValid) {
      const rejectedPayment = await this.client.incomingPayment.update({
        where: { id: match.payment.id },
        data: { status: 'REJECTED' },
      });
      return {
        payment: rejectedPayment,
        matchedOrder: match.order,
        verification,
        confirmed: false,
        reason: `VERIFICATION_FAILED: ${verification.errors.join(', ')}`,
      };
    }

    // 9. Atomic confirmation
    const confirmResult = await this.confirm(match.order.id, match.payment.id, now);

    return {
      payment: confirmResult.payment,
      matchedOrder: confirmResult.order,
      verification,
      confirmed: true,
    };
  }
}

export const paymentService = new PaymentService();
