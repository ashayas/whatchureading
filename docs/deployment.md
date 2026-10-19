# Deployment

All deployment-specific values belong in ignored `.env`. Copy `.env.example`, fill in your own account and D1 IDs plus Supabase auth settings, then run:

```sh
npm run setup
npx wrangler whoami
npm run typecheck
npm run build
npx wrangler deploy --dry-run
npm run db:remote
npm run deploy
```

Verify the generated `wrangler.jsonc` points to the intended account, Worker and D1 before applying remote migrations or deploying. The setup script uses explicit identifiers and does not create or select remote resources for you. Create your own D1 database first using Wrangler or the Cloudflare dashboard.

`wrangler.example.jsonc` is the published template; `wrangler.jsonc` is deliberately ignored. `CF_CUSTOM_DOMAIN` is optional. When set, setup attaches the apex and www names as Worker custom domains; otherwise the Worker can use its workers.dev address.

Auth settings are sourced from `.env`, mirrored into ignored `.dev.vars` for local development, and uploaded as Worker secrets for production. `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` are mapped to Worker secrets named `AUTH_SUPABASE_URL` and `AUTH_SUPABASE_KEY`. Neither the management token nor any database password is deployed. Secret values are supplied over stdin, not command-line arguments.

Local D1 and remote D1 are separate. Published migrations contain schema only. The catalog seed migration and any exported data are excluded; an empty catalog is supported. Existing deployments retain previously applied migrations and data.

The SPA serves `/auth/callback`; configure the corresponding allowed redirect URLs and site origin in Supabase. Authentication is the only Supabase feature used. Email confirmation/reset delivery requires SMTP.

One more Worker deploys alongside the app, with its own gitignored config copied from the published `mcp.wrangler.example.jsonc` template and its own `npm run deploy:mcp` step (run automatically by `npm run deploy`): `mcp-worker` (the [MCP server](mcp.md), `whatchureading-mcp` on `mcp.whatchureading.com`). It binds the same D1 `DB` as the main app and needs no Supabase secrets of its own.

Useful references: [Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/), [Supabase password auth](https://supabase.com/docs/guides/auth/passwords).
