# MCP server — tracking books from an AI agent

`mcp-worker/` is a standalone Worker that lets AI agents (Claude, ChatGPT, or any MCP-compatible
client) track reading progress, add books to "want to read", and leave comments on a reader's
behalf. It is a second Worker beside the main Rust app, built on Cloudflare's
Agents SDK (`createMcpHandler`, stateless — no Durable Object), and bound to the same D1 `DB` as
the main app.

## Getting a token

In the app's settings (the gear icon next to the reading challenge), click **Add to your AI
agent**. This generates a personal access token for MCP use — shown once, in plaintext, alongside
a ready-made `mcpServers` config block to paste into Claude Code, Claude Desktop, ChatGPT, or any
other MCP client. Clicking it again (**Regenerate token**) rotates the token: the previous one
stops working immediately.

The token is not a Supabase session token — it's long-lived, scoped only to MCP access, and stored
in D1 only as a SHA-256 hash (`readers.agent_token_hash`); the plaintext is never persisted and
can't be recovered once the settings dialog is closed. There's one token per reader, matching the
single-button flow — no list of named tokens to manage.

## Tools

| Tool | What it does |
|---|---|
| `search_books(query)` | Searches Open Library (same source as the app's catalog search) and returns candidates with the `open_library_key` needed by `add_to_want_to_read`. |
| `get_library()` | Lists the reader's shelf: status, page, and review per book. |
| `add_to_want_to_read(open_library_key,title,author,pages,cover_id?)` | Imports the book if new (mirrors `POST /books/import`) and sets it to the `want` shelf. |
| `update_reading_progress(book_id,status,page,review?)` | Mirrors `PUT /library`: replaces shelf status/page, forces the final page on `read`, zeroes the page on `want`/`did-not-finish`. Unlike the raw API, omitting `review` here keeps the existing one instead of clearing it — friendlier for an agent that doesn't know the current review text. |
| `add_comment(book_id,page,body,spoiler?,visibility?)` | Mirrors `POST /notes`: a page-anchored thought, public by default. If the book isn't on the reader's shelf yet, it's added to `reading` first, then the comment is attached — a comment always implies a shelf entry, same as the REST endpoint. |

## Authentication

Each request's `Authorization: Bearer <token>` is SHA-256 hashed and matched against
`readers.agent_token_hash` directly in D1 — no call back into the Rust API, since the MCP token
isn't a Supabase session token the Rust worker would accept. Missing or invalid tokens get a 401
before the MCP handler runs.

## Deployment

Hosted at `mcp.whatchureading.com`, its own Worker (`whatchureading-mcp`) with its own
`mcp.wrangler.jsonc` (gitignored; copy `mcp.wrangler.example.jsonc` and fill in your account/D1
IDs). Deploy with `npm run deploy:mcp`, or as part of
`npm run deploy` alongside the app Worker.

## Self-hosting

See the [README's self-hosting section](../README.md#self-hosting) — a self-hosted instance runs
the MCP server from the same container on the same port, reachable at `/mcp` on your own origin
instead of a separate subdomain. The settings UI detects this automatically and generates a
same-origin config snippet.
