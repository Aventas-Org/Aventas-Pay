-- Optional no-gateway amount-only reconciliation prototype. STAGING ONLY.
--
-- Not part of the live checkout migrations 0001-0003. Do NOT apply in
-- production until merchant, legal/tax, recipient, and release reviews.
-- Neither table can mark an order paid or trigger fulfillment.
--
-- recipient_key is a trusted stable opaque identifier for the *actual*
-- receiving bank account. Different UPI aliases to the same bank account
-- MUST use the same key; rotating displayed payee name is not enough.
--
-- UNIQUE(recipient_key, amount_paise) intentionally prevents reuse for the
-- entire life of the store, including paid/expired/cancelled orders. This
-- safe prototype can exhaust its 99 fractional values per whole-rupee base.
-- Implement a reviewed late-payment/cooling policy before any recycling.

CREATE TABLE IF NOT EXISTS payment_amount_reservations (
  recipient_key     TEXT NOT NULL CHECK (length(recipient_key) BETWEEN 1 AND 128),
  order_id          TEXT NOT NULL CHECK (length(order_id) BETWEEN 1 AND 64),
  base_amount_paise INTEGER NOT NULL CHECK (base_amount_paise > 0 AND base_amount_paise % 100 = 0),
  amount_paise      INTEGER NOT NULL
                         CHECK (amount_paise > base_amount_paise
                                AND amount_paise <= base_amount_paise + 99),
  created_at_ms     INTEGER NOT NULL CHECK (created_at_ms > 0),
  PRIMARY KEY (recipient_key, order_id),
  UNIQUE (recipient_key, amount_paise)
);

CREATE TABLE IF NOT EXISTS payment_email_review_receipts (
  message_key_digest TEXT PRIMARY KEY
                          CHECK (length(message_key_digest) = 64),
  content_digest     TEXT NOT NULL CHECK (length(content_digest) = 64),
  match_reason       TEXT NOT NULL CHECK (match_reason IN (
    'UNUSABLE_EMAIL_AMOUNT', 'NO_MATCH', 'MULTIPLE_MATCHES',
    'NON_PENDING_ORDER', 'SINGLE_POSSIBLE_ORDER',
    'TIME_DATA_MISSING', 'OUTSIDE_PAYMENT_WINDOW'
  )),
  candidate_order_id TEXT,
  observed_at_ms     INTEGER NOT NULL CHECK (observed_at_ms > 0),
  CHECK ((match_reason = 'SINGLE_POSSIBLE_ORDER' AND candidate_order_id IS NOT NULL)
      OR (match_reason <> 'SINGLE_POSSIBLE_ORDER' AND candidate_order_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_payment_email_review_candidate
  ON payment_email_review_receipts (candidate_order_id, observed_at_ms);
