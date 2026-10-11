ALTER TABLE readers ADD COLUMN avatar_key TEXT;
ALTER TABLE library ADD COLUMN topic_signals TEXT NOT NULL DEFAULT '{}';

-- A synthetic reader everyone starts out friends with, so the feed and
-- friends list are never empty for a brand-new account. No supabase_user_id
-- (NULL), so this account can never be matched during auth and never signs in.
INSERT OR IGNORE INTO readers (id, supabase_user_id, email, name, username, goal) VALUES
  ('shakespeare', NULL, NULL, 'William Shakespeare', 'shakespeare', 24);

INSERT OR IGNORE INTO library (reader_id, book_id, status, page, review, finished_at) VALUES
  ('shakespeare', 'sapiens', 'read', 464, '', CURRENT_TIMESTAMP),
  ('shakespeare', 'gentleman', 'reading', 118, '', NULL);

INSERT OR IGNORE INTO notes (id, reader_id, book_id, page, body, spoiler, visibility) VALUES
  ('shakespeare-note-1', 'shakespeare', 'sapiens', 210, 'All the world''s a stage, and Harari has written us a fine new act. A history worth the reading.', 0, 'public'),
  ('shakespeare-note-2', 'shakespeare', 'gentleman', 80, 'Methinks the Count''s confinement is the freest I have seen a man. A room can be a whole world, if you let it.', 0, 'public');

-- Backfill: friend every existing reader with Shakespeare, both directions.
INSERT OR IGNORE INTO reader_friends (reader_id, friend_id)
  SELECT id, 'shakespeare' FROM readers WHERE id <> 'shakespeare';
INSERT OR IGNORE INTO reader_friends (reader_id, friend_id)
  SELECT 'shakespeare', id FROM readers WHERE id <> 'shakespeare';
