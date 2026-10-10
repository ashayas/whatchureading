CREATE TABLE reader_friends (
  reader_id TEXT NOT NULL REFERENCES readers(id) ON DELETE CASCADE,
  friend_id TEXT NOT NULL REFERENCES readers(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (reader_id, friend_id),
  CHECK (reader_id <> friend_id)
);
CREATE INDEX reader_friends_friend ON reader_friends(friend_id);
