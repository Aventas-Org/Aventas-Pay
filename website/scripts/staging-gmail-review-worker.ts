/** Private Railway staging worker entrypoint; deliberately not bundled into a public API. */
import { chooseMode, openReviewDb, reviewTick, POLL_MS } from "../src/services/stagingGmailWorkerCore";

/** Run the private worker with one active tick and capped retry delays. */
async function runForever(): Promise<void> {
  const env = process.env;
  if (env.APP_ENV !== "staging" || env.RAILWAY_ENVIRONMENT_NAME !== "staging") {
    console.error("staging_gmail_review_environment_rejected");
    process.exitCode = 1;
    return;
  }
  const mode = chooseMode(env);
  if (mode === "disabled" && (env.GMAIL_REVIEW_MODE ?? "disabled") !== "disabled") {
    console.error("staging_gmail_review_configuration_rejected");
    process.exitCode = 1;
    return;
  }
  // No access to Gmail or bank in disabled/synthetic mode.
  if (mode === "oauth" && env.RAILWAY_VOLUME_MOUNT_PATH !== "/data") {
    console.error("staging_gmail_review_durable_volume_required");
    process.exitCode = 1;
    return;
  }
  const { executor, database } = openReviewDb();
  const startedAtMs = Date.now();
  let stopped = false;
  process.on("SIGTERM", () => { stopped = true; });
  process.on("SIGINT", () => { stopped = true; });
  console.info(JSON.stringify({
    event: "staging_gmail_review_started", mode,
    intervalSeconds: POLL_MS / 1000, paymentVerified: false, canFulfill: false,
  }));
  let cycles = 0;
  let consecutiveFailures = 0;
  try {
    while (!stopped) {
      cycles += 1;
      try {
        const result = await reviewTick(executor, env, startedAtMs, Date.now());
        consecutiveFailures = 0;
        // Log only counts; no bodies, account IDs, access tokens or transaction refs.
        if (cycles === 1 || result.queued > 0 || cycles % 30 === 0) {
          console.info(JSON.stringify({
            event: "staging_gmail_review_tick", ...result, cycles,
          }));
        }
      } catch (error) {
        consecutiveFailures += 1;
        // Expose only known operational errors, never upstream details.
        console.error(error instanceof Error && error.message === "GMAIL_REVIEW_BACKLOG"
          ? "staging_gmail_review_backlog_detected"
          : error instanceof Error && error.message === "GMAIL_REVIEW_CURSOR_REJECTED"
            ? "staging_gmail_review_cursor_restarted"
            : "staging_gmail_review_tick_unavailable");
      }
      if (!stopped) await Bun.sleep(POLL_MS * 2 ** Math.min(consecutiveFailures, 3));
    }
  } finally {
    database.close();
    console.info("staging_gmail_review_stopped");
  }
}

if (import.meta.main) await runForever();
