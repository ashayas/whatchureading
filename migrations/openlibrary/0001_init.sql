-- Schema for the owned Open Library edition index (separate D1 database from
-- the app's primary DB). Flattened columns only, never raw Open Library JSON,
-- to keep this well under D1's storage limits. Applied idempotently by both
-- local dev (`wrangler d1 execute --file`) and the monthly sync job, so it
-- must stay plain CREATE/INDEX IF NOT EXISTS rather than a numbered ALTER
-- series.
CREATE TABLE IF NOT EXISTS editions (
  id TEXT PRIMARY KEY,
  work_key TEXT,
  isbn TEXT,
  title TEXT NOT NULL,
  author TEXT,
  pages INTEGER,
  publish_date TEXT,
  cover_id INTEGER,
  fingerprint TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS editions_isbn ON editions(isbn);
CREATE INDEX IF NOT EXISTS editions_work ON editions(work_key);
