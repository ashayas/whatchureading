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

-- Full-text search over title/author, ranked with FTS5's BM25. External
-- content (content='editions') so the text isn't stored twice; triggers keep
-- it in step with the monthly sync's upserts and deletes. A brand-new or
-- pre-existing table is populated in rowid batches by
-- scripts/openlibrary-fts-build.mjs, since one 'rebuild' over ~22M rows
-- exceeds D1's per-query time limit.
CREATE VIRTUAL TABLE IF NOT EXISTS editions_fts USING fts5(
  title,
  author,
  content='editions',
  tokenize='unicode61 remove_diacritics 2',
  detail=column
);
CREATE TRIGGER IF NOT EXISTS editions_fts_insert AFTER INSERT ON editions BEGIN
  INSERT INTO editions_fts(rowid, title, author) VALUES (new.rowid, new.title, new.author);
END;
CREATE TRIGGER IF NOT EXISTS editions_fts_delete AFTER DELETE ON editions BEGIN
  INSERT INTO editions_fts(editions_fts, rowid, title, author) VALUES ('delete', old.rowid, old.title, old.author);
END;
CREATE TRIGGER IF NOT EXISTS editions_fts_update AFTER UPDATE OF title, author ON editions BEGIN
  INSERT INTO editions_fts(editions_fts, rowid, title, author) VALUES ('delete', old.rowid, old.title, old.author);
  INSERT INTO editions_fts(rowid, title, author) VALUES (new.rowid, new.title, new.author);
END;
