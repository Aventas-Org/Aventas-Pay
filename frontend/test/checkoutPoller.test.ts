import { describe, expect, test } from "bun:test";
import {
  DEFAULT_POLLER_CONFIG,
  nextDelayMs,
  parseSnapshot,
  shouldStop,
  startPolling,
  PollOutcome,
} from "../src/lib/checkoutPoller";

const FUTURE = "2099-10-20T10:30:00Z";

describe("nextDelayMs", () => {
  const cfg = { ...DEFAULT_POLLER_CONFIG, baseIntervalMs: 1000, maxIntervalMs: 8000 };

  test("base interval when no failures", () => {
    expect(nextDelayMs(0, cfg)).toBe(1000);
  });

  test("exponential growth with jitter bounds, capped at max", () => {
    for (let failures = 1; failures <= 10; failures++) {
      const d = nextDelayMs(failures, cfg, failures);
      const uncapped = Math.min(1000 * 2 ** failures, 8000);
      expect(d).toBeGreaterThanOrEqual(Math.floor(uncapped * 0.8));
      expect(d).toBeLessThanOrEqual(Math.ceil(uncapped * 1.5));
    }
    expect(nextDelayMs(20, cfg, 1)).toBeLessThanOrEqual(12000);
  });
});

describe("shouldStop", () => {
  test("terminal statuses stop polling", () => {
    for (const status of ["PAID", "EXPIRED", "CANCELLED"] as const) {
      expect(shouldStop({ status, expires_at: FUTURE }, Date.now())).toEqual({
        stop: true,
        reason: "terminal_status",
      });
    }
  });

  test("pending before expiry keeps polling", () => {
    expect(shouldStop({ status: "PENDING", expires_at: FUTURE }, Date.now())).toEqual({
      stop: false,
      reason: null,
    });
  });

  test("pending at or past expiry stops as expired", () => {
    const expiry = Date.parse(FUTURE);
    expect(shouldStop({ status: "PENDING", expires_at: FUTURE }, expiry).reason).toBe("expired");
    expect(shouldStop({ status: "PENDING", expires_at: FUTURE }, expiry + 1).reason).toBe(
      "expired",
    );
  });

  test("unparseable expiry does not stop a pending session prematurely", () => {
    expect(shouldStop({ status: "PENDING", expires_at: "not-a-date" }, Date.now()).stop).toBe(
      false,
    );
  });
});

describe("parseSnapshot", () => {
  test("accepts a valid payload", () => {
    expect(parseSnapshot({ status: "PENDING", expires_at: FUTURE })).toEqual({
      status: "PENDING",
      expires_at: FUTURE,
    });
  });

  test.each([
    [null],
    ["string"],
    [{}],
    [{ status: "PENDING" }],
    [{ status: "MAYBE", expires_at: FUTURE }],
    [{ status: "PENDING", expires_at: "garbage" }],
    [{ status: 5, expires_at: FUTURE }],
  ])("rejects malformed payload %p", (payload) => {
    expect(parseSnapshot(payload)).toBeNull();
  });
});

