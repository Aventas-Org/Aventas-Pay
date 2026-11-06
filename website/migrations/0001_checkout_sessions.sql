-- Additive checkout-session migration for Aventas-website D1.
--
-- Timestamps use INTEGER epoch-milliseconds, matching the website schema.
-- Monetary values use integer paise. Apply 0001, 0002, then 0003 to an
-- isolated staging D1 database before enabling checkout there. Provisioning
-- production requires a separate reviewed operator action.
--
-- Design notes:
--   * Monetary values are integer paise (CHECK-validated), never floats.
--   * Discord user id is stored server-side here and is NEVER selected into a
--     public response; the public handler projects an allow-list of columns.
--   * The UPI recipient is snapshotted at creation so a settings change or page
--     reload can never change where a customer is told to pay.
--   * idempotency_key + attempt implements replay-safe creation:
--     UNIQUE(idempotency_key, attempt) rejects concurrent duplicate inserts.
--   * checkout_session_events provides the audit trail required by Stage 1.

CREATE TABLE IF NOT EXISTS checkout_sessions (
  id                       TEXT    PRIMARY KEY,
  order_id                 TEXT    NOT NULL,
  discord_user_id          TEXT    NOT NULL,
  product_id               TEXT    NOT NULL,
  product_name             TEXT    NOT NULL,
  amount_paise             INTEGER NOT NULL CHECK (amount_paise > 0),
  currency                 TEXT    NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  payment_profile_id       TEXT    NOT NULL,
  upi_vpa                  TEXT    NOT NULL,
  upi_display_name         TEXT    NOT NULL,
  status                   TEXT    NOT NULL DEFAULT 'PENDING'
                               CHECK (status IN ('PENDING', 'PAID', 'EXPIRED', 'CANCELLED')),
  idempotency_key          TEXT    NOT NULL,
  attempt                  INTEGER NOT NULL DEFAULT 1,
  -- sha256 hex of the public checkout token; plaintext token is never stored
  token_hash               TEXT    NOT NULL,
  source                   TEXT    NOT NULL DEFAULT 'discord_bot',
  provider_transaction_ref TEXT,
  -- INTEGER epoch-milliseconds, matching the website's existing convention.
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  expires_at               INTEGER NOT NULL,
  paid_at                  INTEGER
);

-- lookup by hashed public token (the plaintext token is never stored)
CREATE UNIQUE INDEX IF NOT EXISTS idx_checkout_sessions_token_hash
  ON checkout_sessions (token_hash);

CREATE UNIQUE INDEX IF NOT EXISTS idx_checkout_sessions_idem
  ON checkout_sessions (idempotency_key, attempt);

CREATE INDEX IF NOT EXISTS idx_checkout_sessions_order
  ON checkout_sessions (order_id, status);

CREATE INDEX IF NOT EXISTS idx_checkout_sessions_expires
  ON checkout_sessions (expires_at);

CREATE TABLE IF NOT EXISTS checkout_session_events (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES checkout_sessions (id),
  event_type  TEXT NOT NULL,
  actor       TEXT    NOT NULL,
  detail      TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_checkout_session_events_session
  ON checkout_session_events (session_id, created_at);
