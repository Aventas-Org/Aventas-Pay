/**
 * End-to-end test server: mounts the REAL checkout handlers over real HTTP
 * with the REAL SQL store, the REAL migration files and the REAL rate limiter.
 * No mocks, no debug shortcuts — the same code paths a Worker deployment runs.
 *
 * Started by bot/tests/test_e2e.py. Prints one JSON line to stdout with the
 * bound port, then serves until killed.
 *
 * Env:
 *   E2E_BOT_SECRET     — server-to-server secret the Python client must send
 *   E2E_TOKEN_SECRET   — checkout token derivation secret
 *   E2E_WEBSITE_BASE   — base URL echoed in checkout_url (default http://127.0.0.1:<port>)
 */

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BunSqliteExecutor } from "../helpers/bunSqlite";
import { SqlSessionStore } from "../../src/adapters/sqlSessionStore";
import { SqlRateLimiter } from "../../src/adapters/sqlRateLimiter";
import { InMemoryRateLimiter } from "../../src/domain/rateLimit";
import { consoleLogger } from "../../src/domain/log";
import { handleCreateSession } from "../../src/handlers/createSession";
import { handleSessionStatus } from "../../src/handlers/sessionStatus";
import { handleCancelSession } from "../../src/handlers/cancelSession";
import { handleVerifySession } from "../../src/handlers/verifySession";
import { HandlerRequest, HandlerResponse } from "../../src/handlers/http";

const BOT_SECRET = process.env.E2E_BOT_SECRET ?? "";
const TOKEN_SECRET = process.env.E2E_TOKEN_SECRET ?? "";
if (!BOT_SECRET || !TOKEN_SECRET) {
  console.error("E2E_BOT_SECRET and E2E_TOKEN_SECRET are required");
  process.exit(1);
}

const db = new Database(":memory:", { create: true });
for (const file of ["0001_checkout_sessions.sql", "0002_rate_limits.sql"]) {
  db.run(readFileSync(join(import.meta.dir, "..", "..", "migrations", file), "utf8"));
}
const executor = new BunSqliteExecutor(db);
const store = new SqlSessionStore(executor);
// Durable limiter like production; fall back to memory if the table is missing.
const limiter = new SqlRateLimiter(executor);
const clock = { now: () => new Date() };

function baseDeps() {
  return { store, clock, limiter, logger: consoleLogger };
}

// Assigned after Bun.serve binds; read lazily inside request handlers.
let boundPort = 0;
function websiteBase(): string {
  return process.env.E2E_WEBSITE_BASE ?? `http://127.0.0.1:${boundPort}`;
}

function toHandlerRequest(req: Request, path: string): HandlerRequest {
  return {
    method: req.method,
    path,
    authorization: req.headers.get("authorization"),
    clientIp:
      (req.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() ||
      "127.0.0.1",
    bodyText: null,
  };
}

async function readBody(req: Request): Promise<string> {
  return req.text();
}

function toResponse(res: HandlerResponse): Response {
  return new Response(res.body, { status: res.status, headers: res.headers });
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "POST" && path === "/api/payments/checkout-sessions") {
      const handlerReq = toHandlerRequest(req, path);
      handlerReq.bodyText = await readBody(req);
      return toResponse(
        await handleCreateSession(
          { ...baseDeps(), botApiSecret: BOT_SECRET, tokenSecret: TOKEN_SECRET, websiteBaseUrl: websiteBase() },
          handlerReq,
        ),
      );
    }

    if (req.method === "POST" && path === "/api/payments/checkout-sessions/verify") {
      const handlerReq = toHandlerRequest(req, path);
      handlerReq.bodyText = await readBody(req);
      return toResponse(
        await handleVerifySession(
          { ...baseDeps(), botApiSecret: BOT_SECRET },
          handlerReq,
        ),
      );
    }

    if (req.method === "POST" && path === "/api/payments/checkout-sessions/cancel") {
      const handlerReq = toHandlerRequest(req, path);
      handlerReq.bodyText = await readBody(req);
      return toResponse(
        await handleCancelSession(
          { ...baseDeps(), botApiSecret: BOT_SECRET, websiteBaseUrl: websiteBase() },
          handlerReq,
        ),
      );
    }

    const statusMatch = path.match(/^\/api\/payments\/checkout-sessions\/([A-Za-z0-9_-]+)$/);
    if (req.method === "GET" && statusMatch) {
      return toResponse(
        await handleSessionStatus(baseDeps(), toHandlerRequest(req, path), statusMatch[1]!),
      );
    }

    // Anything else is genuinely not found — no directory listing, no debug.
    return new Response(
      JSON.stringify({ error: { code: "NOT_FOUND", message: "Not found." } }),
      { status: 404, headers: { "content-type": "application/json" } },
    );
  },
});

boundPort = server.port ?? 0;
console.log(JSON.stringify({ ready: true, port: boundPort }));
