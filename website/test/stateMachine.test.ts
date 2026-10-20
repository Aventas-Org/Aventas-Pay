import { describe, expect, test } from "bun:test";
import {
  applyTransition,
  canTransition,
  effectiveStatus,
  IllegalTransition,
  isActive,
  isExpired,
  recordTrustedPayment,
} from "../src/domain/stateMachine";
import { CheckoutSession } from "../src/domain/types";
import { InMemorySessionStore } from "./helpers/memoryStore";

const NOW = new Date("2026-10-20T10:00:00Z");
const LATER = new Date("2026-10-20T11:00:00Z");
const EXPIRES = new Date("2026-10-20T10:30:00Z");

function session(overrides: Partial<CheckoutSession> = {}): CheckoutSession {
  return {
    id: "sess-1",
    orderId: "AVT-1",
    discordUserId: "123456789012345678",
    productId: "vp-1000",
    productName: "1000 VP",
    amountPaise: 99900,
    currency: "INR",
    paymentProfileId: "primary",
    upi: { vpa: "merchant@upi", displayName: "Aventas Store" },
    status: "PENDING",
    idempotencyKey: "AVT-1:checkout-session",
    attempt: 1,
    source: "discord_bot",
    providerTransactionRef: null,
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: EXPIRES,
    paidAt: null,
    ...overrides,
  };
}

describe("state machine", () => {
  test("only PENDING can leave its state; terminal states are locked", () => {
    expect(canTransition("PENDING", "PAID")).toBe(true);
    expect(canTransition("PENDING", "EXPIRED")).toBe(true);
    expect(canTransition("PENDING", "CANCELLED")).toBe(true);
    expect(canTransition("PAID", "CANCELLED")).toBe(false);
    expect(canTransition("PAID", "PENDING")).toBe(false);
    expect(canTransition("EXPIRED", "PAID")).toBe(false);
    expect(canTransition("EXPIRED", "PENDING")).toBe(false);
    expect(canTransition("CANCELLED", "PENDING")).toBe(false);
    expect(canTransition("CANCELLED", "PAID")).toBe(false);
  });

  test("active means PENDING and before expiry", () => {
    expect(isActive(session(), NOW)).toBe(true);
    expect(isActive(session(), EXPIRES)).toBe(false);
    expect(isActive(session({ status: "PAID" }), NOW)).toBe(false);
  });

  test("effective status flips to EXPIRED at and after expiry", () => {
    expect(effectiveStatus(session(), NOW)).toBe("PENDING");
    expect(effectiveStatus(session(), new Date(EXPIRES.getTime() - 1))).toBe("PENDING");
    expect(effectiveStatus(session(), EXPIRES)).toBe("EXPIRED");
    expect(effectiveStatus(session(), LATER)).toBe("EXPIRED");
  });

  test("expired sessions cannot be revived, even by the trusted path", () => {
    const expired = session();
    expect(isExpired(expired, LATER)).toBe(true);
    expect(() => applyTransition(expired, "PAID", LATER, "ref")).toThrow(IllegalTransition);
    expect(() => applyTransition(expired, "PENDING", LATER)).toThrow(IllegalTransition);
  });

  test("applyTransition stamps paidAt and provider reference only on PAID", () => {
    const paid = applyTransition(session(), "PAID", NOW, "txn-123").session;
    expect(paid.status).toBe("PAID");
    expect(paid.paidAt).toEqual(NOW);
    expect(paid.providerTransactionRef).toBe("txn-123");

    const cancelled = applyTransition(session(), "CANCELLED", NOW, "txn-999").session;
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.providerTransactionRef).toBeNull();
  });

  test("illegal transitions throw", () => {
    expect(() => applyTransition(session({ status: "PAID" }), "PENDING", NOW)).toThrow(
      IllegalTransition,
    );
  });

  const clockAt = (d: Date) => ({ now: () => d });

  test("recordTrustedPayment requires a provider reference", async () => {
    const store = new InMemorySessionStore();
    await expect(
      recordTrustedPayment(store, "sess-1", "", clockAt(NOW)),
    ).rejects.toThrow(/provider transaction reference/);
    await expect(
      recordTrustedPayment(store, "sess-1", "ab", clockAt(NOW)),
    ).rejects.toThrow(/provider transaction reference/);
  });

  test("recordTrustedPayment marks PENDING session PAID and records the event", async () => {
    const store = new InMemorySessionStore();
    const s = session();
    store.sessions.set(s.id, s);
    const result = await recordTrustedPayment(store, s.id, "txn-123", clockAt(NOW));
    expect(result.status).toBe("PAID");
    expect(result.providerTransactionRef).toBe("txn-123");
    expect(store.events).toHaveLength(1);
    expect(store.events[0]!.eventType).toBe("PAYMENT_RECORDED");
    expect(store.events[0]!.actor).toBe("trusted_verifier");
  });

  test("recordTrustedPayment refuses when the session already expired", async () => {
    const store = new InMemorySessionStore();
    const s = session();
    store.sessions.set(s.id, s);
    await expect(
      recordTrustedPayment(store, s.id, "txn-123", clockAt(LATER)),
    ).rejects.toThrow(IllegalTransition);
  });

  test("optimistic-update race returns current state instead of overwriting", async () => {
    const store = new InMemorySessionStore();
    const s = session();
    store.sessions.set(s.id, s);

    // Simulate the race window: findById sees PENDING, but another actor
    // transitions the row before our updateStatus lands (it returns false),
    // so the second read surfaces the other actor's result.
    const originalFind = store.findById.bind(store);
    let firstRead = true;
    store.findById = async (id: string) => {
      const found = await originalFind(id);
      if (!firstRead && found) {
        return { ...found, status: "CANCELLED" as const };
      }
      firstRead = false;
      return found;
    };
    const originalUpdate = store.updateStatus.bind(store);
    store.updateStatus = async (id, from, to, now, ref) => {
      // The competing actor already moved the row, so our guarded update misses.
      await originalUpdate(id, from, "CANCELLED", now);
      return false;
    };

    const result = await recordTrustedPayment(store, s.id, "txn-123", clockAt(NOW));
    expect(result.status).toBe("CANCELLED");
    // The losing writer must not have appended a payment event.
    expect(store.events).toHaveLength(0);
  });
});
