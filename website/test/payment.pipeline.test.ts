import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryDatabaseClient } from '../src/services/database/client.ts';
import { OrderService } from '../src/services/order.service.ts';
import { SliceEmailParser } from '../src/services/gmail/parser.service.ts';
import { MockGmailTransport, GmailWatcherService } from '../src/services/gmail/watcher.service.ts';
import { MatcherService } from '../src/services/payment/matcher.service.ts';
import { VerifierService } from '../src/services/payment/verifier.service.ts';
import { ConfirmationService } from '../src/services/payment/confirmation.service.ts';
import { PaymentService } from '../src/services/payment/payment.service.ts';
import { GmailWorker } from '../src/services/worker/gmailWorker.ts';

describe('AventasPay - Payment Pipeline Integration Tests', () => {
  let db: InMemoryDatabaseClient;
  let orderService: OrderService;
  let mockTransport: MockGmailTransport;
  let parser: SliceEmailParser;
  let watcher: GmailWatcherService;
  let matcher: MatcherService;
  let verifier: VerifierService;
  let confirmation: ConfirmationService;
  let paymentService: PaymentService;
  let worker: GmailWorker;

  beforeEach(async () => {
    db = new InMemoryDatabaseClient(false);
    await db.reset();
    orderService = new OrderService(db);
    mockTransport = new MockGmailTransport();
    parser = new SliceEmailParser();
    watcher = new GmailWatcherService(db, mockTransport, parser);
    matcher = new MatcherService(db);
    verifier = new VerifierService(db);
    confirmation = new ConfirmationService(db);

    paymentService = new PaymentService(
      db,
      orderService,
      matcher,
      verifier,
      confirmation
    );

    worker = new GmailWorker(db, watcher, paymentService);
  });

  it('strictly validates Slice email sender and subject', () => {
    assert.equal(parser.isSliceSender('noreply@slice.bank.in'), true);
    assert.equal(parser.isSliceSender('Slice Bank <noreply@slice.bank.in>'), true);
    assert.equal(parser.isSliceSender('alerts@otherbank.com'), false);

    assert.equal(parser.hasReceivedSubject('Received ₹1.05 from Rahul Sharma'), true);
    assert.equal(parser.hasReceivedSubject('Your OTP is 123456'), false);
  });

  it('allocates unique collision-free decimal offsets for same base amount', async () => {
    const o1 = await orderService.createOrder({ baseAmount: 1 });
    const o2 = await orderService.createOrder({ baseAmount: 1 });

    assert.notEqual(o1.amount, o2.amount);
    assert.ok(o1.amount >= 1.01 && o1.amount <= 1.49);
    assert.ok(o2.amount >= 1.01 && o2.amount <= 1.49);
  });

  it('successfully processes full end-to-end payment workflow from order to Slice email confirmation', async () => {
    // 1. Order created with ₹1 base amount
    const order = await orderService.createOrder({ baseAmount: 1 });
    assert.equal(order.status, 'PENDING');
    assert.match(order.paymentId, /^pay_/);

    // Initial lookup should be PENDING
    const initialStatus = await orderService.getOrder(order.paymentId);
    assert.equal(initialStatus?.status, 'PENDING');

    // 2. Customer pays via UPI, Slice sends notification email
    const paymentTime = new Date(Date.now() + 15000);
    mockTransport.addMessage({
      gmailMessageId: 'slice_msg_test_001',
      from: 'noreply@slice.bank.in',
      subject: `Received ₹${order.amount.toFixed(2)} from Rahul Sharma`,
      body: `You have received a payment of ₹${order.amount.toFixed(2)} from Rahul Sharma via UPI.
UPI Ref No / RRN: 629401841605
Txn Date: ${paymentTime.toISOString()}

Thank you for banking with Slice.`,
      dateHeader: paymentTime.toUTCString(),
      internalDate: paymentTime.getTime(),
    });

    // 3. Gmail Worker ticks
    const { processedCount } = await worker.tick();
    assert.equal(processedCount, 1);

    // 4. Verify Database State
    const confirmedOrder = await db.order.findUnique({
      where: { id: order.paymentId },
    });
    assert.equal(confirmedOrder?.status, 'SUCCESS');
    assert.equal(confirmedOrder?.rrn, '629401841605');
    assert.equal(confirmedOrder?.senderName, 'Rahul Sharma');
    assert.ok(confirmedOrder?.paidAt instanceof Date);

    const verifiedPayment = await db.incomingPayment.findUnique({
      where: { rrn: '629401841605' },
    });
    assert.equal(verifiedPayment?.status, 'VERIFIED');
    assert.equal(verifiedPayment?.matchedOrderId, order.paymentId);

    // 5. Public Order Lookup returns SUCCESS
    const publicResult = await orderService.getOrder(order.paymentId);
    assert.equal(publicResult?.status, 'SUCCESS');
  });

  it('rejects duplicate Slice email RRN', async () => {
    const rawEmail = {
      gmailMessageId: 'slice_dup_1',
      from: 'noreply@slice.bank.in',
      subject: 'Received ₹10.00 from Alice',
      body: 'UPI Ref No / RRN: 999888777666',
    };

    // First ingestion (unmatched order, but stores payment)
    const res1 = await paymentService.ingestSliceEmail(rawEmail);
    assert.equal(res1.confirmed, false);

    // Duplicate ingestion with same RRN
    const res2 = await paymentService.ingestSliceEmail({
      ...rawEmail,
      gmailMessageId: 'slice_dup_2',
    });
    assert.equal(res2.confirmed, false);
    assert.equal(res2.reason, 'DUPLICATE_RRN');
  });
});
