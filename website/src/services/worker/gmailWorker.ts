// AventasPay - Dedicated Gmail Worker Service
// Polls Gmail API/IMAP within bounded order time windows,
// ingests incoming payments, matches, verifies, and confirms payments internally.

import { db, type IDatabaseClient } from '../database/client.ts';
import { orderService } from '../order.service.ts';
import { gmailWatcher, GmailWatcherService } from '../gmail/watcher.service.ts';
import { paymentService, PaymentService } from '../payment/payment.service.ts';

export class GmailWorker {
  private client: IDatabaseClient;
  private watcher: GmailWatcherService;
  private paymentSvc: PaymentService;
  private isRunning: boolean = false;
  private isTicking: boolean = false;
  private pollIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    customDb?: IDatabaseClient,
    customWatcher?: GmailWatcherService,
    customPaymentSvc?: PaymentService,
    pollIntervalMs: number = 5000
  ) {
    this.client = customDb || db;
    this.watcher = customWatcher || gmailWatcher;
    this.paymentSvc = customPaymentSvc || paymentService;
    const envInterval = process.env.GMAIL_POLL_INTERVAL_MS
      ? parseInt(process.env.GMAIL_POLL_INTERVAL_MS, 10)
      : null;
    this.pollIntervalMs = envInterval && !isNaN(envInterval) && envInterval > 0 ? envInterval : pollIntervalMs;
  }

  public getPollIntervalMs(): number {
    return this.pollIntervalMs;
  }

  public setPollIntervalMs(ms: number): void {
    if (ms >= 1000) {
      this.pollIntervalMs = ms;
      console.log(`[GmailWorker] Polling interval updated to ${ms}ms (${ms / 1000}s)`);
    }
  }

  /**
   * Executes a single worker synchronization tick.
   */
  public async tick(): Promise<{ expiredCount: number; processedCount: number }> {
    if (this.isTicking) {
      return { expiredCount: 0, processedCount: 0 };
    }
    this.isTicking = true;

    try {
      const now = new Date();

      // 1. Expiration sweep: mark all overdue pending orders as EXPIRED
      const expiredCount = await orderService.expireOverdueOrders(now);
      if (expiredCount > 0) {
        console.log(`[GmailWorker] Expired ${expiredCount} overdue order(s)`);
      }

      // 2. Poll Gmail API within strict time window for active pending orders
      const newlyIngested = await this.watcher.pollPendingOrders(now);

      let processedCount = 0;
      // 3. Process newly ingested payments: Match -> Verify -> Confirm
      for (const item of newlyIngested) {
        try {
          const paymentRecord = await this.client.incomingPayment.findUnique({
            where: { rrn: item.rrn },
          });

          if (!paymentRecord || paymentRecord.status !== 'NEW') {
            continue;
          }

          // Match payment
          const matchResult = await this.paymentSvc.matcher.matchPayment(paymentRecord.id, now);
          if (!matchResult.matched || !matchResult.order || !matchResult.payment) {
            console.log(`[GmailWorker] Payment ${paymentRecord.id} (RRN: ${paymentRecord.rrn}) unmatched`);
            continue;
          }

          // Verify payment (5 mandatory checks)
          const verification = await this.paymentSvc.verifier.verifyPayment(
            matchResult.payment,
            matchResult.order,
            item.senderEmail,
            now
          );

          if (!verification.isValid) {
            console.warn(`[GmailWorker] Payment verification failed:`, verification.errors);
            await this.client.incomingPayment.update({
              where: { id: matchResult.payment.id },
              data: { status: 'REJECTED' },
            });
            continue;
          }

          // Atomic Confirmation via internal PaymentService.confirm()
          await this.paymentSvc.confirm(matchResult.order.id, matchResult.payment.id, now);
          console.log(
            `[GmailWorker] SUCCESS: Order ${matchResult.order.id} confirmed with RRN ${item.rrn} from ${item.senderName} (₹${item.amount})`
          );
          processedCount++;
        } catch (procErr) {
          console.error(`[GmailWorker] Error processing payment for RRN ${item.rrn}:`, procErr);
        }
      }

      return { expiredCount, processedCount };
    } finally {
      this.isTicking = false;
    }
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`[GmailWorker] Started polling daemon (interval: ${this.pollIntervalMs}ms / ${this.pollIntervalMs / 1000}s)`);

    const loop = async () => {
      if (!this.isRunning) return;
      try {
        await this.tick();
      } catch (err) {
        console.error('[GmailWorker] Unhandled error during tick:', err);
      }
      if (this.isRunning) {
        this.timer = setTimeout(loop, this.pollIntervalMs);
      }
    };

    this.timer = setTimeout(loop, this.pollIntervalMs);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    console.log('[GmailWorker] Stopped polling daemon');
  }
}

export const gmailWorker = new GmailWorker();
