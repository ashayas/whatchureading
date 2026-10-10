ALTER TABLE readers ADD COLUMN username TEXT;
CREATE UNIQUE INDEX readers_username_unique ON readers(username COLLATE NOCASE) WHERE username IS NOT NULL;
