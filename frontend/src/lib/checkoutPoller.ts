/**
 * Checkout status poller.
 *
 * Pure, framework-agnostic state machine so the behaviour that matters —
 * backoff, request timeouts, terminal-state stop, expiry stop, visibility
 * pause — is unit-testable without a DOM. React (or anything else) wires it to
 * real timers and AbortController in `browserPoller`.
 */

export type CheckoutStatus = "PENDING" | "PAID" | "EXPIRED" | "CANCELLED";

export interface StatusSnapshot {
  status: CheckoutStatus;
  expires_at: string;
}

export interface PollerConfig {
  /** Interval between successful polls. */
  baseIntervalMs: number;
  /** Cap for the exponential backoff after failures. */
  maxIntervalMs: number;
  /** Per-request timeout; slow responses count as failures. */
  requestTimeoutMs: number;
  /** Stop polling when this many consecutive failures occur. */
  maxConsecutiveFailures: number;
}

export const DEFAULT_POLLER_CONFIG: PollerConfig = {
  baseIntervalMs: 5000,
  maxIntervalMs: 60000,
  requestTimeoutMs: 8000,
  maxConsecutiveFailures: 8,
};

export const TERMINAL_STATUSES: ReadonlySet<CheckoutStatus> = new Set([
  "PAID",
  "EXPIRED",
  "CANCELLED",
]);

export type PollOutcome =
  | { kind: "ok"; snapshot: StatusSnapshot }
  | { kind: "error"; reason: "timeout" | "http" | "network" | "malformed" };

export interface PollerState {
  /** No further polls will occur. */
  stopped: boolean;
  consecutiveFailures: number;
  lastOutcome: PollOutcome | null;
  /** Why polling stopped, once it has. */
  stopReason: "terminal_status" | "expired" | "too_many_failures" | null;
}

/**
 * Delay before the next poll given the current failure streak.
 * 0 failures -> base interval; each failure doubles up to the cap, with
 * deterministic ±20% jitter derived from the attempt count (test-friendly).
 */
export function nextDelayMs(
  consecutiveFailures: number,
  config: PollerConfig = DEFAULT_POLLER_CONFIG,
  attempt = 0,
): number {
  if (consecutiveFailures <= 0) return config.baseIntervalMs;
  const exponential = config.baseIntervalMs * 2 ** consecutiveFailures;
  const capped = Math.min(exponential, config.maxIntervalMs);
  const jitter = 0.8 + 0.4 * (((attempt * 2654435761) % 1000) / 1000);
  return Math.round(capped * jitter);
}

/** True when the snapshot ends polling (terminal status or wall-clock expiry). */
export function shouldStop(
  snapshot: StatusSnapshot,
  nowMs: number,
): { stop: boolean; reason: "terminal_status" | "expired" | null } {
  if (TERMINAL_STATUSES.has(snapshot.status)) return { stop: true, reason: "terminal_status" };
  const expiryMs = Date.parse(snapshot.expires_at);
  if (!Number.isNaN(expiryMs) && nowMs >= expiryMs) return { stop: true, reason: "expired" };
  return { stop: false, reason: null };
}

/**
 * Validates the wire shape; anything else is a malformed outcome.
 *
 * On success the FULL payload is returned (structurally a StatusSnapshot), so
 * renderers keep every field the server sent (order ref, product, amount, UPI
 * details, qr payload) — only `status` and `expires_at` are inspected here.
 */
export function parseSnapshot(payload: unknown): StatusSnapshot | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const status = p.status;
  const expiresAt = p.expires_at;
  if (
    typeof status !== "string" ||
    !["PENDING", "PAID", "EXPIRED", "CANCELLED"].includes(status)
  ) {
    return null;
  }
  if (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt))) return null;
  return payload as StatusSnapshot;
}

export interface PollerCallbacks {
  /** Called after every poll attempt with the merged state. */
  onState?: (state: PollerState) => void;
  /** Called when polling stops for a non-error reason. */
  onStop?: (reason: NonNullable<PollerState["stopReason"]>) => void;
  /** Injected for tests; defaults to setTimeout. */
  schedule?: (fn: () => void, ms: number) => unknown;
  /** Injected for tests; defaults to clearTimeout. */
  cancel?: (handle: unknown) => void;
  now?: () => number;
}

/**
 * Runs the polling loop. `fetchSnapshot` must honour the abort signal for the
 * request-timeout behaviour to apply in real environments.
 */
export function startPolling(
  fetchSnapshot: (signal: AbortSignal) => Promise<unknown>,
  callbacks: PollerCallbacks = {},
  config: PollerConfig = DEFAULT_POLLER_CONFIG,
): { stop: () => void; state: () => PollerState } {
  const schedule = callbacks.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = callbacks.cancel ?? ((h) => clearTimeout(h as never));
  const now = callbacks.now ?? (() => Date.now());

  const state: PollerState = {
    stopped: false,
    consecutiveFailures: 0,
    lastOutcome: null,
    stopReason: null,
  };
  let timerHandle: unknown = null;
  let inflight: AbortController | null = null;
  let attempt = 0;

  const emit = () => callbacks.onState?.({ ...state });

  const finish = (reason: NonNullable<PollerState["stopReason"]>) => {
    state.stopped = true;
    state.stopReason = reason;
    inflight?.abort();
    emit();
    callbacks.onStop?.(reason);
  };

  const tick = async () => {
    if (state.stopped) return;
    inflight = new AbortController();
    const timeoutId = setTimeout(() => inflight?.abort(), config.requestTimeoutMs);
    let outcome: PollOutcome;
    try {
      const payload = await fetchSnapshot(inflight.signal);
      const snapshot = parseSnapshot(payload);
      outcome = snapshot
        ? { kind: "ok", snapshot }
        : { kind: "error", reason: "malformed" };
    } catch (err) {
      const aborted = (err as { name?: string })?.name === "AbortError";
      outcome = { kind: "error", reason: aborted ? "timeout" : "network" };
    } finally {
      clearTimeout(timeoutId);
      inflight = null;
    }

    state.lastOutcome = outcome;
    attempt += 1;

    if (outcome.kind === "ok") {
      state.consecutiveFailures = 0;
      const decision = shouldStop(outcome.snapshot, now());
      if (decision.stop && decision.reason) {
        finish(decision.reason);
        return;
      }
    } else {
      state.consecutiveFailures += 1;
      if (state.consecutiveFailures >= config.maxConsecutiveFailures) {
        finish("too_many_failures");
        return;
      }
    }

    emit();
    timerHandle = schedule(() => void tick(), nextDelayMs(state.consecutiveFailures, config, attempt));
  };

  void tick();

  return {
    stop: () => {
      if (state.stopped) return;
      state.stopped = true;
      inflight?.abort();
      if (timerHandle !== null) cancel(timerHandle);
      emit();
    },
    state: () => ({ ...state }),
  };
}
