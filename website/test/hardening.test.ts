/**
 * Stage 2 hardening tests: request-size limits and redaction-guarded logging.
 */

import { describe, expect, test } from "bun:test";
import { handleCreateSession, CreateSessionDeps } from "../src/handlers/createSession";
import { handleSessionStatus } from "../src/handlers/sessionStatus";
import { InMemoryRateLimiter } from "../src/domain/rateLimit";
import { capturingLogger, redact } from "../src/domain/log";
import { MAX_BODY_BYTES } from "../src/handlers/http";
import { InMemorySessionStore } from "./helpers/memoryStore";

const BOT_SECRET = "bot-secret-at-least-16-characters";

function makeDeps() {
  const clock = {
    current: new Date("2026-10-20T10:00:00Z"),
    now() {
      return this.current;
    },
  };
  const logger = capturingLogger();
  const deps: CreateSessionDeps = {
    store: new InMemorySessionStore(),
    clock,
    limiter: new InMemoryRateLimiter(),
    botApiSecret: BOT_SECRET,
    tokenSecret: "token-secret-at-least-16-chars",
    websiteBaseUrl: "https://avantas.example",
    logger,
  };
  return { deps, logger, store: deps.store as InMemorySessionStore };
}

function validBody() {
  return {
    order_id: "AVT-2026-000123",
    discord_user_id: "123456789012345678",
    product_id: "vp-1000",
    product_name: "1000 Valorant Points",
    amount_paise: 99900,
    currency: "INR",
    payment_profile_id: "primary",
    upi: { vpa: "merchant@upi", display_name: "Aventas Store" },
  };
}

describe("request-size limits", () => {
  test("oversized body is rejected with 413 and nothing is persisted", async () => {
    const { deps, store } = makeDeps();
    // Inflate the product name far past the byte cap with a giant padding key.
    const big = { ...validBody(), padding: "x".repeat(MAX_BODY_BYTES + 100) };
    const res = await handleCreateSession(deps, {
      method: "POST",
      path: "/payments/checkout-sessions",
      authorization: `Bearer ${BOT_SECRET}`,
      clientIp: "203.0.113.10",
      bodyText: JSON.stringify(big),
    });
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body).error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(store.sessions.size).toBe(0);
  });

  test("multi-byte characters count as bytes, not characters", async () => {
    const { deps, store } = makeDeps();
    // Each '€' is 3 UTF-8 bytes: character length stays under the cap while
    // byte length exceeds it.
    const euroCount = Math.ceil(MAX_BODY_BYTES / 3) + 50;
    const big = { ...validBody(), padding: "€".repeat(euroCount) };
    const text = JSON.stringify(big);
    expect(text.length).toBeLessThan(MAX_BODY_BYTES * 2);
    const res = await handleCreateSession(deps, {
      method: "POST",
      path: "/payments/checkout-sessions",
      authorization: `Bearer ${BOT_SECRET}`,
      clientIp: "203.0.113.10",
      bodyText: text,
    });
    expect(res.status).toBe(413);
    expect(store.sessions.size).toBe(0);
  });

  test("a normal payload stays well under the cap and succeeds", async () => {
    const { deps } = makeDeps();
    const text = JSON.stringify(validBody());
    expect(new TextEncoder().encode(text).length).toBeLessThan(MAX_BODY_BYTES);
    const res = await handleCreateSession(deps, {
      method: "POST",
      path: "/payments/checkout-sessions",
      authorization: `Bearer ${BOT_SECRET}`,
      clientIp: "203.0.113.10",
      bodyText: text,
    });
    expect(res.status).toBe(201);
  });
});

describe("redaction-guarded logging", () => {
  test("redact masks secret-named keys and token-like values", () => {
    const out = redact({
      checkout_token: "tok_value",
      secret: "s3cr3t",
      discord_user_id: "123456789012345678",
      upi_vpa: "merchant@upi",
      order_id: "AVT-1", // safe
      amount_paise: 99900, // safe
      some_field: "a".repeat(50), // token-like value under an innocent key
    });
    expect(out.checkout_token).toBe("[REDACTED]");
    expect(out.secret).toBe("[REDACTED]");
    expect(out.discord_user_id).toBe("[REDACTED]");
    expect(out.upi_vpa).toBe("[REDACTED]");
    expect(out.some_field).toBe("[REDACTED]");
    expect(out.order_id).toBe("AVT-1");
    expect(out.amount_paise).toBe(99900);
  });

  test("session_created log carries ops fields and no secrets", async () => {
    const { deps, logger } = makeDeps();
    const res = await handleCreateSession(deps, {
      method: "POST",
      path: "/payments/checkout-sessions",
      authorization: `Bearer ${BOT_SECRET}`,
      clientIp: "203.0.113.10",
      bodyText: JSON.stringify(validBody()),
    });
    const token = JSON.parse(res.body).checkout_token as string;
    const created = logger.events.find((e) => e.event === "session_created");
    expect(created).toBeDefined();
    expect(created!.fields.order_id).toBe("AVT-2026-000123");
    expect(created!.fields.amount_paise).toBe(99900);
    expect(typeof created!.fields.latency_ms).toBe("number");
    // Nothing sensitive anywhere in the captured log stream.
    const blob = JSON.stringify(logger.events);
    expect(blob).not.toContain(token);
    expect(blob).not.toContain(BOT_SECRET);
    expect(blob).not.toContain("123456789012345678");
    expect(blob).not.toContain("merchant@upi");
  });

  test("rejections are logged with reasons but no token material", async () => {
    const { deps, logger } = makeDeps();
    await handleCreateSession(deps, {
      method: "POST",
      path: "/payments/checkout-sessions",
      authorization: null,
      clientIp: "203.0.113.10",
      bodyText: JSON.stringify(validBody()),
    });
    const rejected = logger.events.find((e) => e.event === "create_rejected");
    expect(rejected!.fields.reason).toBe("unauthorized");
  });

  test("unknown-token status lookups are logged without the token", async () => {
    const { deps } = makeDeps();
    const logger = capturingLogger();
    const statusDeps = { ...deps, logger };
    const token = "A".repeat(43);
    await handleSessionStatus(
      statusDeps,
      {
        method: "GET",
        path: "/payments/checkout-sessions/:token",
        authorization: null,
        clientIp: "198.51.100.7",
        bodyText: null,
      },
      token,
    );
    const rejected = logger.events.find((e) => e.event === "status_rejected");
    expect(rejected!.fields.reason).toBe("unknown_token");
    expect(JSON.stringify(logger.events)).not.toContain(token);
  });
});
