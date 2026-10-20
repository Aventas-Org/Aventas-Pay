import { describe, expect, test } from "bun:test";
import { handleCreateSession, CreateSessionDeps } from "../src/handlers/createSession";
import { HandlerRequest } from "../src/handlers/http";
import { InMemoryRateLimiter } from "../src/domain/rateLimit";
import { IdempotencyConflict } from "../src/domain/types";
import { InMemorySessionStore } from "./helpers/memoryStore";

const BOT_SECRET = "bot-secret-at-least-16-characters";
const TOKEN_SECRET = "token-secret-at-least-16-chars";
const BASE_URL = "https://avantas.example/";

function makeDeps(overrides: Partial<CreateSessionDeps> = {}) {
  const clock = { current: new Date("2026-10-20T10:00:00Z"), now() { return this.current; } };
  const deps: CreateSessionDeps = {
    store: new InMemorySessionStore(),
    clock,
    limiter: new InMemoryRateLimiter(),
    botApiSecret: BOT_SECRET,
    tokenSecret: TOKEN_SECRET,
    websiteBaseUrl: BASE_URL,
    ...overrides,
  };
  return { deps, clock, store: deps.store as InMemorySessionStore };
}

function makeRequest(body: unknown, overrides: Partial<HandlerRequest> = {}): HandlerRequest {
  return {
    method: "POST",
    path: "/payments/checkout-sessions",
    authorization: `Bearer ${BOT_SECRET}`,
    clientIp: "203.0.113.10",
    bodyText: typeof body === "string" ? body : JSON.stringify(body),
    ...overrides,
  };
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    order_id: "AVT-2026-000123",
    discord_user_id: "123456789012345678",
    product_id: "vp-1000",
    product_name: "1000 Valorant Points",
    amount_paise: 99900,
    currency: "INR",
    payment_profile_id: "primary",
    upi: { vpa: "merchant@upi", display_name: "Aventas Store" },
    ...overrides,
  };
}

function collectKeys(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const v of value) collectKeys(v, out);
  else if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      collectKeys(v, out);
    }
  }
  return out;
}

describe("handleCreateSession — authentication", () => {
  test("missing Authorization header is rejected with generic 401", async () => {
    const { deps } = makeDeps();
    const res = await handleCreateSession(deps, makeRequest(validBody(), { authorization: null }));
    expect(res.status).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(res.body).not.toContain(BOT_SECRET);
  });

  test("wrong secret is rejected", async () => {
    const { deps } = makeDeps();
    const res = await handleCreateSession(
      deps,
      makeRequest(validBody(), { authorization: "Bearer wrong-secret-value-here" }),
    );
    expect(res.status).toBe(401);
  });

  test("malformed Authorization header is rejected", async () => {
    const { deps } = makeDeps();
    for (const header of ["Basic abc", "Bearer", BOT_SECRET, "bearer "]) {
      const res = await handleCreateSession(deps, makeRequest(validBody(), { authorization: header }));
      expect(res.status).toBe(401);
    }
  });

  test("empty server-side secret rejects everything", async () => {
    const { deps } = makeDeps({ botApiSecret: "" });
    const res = await handleCreateSession(deps, makeRequest(validBody()));
    expect(res.status).toBe(401);
  });
});

describe("handleCreateSession — creation", () => {
  test("valid request returns 201 with checkout token and URL", async () => {
    const { deps, store } = makeDeps();
    const res = await handleCreateSession(deps, makeRequest(validBody()));
    expect(res.status).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.session_status).toBe("PENDING");
    expect(body.order_ref).toBe("AVT-2026-000123");
    expect(body.amount_paise).toBe(99900);
    expect(body.amount_display).toBe("999.00");
    expect(body.upi).toEqual({ vpa: "merchant@upi", display_name: "Aventas Store" });
    expect(body.checkout_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.checkout_url).toBe(`${BASE_URL}checkout/${body.checkout_token}`);
    expect(body.reused).toBe(false);
    expect(store.sessions.size).toBe(1);
    expect(store.events[0]!.eventType).toBe("SESSION_CREATED");
  });

  test("response contains no private or internal fields", async () => {
    const { deps } = makeDeps();
    const res = await handleCreateSession(deps, makeRequest(validBody()));
    const keys = collectKeys(JSON.parse(res.body));
    for (const forbidden of [
      "discord_user_id",
      "discordUserId",
      "idempotency_key",
      "token_hash",
      "payment_profile_id",
      "attempt",
      "source",
      "session_id",
      "provider_transaction_ref",
    ]) {
      expect(keys.has(forbidden)).toBe(false);
    }
    expect(res.body).not.toContain("123456789012345678");
  });

  test("expires_at honours the requested ttl", async () => {
    const { deps, clock } = makeDeps();
    const res = await handleCreateSession(
      deps,
      makeRequest(validBody({ ttl_seconds: 600 })),
    );
    const body = JSON.parse(res.body);
    const expected = new Date(clock.current.getTime() + 600 * 1000).toISOString();
    expect(body.expires_at).toBe(expected);
  });

  test("security headers are set (no-store, no-referrer)", async () => {
    const { deps } = makeDeps();
    const res = await handleCreateSession(deps, makeRequest(validBody()));
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });
});

