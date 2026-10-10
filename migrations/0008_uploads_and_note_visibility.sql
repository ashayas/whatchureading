ALTER TABLE books ADD COLUMN kind TEXT NOT NULL DEFAULT 'catalog';
ALTER TABLE books ADD COLUMN content_key TEXT;
ALTER TABLE books ADD COLUMN uploader_reader_id TEXT REFERENCES readers(id);
ALTER TABLE books ADD COLUMN is_shared INTEGER NOT NULL DEFAULT 1;
CREATE INDEX books_uploader ON books(uploader_reader_id);

ALTER TABLE notes ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';
CREATE INDEX notes_visibility ON notes(reader_id,visibility);
