-- Groups: shared views of members' reading plus optional book-club picks.
-- A group becomes a book club simply by having a row in group_picks with
-- ends_at IS NULL (its current pick); there is no separate "is club" flag.
CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES readers(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE group_members (
  group_id TEXT NOT NULL REFERENCES groups(id),
  reader_id TEXT NOT NULL REFERENCES readers(id),
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','member')),
  joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(group_id, reader_id)
);
CREATE INDEX group_members_reader ON group_members(reader_id);

-- At most one row per group has ends_at IS NULL: the current pick.
CREATE TABLE group_picks (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  book_id TEXT NOT NULL REFERENCES books(id),
  selected_by TEXT NOT NULL REFERENCES readers(id),
  starts_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ends_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX group_picks_group ON group_picks(group_id, starts_at);

-- Opinions on a pick, scoped to the group — distinct from the app's
-- personal public/private notes, which are per-reader, not per-group.
CREATE TABLE group_pick_comments (
  id TEXT PRIMARY KEY,
  pick_id TEXT NOT NULL REFERENCES group_picks(id),
  reader_id TEXT NOT NULL REFERENCES readers(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX group_pick_comments_pick ON group_pick_comments(pick_id, created_at);
