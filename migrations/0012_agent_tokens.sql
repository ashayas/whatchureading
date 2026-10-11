-- A single long-lived personal token per reader for MCP (AI agent) access.
-- Never stored as plaintext; only its SHA-256 hash lives in D1. Regenerating
-- overwrites the hash, which immediately revokes the previous token.
ALTER TABLE readers ADD COLUMN agent_token_hash TEXT;
ALTER TABLE readers ADD COLUMN agent_token_created_at TEXT;
CREATE UNIQUE INDEX readers_agent_token_hash ON readers(agent_token_hash) WHERE agent_token_hash IS NOT NULL;
