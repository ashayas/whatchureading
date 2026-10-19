# Owning an Open Library edition index

A monthly job that mirrors a filtered, flattened slice of [Open Library's bulk
data dumps](https://openlibrary.org/developers/dumps) into a D1 database this
project owns, instead of depending on Open Library's live search API at
request time. It writes only the rows that changed since the previous run, so
the recurring cost stays near zero.

## Why a separate D1 database and R2 bucket

- `whatchureading-openlibrary` is its own D1 database, not the app's primary
  `whatchureading-db`. The two have unrelated lifecycles and failure modes;
  wiping and rebuilding the Open Library index should never be able to touch
  reader data.
- `whatchureading-openlibrary-sync` (R2) holds only the previous run's
  flattened snapshot (NDJSON, gzipped) used purely for diffing against this
  run's dump. It never holds the raw Open Library dump files or any reader
  data.

## What gets ingested

Open Library's editions dump (`ol_dump_editions_latest.txt.gz`), filtered to
rows with:
- a title,
- at least one ISBN,
- English in `languages`.

That's a deliberate scoping choice to keep storage and write costs small.
Each kept row is flattened to `{id, work_key, isbn, title, author, pages,
publish_date, cover_id}` — never the raw Open Library JSON. `author` comes
from the edition's own `by_statement` free-text field rather than joining the
much larger, separate authors dump, which keeps this a single-dump sync.
Works and authors dumps are not ingested.

## How the diffing works

1. Download and stream-filter this month's editions dump, writing matching
   rows to a local NDJSON file with a SHA-1 fingerprint per row.
2. Pull last month's flattened snapshot from R2 (skipped on the very first
   run — everything is then treated as new).
3. Walk this month's rows against last month's fingerprints: unchanged rows
   are skipped entirely; new or changed rows become `INSERT ... ON CONFLICT
   DO UPDATE` statements; ids present last month but missing this month
   become `DELETE` statements.
4. Apply the diff to D1 in batches via `wrangler d1 execute`.
5. Upload this month's flattened snapshot to R2, replacing last month's, so
   next month's run diffs against it.

## Cost

Open Library's month-to-month change rate is a small fraction of the corpus,
so after the one-time backfill, ongoing diffs are typically well under D1's
free-tier write allowance:

- **One-time backfill:** ~$15–20 (D1 charges $1.00/million rows written
  beyond the free tier; the initial English+ISBN filtered load is tens of
  millions of rows).
- **Monthly ongoing:** $0–5. D1's free tier alone covers 100,000 rows
  written per day; a monthly diff batch comfortably fits in a single day's
  allowance. R2 storage of one flattened snapshot (a few hundred MB
  compressed) is within R2's 10GB free tier.
- **Compute:** $0. The sync runs in GitHub Actions, which is free for public
  repositories, not in a Cloudflare Worker — Workers' memory/CPU limits
  can't stream-process a multi-gigabyte dump file.

## One-time backfill vs. the monthly sync

The very first load (table empty, tens of millions of inserts) is a
different shape of problem than the monthly incremental diff, so it's a
separate script: `scripts/openlibrary-backfill.mjs` (`npm run
backfill:openlibrary`). It streams rows straight to a handful of
~1M-row SQL files and pushes each through D1's Import REST API (one
server-side ingest job per file — the same thing `wrangler d1 execute
--remote --file` already does internally for every file, so this needs
no extra credentials beyond the usual `wrangler` OAuth login and
`CLOUDFLARE_ACCOUNT_ID`) instead of driving thousands of small `wrangler
d1 execute` calls, and it creates the two secondary indexes only after
the bulk load instead of maintaining them row-by-row. Run `node
scripts/openlibrary-backfill.mjs smoke-test` first to verify end-to-end
write access before committing to the full run. It's resumable:
intermediate files live in a fixed `os.tmpdir()` path, so a crash after the
download/filter phase doesn't force a redownload.

Once the backfill has run once and published a snapshot to R2, every
month after that is a small diff and the regular sync job below handles
it.

## Running the monthly sync

- Scheduled automatically: `.github/workflows/openlibrary-sync.yml` runs on
  the 11th of each month via `cron` — a 10-day buffer after Open Library's
  own monthly dump cadence (around the 1st), so the dump this job fetches
  is the finished one, not a possibly still-generating one. No manual
  trigger needed; it also supports `workflow_dispatch` for an on-demand run
  from the Actions tab.
- Requires two GitHub repository secrets: `CLOUDFLARE_API_TOKEN` (a token
  scoped to D1 + R2 edit on the `ashaya` account only — never a global
  token) and `CLOUDFLARE_ACCOUNT_ID`.
- Locally: `npm run sync:openlibrary`, with `CLOUDFLARE_ACCOUNT_ID` set and
  `wrangler` already authenticated (OAuth login is enough locally; CI needs
  the API token since it can't do an interactive login).

## Serving search from the index

The app's `GET /api/v1/search` and the MCP server's `search_books` query this
index through an `OPENLIBRARY` D1 binding (read-only by convention; only the
sync and backfill scripts write to it):

- `editions_fts` is an FTS5 table over `title` and `author` with external
  content (`content='editions'`), so the text isn't stored twice. Triggers in
  `migrations/openlibrary/0001_init.sql` keep it current as the monthly sync
  upserts and deletes rows. A one-time population of an existing table runs
  in rowid batches via `node scripts/openlibrary-fts-build.mjs` (~22M rows
  written, ~0.9 GB, ~10 minutes).
- Queries drop stopwords, match every remaining word (the last as a prefix
  once it has 3+ characters), rank with BM25 weighting title over author, fold
  editions into one result per work, boost works with more matching editions
  and exact title matches, and merge duplicate works with the same title.
- A cheap capped count runs first: queries matching more than 8,000 editions
  (single common words) are too broad to rank within D1's CPU limit, so those,
  thin result sets, and installs without the binding fall back to Open
  Library's live search API.

Known gap: `author` comes from the edition's free-text `by_statement`, which
only ~23% of editions carry, so author-only searches lean on the live
fallback. Enriching authors from the authors dump is the next step.
