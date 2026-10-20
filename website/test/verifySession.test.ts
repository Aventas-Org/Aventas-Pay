/**
 * Verify-endpoint tests: the only HTTP path that can mark a session PAID.
 * Runs against the real SQL store + real migrations (bun:sqlite).
 */

import { describe, expect, test } from "bun:test";
import { handleVerifySession } from "../src/handlers/verifySession";
import { handleCreateSession } from "../src/handlers/createSession";
import { handleSessionStatus } from "../src/handlers/sessionStatus";
import { InMemoryRateLimiter } from "../src/domain/rateLimit";
import { capturingLogger } from "../src/domain/log";
import { migratedExecutor } from "./helpers/bunSqlite";
import { SqlSessionStore } from "../src/adapters/sqlSessionStore";
import { HandlerRequest } from "../src/handlers/http";

const BOT_SECRET = "bot-secret-at-least-16-characters";

function makeEnv() {
  const clock = {
    current: new Date("2026-10-20T10:00:00Z"),
    now() {
      return this.current;
    },
  };
  const { executor } = migratedExecutor();
  const store = new SqlSessionStore(executor);
  const limiter = new InMemoryRateLimiter();
  const logger = capturingLogger();
  const deps = { store, clock, limiter, botApiSecret: BOT_SECRET, logger };
  const createDeps = {
    ...deps,
    tokenSecret: "token-secret-at-least-16-chars",
    websiteBaseUrl: "https://avantas.example",
  };
  return { deps, createDeps, clock, store, logger };
}

function verifyRequest(body: unknown, auth: string | null = `Bearer ${BOT_SECRET}`): HandlerRequest {
  return {
    method: "POST",
    path: "/api/payments/checkout-sessions/verify",
    authorization: auth,
    clientIp: "203.0.113.20",
    bodyText: JSON.stringify(body),
  };
}

async function createSession(
  env: ReturnType<typeof makeEnv>,
  orderId = "AVT-2026-000123",
  discordId = "123456789012345678",
) {
  const res = await handleCreateSession(env.createDeps, {
    method: "POST",
    path: "/api/payments/checkout-sessions",
    authorization: `Bearer ${BOT_SECRET}`,
    clientIp: "203.0.113.10",
    bodyText: JSON.stringify({
      order_id: orderId,
      discord_user_id: discordId,
      product_id: "vp-1000",
      product_name: "1000 Valorant Points",
      amount_paise: 99900,
      currency: "INR",
      payment_profile_id: "primary",
      upi: { vpa: "merchant@upi", display_name: "Aventas Store" },
    }),
  });
  return JSON.parse(res.body);
}

const TOKEN_SECRET = "token-secret-at-least-16-chars";

async function publicStatus(env: ReturnType<typeof makeEnv>, token: string) {
  const res = await handleSessionStatus(
    { store: env.store, clock: env.clock, limiter: new InMemoryRateLimiter() },
    {
      method: "GET",
      path: "/x",
      authorization: null,
      clientIp: "198.51.100.9",
      bodyText: null,
    },
    token,
  );
  return { status: res.status, body: JSON.parse(res.body) };
}

