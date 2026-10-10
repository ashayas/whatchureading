# API v1 — web and mobile

Base path: `/api/v1`. JSON request/response bodies. Errors: `{ "error": "human-readable message" }`.

Except `/health`, `/auth/config`, and `/covers/:cover_id`, every endpoint requires `Authorization: Bearer <Supabase access_token>`. Web and mobile sign in through Supabase Auth, refresh sessions with its auth SDK, and send access tokens to the same Rust API. Tokens are verified against the configured Supabase project's `/auth/v1/user`; D1 reader IDs are resolved from the verified auth subject. `reader_id` returned by bootstrap is an application identifier, never an authentication credential. Old `X-Reader-Id` headers and demo cookies are ignored. Missing, forged and expired sessions return 401; unavailable authentication returns 503. Browser mutations require same-origin requests; native HTTP clients do not need CORS.

D1 exclusively stores application users/metadata and reading data. Supabase stores only required auth identities and sessions. No app-level fields are written to Supabase `user_metadata`. New accounts have empty shelves. `readers.supabase_user_id` is a unique subject-to-reader mapping; all private queries use the internal D1 reader ID.

| Method | Path | Request / result |
|---|---|---|
| GET | `/auth/config` | Public `{url,publishableKey}` for the auth client; no privileged keys |
| GET | `/health` | Rust runtime health and version |
| GET | `/bootstrap` | reader_id, profile, books, library, notes, likes, recommendations, attributes |
| PUT | `/library` | `{book_id,status:"reading"\|"want"\|"read"\|"did-not-finish",page,review?:string}`. Replaces shelf fields; include current review to preserve it. Finished forces final page. Leaving the `read` shelf clears the book's ranking. |
| PUT | `/library/rank` | `{book_id,rank_position:0..N}`. Inserts/moves a finished book at `rank_position` among the reader's ranked finished books (0 = favorite), shifting the rest. 400 if the book isn't on the `read` shelf. |
| DELETE | `/library` | `{book_id}`. Removes shelf entry and swipe; preserves notes. Closes any ranking gap it leaves. |
| POST | `/notes` | `{book_id,page,body,spoiler?:boolean,visibility?:"public"\|"private"}`. Page-anchored thought; defaults to public. Private notes are never shown to friends. |
| POST | `/uploads` | `{title,author,kind:"book"\|"paper",pages}`. Creates a personal (unshared) book/paper entry for an uploaded PDF; returns `{id,content_key}`. |
| PUT | `/uploads/:id/content` | Raw PDF bytes (`Content-Type: application/pdf`), owner-only, 40MB limit. |
| GET | `/uploads/:id/content` | Streams the uploaded PDF back, owner-only. |
| GET | `/uploads/mine` | Lists the reader's own uploaded books/papers. |
| POST | `/swipes` | `{book_id,action:"skip"\|"want"\|"read"}`. Saves choice and adds to shelf when appropriate. |
| POST | `/swipes/reset` | `{}`. Revisit skipped books. |
| PUT | `/profile` | `{name,goal}`. Name 1–60 chars; goal 1–500. |
| POST | `/likes` | `{activity_id:"maya"\|"james"\|"sophie"\|"leo",liked:boolean}` |
| GET | `/search?q=...` | Open Library search (2–150 chars), up to 12 results. |
| GET | `/covers/:cover_id` | Proxies an Open Library cover image through this Worker's edge cache (no auth; `cover_id` must be digits only). Caches both hits and misses so repeat requests for the same cover never re-hit Open Library. |
| POST | `/books/import` | `{key:"/works/OL...W",title,author,pages,cover_id}`. Imports metadata; returns `{id}`. |
| POST | `/import/goodreads` | `{records:[{goodreads_book_id,title,author,status,pages,rating,average_rating,isbn,review,started_at,finished_at,history}]}`. Imports a user-selected Goodreads CSV preview into the authenticated reader; accepts up to 2,000 records and is idempotent for existing reader-book rows. |

Progress is pages rather than percentages so web and mobile calculate the same timeline. Reviews allow 5,000 characters, thoughts 2,000. SQL is parameterized. D1 enforces unique auth subjects; batches update swipe/shelf records atomically. Genre attributes are playful inferred metrics, not ability scores. Discovery scores are an explicit heuristic, not a trained recommendation model.

Personal ratings are relative, not a number a reader types in. Finishing a book walks them through "did you like it more than this one?" comparisons against books they already ranked (binary insertion against their existing ranking, so it takes at most `ceil(log2(n+1))` comparisons), and the result is stored as `rank_position` (0 = favorite) rather than a 1-5 score. `/bootstrap` derives a `normalized_rating` (1-5, one decimal) from `rank_position` and the reader's total ranked count, spreading `rank_position` 0..N-1 evenly across 1-5; it is `null` until the reader has ranked at least `RATING_THRESHOLD` (5) books, so the UI can tell readers to keep ranking instead of showing an unstable number. Every library item also carries `ranked_total`. Deleting a book or moving it off the `read` shelf closes the gap it leaves in the reader's ranking.

API and book information docs consulted: [Workers Rust](https://developers.cloudflare.com/workers/languages/rust/), [D1](https://developers.cloudflare.com/d1/worker-api/d1-database/), [Open Library search](https://openlibrary.org/dev/docs/api/search), [Open Library API usage](https://openlibrary.org/developers/api).

## Browser callbacks

`/auth/callback` is served by the SPA. The auth client consumes PKCE `?code=...` callbacks; email templates can also use `?token_hash=...&type=email` or `type=recovery` for one-use verification across browsers. Recovery renders the new-password page before loading the app. Callback credentials are removed from browser history. Sign-out clears the local auth session. Access tokens already issued follow Supabase expiry rules; refresh tokens are revoked on sign-out.

Sources: [Supabase password auth](https://supabase.com/docs/guides/auth/passwords), [token validation](https://supabase.com/docs/guides/auth/jwts), [auth-only SDK](https://github.com/supabase/supabase-js/tree/master/packages/core/auth-js), [SMTP setup](https://supabase.com/docs/guides/auth/auth-smtp).
