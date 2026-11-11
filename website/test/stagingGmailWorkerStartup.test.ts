import { expect, test } from "bun:test";

test("requested OAuth polling fails before opening storage when credentials are absent", async () => {
  const worker = Bun.spawn([
    process.execPath,
    new URL("../scripts/staging-gmail-review-worker.ts", import.meta.url).pathname,
  ], {
    env: {
      APP_ENV: "staging",
      RAILWAY_ENVIRONMENT_NAME: "staging",
      RAILWAY_VOLUME_MOUNT_PATH: "/data",
      GMAIL_REVIEW_MODE: "oauth",
      GMAIL_REVIEW_ENABLED: "true",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const exitCode = await Promise.race([
      worker.exited,
      Bun.sleep(3000).then(() => { throw new Error("Worker did not reject invalid OAuth mode"); }),
    ]);
    expect(exitCode).toBe(1);
    expect(await new Response(worker.stdout).text()).toBe("");
    expect(await new Response(worker.stderr).text()).toBe("staging_gmail_review_configuration_rejected\n");
  } finally {
    worker.kill();
  }
});