describe("handleVerifySession", () => {
  test("requires the bot secret", async () => {
    const env = makeEnv();
    await createSession(env);
    for (const auth of [null, "Bearer wrong-secret-value-here", "Basic x"]) {
      const res = await handleVerifySession(env.deps, verifyRequest(
        { order_id: "AVT-2026-000123", provider_transaction_ref: "UTR1234567890" },
        auth,
      ));
      expect(res.status).toBe(401);
    }
  });

  test("marks a PENDING session PAID and the public view reflects it", async () => {
    const env = makeEnv();
    const created = await createSession(env);
    const res = await handleVerifySession(env.deps, verifyRequest({
      order_id: "AVT-2026-000123",
      provider_transaction_ref: "UTR-99887766",
    }));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).status).toBe("PAID");

    const pub = await publicStatus(env, created.checkout_token);
    expect(pub.status).toBe(200);
    expect(pub.body.status).toBe("PAID");
    // Public PAID view still leaks nothing private.
    expect(pub.body).not.toHaveProperty("provider_transaction_ref");
    expect(JSON.stringify(pub.body)).not.toContain("123456789012345678");
  });

  test("replay with the same reference is idempotent; different reference conflicts", async () => {
    const env = makeEnv();
    await createSession(env);
    const first = await handleVerifySession(env.deps, verifyRequest({
      order_id: "AVT-2026-000123",
      provider_transaction_ref: "UTR-99887766",
    }));
    expect(first.status).toBe(200);

    const replay = await handleVerifySession(env.deps, verifyRequest({
      order_id: "AVT-2026-000123",
      provider_transaction_ref: "UTR-99887766",
    }));
    expect(replay.status).toBe(200);
    expect(JSON.parse(replay.body).status).toBe("PAID");

    const mismatch = await handleVerifySession(env.deps, verifyRequest({
      order_id: "AVT-2026-000123",
      provider_transaction_ref: "UTR-OTHER-REF1",
    }));
    expect(mismatch.status).toBe(409);
  });

  test("expired session cannot be verified late (never revived)", async () => {
    const env = makeEnv();
    const created = await createSession(env);
    env.clock.current = new Date(env.clock.current.getTime() + 3600_000);
    const res = await handleVerifySession(env.deps, verifyRequest({
      order_id: "AVT-2026-000123",
      provider_transaction_ref: "UTR-LATE-PAY1",
    }));
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe("CONFLICT");
    const pub = await publicStatus(env, created.checkout_token);
    expect(pub.body.status).toBe("EXPIRED");
  });

  test("cancelled session cannot be verified", async () => {
    const env = makeEnv();
    const created = await createSession(env);
    await env.store.updateStatus(
      (await env.store.findActiveByOrderId("AVT-2026-000123", env.clock.now()))!.id,
      "PENDING",
      "CANCELLED",
      env.clock.now(),
    );
    const res = await handleVerifySession(env.deps, verifyRequest({
      order_id: "AVT-2026-000123",
      provider_transaction_ref: "UTR-CANCEL-P1",
    }));
    expect(res.status).toBe(409);
    const pub = await publicStatus(env, created.checkout_token);
    expect(pub.body.status).toBe("CANCELLED");
  });

  test("unknown order returns generic 404", async () => {
    const env = makeEnv();
    const res = await handleVerifySession(env.deps, verifyRequest({
      order_id: "AVT-UNKNOWN-99",
      provider_transaction_ref: "UTR-UNKNOWN1",
    }));
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).error.message).toBe("Checkout session not found.");
  });

  test("one provider receipt cannot verify two orders (DB-enforced)", async () => {
    const env = makeEnv();
    await createSession(env, "AVT-2026-000123");
    await createSession(env, "AVT-2026-000456", "999999999999999999");
    const first = await handleVerifySession(env.deps, verifyRequest({
      order_id: "AVT-2026-000123",
      provider_transaction_ref: "UTR-SHARED-REF",
    }));
    expect(first.status).toBe(200);
    const second = await handleVerifySession(env.deps, verifyRequest({
      order_id: "AVT-2026-000456",
      provider_transaction_ref: "UTR-SHARED-REF",
    }));
    expect(second.status).toBe(409);
  });

  test("malformed payloads are rejected", async () => {
    const env = makeEnv();
    await createSession(env);
    for (const body of [
      { order_id: "bad order id", provider_transaction_ref: "UTR-OK-1234" },
      { order_id: "AVT-2026-000123", provider_transaction_ref: "abc" }, // < 4-char minimum
      { order_id: "AVT-2026-000123" },
      { provider_transaction_ref: "UTR-OK-1234" },
    ]) {
      const res = await handleVerifySession(env.deps, verifyRequest(body));
      expect(res.status).toBe(400);
    }
  });

  test("verify activity is logged without secrets", async () => {
    const env = makeEnv();
    await createSession(env);
    await handleVerifySession(env.deps, verifyRequest({
      order_id: "AVT-2026-000123",
      provider_transaction_ref: "UTR-LOG-TEST1",
    }));
    const recorded = env.logger.events.find((e) => e.event === "verify_recorded");
    expect(recorded!.fields.order_id).toBe("AVT-2026-000123");
    const blob = JSON.stringify(env.logger.events);
    expect(blob).not.toContain(BOT_SECRET);
    expect(blob).not.toContain(TOKEN_SECRET);
    expect(blob).not.toContain("123456789012345678");
  });
});

describe("order-ID format compatibility (real bot: AVT- new, LGN- legacy)", () => {
  const ACCEPTS = [
    "AVT-2026-000123", // documented new format
    "AVT-0000000001",
    "AVT-ABCDEFGHIJ",
    "LGN-000123", // legacy IDs remain valid
    "LGN-1",
  ];
  const REJECTS = [
    "AVT 2026 000123", // spaces
    "AVT/2026", // path separators
    "AVT-2026; DROP TABLE checkout_sessions",
    "",
  ];

  test.each(ACCEPTS)("accepts documented order id %s", async (orderId) => {
    const env = makeEnv();
    const created = await createSession(env, orderId);
    expect(created.order_ref).toBe(orderId);
    const verify = await handleVerifySession(env.deps, verifyRequest({
      order_id: orderId,
      provider_transaction_ref: `UTR-${orderId.replace(/[^A-Za-z0-9]/g, "")}`.slice(0, 64),
    }));
    expect(verify.status).toBe(200);
  });

  test.each(REJECTS)("rejects malformed order id %p", async (orderId) => {
    const env = makeEnv();
    const created = await createSession(env, "AVT-OK-000001");
    expect(created.order_ref).toBe("AVT-OK-000001");
    const verify = await handleVerifySession(env.deps, verifyRequest({
      order_id: orderId,
      provider_transaction_ref: "UTR-REJECT-12",
    }));
    expect(verify.status).toBe(400);
  });
});
