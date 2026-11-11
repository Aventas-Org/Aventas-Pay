import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { chooseMode } from "../src/services/stagingGmailWorkerCore";

const BASE_ENV = {
  APP_ENV: "staging",
  RAILWAY_ENVIRONMENT_NAME: "staging",
  RAILWAY_VOLUME_MOUNT_PATH: "/data",
  GMAIL_REVIEW_MODE: "oauth",
  GMAIL_REVIEW_ENABLED: "true",
  STAGING_GMAIL_SNAPSHOT_TOKEN: "synthetic-snapshot-token-000000000000000000000000",
};
const OAUTH_ENV = {
  GMAIL_OAUTH_CLIENT_ID: "synthetic-client-id",
  GMAIL_OAUTH_CLIENT_SECRET: "synthetic-client-secret",
  GMAIL_OAUTH_REFRESH_TOKEN: "synthetic-refresh-token",
  GMAIL_MAILBOX_CONNECTION_ID: "synthetic-mailbox",
  GMAIL_CREDIT_ALERT_SENDER: "alerts@example.test",
};

test.each([
  ["missing credentials", {}],
  ["empty client ID", { ...OAUTH_ENV, GMAIL_OAUTH_CLIENT_ID: "" }],
  ["short client secret", { ...OAUTH_ENV, GMAIL_OAUTH_CLIENT_SECRET: "short" }],
  ["empty refresh token", { ...OAUTH_ENV, GMAIL_OAUTH_REFRESH_TOKEN: "" }],
  ["invalid sender", { ...OAUTH_ENV, GMAIL_CREDIT_ALERT_SENDER: "invalid" }],
  ["invalid mailbox ID", { ...OAUTH_ENV, GMAIL_MAILBOX_CONNECTION_ID: "invalid/mailbox" }],
] as const)("requested OAuth mode rejects %s before opening storage", async (_, credentials) => {
  const worker = Bun.spawn([
    process.execPath,
    fileURLToPath(new URL("../scripts/staging-gmail-review-worker.ts", import.meta.url)),
  ], {
    env: { ...BASE_ENV, ...credentials },
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

test("valid OAuth configuration keeps the requested polling mode", () => {
  expect(chooseMode({ ...BASE_ENV, ...OAUTH_ENV })).toBe("oauth");
});
