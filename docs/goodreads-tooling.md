# Goodreads capture tooling

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

The parser checks the subject, record counts, uniqueness, complete pagination and shelf membership. It refuses login/error pages or incomplete/overlapping captures. Dates retain day/month/year precision and repeated reading slots, including unset values. Empty fields remain empty.

Raw HTML can contain private notes and session-related metadata. Keep HTML, membership maps and staged JSON under ignored `artifacts/`; never put them in `public/` or commit them. Outputs are written with owner-only permissions.

The output is a staging format, not an automatic app import. Before importing, map the correct D1 reader identity explicitly. Never guess a login association from a display name or create another person's login account. Support for did-not-finish, partial/repeated reading dates and stable source IDs is needed before preserving every source field in the app. Supabase remains authentication only; all application data belongs in D1.
