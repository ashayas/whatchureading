# whatchureading

An open-source reading app with a React/TypeScript web frontend, a Rust Cloudflare Worker API, and D1 storage. Track reading progress, leave page-specific thoughts, write final verdicts, and discover your next book.

Live app: [whatchureading.com](https://whatchureading.com).

## Self-hosting

You can run the app on your own machine or server with Docker Compose, or use the included Kubernetes example. The app API still runs as a Cloudflare Worker, using Wrangler's local Worker runtime and a persistent, local D1-compatible SQLite database. It does not connect to Cloudflare or need a Cloudflare account in this mode. The default hosted deployment remains Cloudflare Workers with Cloudflare D1; its configuration and deployment flow are unchanged.

It is **not just a SQLite file path**: this API uses the D1 binding interface, so Wrangler manages the local SQLite database and applies the schema migrations at startup. The local database starts empty. The private catalog seed is intentionally excluded; readers can add books through Open Library search. Back up the persistent `/data` volume regularly. Keep this single replica when using SQLite; the Kubernetes example uses one replica and a `ReadWriteOnce` volume.

Supabase Auth is still required for signup and login. You may use a hosted Supabase project or run Supabase yourself; set its public project URL and publishable key below. The browser must be able to reach that auth URL. Configure the auth site's allowed origins and redirect URLs for the address where you serve this app, including `/auth/callback`.

### Docker Compose

Requires Docker with Compose. From the repository root, create a private environment file with your Supabase settings:

```sh
cat > .env.selfhost <<'EOF'
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_PUBLISHABLE_KEY=your-publishable-key
EOF
docker compose --env-file .env.selfhost up --build -d
```

Open http://localhost:8787. Compose binds to localhost by default; put a TLS reverse proxy in front if you want to serve it to other devices. Data persists in the `whatchureading-data` Docker volume. `docker compose down` keeps the volume; back it up before removing or migrating it.

### Kubernetes

Build and push the image to a registry reachable by your cluster, then change `image` in [`deploy/kubernetes.yaml`](deploy/kubernetes.yaml) to that image. Create the auth secret from your private env file and apply the included PVC, single-replica Deployment, and ClusterIP Service:

```sh
docker build -t registry.example.com/whatchureading:latest .
docker push registry.example.com/whatchureading:latest
kubectl create secret generic whatchureading-auth --from-env-file=.env.selfhost
kubectl apply -f deploy/kubernetes.yaml
```

Expose the Service through your own ingress or gateway and configure Supabase with that public origin. Use volume snapshots or another SQLite-safe backup method for the `whatchureading-data` claim. Do not scale this Deployment above one replica: the app uses a local SQLite database, not a shared multi-writer database.

Both self-hosted options run the same API and frontend as the default Cloudflare deployment. They use the separate [`wrangler.selfhost.jsonc`](wrangler.selfhost.jsonc) configuration and the persistent local runtime state. The standard [`wrangler.example.jsonc`](wrangler.example.jsonc), `npm run setup`, D1 migrations, and `npm run deploy` remain the path for the project hosted on Cloudflare.

## Features

- Book-page signup/login flow with continuous page flipping while the app loads.
- Mobile layouts, keyboard/autofill support, safe areas, and reduced-motion animations.
- Reading, want-to-read, and finished shelves; progress, reviews, and spoiler-aware notes.
- Relative personal ratings: finishing a book asks "did you like it more than this one?" against books you've already ranked, instead of picking a number. The derived 1-5 rating stays hidden until you've ranked enough books.
- Swipe discovery and genre-based recommendations; six-axis reading profile.
- Open Library search/import and covers. Missing page counts are visibly estimated.
- Clearly labeled fictional friend activity for the POC. Real friendships are not implemented yet.

Supabase is **authentication only**. D1 owns all application users, profiles, metadata, shelves, notes, reviews, likes and swipes. The Rust API verifies bearer tokens with Supabase Auth and maps the verified subject to an internal D1 reader. Supabase necessarily stores login identities, credential hashes and sessions; no application tables or custom profile metadata are written there.

## Local development

Requires Node 22+, rustup and worker-build 0.8.7.

```sh
npm ci
rustup target add wasm32-unknown-unknown
cargo install worker-build --version 0.8.7 --locked
cp .env.example .env
# Fill .env with your own auth URL/key and Cloudflare account/D1 IDs.
npm run setup
npm run db:local
npm run dev
```

Open http://localhost:8787. Optional frontend hot reload: `npm run dev:ui`, which proxies the API to port 8787. Local D1 is persisted under ignored `.wrangler/state/` and is independent from production D1. Local login uses your configured hosted auth service.

`npm run setup` generates ignored `wrangler.jsonc` and `.dev.vars` from `.env` and the portable `wrangler.example.jsonc`. It does not change remote resources. Keep the explicit account/D1 identifiers in your generated configuration to prevent deploying to the wrong account.

This repository contains **no database contents, personal reading records, saved Goodreads captures, catalog exports, screenshots, or deployment credentials**. Only schema migrations are published. New installations start with an empty catalog and empty shelves; use search to import books. Existing local catalog files and cover caches are ignored.

## Auth configuration

Set `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` in your ignored `.env`. Never place real values in tracked source, documentation, or build artifacts. The browser receives the public auth configuration from `/api/v1/auth/config` at runtime. A browser client necessarily needs the auth URL and publishable key; privileged management credentials are never sent to the browser or deployed.

In your Supabase project's auth settings, set your site's origin and allow `/auth/callback`, including `?recovery=1`. Add localhost/127.0.0.1 callbacks for ports 8787 and 5173 if used. PKCE email links must open in the requesting browser. The callback also supports one-use token-hash email links for cross-device verification.

Configure SMTP for public confirmation and password-reset email delivery. You can enable immediate signup for development. Password recovery and confirmation screens are included.

## Checks and deployment

```sh
npm run typecheck
cargo test --locked
npm run build
npm run check:public
```

Real-auth integration/browser checks require a local server and an `SB_TOKEN` management token in `.env` for disposable auth accounts. Tests generate fictional local catalog fixtures only when the local catalog is empty; no personal data is needed.

```sh
npx playwright install chromium webkit
npm run test:integration
npm run test:browser
TEST_BROWSER=webkit npm run test:browser
```

Tests delete only their own temporary auth users and D1 reader records. Remote testing requires `TEST_ALLOW_REMOTE=1` and a `TEST_BASE_URL` whose host matches the configured domain. Prefer a separate development auth project and D1 database.

See [deployment instructions](docs/deployment.md). `npm run deploy` verifies the private target, builds the frontend, uploads **only** auth runtime settings as Worker secrets through stdin, then deploys. It does not upload `.env` or the management token.

## Architecture and license

The API is versioned under `/api/v1` for web and future native mobile clients. See [API contract](docs/api.md) and [Goodreads capture tooling](docs/goodreads-tooling.md).

Rust uses `worker-rs` compiled to WebAssembly directly on Workers. Actix is not used because it requires native server/container hosting. `strip = "debuginfo"` preserves Wasm sections required by wasm-bindgen.

Source code and the generated app logo are available under the [MIT license](LICENSE). Bundled fonts retain their included SIL Open Font Licenses. Third-party cover artwork and catalog content are not included or relicensed by this repository.
