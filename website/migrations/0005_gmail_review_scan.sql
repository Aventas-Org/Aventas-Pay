-- Railway's private SQLite evidence database. No payment authority is stored.
CREATE TABLE IF NOT EXISTS gmail_review_scan (
  mailbox_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  after_sec INTEGER NOT NULL CHECK (after_sec > 0),
  before_sec INTEGER CHECK (before_sec > after_sec),
  page_token TEXT CHECK (before_sec IS NOT NULL OR page_token IS NULL),
  PRIMARY KEY (mailbox_id, sender)
);
