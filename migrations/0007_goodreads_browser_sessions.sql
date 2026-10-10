CREATE TABLE goodreads_browser_sessions (
  id TEXT PRIMARY KEY,
  reader_id TEXT NOT NULL REFERENCES readers(id),
  browser_session_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('awaiting_login','exporting','ready','error')),
  csv TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX goodreads_browser_sessions_reader ON goodreads_browser_sessions(reader_id);