describe("handleCreateSession — idempotency", () => {
  test("replayed request returns the same session and URL, creating no duplicate", async () => {
    const { deps, store } = makeDeps();
    const first = await handleCreateSession(deps, makeRequest(validBody()));
    const second = await handleCreateSession(deps, makeRequest(validBody()));
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    const a = JSON.parse(first.body);
    const b = JSON.parse(second.body);
    expect(b.checkout_url).toBe(a.checkout_url);
    expect(b.checkout_token).toBe(a.checkout_token);
    expect(b.reused).toBe(true);
    expect(store.sessions.size).toBe(1);
  });

  test("duplicate Discord clicks (same order, no explicit key) stay idempotent", async () => {
    const { deps, store } = makeDeps();
    for (let i = 0; i < 5; i++) {
      const res = await handleCreateSession(deps, makeRequest(validBody()));
      expect(res.status).toBe(i === 0 ? 201 : 200);
    }
    expect(store.sessions.size).toBe(1);
  });

  test("concurrent insert conflict resolves to the winning session", async () => {
    const { deps, store } = makeDeps();
    const first = await handleCreateSession(deps, makeRequest(validBody()));
    const firstBody = JSON.parse(first.body);
    // Force the next create down the conflict path.
    const originalInsert = store.insertSession.bind(store);
    store.insertSession = async () => {
      throw new IdempotencyConflict();
    };
    const replay = await handleCreateSession(deps, makeRequest(validBody()));
    store.insertSession = originalInsert;
    expect(replay.status).toBe(200);
    expect(JSON.parse(replay.body).checkout_url).toBe(firstBody.checkout_url);
  });

  test("after expiry a new attempt is created and gets a fresh token", async () => {
    const { deps, clock, store } = makeDeps();
    const first = await handleCreateSession(
      deps,
      makeRequest(validBody({ ttl_seconds: 300 })),
    );
    const firstToken = JSON.parse(first.body).checkout_token;
    clock.current = new Date(clock.current.getTime() + 301 * 1000);
    const second = await handleCreateSession(deps, makeRequest(validBody()));
    expect(second.status).toBe(201);
    const secondToken = JSON.parse(second.body).checkout_token;
    expect(secondToken).not.toBe(firstToken);
    expect(store.sessions.size).toBe(2);
    const attempts = [...store.sessions.values()].map((s) => s.attempt).sort();
    expect(attempts).toEqual([1, 2]);
  });
});

describe("handleCreateSession — validation and failures", () => {
  test("malformed amount is rejected and nothing is persisted", async () => {
    const { deps, store } = makeDeps();
    const res = await handleCreateSession(
      deps,
      makeRequest(validBody({ amount_paise: -100 })),
    );
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.fields).toContain("amount_paise");
    expect(store.sessions.size).toBe(0);
  });

  test("unknown/garbage fields do not create a session silently", async () => {
    const { deps, store } = makeDeps();
    const res = await handleCreateSession(
      deps,
      makeRequest({ totally: "unrelated" }),
    );
    expect(res.status).toBe(400);
    expect(store.sessions.size).toBe(0);
  });

  test("malformed JSON body returns generic 400", async () => {
    const { deps } = makeDeps();
    const res = await handleCreateSession(deps, makeRequest("{not json"));
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("VALIDATION_ERROR");
  });

  test("database failure returns generic 500 without leaking the error", async () => {
    const { deps, store } = makeDeps();
    store.failNextWrite = new Error("SQLITE_CONSTRAINT: internal details");
    const res = await handleCreateSession(deps, makeRequest(validBody()));
    expect(res.status).toBe(500);
    expect(res.body).not.toContain("SQLITE");
    expect(res.body).not.toContain("internal details");
    expect(JSON.parse(res.body).error.code).toBe("INTERNAL_ERROR");
  });

  test("rate limit returns 429 with retry-after", async () => {
    const { deps } = makeDeps();
    let last = null as unknown;
    for (let i = 0; i < 121; i++) {
      last = await handleCreateSession(deps, makeRequest(validBody()));
    }
    const res = last as { status: number; body: string };
    expect(res.status).toBe(429);
    expect(JSON.parse(res.body).error.retryAfterSeconds).toBeGreaterThan(0);
  });
});
