-- Legacy demo readers remain untouched; verified accounts get fresh, private shelves.
ALTER TABLE readers ADD COLUMN supabase_user_id TEXT;
ALTER TABLE readers ADD COLUMN email TEXT;
CREATE UNIQUE INDEX readers_supabase_user_id ON readers(supabase_user_id) WHERE supabase_user_id IS NOT NULL;
