# API v1 — web and mobile

Base path: `/api/v1`. JSON request/response bodies. Errors: `{ "error": "human-readable message" }`.

Except `/health` and `/auth/config`, every endpoint requires `Authorization: Bearer <Supabase access_token>`. Web and mobile sign in through Supabase Auth, refresh sessions with its auth SDK, and send access tokens to the same Rust API. Tokens are verified against the configured Supabase project's `/auth/v1/user`; D1 reader IDs are resolved from the verified auth subject. `reader_id` returned by bootstrap is an application identifier, never an authentication credential. Old `X-Reader-Id` headers and demo cookies are ignored. Missing, forged and expired sessions return 401; unavailable authentication returns 503. Browser mutations require same-origin requests; native HTTP clients do not need CORS.

D1 exclusively stores application users/metadata and reading data. Supabase stores only required auth identities and sessions. No app-level fields are written to Supabase `user_metadata`. New accounts have empty shelves. `readers.supabase_user_id` is a unique subject-to-reader mapping; all private queries use the internal D1 reader ID.

| Method | Path | Request / result |
|---|---|---|
| GET | `/auth/config` | Public `{url,publishableKey}` for the auth client; no privileged keys |
| GET | `/health` | Rust runtime health and version |
| GET | `/bootstrap` | reader_id, profile, books, library, notes, likes, recommendations, attributes |
| PUT | `/library` | `{book_id,status:"reading"\|"want"\|"read",page,rating?:1..5,review?:string}`. Replaces shelf fields; include current rating/review to preserve them. Finished forces final page. |
| DELETE | `/library` | `{book_id}`. Removes shelf entry and swipe; preserves notes. |
| POST | `/notes` | `{book_id,page,body,spoiler?:boolean}`. Page-anchored thought. |
| POST | `/swipes` | `{book_id,action:"skip"\|"want"\|"read"}`. Saves choice and adds to shelf when appropriate. |
| POST | `/swipes/reset` | `{}`. Revisit skipped books. |
| PUT | `/profile` | `{name,goal}`. Name 1–60 chars; goal 1–500. |
| POST | `/likes` | `{activity_id:"maya"\|"james"\|"sophie"\|"leo",liked:boolean}` |
| GET | `/search?q=...` | Open Library search (2–150 chars), up to 12 results. |
| POST | `/books/import` | `{key:"/works/OL...W",title,author,pages,cover_id}`. Imports metadata; returns `{id}`. |

Progress is pages rather than percentages so web and mobile calculate the same timeline. Reviews allow 5,000 characters, thoughts 2,000. SQL is parameterized. D1 enforces unique auth subjects; batches update swipe/shelf records atomically. Genre attributes are playful inferred metrics, not ability scores. Discovery scores are an explicit heuristic, not a trained recommendation model.

API and book information docs consulted: [Workers Rust](https://developers.cloudflare.com/workers/languages/rust/), [D1](https://developers.cloudflare.com/d1/worker-api/d1-database/), [Open Library search](https://openlibrary.org/dev/docs/api/search), [Open Library API usage](https://openlibrary.org/developers/api).

## Browser callbacks

`/auth/callback` is served by the SPA. The auth client consumes PKCE `?code=...` callbacks; email templates can also use `?token_hash=...&type=email` or `type=recovery` for one-use verification across browsers. Recovery renders the new-password page before loading the app. Callback credentials are removed from browser history. Sign-out clears the local auth session. Access tokens already issued follow Supabase expiry rules; refresh tokens are revoked on sign-out.

Sources: [Supabase password auth](https://supabase.com/docs/guides/auth/passwords), [token validation](https://supabase.com/docs/guides/auth/jwts), [auth-only SDK](https://github.com/supabase/supabase-js/tree/master/packages/core/auth-js), [SMTP setup](https://supabase.com/docs/guides/auth/auth-smtp).