describe("startPolling", () => {
  /** Deterministic manual scheduler; macrotask yields let async ticks settle. */
  function makeScheduler() {
    const queue: Array<{ fn: () => void; ms: number }> = [];
    const settle = () => new Promise((r) => setTimeout(r, 0));
    return {
      schedule: (fn: () => void, ms: number) => {
        queue.push({ fn, ms });
        return queue.length;
      },
      cancel: () => {
        queue.length = 0;
      },
      async flush(max = 50) {
        let steps = 0;
        // Let the initial in-flight tick reach its schedule() call.
        await settle();
        while (queue.length && steps < max) {
          const item = queue.shift()!;
          item.fn();
          await settle();
          steps++;
        }
      },
      pending: () => queue.length,
    };
  }

  const instantConfig = { ...DEFAULT_POLLER_CONFIG, baseIntervalMs: 1, maxIntervalMs: 2 };

  test("stops on the first terminal status and does not reschedule", async () => {
    const scheduler = makeScheduler();
    let calls = 0;
    const controller = startPolling(
      async () => {
        calls += 1;
        return { status: "PAID", expires_at: FUTURE };
      },
      { schedule: scheduler.schedule, cancel: scheduler.cancel },
      instantConfig,
    );
    await scheduler.flush();
    expect(calls).toBe(1);
    expect(controller.state().stopped).toBe(true);
    expect(controller.state().stopReason).toBe("terminal_status");
    expect(scheduler.pending()).toBe(0);
  });

  test("keeps polling while PENDING, then stops at terminal", async () => {
    const scheduler = makeScheduler();
    let calls = 0;
    const controller = startPolling(
      async () => {
        calls += 1;
        return { status: calls < 3 ? "PENDING" : "EXPIRED", expires_at: FUTURE };
      },
      { schedule: scheduler.schedule, cancel: scheduler.cancel },
      instantConfig,
    );
    await scheduler.flush();
    expect(calls).toBe(3);
    expect(controller.state().stopReason).toBe("terminal_status");
  });

  test("stops as expired when the wall clock passes expires_at", async () => {
    const scheduler = makeScheduler();
    let nowMs = Date.parse("2026-10-20T10:00:00Z");
    let calls = 0;
    const controller = startPolling(
      async () => {
        calls += 1;
        nowMs += 3600_000; // each poll advances the clock past expiry
        return { status: "PENDING", expires_at: "2026-10-20T10:30:00Z" };
      },
      { schedule: scheduler.schedule, cancel: scheduler.cancel, now: () => nowMs },
      instantConfig,
    );
    await scheduler.flush();
    expect(controller.state().stopReason).toBe("expired");
    expect(calls).toBe(1);
  });

  test("backs off on failures and stops after maxConsecutiveFailures", async () => {
    const scheduler = makeScheduler();
    let calls = 0;
    const controller = startPolling(
      async () => {
        calls += 1;
        throw new Error("network down");
      },
      { schedule: scheduler.schedule, cancel: scheduler.cancel },
      { ...instantConfig, maxConsecutiveFailures: 3 },
    );
    await scheduler.flush();
    expect(calls).toBe(3);
    expect(controller.state().stopReason).toBe("too_many_failures");
    expect(controller.state().consecutiveFailures).toBe(3);
  });

  test("a timeout counts as a failure outcome", async () => {
    const scheduler = makeScheduler();
    const controller = startPolling(
      () =>
        new Promise((_resolve, reject) => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        }),
      { schedule: scheduler.schedule, cancel: scheduler.cancel },
      { ...instantConfig, maxConsecutiveFailures: 2 },
    );
    await scheduler.flush();
    const state = controller.state();
    expect(state.stopReason).toBe("too_many_failures");
    expect((state.lastOutcome as PollOutcome & { reason: string }).reason).toBe("timeout");
  });

  test("malformed payloads count as failures", async () => {
    const scheduler = makeScheduler();
    const controller = startPolling(
      async () => ({ unexpected: "shape" }),
      { schedule: scheduler.schedule, cancel: scheduler.cancel },
      { ...instantConfig, maxConsecutiveFailures: 2 },
    );
    await scheduler.flush();
    expect(controller.state().stopReason).toBe("too_many_failures");
    expect(controller.state().lastOutcome).toEqual({ kind: "error", reason: "malformed" });
  });

  test("manual stop halts scheduling", async () => {
    const scheduler = makeScheduler();
    let calls = 0;
    const controller = startPolling(
      async () => {
        calls += 1;
        return { status: "PENDING", expires_at: FUTURE };
      },
      { schedule: scheduler.schedule, cancel: scheduler.cancel },
      instantConfig,
    );
    await scheduler.flush(1);
    const callsBeforeStop = calls;
    controller.stop();
    expect(controller.state().stopped).toBe(true);
    expect(scheduler.pending()).toBe(0);
    await scheduler.flush();
    // No further fetches may start once stopped.
    expect(calls).toBe(callsBeforeStop);
  });

  test("failure streak resets after a success", async () => {
    const scheduler = makeScheduler();
    let calls = 0;
    const controller = startPolling(
      async () => {
        calls += 1;
        if (calls % 2 === 1) throw new Error("flaky");
        return { status: "PENDING", expires_at: FUTURE };
      },
      { schedule: scheduler.schedule, cancel: scheduler.cancel },
      { ...instantConfig, maxConsecutiveFailures: 3 },
    );
    await scheduler.flush(6);
    // Alternating failure/success must never trip the consecutive cap.
    expect(controller.state().stopped).toBe(false);
    expect(calls).toBeGreaterThanOrEqual(4);
    controller.stop();
  });
});
