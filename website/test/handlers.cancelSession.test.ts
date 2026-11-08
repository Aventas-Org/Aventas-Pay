import { describe, expect, test } from "bun:test";
import { handleCreateSession, CreateSessionDeps } from "../src/handlers/createSession";
import { handleCancelSession } from "../src/handlers/cancelSession";
import { HandlerRequest } from "../src/handlers/http";
import { InMemoryRateLimiter } from "../src/domain/rateLimit";
import { InMemorySessionStore } from "./helpers/memoryStore";

const BOT_SECRET = "bot-secret-at-least-16-characters";

function makeEnv() {
  const clock = { current: new Date("2026-10-20T10:00:00Z"), now() { return this.current; } };
  const store = new InMemorySessionStore();
  const limiter = new InMemoryRateLimiter();
  const deps: CreateSessionDeps = {
    store,
    clock,
    limiter,
    botApiSecret: BOT_SECRET,
    tokenSecret: "token-secret-at-least-16-chars",
    websiteBaseUrl: "https://avantas.example",
  };
  const cancelDeps = { store, clock, limiter, botApiSecret: BOT_SECRET, websiteBaseUrl: "https://avantas.example" };
  return { deps, cancelDeps, store, clock };
}

async function createOrder(
  deps: CreateSessionDeps,
  orderId = "AVT-2026-000123",
  idempotencyKey?: string,
) {
  const res = await handleCreateSession(deps, {
    method: "POST",
    path: "/payments/checkout-sessions",
    authorization: `Bearer ${BOT_SECRET}`,
    clientIp: "203.0.113.10",
    bodyText: JSON.stringify({
      order_id: orderId,
      discord_user_id: "123456789012345678",
      product_id: "vp-1000",
      product_name: "1000 Valorant Points",
      amount_paise: 99900,
      currency: "INR",
      payment_profile_id: "primary",
      upi: { vpa: "merchant@upi", display_name: "Aventas Store" },
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    }),
  });
  return JSON.parse(res.body);
}

function cancelRequest(orderId: string, auth: string | null = `Bearer ${BOT_SECRET}`): HandlerRequest {
  return {
    method: "POST",
    path: "/payments/checkout-sessions/cancel",
    authorization: auth,
    clientIp: "203.0.113.11",
    bodyText: JSON.stringify({ order_id: orderId }),
  };
}

describe("handleCancelSession", () => {
  test("requires the bot secret", async () => {
    const { deps, cancelDeps } = makeEnv();
    await createOrder(deps);
    for (const auth of [null, "Bearer wrong-secret-value-here", "Basic abc"]) {
      const res = await handleCancelSession(cancelDeps, cancelRequest("AVT-2026-000123", auth));
      expect(res.status).toBe(401);
    }
  });

  test("cancels an active session and records the event", async () => {
    const { deps, cancelDeps, store } = makeEnv();
    await createOrder(deps);
    const res = await handleCancelSession(cancelDeps, cancelRequest("AVT-2026-000123"));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).status).toBe("CANCELLED");
    expect([...store.sessions.values()][0]!.status).toBe("CANCELLED");
    expect(store.events.some((e) => e.eventType === "SESSION_CANCELLED")).toBe(true);
  });

  test("repeated cancel is idempotent and returns the terminal state", async () => {
    const { deps, cancelDeps } = makeEnv();
    await createOrder(deps);
    const first = await handleCancelSession(cancelDeps, cancelRequest("AVT-2026-000123"));
    const second = await handleCancelSession(cancelDeps, cancelRequest("AVT-2026-000123"));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(JSON.parse(second.body).status).toBe("CANCELLED");
  });


  test("custom-key cancellation and replay return the same terminal state without payment instructions", async () => {
    const { deps, cancelDeps, store } = makeEnv();
    const orderId = "AVT-CUSTOM-CANCEL-1";
    await createOrder(deps, orderId, "custom-order-cancel-key-01");
    for (let i = 0; i < 2; i++) {
      const res = await handleCancelSession(cancelDeps, cancelRequest(orderId));
      const body = JSON.parse(res.body);
      expect(res.status).toBe(200);
      expect(body.status).toBe("CANCELLED");
      expect(body.upi).toEqual({ vpa: "", display_name: "" });
      expect(body.qr_payload).toBe("");
    }
    expect(store.events.filter((e) => e.eventType === "SESSION_CANCELLED")).toHaveLength(1);
  });

  test("custom-key expired checkout is discoverable but not revived by late cancellation", async () => {
    const { deps, cancelDeps, clock, store } = makeEnv();
    const orderId = "AVT-CUSTOM-EXPIRED-1";
    await createOrder(deps, orderId, "custom-order-expiry-key-01");
    clock.current = new Date(clock.current.getTime() + 121000);
    const res = await handleCancelSession(cancelDeps, cancelRequest(orderId));
    const body = JSON.parse(res.body);
    expect(res.status).toBe(200);
    expect(body.status).toBe("EXPIRED");
    expect(body.upi.vpa).toBe("");
    expect(body.qr_payload).toBe("");
    expect([...store.sessions.values()][0]!.status).toBe("PENDING");
    expect(store.events.some((e) => e.eventType === "SESSION_CANCELLED")).toBe(false);
  });

  test("losing cancellation to concurrent verification cannot expose stale payment instructions", async () => {
    const { deps, cancelDeps, store } = makeEnv();
    await createOrder(deps);
    const originalUpdate = store.updateStatus.bind(store);
    store.updateStatus = async (id, from, to, now, providerRef) => {
      if (to === "CANCELLED") {
        await originalUpdate(id, from, "PAID", now, "BANK-RECEIPT-1");
        return false;
      }
      return originalUpdate(id, from, to, now, providerRef);
    };
    const res = await handleCancelSession(cancelDeps, cancelRequest("AVT-2026-000123"));
    const body = JSON.parse(res.body);
    expect(res.status).toBe(200);
    expect(body.status).toBe("PAID");
    expect(body.upi.vpa).toBe("");
    expect(body.qr_payload).toBe("");
    expect(store.events.filter((e) => e.eventType === "SESSION_CANCELLED")).toHaveLength(0);
  });

  test("unknown order returns generic 404", async () => {
    const { cancelDeps } = makeEnv();
    const res = await handleCancelSession(cancelDeps, cancelRequest("AVT-UNKNOWN-1"));
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("NOT_FOUND");
  });

  test("invalid order id returns 400", async () => {
    const { cancelDeps } = makeEnv();
    const res = await handleCancelSession(
      cancelDeps,
      cancelRequest("bad order id with spaces"),
    );
    expect(res.status).toBe(400);
  });

  test("cancelled session cannot be paid afterwards (no public or cancel-path revival)", async () => {
    const { deps, cancelDeps, store } = makeEnv();
    const created = await createOrder(deps);
    await handleCancelSession(cancelDeps, cancelRequest("AVT-2026-000123"));
    // The stored session is terminal: a status update from PENDING must fail.
    const session = [...store.sessions.values()][0]!;
    const applied = await store.updateStatus(session.id, "PENDING", "PAID", new Date(), "txn");
    expect(applied).toBe(false);
    expect(created.session_status).toBe("PENDING");
    expect([...store.sessions.values()][0]!.status).toBe("CANCELLED");
  });
});
