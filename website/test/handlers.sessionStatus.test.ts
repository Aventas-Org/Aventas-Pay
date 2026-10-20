import { describe, expect, test } from "bun:test";
import { handleCreateSession } from "../src/handlers/createSession";
import { handleSessionStatus, SessionStatusDeps } from "../src/handlers/sessionStatus";
import { HandlerRequest } from "../src/handlers/http";
import { InMemoryRateLimiter } from "../src/domain/rateLimit";
import { hashCheckoutToken } from "../src/domain/tokens";
import { InMemorySessionStore } from "./helpers/memoryStore";

const BOT_SECRET = "bot-secret-at-least-16-characters";
const TOKEN_SECRET = "token-secret-at-least-16-chars";

function makeDeps() {
  const clock = { current: new Date("2026-10-20T10:00:00Z"), now() { return this.current; } };
  const store = new InMemorySessionStore();
  const limiter = new InMemoryRateLimiter();
  const createDeps = {
    store,
    clock,
    limiter,
    botApiSecret: BOT_SECRET,
    tokenSecret: TOKEN_SECRET,
    websiteBaseUrl: "https://avantas.example",
  };
  const statusDeps: SessionStatusDeps = { store, clock, limiter };
  return { createDeps, statusDeps, clock, store };
}

function statusRequest(ip = "203.0.113.50"): HandlerRequest {
  return {
    method: "GET",
    path: "/payments/checkout-sessions/:token",
    authorization: null,
    clientIp: ip,
    bodyText: null,
  };
}

async function createdToken(createDeps: unknown, body: Record<string, unknown> = {}) {
  const res = await handleCreateSession(createDeps as never, {
    method: "POST",
    path: "/payments/checkout-sessions",
    authorization: `Bearer ${BOT_SECRET}`,
    clientIp: "203.0.113.10",
    bodyText: JSON.stringify({
      order_id: "AVT-2026-000123",
      discord_user_id: "123456789012345678",
      product_id: "vp-1000",
      product_name: "1000 Valorant Points",
      amount_paise: 99900,
      currency: "INR",
      payment_profile_id: "primary",
      upi: { vpa: "merchant@upi", display_name: "Aventas Store" },
      ...body,
    }),
  });
  return JSON.parse(res.body).checkout_token as string;
}

describe("handleSessionStatus", () => {
  test("valid token returns the minimal render projection", async () => {
    const { createDeps, statusDeps } = makeDeps();
    const token = await createdToken(createDeps);
    const res = await handleSessionStatus(statusDeps, statusRequest(), token);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("PENDING");
    expect(body.order_ref).toBe("AVT-2026-000123");
    expect(body.product.name).toBe("1000 Valorant Points");
    expect(body.amount_paise).toBe(99900);
    expect(body.upi.vpa).toBe("merchant@upi");
    expect(body.qr_payload).toContain("pa=merchant%40upi");
    expect(body.qr_payload).toContain("am=999.00");
  });

  test("response leaks no discord id, secrets or internal fields", async () => {
    const { createDeps, statusDeps } = makeDeps();
    const token = await createdToken(createDeps);
    const res = await handleSessionStatus(statusDeps, statusRequest(), token);
    expect(res.body).not.toContain("123456789012345678");
    expect(res.body).not.toContain("discord");
    expect(res.body).not.toContain("idempotency");
    expect(res.body).not.toContain("token_hash");
    expect(res.body).not.toContain("payment_profile_id");
    expect(res.body).not.toContain(BOT_SECRET);
    expect(res.body).not.toContain(TOKEN_SECRET);
  });

  test("recipient and QR are stable across repeated loads", async () => {
    const { createDeps, statusDeps } = makeDeps();
    const token = await createdToken(createDeps);
    const a = JSON.parse((await handleSessionStatus(statusDeps, statusRequest(), token)).body);
    const b = JSON.parse((await handleSessionStatus(statusDeps, statusRequest(), token)).body);
    expect(b.upi).toEqual(a.upi);
    expect(b.qr_payload).toBe(a.qr_payload);
    expect(b.amount_paise).toBe(a.amount_paise);
  });

  test("unknown but well-formed token returns generic 404", async () => {
    const { statusDeps } = makeDeps();
    const unknownToken = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const res = await handleSessionStatus(statusDeps, statusRequest(), unknownToken);
    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toBe("Checkout session not found.");
  });

  test("malformed tokens are rejected without a database lookup", async () => {
    const { statusDeps, store } = makeDeps();
    let lookups = 0;
    const original = store.findByTokenHash.bind(store);
    store.findByTokenHash = async (h) => {
      lookups += 1;
      return original(h);
    };
    for (const bad of ["short", "!!!!", "a".repeat(44), "../etc/passwd", ""]) {
      const res = await handleSessionStatus(statusDeps, statusRequest(), bad);
      expect(res.status).toBe(404);
    }
    expect(lookups).toBe(0);
  });

  test("expired pending session reports EXPIRED, persists it and cannot be revived", async () => {
    const { createDeps, statusDeps, clock, store } = makeDeps();
    const token = await createdToken(createDeps, { ttl_seconds: 300 });
    clock.current = new Date(clock.current.getTime() + 301 * 1000);
    const res = await handleSessionStatus(statusDeps, statusRequest(), token);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("EXPIRED");
    // Transition persisted for the audit trail.
    const session = [...store.sessions.values()][0]!;
    expect(session.status).toBe("EXPIRED");
    expect(store.events.some((e) => e.eventType === "SESSION_EXPIRED")).toBe(true);
    // Subsequent reads keep reporting EXPIRED.
    const again = await handleSessionStatus(statusDeps, statusRequest(), token);
    expect(JSON.parse(again.body).status).toBe("EXPIRED");
  });

  test("audit-write failure does not break the read path", async () => {
    const { createDeps, statusDeps, clock, store } = makeDeps();
    const token = await createdToken(createDeps, { ttl_seconds: 300 });
    clock.current = new Date(clock.current.getTime() + 301 * 1000);
    store.failNextWrite = new Error("disk full");
    const res = await handleSessionStatus(statusDeps, statusRequest(), token);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).status).toBe("EXPIRED");
  });

  test("rate limit returns 429 after 30 requests per IP window", async () => {
    const { createDeps, statusDeps } = makeDeps();
    const token = await createdToken(createDeps);
    let last = null as unknown;
    for (let i = 0; i < 31; i++) {
      last = await handleSessionStatus(statusDeps, statusRequest("198.51.100.7"), token);
    }
    const res = last as { status: number };
    expect(res.status).toBe(429);
  });

  test("no-store and no-referrer headers on public responses", async () => {
    const { createDeps, statusDeps } = makeDeps();
    const token = await createdToken(createDeps);
    const res = await handleSessionStatus(statusDeps, statusRequest(), token);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  test("hashed lookup never stores the plaintext token", async () => {
    const { createDeps, statusDeps, store } = makeDeps();
    const token = await createdToken(createDeps);
    const stored = [...store.tokenHashes.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]).not.toBe(token);
    expect(stored[0]).toBe(await hashCheckoutToken(token));
  });
});
