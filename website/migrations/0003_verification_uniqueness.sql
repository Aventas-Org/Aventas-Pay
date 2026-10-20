-- Stage 2 additive migration: one provider receipt may verify at most one
-- session, mirroring the bot's Slice-email Message-ID dedup rule at the
-- database layer as defense in depth.
--
-- STATUS: tested against real SQLite in test/verifySession.test.ts and the
-- cross-system e2e suite (bot/tests/test_e2e.py).

CREATE UNIQUE INDEX IF NOT EXISTS idx_checkout_sessions_provider_ref
  ON checkout_sessions (provider_transaction_ref)
  WHERE provider_transaction_ref IS NOT NULL;
