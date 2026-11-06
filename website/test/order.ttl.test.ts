import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderService } from '../src/services/order.service.ts';
import { db } from '../src/services/database/client.ts';

test('Order TTL Invariant - expiresAt is strictly after createdAt (createdAt + TTL)', async () => {
  const orderService = new OrderService();
  const created = await orderService.createOrder({
    baseAmount: 100,
    productName: 'TTL Test Product',
  });

  const createdTime = new Date(created.createdAt).getTime();
  const expiresTime = new Date(created.expiresAt).getTime();

  assert.ok(
    expiresTime > createdTime,
    `expiresAt (${created.expiresAt}) must be strictly later than createdAt (${created.createdAt})`
  );

  // Default TTL is 10 minutes (600,000 ms)
  const diffMinutes = Math.round((expiresTime - createdTime) / 60000);
  assert.equal(diffMinutes, 10, 'Default TTL should be exactly 10 minutes');

  // Verify lookup
  const found = await orderService.getOrder(created.paymentId);
  assert.ok(found);
  assert.equal(found.status, 'PENDING');
  assert.ok(new Date(found.expiresAt).getTime() > new Date(found.createdAt).getTime());
});

test('Order Invariant Enforcement - throws if expiresAt <= createdAt', async () => {
  const now = new Date();
  const past = new Date(now.getTime() - 60000);

  await assert.rejects(
    async () => {
      await db.order.create({
        data: {
          id: `test_inv_${Date.now()}`,
          amount: 50,
          baseAmount: 50,
          decimalOffset: 1,
          currency: 'INR',
          status: 'PENDING',
          createdAt: now,
          expiresAt: past, // Earlier than createdAt
        },
      });
    },
    /Invariant violation/
  );
});

test('Order Invariant Enforcement - update rejects setting expiresAt <= createdAt', async () => {
  const now = new Date();
  const future = new Date(now.getTime() + 600000);
  const past = new Date(now.getTime() - 60000);

  const ord = await db.order.create({
    data: {
      id: `test_upd_${Date.now()}`,
      amount: 75,
      baseAmount: 75,
      decimalOffset: 2,
      currency: 'INR',
      status: 'PENDING',
      createdAt: now,
      expiresAt: future,
    },
  });

  await assert.rejects(
    async () => {
      await db.order.update({
        where: { id: ord.id },
        data: { expiresAt: past },
      });
    },
    /Invariant violation/
  );
});
