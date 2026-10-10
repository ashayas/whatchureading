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

## Running it

- Scheduled automatically: `.github/workflows/openlibrary-sync.yml` runs on
  the 1st of each month via `cron`, no manual trigger needed. It also
  supports `workflow_dispatch` for an on-demand run from the Actions tab.
- Requires two GitHub repository secrets: `CLOUDFLARE_API_TOKEN` (a token
  scoped to D1 + R2 edit on the `ashaya` account only — never a global
  token) and `CLOUDFLARE_ACCOUNT_ID`.
- Locally: `npm run sync:openlibrary`, with `CLOUDFLARE_ACCOUNT_ID` set and
  `wrangler` already authenticated (OAuth login is enough locally; CI needs
  the API token since it can't do an interactive login).

## Not yet wired into the app

This sync only populates `whatchureading-openlibrary`. The app's `/search`
and `/books/import` endpoints still call Open Library's live search API.
Querying this owned index from the Rust API (e.g. for import matching or to
replace the live search call) is a follow-up, not part of this change.
