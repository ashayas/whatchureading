-- Keep existing reader progress while adding an explicit did-not-finish shelf
-- and space for source dates, including partial and repeated Goodreads dates.
CREATE TABLE library_next (
  reader_id TEXT NOT NULL REFERENCES readers(id),
  book_id TEXT NOT NULL REFERENCES books(id),
  status TEXT NOT NULL CHECK(status IN ('reading','want','read','did-not-finish')),
  page INTEGER NOT NULL DEFAULT 0 CHECK(page >= 0),
  rating INTEGER CHECK(rating BETWEEN 1 AND 5),
  review TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  finished_at TEXT,
  reading_history TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY(reader_id,book_id)
);
INSERT INTO library_next(reader_id,book_id,status,page,rating,review,updated_at,finished_at)
SELECT reader_id,book_id,status,page,rating,review,updated_at,finished_at FROM library;
DROP TABLE library;
ALTER TABLE library_next RENAME TO library;
