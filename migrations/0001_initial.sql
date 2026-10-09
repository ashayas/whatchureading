PRAGMA foreign_keys = ON;
CREATE TABLE books (id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL, genre TEXT NOT NULL, pages INTEGER NOT NULL CHECK(pages > 0), rating REAL NOT NULL, isbn TEXT, color TEXT NOT NULL, friend_count INTEGER NOT NULL DEFAULT 0, description TEXT NOT NULL);
CREATE TABLE readers (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT 'Reader', goal INTEGER NOT NULL DEFAULT 24 CHECK(goal BETWEEN 1 AND 500), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE library (reader_id TEXT NOT NULL REFERENCES readers(id), book_id TEXT NOT NULL REFERENCES books(id), status TEXT NOT NULL CHECK(status IN ('reading','want','read')), page INTEGER NOT NULL DEFAULT 0 CHECK(page >= 0), rating INTEGER CHECK(rating BETWEEN 1 AND 5), review TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at TEXT, PRIMARY KEY(reader_id,book_id));
CREATE TABLE notes (id TEXT PRIMARY KEY, reader_id TEXT NOT NULL REFERENCES readers(id), book_id TEXT NOT NULL REFERENCES books(id), page INTEGER NOT NULL CHECK(page >= 0), body TEXT NOT NULL, spoiler INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX notes_reader_book ON notes(reader_id,book_id,page);
CREATE TABLE swipes (reader_id TEXT NOT NULL REFERENCES readers(id), book_id TEXT NOT NULL REFERENCES books(id), action TEXT NOT NULL CHECK(action IN ('skip','want','read')), PRIMARY KEY(reader_id,book_id));
CREATE TABLE likes (reader_id TEXT NOT NULL REFERENCES readers(id), activity_id TEXT NOT NULL, PRIMARY KEY(reader_id,activity_id));
