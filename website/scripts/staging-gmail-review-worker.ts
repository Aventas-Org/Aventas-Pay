/** Private Railway staging worker entrypoint; deliberately not bundled into a public API. */
import { chooseMode, openReviewDb, reviewTick, POLL_MS } from "../src/services/stagingGmailWorkerCore";

async function runForever(): Promise<void> {
  const env = process.env;
  if (env.APP_ENV !== "staging" || env.RAILWAY_ENVIRONMENT_NAME !== "staging") {
    console.error("staging_gmail_review_environment_rejected");
    process.exitCode = 1;
    return;
  }
  const mode = chooseMode(env);
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
  try {
    while (!stopped) {
      cycles += 1;
      try {
        const result = await reviewTick(executor, env, startedAtMs, Date.now());
        // Log only counts; no bodies, account IDs, access tokens or transaction refs.
        if (cycles === 1 || result.queued > 0 || cycles % 30 === 0) {
          console.info(JSON.stringify({
            event: "staging_gmail_review_tick", ...result, cycles,
          }));
        }
      } catch {
        // Do not expose upstream error bodies, OAuth secrets or credit evidence.
        console.error("staging_gmail_review_tick_unavailable");
      }
      if (!stopped) await Bun.sleep(POLL_MS);
    }
  } finally {
    database.close();
    console.info("staging_gmail_review_stopped");
  }
}

if (import.meta.main) await runForever();
