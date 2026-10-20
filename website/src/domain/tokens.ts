/**
 * Checkout token derivation, hashing and constant-time comparison.
 *
 * Design note (documented tradeoff):
 *   checkout_token = base64url( HMAC-SHA256( AVENTAS_PAYMENT_TOKEN_SECRET,
 *                                            "avantas-checkout:v1:" + session_id ) )
 *
 * The token is deterministic given (secret, session_id). That determinism is what
 * makes idempotent bot retries safe: when the bot replays a create-session request,
 * the server can re-derive the exact same token for the same session and return the
 * same checkout URL, instead of being unable to re-display a random token whose
 * plaintext was never stored.
 *
 * Security properties:
 *   - 256-bit output from a server-side secret: indistinguishable from random to
 *     any party without the secret; safe as a bearer capability over TLS.
 *   - The database stores only SHA-256(token), so a database leak does not yield
 *     usable tokens for other sessions (the secret is required to derive them).
 *   - Known tradeoff: rotating AVENTAS_PAYMENT_TOKEN_SECRET invalidates outstanding
 *     checkout tokens. Rotation must be a coordinated operation (see DEPLOYMENT doc).
 */

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return new Uint8Array(sig);
}

async function sha256(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return new Uint8Array(digest);
}

/** Derives the public checkout token for a session. Server-side only. */
export async function deriveCheckoutToken(
  tokenSecret: string,
  sessionId: string,
): Promise<string> {
  if (!tokenSecret || tokenSecret.length < 16) {
    throw new Error("token secret must be at least 16 characters");
  }
  const mac = await hmacSha256(tokenSecret, `avantas-checkout:v1:${sessionId}`);
  return toBase64Url(mac);
}

/** SHA-256 of a checkout token, hex encoded. This is what the database stores. */
export async function hashCheckoutToken(token: string): Promise<string> {
  return toHex(await sha256(token));
}

/**
 * Constant-time comparison of two UTF-8 strings. Compares SHA-256 digests so the
 * comparison time does not depend on the length or content of either input.
 */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= (da[i] ?? 0) ^ (db[i] ?? 0);
  return diff === 0;
}

/**
 * Validates the shape of a public token before hashing it, so garbage input never
 * reaches the database. Returns false for anything that cannot be one of ours.
 */
export function looksLikeCheckoutToken(candidate: unknown): candidate is string {
  if (typeof candidate !== "string") return false;
  return /^[A-Za-z0-9_-]{43}$/.test(candidate);
}
