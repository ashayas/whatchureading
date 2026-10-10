# Goodreads capture tooling

## Recommended path: account-owner CSV export

Goodreads does not currently offer a new public developer API. For a friend’s
library, ask the account owner to use **My Books → Tools → Import and export →
Export Library**, then send you the downloaded CSV. This is the lowest-friction
path because it uses Goodreads’ own export and never handles their password,
cookies, or browser session.

Stage and inspect the import locally:

```sh
node scripts/goodreads-csv.mjs \
  --input ~/Downloads/goodreads_library_export.csv \
  --output artifacts/goodreads/friend.json \
  --goodreads-user-id GOODREADS_USER_ID \
  --name 'Friend'
```

The Goodreads user ID is the numeric value in their profile URL. The converter
refuses duplicate IDs, unsupported/ambiguous shelf rows, malformed dates, and
missing required columns. It maps `Date Read` or a positive `Read Count` to
`read`, and preserves ratings, reviews, shelves, ISBNs, dates added/read, page
counts, publication years, binding, private notes, and read counts. The CSV
does not contain comments, likes, start dates, or repeated reading-history
slots, so those cannot be reconstructed from this transport.

After reviewing the staging summary and JSON, merge it into the friend’s app
reader with the existing guarded importer:

```sh
node scripts/goodreads-import.mjs \
  --input artifacts/goodreads/friend.json \
  --goodreads-user-id GOODREADS_USER_ID \
  --supabase-user-id SUPABASE_USER_UUID \
  --reader-id D1_READER_UUID

# Repeat with --apply only after reviewing the dry run.
```

For a one-command run, add `--apply --supabase-user-id ... --reader-id ...` to
`goodreads-csv.mjs`; the same account/database guard and post-write verification
still run through `goodreads-import.mjs`.

`scripts/goodreads.py` parses saved shelf HTML into a local staging JSON file. It does not export browser cookies, log in, or perform remote writes. Use only captures you are authorized to access.

1. Open the subject's **All** books table in your browser.
2. Select **100** per page and save every page as **Webpage, HTML Only** under ignored `artifacts/goodreads/`.
3. For your own shelf, pass the subject's ID and display name:

   ```sh
   python3 scripts/goodreads.py artifacts/goodreads/library.html \
     --user-id YOUR_GOODREADS_ID --name 'Reader' \
     --output artifacts/goodreads/library.json
   ```

For another reader's shelf, Goodreads may show the logged-in viewer's shelf controls. Do not infer the subject's memberships from those controls. Capture every subject shelf and pass repeated `--shelf SHELF_NAME HTML_FILE` arguments, or supply `--memberships` with a local JSON object mapping review IDs to shelf names.

If you only have a friend-view **All books** capture, you can make a
conservative partial import by explicitly choosing a fallback status. Books
with a subject `Date Read` or positive `Read Count` are marked `read`; all
other books receive the fallback status. This does not pretend Goodreads
exposed the subject's private shelf membership:

```sh
python3 scripts/goodreads.py \
  artifacts/goodreads/sofia-books-all-1.html \
  artifacts/goodreads/sofia-all-page2.html \
  artifacts/goodreads/sofia-all-page3.html \
  artifacts/goodreads/sofia-all-page4.html \
  --user-id 75360881 --name Sofia --friend-default-status want \
  --output artifacts/goodreads/sofia.json
```

The parser checks the subject, record counts, uniqueness, complete pagination and shelf membership. It refuses login/error pages or incomplete/overlapping captures. Dates retain day/month/year precision and repeated reading slots, including unset values. Empty fields remain empty.

Raw HTML can contain private notes and session-related metadata. Keep HTML, membership maps and staged JSON under ignored `artifacts/`; never put them in `public/` or commit them. Outputs are written with owner-only permissions.

The output is a staging format. To merge it into a reader's app account, provide the Goodreads profile ID plus the exact Supabase user ID and D1 reader ID. The importer verifies that mapping against the configured D1 database, matches existing catalog books by ISBN/title, adds unmatched books with stable Goodreads IDs, and never overwrites an existing reader-book entry. It supports the read, want-to-read, currently-reading and did-not-finish shelves, and preserves partial/repeated date slots in `reading_history`.

Always inspect the dry-run summary first. The explicit `--apply` flag performs a remote D1 write, and the script refuses to run against any account/database other than this project's configured personal Cloudflare target.

```sh
node scripts/goodreads-import.mjs \
  --input artifacts/goodreads/library.json \
  --goodreads-user-id GOODREADS_USER_ID \
  --supabase-user-id SUPABASE_USER_UUID \
  --reader-id D1_READER_UUID

# After reviewing the output, repeat the command with --apply.
```

The importer only transfers details present in the staged file. Goodreads RSS may be unavailable for some profiles; in that case ratings, written reviews and comments are not inferred. Supabase remains authentication only; all application reading data belongs in D1.
