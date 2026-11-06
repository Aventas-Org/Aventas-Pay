// AventasPay - Unified Payment Server
// Provides full HTTP API:
// - Checkout sessions (/api/payments/checkout-sessions)
// - Status polling (/api/payments/checkout-sessions/:token)
// - Verification (/api/payments/checkout-sessions/verify)
// - Cancellation (/api/payments/checkout-sessions/cancel)
// - Direct order create & status (/api/payments/create, /v1/payments/create)
// - Slice email simulation (/api/simulator/slice-email, /internal/simulate/slice-email)
// - Health check (/health)
// Zero-dependency HTTP server that runs natively on Node.js and Bun.

import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleCreateSession } from './handlers/createSession.ts';
import type { CreateSessionDeps } from './handlers/createSession.ts';
import { handleSessionStatus } from './handlers/sessionStatus.ts';
import { handleCancelSession } from './handlers/cancelSession.ts';
import { handleVerifySession } from './handlers/verifySession.ts';
import type { HandlerRequest, HandlerResponse } from './handlers/http.ts';
import { InMemorySessionStore } from '../test/helpers/memoryStore.ts';
import { InMemoryRateLimiter } from './domain/rateLimit.ts';
import { consoleLogger } from './domain/log.ts';
import { orderService } from './services/order.service.ts';
import { paymentService } from './services/payment/payment.service.ts';
import { gmailWorker } from './services/worker/gmailWorker.ts';
import { productService } from './services/product.service.ts';
import { db } from './services/database/client.ts';
import { sqlite } from './services/database/sqlite.ts';
import { getActiveUpiConfig, findAccountsConfigPath } from './config/accounts.ts';
import { status_bucket } from './domain/statusBucket.ts';
import { loginLockoutManager } from './config/security.ts';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Auto-load .env if available
try {
  if (typeof (process as any).loadEnvFile === 'function') {
    const envPaths = [
      path.resolve(process.cwd(), '.env'),
      path.resolve(process.cwd(), '../.env'),
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env'),
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env'),
    ];
    for (const p of envPaths) {
      if (fs.existsSync(p)) {
        (process as any).loadEnvFile(p);
        break;
      }
    }
  }
} catch {}

const BOT_SECRET = process.env.BOT_SECRET || process.env.E2E_BOT_SECRET || 'bot-secret-at-least-16-characters';
const TOKEN_SECRET = process.env.TOKEN_SECRET || process.env.E2E_TOKEN_SECRET || 'token-secret-at-least-16-chars';
const PORT = Number(process.env.PORT || 4000);

const DEMO_MODE = process.env.DEMO_MODE === 'true';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');

// Rule 2: Refuse to start if PUBLIC_BASE_URL is unset when DEMO_MODE is false
const isMainScript = Boolean(
  process.argv[1] &&
  (
    path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase() ||
    process.argv[1].endsWith('server.ts') ||
    process.argv[1].endsWith('server.js')
  )
);

if (isMainScript && !DEMO_MODE && !PUBLIC_BASE_URL) {
  console.error('\n[FATAL ERROR: PUBLIC_BASE_URL REQUIRED]');
  console.error('The PUBLIC_BASE_URL environment variable must be set in production mode (DEMO_MODE is not true).');
  console.error('Example: PUBLIC_BASE_URL=https://pay.yourdomain.com');
  console.error('Or run with DEMO_MODE=true for local simulation.\n');
  process.exit(1);
}

export const EFFECTIVE_BASE_URL = PUBLIC_BASE_URL || process.env.WEBSITE_BASE_URL || `http://127.0.0.1:${PORT}`;

// In-memory or shared session store & rate limiter
const sessionStore = new InMemorySessionStore();
const rateLimiter = new InMemoryRateLimiter();
const clock = { now: () => new Date() };

function getBaseDeps(): CreateSessionDeps {
  return {
    store: sessionStore,
    clock,
    limiter: rateLimiter,
    botApiSecret: BOT_SECRET,
    tokenSecret: TOKEN_SECRET,
    websiteBaseUrl: EFFECTIVE_BASE_URL,
    logger: consoleLogger,
  };
}

function toHandlerRequest(req: IncomingMessage, body: string, path: string): HandlerRequest {
  const clientIp =
    ((req.headers['x-forwarded-for'] as string) ?? '').split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    '127.0.0.1';

  return {
    method: req.method || 'GET',
    path,
    authorization: req.headers['authorization'] || null,
    clientIp,
    bodyText: body || null,
  };
}

function sendResponse(res: ServerResponse, status: number, headers: Record<string, string>, body: string | Buffer) {
  res.writeHead(status, {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end(body);
}

function getFrontendDistPath(): string | null {
  const currentDir = typeof __dirname !== 'undefined'
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));

  const candidates = [
    path.resolve(process.cwd(), 'frontend', 'dist'),
    path.resolve(process.cwd(), '..', 'frontend', 'dist'),
    path.resolve(currentDir, '..', '..', '..', 'frontend', 'dist'),
    path.resolve(currentDir, '..', '..', 'frontend', 'dist'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** ADMIN_SECRET_KEY env (if set) wins over the stored key: lets you recover a forgotten key by restarting. */
function currentAdminKey(): string | null {
  const envKey = (process.env.ADMIN_SECRET_KEY ?? '').trim();
  return envKey || sqlite.getSetting('admin_secret_key') || null;
}

function checkAdminAuth(req: IncomingMessage): boolean {
  const secretKey = currentAdminKey();
  // Fail closed: with no key configured nobody is an admin.
  if (!secretKey) return false;

  const adminKeyHeader = req.headers['x-admin-key'];
  if (typeof adminKeyHeader === 'string' && adminKeyHeader && safeEqual(adminKeyHeader, secretKey)) {
    return true;
  }
  const authHeader = req.headers['authorization'];
  if (typeof authHeader === 'string') {
    const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (bearer && safeEqual(bearer, secretKey)) return true;
  }
  return false;
}

/**
 * The ONE place that decides which bucket an order is in. Every admin page reads these
 * values, so the cards, donut, tabs and Manual Review counter can never disagree.
 * Precedence: success > review (open manual-review ticket) > pending / expired / failed.
 */
function orderBucketFn(rawDb: any): (o: any, now: Date) => ReturnType<typeof status_bucket> {
  const inReview = new Set<string>(
    (rawDb.prepare("SELECT orderId FROM manual_reviews WHERE status = 'Pending'").all() as any[]).map((r) => r.orderId)
  );
  return (o, now) => {
    const b = status_bucket(o, now);
    return b !== 'success' && inReview.has(o.id) ? 'review' : b;
  };
}

function jsonResponse(res: ServerResponse, status: number, payload: unknown) {
  return sendResponse(res, status, { 'Content-Type': 'application/json' }, JSON.stringify(payload));
}

function unauthorized(res: ServerResponse) {
  return jsonResponse(res, 401, { error: 'UNAUTHORIZED', message: 'Valid Admin Secret Key required' });
}

const IST = 'Asia/Kolkata';
/** YYYY-MM-DD of an instant in India time (the store's business day). */
function istDay(d: Date | string | number): string {
  return new Date(d).toLocaleDateString('en-CA', { timeZone: IST });
}
/** 0-23 hour of an instant in India time. */
function istHour(d: Date | string | number): number {
  return Number(new Date(d).toLocaleString('en-GB', { timeZone: IST, hour: '2-digit', hour12: false })) % 24;
}

export function createUnifiedServer() {
  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // 1. CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-key');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const host = req.headers.host || `localhost:${PORT}`;
    const url = new URL(req.url || '/', `http://${host}`);
    const pathname = url.pathname;

    let bodyRaw = '';
    req.on('data', (chunk) => {
      bodyRaw += chunk;
    });

    req.on('end', async () => {
      try {
        const rawDb = sqlite.getRawDb();
        // HEALTH CHECK
        if (req.method === 'GET' && pathname === '/health') {
          return sendResponse(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({ status: 'ok', service: 'AventasPay' }));
        }

        // ADMIN AUTHENTICATION GATE
        if (pathname.startsWith('/api/admin/') && pathname !== '/api/admin/auth/verify') {
          if (!checkAdminAuth(req)) {
            return sendResponse(
              res,
              401,
              { 'Content-Type': 'application/json' },
              JSON.stringify({ error: 'UNAUTHORIZED', message: 'Valid Admin Secret Key required' })
            );
          }
        }

        // ADMIN AUTH VERIFY: POST /api/admin/auth/verify (Rule 8: Login lockout)
        if (req.method === 'POST' && pathname === '/api/admin/auth/verify') {
          const clientIp =
            ((req.headers['x-forwarded-for'] as string) ?? '').split(',')[0]?.trim() ||
            req.socket.remoteAddress ||
            '127.0.0.1';

          if (loginLockoutManager.isLocked(clientIp)) {
            console.warn(`[Security] Blocked login attempt from locked IP ${clientIp}`);
            return sendResponse(
              res,
              401,
              { 'Content-Type': 'application/json' },
              JSON.stringify({ valid: false, error: 'Invalid secret key' })
            );
          }

          const body = JSON.parse(bodyRaw || '{}');
          const currentKey = currentAdminKey();
          if (body.secretKey && currentKey && safeEqual(String(body.secretKey).trim(), currentKey)) {
            loginLockoutManager.recordSuccess(clientIp);
            return sendResponse(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({ valid: true }));
          }

          const lockoutState = loginLockoutManager.recordFailure(clientIp);
          console.warn(`[Security] Failed admin login attempt from ${clientIp}. Attempts remaining: ${lockoutState.attemptsLeft}`);
          return sendResponse(
            res,
            401,
            { 'Content-Type': 'application/json' },
            JSON.stringify({ valid: false, error: 'Invalid secret key' })
          );
        }

        // 1. CHECKOUT SESSION CREATE: POST /api/payments/checkout-sessions
        if (req.method === 'POST' && pathname === '/api/payments/checkout-sessions') {
          const handlerReq = toHandlerRequest(req, bodyRaw, pathname);
          const response = await handleCreateSession(getBaseDeps(), handlerReq);

          // If session was created, sync with order service for decimal offset matching
          if (response.status === 201 || response.status === 200) {
            try {
              const parsedRes = JSON.parse(response.body);
              const parsedBody = JSON.parse(bodyRaw || '{}');
              const amountPaise = parsedBody.amount_paise || 100;
              const baseAmount = Math.floor(amountPaise / 100);
              const decimalOffset = amountPaise % 100;

              // Store order record in db client so slice email ingestion can match
              await db.order.create({
                data: {
                  id: parsedRes.order_ref,
                  amount: amountPaise / 100,
                  baseAmount,
                  decimalOffset,
                  currency: parsedBody.currency || 'INR',
                  status: 'PENDING',
                  expiresAt: new Date(parsedRes.expires_at),
                  token: parsedRes.checkout_token,
                },
              });
            } catch (syncErr) {
              console.warn('[Sync] Non-critical: session sync to order table:', syncErr);
            }
          }

          return sendResponse(res, response.status, response.headers, response.body);
        }

        // 2. CHECKOUT SESSION VERIFY: POST /api/payments/checkout-sessions/verify
        if (req.method === 'POST' && pathname === '/api/payments/checkout-sessions/verify') {
          const handlerReq = toHandlerRequest(req, bodyRaw, pathname);
          const response = await handleVerifySession({ ...getBaseDeps(), botApiSecret: BOT_SECRET }, handlerReq);
          return sendResponse(res, response.status, response.headers, response.body);
        }

        // 3. CHECKOUT SESSION CANCEL: POST /api/payments/checkout-sessions/cancel
        if (req.method === 'POST' && pathname === '/api/payments/checkout-sessions/cancel') {
          const handlerReq = toHandlerRequest(req, bodyRaw, pathname);
          const response = await handleCancelSession(getBaseDeps(), handlerReq);
          return sendResponse(res, response.status, response.headers, response.body);
        }

        // 4. CHECKOUT SESSION STATUS: GET /api/payments/checkout-sessions/:token
        const sessionMatch = pathname.match(/^\/api\/payments\/checkout-sessions\/([A-Za-z0-9_-]+)$/);
        if (req.method === 'GET' && sessionMatch && sessionMatch[1]) {
          const token = sessionMatch[1];
          const handlerReq = toHandlerRequest(req, bodyRaw, pathname);
          const response = await handleSessionStatus(getBaseDeps(), handlerReq, token);
          return sendResponse(res, response.status, response.headers, response.body);
        }

        // 5. DIRECT ORDER CREATION: POST /v1/payments/create or POST /api/payments/create
        if (req.method === 'POST' && (pathname === '/v1/payments/create' || pathname === '/api/payments/create')) {
          const body = JSON.parse(bodyRaw || '{}');
          const baseAmount = body.baseAmount || body.amount;

          if (!baseAmount || typeof baseAmount !== 'number' || baseAmount <= 0) {
            return sendResponse(
              res,
              400,
              { 'Content-Type': 'application/json' },
              JSON.stringify({ error: 'BAD_REQUEST', message: 'Field "amount" or "baseAmount" must be a positive number' })
            );
          }

          const order = await orderService.createOrder({
            baseAmount,
            currency: body.currency || 'INR',
            productName: body.product_name || body.productName || 'Direct UPI Payment',
            redirectUrl: body.redirectUrl || body.redirect_url || '',
          });

          let finalOrderResponse: unknown = order;
          // Also create matching checkout session so /checkout/:token UI can display it
          try {
            const amountPaise = Math.round(order.amount * 100);
            const activeUpi = getActiveUpiConfig();
            const sessionPayload = JSON.stringify({
              order_id: order.paymentId,
              discord_user_id: 'guest_user',
              product_id: 'product_direct',
              product_name: body.product_name || `Direct Payment (₹${order.amount})`,
              amount_paise: amountPaise,
              currency: 'INR',
              payment_profile_id: String(activeUpi.id),
              upi: {
                vpa: activeUpi.upiId,
                display_name: 'Aventas Pay',
              },
              idempotency_key: `create:${order.paymentId}`,
              ttl_seconds: 600,
            });

            const sessionReq: HandlerRequest = {
              method: 'POST',
              path: '/api/payments/checkout-sessions',
              authorization: `Bearer ${BOT_SECRET}`,
              clientIp: '127.0.0.1',
              bodyText: sessionPayload,
            };

            const sessionRes = await handleCreateSession(getBaseDeps(), sessionReq);
            if (sessionRes.status === 201 || sessionRes.status === 200) {
              const sessionData = JSON.parse(sessionRes.body);
              finalOrderResponse = {
                ...order,
                checkoutUrl: sessionData.checkout_url,
                checkoutToken: sessionData.checkout_token,
              };
            }
          } catch (sessionErr) {
            console.warn('[Server] Direct create session link warning:', sessionErr);
          }

          return sendResponse(res, 201, { 'Content-Type': 'application/json' }, JSON.stringify(finalOrderResponse));
        }

        // 6. DIRECT ORDER STATUS: GET /v1/payments/:id or GET /api/payments/:id
        const orderMatch = pathname.match(/^\/(?:v1|api)\/payments\/([^/]+)$/);
        if (req.method === 'GET' && orderMatch && orderMatch[1]) {
          const paymentId = orderMatch[1];
          const order = await orderService.getOrder(paymentId);
          if (!order) {
            return sendResponse(
              res,
              404,
              { 'Content-Type': 'application/json' },
              JSON.stringify({ error: 'NOT_FOUND', message: `Payment '${paymentId}' not found` })
            );
          }
          return sendResponse(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify(order));
        }

        // 7. SIMULATOR: POST /api/simulator/slice-email or /internal/simulate/slice-email
        if (
          req.method === 'POST' &&
          (pathname === '/api/simulator/slice-email' || pathname === '/internal/simulate/slice-email')
        ) {
          // This endpoint fabricates a "payment received" email, so it must never be
          // reachable by the public. Only in DEMO_MODE, or with a valid admin key.
          if (!DEMO_MODE && !checkAdminAuth(req)) return unauthorized(res);
          const body = JSON.parse(bodyRaw || '{}');
          const { senderName = 'Rahul Sharma', amount, rrn } = body;
          const parsedAmount = typeof amount === 'number' ? amount : parseFloat(amount);
          const uniqueRrn = rrn || String(Math.floor(100000000000 + Math.random() * 900000000000));
          const gmailMessageId = `sim_msg_${Math.random().toString(36).substring(2, 12)}`;

          const rawEmail = {
            gmailMessageId,
            from: 'noreply@slice.bank.in',
            subject: `Received ₹${parsedAmount.toFixed(2)} from ${senderName}`,
            body: `Hi Team,\nYou have received a payment via UPI.\n\nAmount: ₹${parsedAmount.toFixed(2)}\nSender: ${senderName}\nUPI Ref No / RRN: ${uniqueRrn}\nDate: ${new Date().toISOString()}\n\nThank you for banking with Slice.\nSlice Bank Team`,
            dateHeader: new Date().toUTCString(),
            internalDate: Date.now(),
          };

          const result = await paymentService.ingestSliceEmail(rawEmail);

          // If matched and confirmed, also update any website checkout session with that order id
          if (result.confirmed && result.matchedOrder) {
            try {
              const verifyReq: HandlerRequest = {
                method: 'POST',
                path: '/api/payments/checkout-sessions/verify',
                authorization: `Bearer ${BOT_SECRET}`,
                clientIp: '127.0.0.1',
                bodyText: JSON.stringify({
                  order_id: result.matchedOrder.id,
                  provider_transaction_ref: uniqueRrn,
                }),
              };
              await handleVerifySession({ ...getBaseDeps(), botApiSecret: BOT_SECRET }, verifyReq);
            } catch (vErr) {
              console.warn('[Simulator] Notice updating checkout session verify:', vErr);
            }
          }

          return sendResponse(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify(result));
        }

        // 8. PRODUCTS API
        if (req.method === 'GET' && pathname === '/api/products') {
          const products = await productService.getProducts();
          return sendResponse(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify(products));
        }

        const productDetailMatch = pathname.match(/^\/api\/products\/([^/]+)$/);
        if (req.method === 'GET' && productDetailMatch && productDetailMatch[1]) {
          const product = await productService.getProduct(productDetailMatch[1]);
          if (!product) {
            return sendResponse(res, 404, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'Product not found' }));
          }
          return sendResponse(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify(product));
        }

        if (req.method === 'POST' && pathname === '/api/products') {
          if (!checkAdminAuth(req)) return unauthorized(res);
          const body = JSON.parse(bodyRaw || '{}');
          if (!body.name || !body.baseAmount) {
            return sendResponse(res, 400, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'name and baseAmount are required' }));
          }
          const product = await productService.createProduct(body);
          return sendResponse(res, 201, { 'Content-Type': 'application/json' }, JSON.stringify(product));
        }

        if (req.method === 'DELETE' && productDetailMatch && productDetailMatch[1]) {
          if (!checkAdminAuth(req)) return unauthorized(res);
          const deleted = await productService.deleteProduct(productDetailMatch[1]);
          return sendResponse(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({ success: deleted }));
        }

        // 9. ADMIN API OVERVIEW (Rule 3: status_bucket & Rule 5: strict revenue from success only)
        if (req.method === 'GET' && pathname === '/api/admin/overview') {
          const allOrders = await db.order.findMany({ orderBy: { createdAt: 'desc' } });
          const allPayments = await db.incomingPayment.findMany({ orderBy: { receivedAt: 'desc' } });

          const now = new Date();
          const bucketOf = orderBucketFn(rawDb);
          const todayKey = istDay(now);

          let revenueToday = 0;
          let totalRevenue = 0;
          let successfulCount = 0;
          let pendingCount = 0;
          let failedCount = 0;
          let expiredCount = 0;
          let reviewCount = 0;

          for (const ord of allOrders) {
            const bucket = bucketOf(ord, now);
            if (bucket === 'success') {
              successfulCount++;
              totalRevenue += ord.amount;
              const paidWhen = ord.paidAt || ord.createdAt;
              if (paidWhen && istDay(paidWhen) === todayKey) {
                revenueToday += ord.amount;
              }
            } else if (bucket === 'pending') {
              pendingCount++;
            } else if (bucket === 'expired') {
              expiredCount++;
            } else if (bucket === 'review') {
              reviewCount++;
            } else {
              failedCount++;
            }
          }

          const formattedOrders = allOrders.map((o) => {
            const bucket = bucketOf(o, now);
            return {
              id: o.id,
              orderId: o.id,
              paymentId: o.id,
              amount: o.amount,
              expected: o.baseAmount,
              customer: o.senderName || 'UPI Customer',
              utr: o.rrn || '—',
              source: 'Slice UPI',
              status: bucket,
              statusBucket: bucket,
              createdAt: o.createdAt ? new Date(o.createdAt).toISOString() : null,
              expiresAt: o.expiresAt ? new Date(o.expiresAt).toISOString() : null,
              paidAt: o.paidAt ? new Date(o.paidAt).toISOString() : null,
              time: o.createdAt ? new Date(o.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—',
              expires: o.expiresAt ? new Date(o.expiresAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—',
              confirmed: '—',
            };
          });

          // Derive recent payments from incoming_payments OR successful orders if incoming payments table is empty
          const paymentsToFormat = allPayments.length > 0 ? allPayments : allOrders.filter(o => status_bucket(o, now) === 'success' || (o.rrn && o.rrn !== '—')).map(o => ({
            id: `pay_${o.id}`,
            matchedOrderId: o.id,
            amount: o.amount,
            senderName: o.senderName || 'Verified Payer',
            rrn: o.rrn,
            status: 'VERIFIED',
            receivedAt: o.paidAt || o.createdAt,
            gmailMessageId: `msg_${o.id}`,
          }));

          const formattedPayments = paymentsToFormat.map((p: any) => {
            const bucket = status_bucket(p, now);
            return {
              id: p.id,
              orderId: p.matchedOrderId || p.id || '—',
              amount: p.amount,
              customer: p.senderName || 'Verified Payer',
              utr: p.rrn || '—',
              source: 'Slice UPI',
              status: bucket,
              statusBucket: bucket,
              createdAt: p.receivedAt ? new Date(p.receivedAt).toISOString() : null,
              receivedAt: p.receivedAt ? new Date(p.receivedAt).toISOString() : null,
              time: p.receivedAt ? new Date(p.receivedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—',
              confirmed: '—',
              email: p.gmailMessageId,
            };
          });

          const activeConfig = getActiveUpiConfig();

          const overview = {
            revenueToday,
            totalRevenue,
            totalOrders: allOrders.length,
            successfulCount,
            pendingCount,
            failedCount: failedCount + expiredCount,
            expiredCount,
            reviewCount,
            recentOrders: formattedOrders.slice(0, 10),
            recentPayments: formattedPayments.slice(0, 10),
            systemStatus: [
              { name: 'Email Listener', val: 'Online (Every 5s)' },
              { name: 'Payment Parser', val: 'Online (Slice Bank)' },
              { name: 'Webhook Service', val: 'Online' },
              { name: 'Database', val: 'Healthy (Persistent)' },
              { name: 'Gmail Watcher', val: `Active (${activeConfig.upiId})` },
            ],
          };

          return sendResponse(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify(overview));
        }

        // 10. ADMIN ORDERS LIST (Rule 3: status_bucket)
        if (req.method === 'GET' && pathname === '/api/admin/orders') {
          const allOrders = await db.order.findMany({ orderBy: { createdAt: 'desc' } });
          const now = new Date();
          const bucketOf = orderBucketFn(rawDb);
          const formatted = allOrders.map((o) => {
            const bucket = bucketOf(o, now);
            return {
              id: o.id,
              orderId: o.id,
              paymentId: o.id,
              amount: o.amount,
              expected: o.baseAmount,
              customer: o.senderName || 'UPI Customer',
              utr: o.rrn || '—',
              source: 'Slice UPI',
              status: bucket,
              statusBucket: bucket,
              createdAt: o.createdAt ? new Date(o.createdAt).toISOString() : null,
              expiresAt: o.expiresAt ? new Date(o.expiresAt).toISOString() : null,
              paidAt: o.paidAt ? new Date(o.paidAt).toISOString() : null,
              time: o.createdAt ? new Date(o.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—',
              expires: o.expiresAt ? new Date(o.expiresAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—',
              confirmed: '—',
            };
          });
          return sendResponse(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify(formatted));
        }

        // 11. ADMIN TRANSACTIONS LIST (Rule 3: status_bucket)
        if (req.method === 'GET' && pathname === '/api/admin/transactions') {
          const allPayments = await db.incomingPayment.findMany({ orderBy: { receivedAt: 'desc' } });
          const allOrders = await db.order.findMany({ orderBy: { createdAt: 'desc' } });
          const now = new Date();

          // If incomingPayment is empty, use confirmed orders so transactions page is populated
          const sourceList = allPayments.length > 0 ? allPayments : allOrders.filter(o => status_bucket(o, now) === 'success' || (o.rrn && o.rrn !== '—')).map(o => ({
            id: `pay_${o.id}`,
            matchedOrderId: o.id,
            amount: o.amount,
            senderName: o.senderName || 'Verified Payer',
            rrn: o.rrn,
            status: 'VERIFIED',
            receivedAt: o.paidAt || o.createdAt,
            gmailMessageId: `msg_${o.id}`,
          }));

          const formatted = sourceList.map((p: any) => {
            const bucket = status_bucket(p, now);
            return {
              id: p.id,
              orderId: p.matchedOrderId || p.id || '—',
              amount: p.amount,
              customer: p.senderName || 'Verified Payer',
              utr: p.rrn || '—',
              source: 'Slice UPI',
              status: bucket,
              statusBucket: bucket,
              createdAt: p.receivedAt ? new Date(p.receivedAt).toISOString() : null,
              receivedAt: p.receivedAt ? new Date(p.receivedAt).toISOString() : null,
              time: p.receivedAt ? new Date(p.receivedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—',
              confirmed: '—',
              email: p.gmailMessageId,
            };
          });
          return sendResponse(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify(formatted));
        }

        // 12. ADMIN EMAILS LIST
        if (req.method === 'GET' && pathname === '/api/admin/emails') {
          const allPayments = await db.incomingPayment.findMany({ orderBy: { receivedAt: 'desc' } });
          const formatted = allPayments.map((p, idx) => ({
            id: idx + 1,
            subject: `Received ₹${p.amount.toFixed(2)} from ${p.senderName || 'Customer'} via UPI`,
            from: 'noreply@slice.bank.in',
            amount: p.amount,
            status: p.status === 'VERIFIED' ? 'Matched' : p.status === 'DUPLICATE' ? 'Duplicate' : 'Unmatched',
            read: true,
            receivedAt: p.receivedAt ? new Date(p.receivedAt).toISOString() : null,
            time: p.receivedAt ? new Date(p.receivedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—',
            utr: p.rrn,
            sender: p.senderName || 'Slice User',
            gmailMessageId: p.gmailMessageId,
          }));
          return sendResponse(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify(formatted));
        }

        // 13. ADMIN MANUAL SYNC TRIGGER: POST /api/admin/sync-now
        if (req.method === 'POST' && pathname === '/api/admin/sync-now') {
          const tickResult = await gmailWorker.tick();
          return sendResponse(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({
            success: true,
            processedCount: tickResult.processedCount,
            expiredCount: tickResult.expiredCount,
            intervalSeconds: 5,
          }));
        }

        // 14. ADMIN SETTINGS API: GET & POST /api/admin/settings
        if (req.method === 'GET' && pathname === '/api/admin/settings') {
          const config = getActiveUpiConfig();
          let currentAccounts: any = null;
          try {
            const configPath = findAccountsConfigPath();
            if (configPath && fs.existsSync(configPath)) {
              currentAccounts = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            }
          } catch {}

          const secEmail = currentAccounts?.account_2?.email || sqlite.getSetting('secondary_email', '');
          const secAppPass = currentAccounts?.account_2?.app_password || sqlite.getSetting('secondary_app_password', '');
          const secUpi = currentAccounts?.account_2?.upi_id || sqlite.getSetting('secondary_upi_id', '');

          return sendResponse(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({
            activeProfileId: config.id,
            upiId: config.upiId,
            email: config.email,
            appPassword: config.appPassword ? '••••••••••••••••' : '',
            maxDecimal: config.maxDecimal,
            pollIntervalSeconds: config.pollIntervalSeconds || 5,
            hasAdminSecretKey: Boolean(sqlite.getSetting('admin_secret_key')),
            discordWebhookUrl: sqlite.getSetting('discord_webhook_url'),
            secondaryEmail: secEmail,
            secondaryAppPassword: secAppPass ? '••••••••••••••••' : '',
            secondaryUpiId: secUpi,
            platformName: sqlite.getSetting('platform_name', 'AventasPay'),
            supportEmail: sqlite.getSetting('support_email', 'support@aventaspay.com'),
            systemTimezone: sqlite.getSetting('system_timezone', 'Asia/Kolkata (UTC+05:30)'),
            settlementCurrency: sqlite.getSetting('settlement_currency', 'INR (₹)'),
            paymentTtlMinutes: sqlite.getSetting('payment_ttl_minutes', '10'),
            notificationsEmailAlerts: sqlite.getSetting('notifications_email_alerts') !== 'false',
            notificationsPaymentAlerts: sqlite.getSetting('notifications_payment_alerts') !== 'false',
            notificationsTimeoutAlerts: sqlite.getSetting('notifications_timeout_alerts') !== 'false',
            allowDbReset: process.env.ALLOW_DB_RESET === 'true',
            publicBaseUrl: EFFECTIVE_BASE_URL,
            paymentMethods: [
              { id: 'slice', name: 'Slice Bank UPI', active: true, status: 'Online (Pure TLS IMAP)' },
            ],
          }));
        }

        if (req.method === 'POST' && pathname === '/api/admin/settings') {
          const body = JSON.parse(bodyRaw || '{}');
          try {
            const configPath = findAccountsConfigPath();
            if (configPath && fs.existsSync(configPath)) {
              const current = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
              if (body.upiId) current.account_1.upi_id = body.upiId;
              if (body.email) current.account_1.email = body.email;
              if (body.appPassword && !body.appPassword.includes('••••')) {
                current.account_1.app_password = body.appPassword;
              }
              if (body.pollIntervalSeconds) current.poll_interval_seconds = parseInt(body.pollIntervalSeconds, 10);
              if (body.maxDecimal) current.max_decimal_offset = parseInt(body.maxDecimal, 10);

              if (!current.account_2) {
                current.account_2 = { email: '', app_password: '', upi_id: '' };
              }
              if (body.secondaryEmail !== undefined) current.account_2.email = body.secondaryEmail;
              if (body.secondaryAppPassword !== undefined && !body.secondaryAppPassword.includes('••••')) {
                current.account_2.app_password = body.secondaryAppPassword;
              }
              if (body.secondaryUpiId !== undefined) current.account_2.upi_id = body.secondaryUpiId;

              fs.writeFileSync(configPath, JSON.stringify(current, null, 2), 'utf-8');
            }
          } catch (cfgErr) {
            console.warn('[Admin Settings] Could not write config file:', cfgErr);
          }

          if (body.discordWebhookUrl !== undefined) sqlite.setSetting('discord_webhook_url', body.discordWebhookUrl);
          if (body.secondaryEmail !== undefined) sqlite.setSetting('secondary_email', body.secondaryEmail);
          if (body.secondaryAppPassword !== undefined && !body.secondaryAppPassword.includes('••••')) {
            sqlite.setSetting('secondary_app_password', body.secondaryAppPassword);
          }
          if (body.secondaryUpiId !== undefined) sqlite.setSetting('secondary_upi_id', body.secondaryUpiId);

          if (body.platformName !== undefined) sqlite.setSetting('platform_name', String(body.platformName).trim());
          if (body.supportEmail !== undefined) sqlite.setSetting('support_email', String(body.supportEmail).trim());
          if (body.systemTimezone !== undefined) sqlite.setSetting('system_timezone', String(body.systemTimezone).trim());
          if (body.settlementCurrency !== undefined) sqlite.setSetting('settlement_currency', String(body.settlementCurrency).trim());
          if (body.paymentTtlMinutes !== undefined) sqlite.setSetting('payment_ttl_minutes', String(body.paymentTtlMinutes).trim());

          if (body.notificationsEmailAlerts !== undefined) sqlite.setSetting('notifications_email_alerts', String(body.notificationsEmailAlerts));
          if (body.notificationsPaymentAlerts !== undefined) sqlite.setSetting('notifications_payment_alerts', String(body.notificationsPaymentAlerts));
          if (body.notificationsTimeoutAlerts !== undefined) sqlite.setSetting('notifications_timeout_alerts', String(body.notificationsTimeoutAlerts));

          return sendResponse(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({ success: true }));
        }

        // 14b. ADMIN UPDATE SECRET KEY: POST /api/admin/settings/secret-key
        if (req.method === 'POST' && pathname === '/api/admin/settings/secret-key') {
          const body = JSON.parse(bodyRaw || '{}');
          const newKey = String(body.newKey || '').trim();
          if (!newKey || newKey.length < 6) {
            return sendResponse(res, 400, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'Secret key must be at least 6 characters' }));
          }
          sqlite.setSetting('admin_secret_key', newKey);
          console.log('[Admin] Admin secret key updated.');
          return sendResponse(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({ success: true, message: 'Admin secret key updated successfully' }));
        }

        // 14c. ADMIN CLEAR DATABASE: POST /api/admin/database/clear (Rule 9)
        if (req.method === 'POST' && pathname === '/api/admin/database/clear') {
          const allowReset = process.env.ALLOW_DB_RESET === 'true';
          if (!allowReset) {
            return sendResponse(res, 403, { 'Content-Type': 'application/json' }, JSON.stringify({
              error: 'Database reset is disabled by server security policy. ALLOW_DB_RESET must be true.'
            }));
          }

          const adminKey = req.headers['x-admin-key'];
          const activeKey = sqlite.getSetting('admin_secret_key');
          if (!adminKey || adminKey !== activeKey) {
            return sendResponse(res, 401, { 'Content-Type': 'application/json' }, JSON.stringify({
              error: 'Unauthorized: Invalid admin secret key'
            }));
          }

          sqlite.wipeDatabase(true);
          console.log('[Admin] Database cleared by authorized admin request.');
          return sendResponse(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({
            success: true,
            message: 'Database wiped clean successfully. Only 1 Rs demo product retained.'
          }));
        }

        // 14d. REAL ADMIN ANALYTICS: GET /api/admin/analytics?range=Today|7D|30D|90D|custom&from=YYYY-MM-DD&to=YYYY-MM-DD
        // Revenue is grouped by the day the payment was VERIFIED (India time), using the same
        // status_bucket() as every other page, so charts and cards can never disagree.
        if (req.method === 'GET' && pathname === '/api/admin/analytics') {
          const rangeRaw = String(url.searchParams.get('range') || '7D').toLowerCase();
          const now = new Date();
          const DAY = 24 * 60 * 60 * 1000;
          const fmtLabel = (key: string) =>
            new Date(`${key}T12:00:00+05:30`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: IST });

          // Build the list of buckets for the requested range
          type Slot = { d: string; revenue: number; payments: number; failed: number };
          let slots: Slot[] = [];
          let slotOf: (when: Date | string) => number = () => -1;

          if (rangeRaw === 'today') {
            const todayKey = istDay(now);
            slots = Array.from({ length: 8 }, (_, i) => {
              const h = i * 3;
              const label = `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'a' : 'p'}`;
              return { d: label, revenue: 0, payments: 0, failed: 0 };
            });
            slotOf = (when) => (istDay(when) === todayKey ? Math.floor(istHour(when) / 3) : -1);
          } else {
            let days = rangeRaw === '30d' ? 30 : rangeRaw === '90d' ? 90 : 7;
            let endKey = istDay(now);
            if (rangeRaw === 'custom') {
              const from = url.searchParams.get('from') || '';
              const to = url.searchParams.get('to') || '';
              if (/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to) {
                endKey = to;
                days = Math.min(120, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY) + 1);
              } else {
                days = 30;
              }
            }
            const endMs = Date.parse(`${endKey}T00:00:00Z`);
            const keys: string[] = [];
            for (let i = days - 1; i >= 0; i--) keys.push(new Date(endMs - i * DAY).toISOString().slice(0, 10));
            slots = keys.map((k) => ({ d: fmtLabel(k), revenue: 0, payments: 0, failed: 0 }));
            const index = new Map(keys.map((k, i) => [k, i]));
            slotOf = (when) => index.get(istDay(when)) ?? -1;
          }

          const allOrders = await db.order.findMany({ orderBy: { createdAt: 'desc' } });
          const bucketOf = orderBucketFn(rawDb);
          const counts = { total: 0, success: 0, pending: 0, review: 0, closed: 0 };
          let totalRevenue = 0;

          for (const o of allOrders) {
            const bucket = bucketOf(o, now);
            const when = bucket === 'success' ? (o.paidAt || o.createdAt) : o.createdAt;
            const idx = when ? slotOf(when) : -1;
            if (idx < 0) continue;
            counts.total++;
            if (bucket === 'success') {
              counts.success++;
              totalRevenue += o.amount;
              slots[idx].revenue += o.amount;
              slots[idx].payments += 1;
            } else if (bucket === 'pending') {
              counts.pending++;
            } else if (bucket === 'review') {
              counts.review++;
            } else {
              counts.closed++;
              slots[idx].failed += 1;
            }
          }

          const round2 = (n: number) => Math.round(n * 100) / 100;
          return sendResponse(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({
            range: rangeRaw,
            totalRevenue: round2(totalRevenue),
            totalOrders: counts.total,
            successOrders: counts.success,
            pendingOrders: counts.pending,
            reviewOrders: counts.review,
            failedOrders: counts.closed,
            successRate: `${counts.total > 0 ? ((counts.success / counts.total) * 100).toFixed(1) : '0.0'}%`,
            // Not measured yet: the confirmation latency is not stored, so do not invent one.
            avgConfirmation: null,
            revenueSeries: slots.map((x) => ({ ...x, revenue: round2(x.revenue) })),
            sources: [{ name: 'Slice Bank UPI', value: counts.success, color: '#22c55e' }],
          }));
        }

        // 15. ADMIN REFUNDS: GET /api/admin/refunds
        if (req.method === 'GET' && pathname === '/api/admin/refunds') {
          const rows = rawDb.prepare('SELECT * FROM refunds ORDER BY createdAt DESC').all();
          return sendResponse(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify(rows));
        }

        // 16. ADMIN REFUNDS CREATE: POST /api/admin/refunds/create
        if (req.method === 'POST' && pathname === '/api/admin/refunds/create') {
          const body = JSON.parse(bodyRaw || '{}');
          const id = `REF-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;
          const now = new Date().toISOString();
          rawDb.prepare(`
            INSERT INTO refunds (id, orderId, amount, reason, customer, method, status, debitUtr, createdAt, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            id,
            body.orderId || 'ORD-DIRECT',
            parseFloat(body.amount) || 0,
            body.reason || 'Customer requested refund',
            body.customer || 'Customer',
            body.method || 'Slice UPI',
            'Pending',
            null,
            now,
            body.notes || ''
          );
          const created = rawDb.prepare('SELECT * FROM refunds WHERE id = ?').get(id);
          return sendResponse(res, 201, { 'Content-Type': 'application/json' }, JSON.stringify(created));
        }

        // 17. ADMIN REFUNDS CONFIRM WITH DEBIT UTR: POST /api/admin/refunds/confirm
        if (req.method === 'POST' && pathname === '/api/admin/refunds/confirm') {
          const body = JSON.parse(bodyRaw || '{}');
          const { refundId, debitUtr, notes } = body;
          if (!debitUtr || !String(debitUtr).trim()) {
            return sendResponse(res, 400, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'Debit UTR is required to confirm refund with bank mail' }));
          }
          const cleanUtr = String(debitUtr).trim();
          const now = new Date().toISOString();
          const ref = rawDb.prepare('SELECT * FROM refunds WHERE id = ?').get(refundId);
          if (!ref) {
            return sendResponse(res, 404, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'Refund record not found' }));
          }

          rawDb.prepare(`
            INSERT OR IGNORE INTO debited_emails (id, gmailMessageId, amount, utr, recipientName, subject, body, receivedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            `deb_${Date.now()}`,
            `deb_msg_${Date.now()}`,
            ref.amount,
            cleanUtr,
            ref.customer,
            `₹${Number(ref.amount).toFixed(2)} debited from your Slice account`,
            `Refund transfer of ₹${Number(ref.amount).toFixed(2)} processed to ${ref.customer}. UTR: ${cleanUtr}.`,
            now
          );

          rawDb.prepare(`
            UPDATE refunds SET status = 'Processed', debitUtr = ?, processedAt = ?, notes = ?
            WHERE id = ?
          `).run(cleanUtr, now, notes || `Confirmed with debit UTR ${cleanUtr}`, refundId);

          const updated = rawDb.prepare('SELECT * FROM refunds WHERE id = ?').get(refundId);
          return sendResponse(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({ success: true, refund: updated }));
        }

        // 17b. ADMIN REFUNDS CANCEL: POST /api/admin/refunds/cancel
        if (req.method === 'POST' && pathname === '/api/admin/refunds/cancel') {
          const body = JSON.parse(bodyRaw || '{}');
          const { refundId, reason } = body;
          const now = new Date().toISOString();
          rawDb.prepare(`
            UPDATE refunds SET status = 'Failed', notes = ?, processedAt = ? WHERE id = ?
          `).run(reason || 'Cancelled by admin', now, refundId);
          const updated = rawDb.prepare('SELECT * FROM refunds WHERE id = ?').get(refundId);
          return sendResponse(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({ success: true, refund: updated }));
        }

        // 18. ADMIN MANUAL REVIEWS: GET /api/admin/manual-reviews
        if (req.method === 'GET' && pathname === '/api/admin/manual-reviews') {
          const rows = rawDb.prepare('SELECT * FROM manual_reviews ORDER BY updatedAt DESC').all();
          const formatted = (rows || []).map((r: any) => ({
            ...r,
            createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
            time: r.createdAt ? new Date(r.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—',
          }));
          return sendResponse(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify(formatted));
        }

        // 19. CHAT START: POST /api/chat/start
        if (req.method === 'POST' && pathname === '/api/chat/start') {
          const body = JSON.parse(bodyRaw || '{}');
          const { orderId, customerName = 'Customer', amount = 0 } = body;
          const existing = rawDb.prepare('SELECT * FROM manual_reviews WHERE orderId = ?').get(orderId);
          const now = new Date().toISOString();
          let reviewId = existing?.id;
          if (!existing) {
            reviewId = `REV-${Date.now()}`;
            rawDb.prepare(`
              INSERT INTO manual_reviews (id, orderId, customerName, amount, expected, issue, priority, status, createdAt, updatedAt)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              reviewId,
              orderId,
              customerName,
              amount,
              amount,
              'Payment Timeout / Customer Contact',
              'High',
              'Pending',
              now,
              now
            );
            rawDb.prepare(`
              INSERT INTO chat_messages (id, orderId, sender, message, createdAt)
              VALUES (?, ?, ?, ?, ?)
            `).run(
              `msg_${Date.now()}`,
              orderId,
              'system',
              'Support ticket initiated. Please tell us your payment details or UTR number below.',
              now
            );
          }
          return sendResponse(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({ reviewId, orderId }));
        }

        // 20. CHAT MESSAGES GET: GET /api/chat/:orderId/messages
        const chatGetMatch = pathname.match(/^\/api\/chat\/([^/]+)\/messages$/);
        if (req.method === 'GET' && chatGetMatch && chatGetMatch[1]) {
          const orderId = chatGetMatch[1];
          const messages = rawDb.prepare('SELECT * FROM chat_messages WHERE orderId = ? ORDER BY createdAt ASC').all(orderId);
          return sendResponse(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify(messages));
        }

        // 21. CHAT MESSAGES POST: POST /api/chat/:orderId/messages
        if (req.method === 'POST' && chatGetMatch && chatGetMatch[1]) {
          const orderId = chatGetMatch[1];
          const body = JSON.parse(bodyRaw || '{}');
          const { sender = 'customer', message } = body;
          if (typeof message !== 'string' || !message.trim()) {
            return sendResponse(res, 400, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'Message cannot be empty' }));
          }
          if (message.length > 2000) {
            return sendResponse(res, 400, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'Message too long' }));
          }
          if (!['customer', 'admin', 'system'].includes(sender)) {
            return sendResponse(res, 400, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'Invalid sender' }));
          }
          // A customer must not be able to post as support or as the system.
          if (sender !== 'customer' && !checkAdminAuth(req)) return unauthorized(res);
          const now = new Date().toISOString();
          const id = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
          rawDb.prepare(`
            INSERT INTO chat_messages (id, orderId, sender, message, createdAt)
            VALUES (?, ?, ?, ?, ?)
          `).run(id, orderId, sender, message.trim(), now);

          rawDb.prepare(`
            UPDATE manual_reviews SET updatedAt = ? WHERE orderId = ?
          `).run(now, orderId);

          const created = rawDb.prepare('SELECT * FROM chat_messages WHERE id = ?').get(id);
          return sendResponse(res, 201, { 'Content-Type': 'application/json' }, JSON.stringify(created));
        }

        // 22. ADMIN MANUAL REVIEW APPROVE & MATCH: POST /api/admin/manual-reviews/approve
        if (req.method === 'POST' && pathname === '/api/admin/manual-reviews/approve') {
          const body = JSON.parse(bodyRaw || '{}');
          const { orderId, utr, adminNotes } = body;
          if (!utr || !String(utr).trim()) {
            return sendResponse(res, 400, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'UTR number is required to approve and match payment' }));
          }
          const cleanUtr = String(utr).trim();
          const now = new Date().toISOString();

          // 1. Update order status in orders table to SUCCESS (Rule 6: explicit manual review approval)
          rawDb.prepare(`
            UPDATE orders SET status = 'SUCCESS', rrn = ?, paidAt = ? WHERE id = ? OR paymentId = ?
          `).run(cleanUtr, now, orderId, orderId);

          // 1b. Update incoming payment status if present
          try {
            rawDb.prepare(`
              UPDATE incoming_payments SET status = 'VERIFIED', matchedOrderId = ? WHERE rrn = ?
            `).run(orderId, cleanUtr);
          } catch {}

          // 2. Update manual_reviews status to Resolved
          rawDb.prepare(`
            UPDATE manual_reviews SET status = 'Resolved', reportedUtr = ?, adminNotes = ?, updatedAt = ? WHERE orderId = ?
          `).run(cleanUtr, adminNotes || 'Approved by admin', now, orderId);

          // 3. Post confirmation message in chat
          rawDb.prepare(`
            INSERT INTO chat_messages (id, orderId, sender, message, createdAt)
            VALUES (?, ?, ?, ?, ?)
          `).run(
            `msg_${Date.now()}`,
            orderId,
            'system',
            `✓ Payment approved and verified by admin! Confirmed UTR: ${cleanUtr}. Order is now complete.`,
            now
          );

          return sendResponse(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({ success: true, orderId, utr: cleanUtr }));
        }

        // 23. FRONTEND STATIC ASSETS & SPA ROUTE SERVING
        const distDir = getFrontendDistPath();
        if (req.method === 'GET' && distDir) {
          const sanitizedPath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
          const filePath = path.join(distDir, sanitizedPath);

          // If the exact static file exists (e.g. assets/*.js, css, images)
          if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            const ext = path.extname(filePath).toLowerCase();
            const mimeTypes: Record<string, string> = {
              '.html': 'text/html; charset=utf-8',
              '.js': 'application/javascript; charset=utf-8',
              '.css': 'text/css; charset=utf-8',
              '.json': 'application/json; charset=utf-8',
              '.png': 'image/png',
              '.jpg': 'image/jpeg',
              '.svg': 'image/svg+xml',
              '.ico': 'image/x-icon',
              '.woff': 'font/woff',
              '.woff2': 'font/woff2',
            };
            const contentType = mimeTypes[ext] || 'application/octet-stream';
            const fileContent = fs.readFileSync(filePath);
            return sendResponse(res, 200, { 'Content-Type': contentType }, fileContent);
          }

          // If SPA route (e.g. /, /products, /orders, /pay/:id, /embed/:id, /checkout/:token)
          const indexHtml = path.join(distDir, 'index.html');
          if (!pathname.startsWith('/api/') && !pathname.startsWith('/v1/') && fs.existsSync(indexHtml)) {
            const htmlContent = fs.readFileSync(indexHtml, 'utf-8');
            const htmlHeaders: Record<string, string> = { 'Content-Type': 'text/html; charset=utf-8' };
            // The admin console and customer pages must not be framed by other sites;
            // only the /embed/ checkout is designed to be iframed on merchant pages.
            if (!pathname.startsWith('/embed/')) {
              htmlHeaders['X-Frame-Options'] = 'DENY';
              htmlHeaders['Content-Security-Policy'] = "frame-ancestors 'none'";
            }
            return sendResponse(res, 200, htmlHeaders, htmlContent);
          }
        }

        // 16. 404
        return sendResponse(
          res,
          404,
          { 'Content-Type': 'application/json' },
          JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found.' } })
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Internal Server Error';
        console.error('[UnifiedServer] Error:', err);
        return sendResponse(res, 500, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'INTERNAL_ERROR', message: msg }));
      }
    });
  });

  return server;
}

const isMain = Boolean(
  process.argv[1] &&
  (
    path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase() ||
    process.argv[1].endsWith('server.ts') ||
    process.argv[1].endsWith('server.js')
  )
);

if (isMain) {
  const server = createUnifiedServer();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[AventasPay] Running on http://localhost:${PORT}`);
    console.log(`  Checkout API:      POST /api/payments/checkout-sessions`);
    console.log(`  Status Poller:     GET  /api/payments/checkout-sessions/:token`);
    console.log(`  Verify Session:    POST /api/payments/checkout-sessions/verify`);
    console.log(`  Direct Payments:   POST /api/payments/create`);
    console.log(`  Simulator:         POST /api/simulator/slice-email`);
    console.log(`  Health Check:      GET  /health`);

    if (process.env.GMAIL_WORKER_ENABLED === 'true') {
      gmailWorker.start();
    }
  });
}
