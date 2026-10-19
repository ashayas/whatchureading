use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use worker::*;

fn reply(v: Value, status: u16) -> Result<Response> {
    Ok(Response::from_json(&v)?.with_status(status))
}
fn bad(message: &str) -> Result<Response> {
    reply(json!({"error": message}), 400)
}
fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}
fn int(v: &Value, k: &str) -> i64 {
    v.get(k).and_then(Value::as_i64).unwrap_or(0)
}
async fn rows(db: &D1Database, sql: &str, args: Vec<wasm_bindgen::JsValue>) -> Result<Vec<Value>> {
    db.prepare(sql).bind(&args)?.all().await?.results::<Value>()
}
fn arg(s: &str) -> wasm_bindgen::JsValue {
    s.into()
}
fn opt_arg(s: &Option<String>) -> wasm_bindgen::JsValue {
    match s {
        Some(s) => s.as_str().into(),
        None => wasm_bindgen::JsValue::NULL,
    }
}
fn num(n: i64) -> wasm_bindgen::JsValue {
    (n as f64).into()
}
fn real(n: f64) -> wasm_bindgen::JsValue {
    n.into()
}
// MCP (AI agent) access token: generated once, shown to the reader once, and
// stored in D1 only as its SHA-256 hash. Two v4 UUIDs give ample randomness
// without adding a dedicated RNG dependency.
fn generate_agent_token() -> String {
    format!("wur_{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}
fn hash_agent_token(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
// Covers are proxied through this Worker (instead of the browser hitting
// Open Library's CDN directly) so Cloudflare's edge Cache API can serve
// repeat requests for the same cover without a fresh upstream fetch. Public,
// no auth: it's the same image Open Library already serves to anyone.
async fn cover(req: &Request, cover_id: &str) -> Result<Response> {
    if cover_id.is_empty() || cover_id.len() > 20 || !cover_id.bytes().all(|c| c.is_ascii_digit()) {
        return bad("Invalid cover id");
    }
    let cache = Cache::default();
    if let Some(cached) = cache.get(req, false).await? {
        return Ok(cached);
    }
    let headers = Headers::new();
    headers.set("User-Agent", "whatchureading.com/0.1 (cover proxy)")?;
    let mut upstream = Fetch::Request(Request::new_with_init(
        &format!("https://covers.openlibrary.org/b/id/{cover_id}-L.jpg"),
        RequestInit::new().with_headers(headers),
    )?)
    .send()
    .await?;
    let mut res = if upstream.status_code() == 200 {
        let bytes = upstream.bytes().await?;
        let mut r = Response::from_bytes(bytes)?;
        r.headers_mut().set("Content-Type", "image/jpeg")?;
        r.headers_mut()
            .set("Cache-Control", "public, max-age=2592000")?;
        r
    } else {
        // Cache the miss too, briefly, so a broken/unknown cover id doesn't
        // get re-fetched from Open Library on every page view.
        let mut r = Response::empty()?.with_status(404);
        r.headers_mut().set("Cache-Control", "public, max-age=600")?;
        r
    };
    cache.put(req, res.cloned()?).await?;
    Ok(res)
}

// Book search runs against the owned Open Library edition index (the
// OPENLIBRARY D1 binding, synced monthly) instead of Open Library's live API.
// FTS5 matches every word of the query (the last one also as a prefix, so
// results firm up while typing), BM25 ranks title hits above author hits, and
// editions are folded into one result per work, with works that have many
// matching editions (a decent popularity signal) floated up. Results keep
// Open Library's search.json field names so clients don't change.
// Words too common to narrow ~22M titles; matching them would only make
// BM25 score hundreds of thousands of rows. The exact-title boost below still
// uses the full query, so "Klara and the Sun" ranks its own title first.
const SEARCH_STOPWORDS: [&str; 16] = [
    "the", "a", "an", "of", "and", "in", "to", "for", "on", "with", "by", "at", "from", "is", "or", "de",
];
// Ranking is only attempted when a query matches at most this many editions
// (counting up to it is cheap; ranking far more exceeds D1's CPU limit).
// Broader queries go to the live API, which handles them well.
const SEARCH_MAX_MATCHES: i64 = 8000;
fn fts_query(q: &str) -> Option<String> {
    let words: Vec<String> = q
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_lowercase)
        .filter(|w| !SEARCH_STOPWORDS.contains(&w.as_str()))
        .take(8)
        .collect();
    let last = words.len().checked_sub(1)?;
    Some(
        words
            .iter()
            .enumerate()
            .map(|(i, w)| {
                // A prefix on very short fragments expands to too many terms.
                if i == last && w.chars().count() >= 3 {
                    format!("\"{w}\"*")
                } else {
                    format!("\"{w}\"")
                }
            })
            .collect::<Vec<_>>()
            .join(" "),
    )
}
// by_statement is free text: "by Cixin Liu ; translated by Ken Liu." -> "Cixin Liu".
fn clean_author(raw: &str) -> String {
    let first = raw.split([';', '[', '(']).next().unwrap_or("").trim();
    let first = first
        .strip_prefix("by ")
        .or_else(|| first.strip_prefix("By "))
        .unwrap_or(first);
    first.trim().trim_end_matches(['.', ',', '/', ':']).trim().to_string()
}
fn normalized(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .collect::<String>()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
async fn search_owned_index(db: &D1Database, q: &str) -> Result<Vec<Value>> {
    let Some(matcher) = fts_query(q) else { return Ok(vec![]) };
    let matches = rows(
        db,
        "SELECT COUNT(*) AS n FROM (SELECT rowid FROM editions_fts WHERE editions_fts MATCH ?1 LIMIT ?2)",
        vec![arg(&matcher), num(SEARCH_MAX_MATCHES + 1)],
    )
    .await?;
    if matches.first().map(|m| int(m, "n")).unwrap_or(0) > SEARCH_MAX_MATCHES {
        return Ok(vec![]);
    }
    let hits = rows(
        db,
        "WITH hits AS (SELECT rowid, bm25(editions_fts, 4.0, 1.0) AS score FROM editions_fts WHERE editions_fts MATCH ?1 ORDER BY score LIMIT 400) \
         SELECT COALESCE(e.work_key, e.id) AS key, e.title, MAX(e.author) AS author, e.pages, MAX(e.pages) AS max_pages, e.publish_date, \
         MAX(e.cover_id) AS cover_id, MIN(h.score) AS score, COUNT(*) AS editions \
         FROM hits h JOIN editions e ON e.rowid = h.rowid GROUP BY COALESCE(e.work_key, e.id) ORDER BY score LIMIT 80",
        vec![arg(&matcher)],
    )
    .await?;
    let wanted = normalized(q);
    let mut ranked: Vec<(f64, Value)> = hits
        .into_iter()
        .map(|h| {
            let title = text(&h, "title").to_string();
            let author = clean_author(text(&h, "author"));
            let editions = int(&h, "editions") as f64;
            let bm25 = -h.get("score").and_then(Value::as_f64).unwrap_or(0.0);
            let title_norm = normalized(&title);
            let mut relevance = bm25 + 1.5 * (1.0 + editions).ln();
            if title_norm == wanted {
                relevance += 6.0;
            } else if title_norm.starts_with(&wanted) {
                relevance += 3.0;
            }
            if int(&h, "cover_id") > 0 {
                relevance += 1.0;
            }
            if !author.is_empty() {
                relevance += 0.5;
            }
            let pages = match int(&h, "pages") {
                0 => int(&h, "max_pages"),
                p => p,
            };
            let year = text(&h, "publish_date")
                .split(|c: char| !c.is_ascii_digit())
                .find(|p| p.len() == 4)
                .and_then(|y| y.parse::<i64>().ok());
            let doc = json!({
                "key": text(&h, "key"),
                "title": title,
                "author_name": if author.is_empty() { json!([]) } else { json!([author]) },
                "cover_i": match int(&h, "cover_id") { 0 => Value::Null, c => json!(c) },
                "number_of_pages_median": if pages > 0 { json!(pages) } else { Value::Null },
                "first_publish_year": year,
                "edition_count": editions as i64,
            });
            (relevance, doc)
        })
        .collect();
    ranked.sort_by(|a, b| b.0.total_cmp(&a.0));
    // Open Library often has one book under several work ids; keep the
    // best-ranked of each title, unless the authors clearly differ.
    let mut results: Vec<Value> = Vec::new();
    for (_, doc) in ranked {
        let title = normalized(doc["title"].as_str().unwrap_or(""));
        let author = normalized(doc["author_name"][0].as_str().unwrap_or(""));
        let duplicate = results.iter().any(|r| {
            let other = normalized(r["author_name"][0].as_str().unwrap_or(""));
            normalized(r["title"].as_str().unwrap_or("")) == title
                && (author.is_empty() || other.is_empty() || author == other)
        });
        if !duplicate {
            results.push(doc);
        }
        if results.len() == 12 {
            break;
        }
    }
    Ok(results)
}
async fn search_open_library_live(q: &str) -> Result<Option<Vec<Value>>> {
    let mut upstream = Url::parse("https://openlibrary.org/search.json")?;
    upstream
        .query_pairs_mut()
        .append_pair("q", q)
        .append_pair("limit", "12")
        .append_pair(
            "fields",
            "key,title,author_name,cover_i,number_of_pages_median,first_publish_year,subject",
        );
    let headers = Headers::new();
    headers.set("User-Agent", "whatchureading.com/0.1 (book discovery POC)")?;
    let mut res = Fetch::Request(Request::new_with_init(
        upstream.as_str(),
        RequestInit::new().with_headers(headers),
    )?)
    .send()
    .await?;
    if res.status_code() != 200 {
        return Ok(None);
    }
    let data: Value = res.json().await?;
    Ok(Some(data["docs"].as_array().cloned().unwrap_or_default()))
}
// Owned index first; live Open Library only tops up a thin result set (the
// index's author coverage is partial) or stands in when the binding is absent
// (self-hosted installs without the index) or the query fails.
async fn search_books(env: &Env, q: &str) -> Result<Response> {
    // Nothing left after stopwords (e.g. "the" while still typing): nothing
    // useful to rank anywhere, and the live API errors on these too.
    if fts_query(q).is_none() {
        return reply(json!({"results":[],"source":"whatchureading index"}), 200);
    }
    let mut results = match env.d1("OPENLIBRARY") {
        Ok(index) => search_owned_index(&index, q).await.unwrap_or_else(|e| {
            console_error!("owned search failed: {e}");
            vec![]
        }),
        Err(_) => vec![],
    };
    let owned = results.len();
    if owned < 5 {
        if let Ok(Some(live)) = search_open_library_live(q).await {
            for doc in live {
                if results.len() >= 12 {
                    break;
                }
                if !results.iter().any(|r| r["key"] == doc["key"]) {
                    results.push(doc);
                }
            }
        } else if owned == 0 {
            return reply(
                json!({"error":"The book catalog is taking a break. Try again shortly."}),
                502,
            );
        }
    }
    let source = match (owned, results.len()) {
        (0, _) => "Open Library",
        (o, n) if o == n => "whatchureading index",
        _ => "whatchureading index + Open Library",
    };
    reply(json!({"results":results,"source":source}), 200)
}
// Self-serve avatars, proxied through this Worker and stored in the same R2
// bucket as uploaded book/paper content. Public, no auth: avatars need to
// render in other readers' feeds and friend lists.
async fn avatar(env: &Env, reader_id: &str) -> Result<Response> {
    if reader_id.is_empty() || reader_id.len() > 64 {
        return reply(json!({"error":"Not found"}), 404);
    }
    let db = env.d1("DB")?;
    let reader = db
        .prepare("SELECT avatar_key FROM readers WHERE id=?")
        .bind(&[arg(reader_id)])?
        .first::<Value>(None)
        .await?;
    let Some(key) = reader.and_then(|r| r.get("avatar_key").and_then(Value::as_str).map(str::to_string)) else {
        return reply(json!({"error":"Not found"}), 404);
    };
    let bucket = env.bucket("UPLOADS")?;
    let Some(object) = bucket.get(&key).execute().await? else {
        return reply(json!({"error":"Not found"}), 404);
    };
    let Some(body) = object.body() else {
        return reply(json!({"error":"Not found"}), 404);
    };
    let bytes = body.bytes().await?;
    let content_type = object
        .http_metadata()
        .content_type
        .unwrap_or_else(|| "image/jpeg".into());
    let mut res = Response::from_bytes(bytes)?;
    res.headers_mut().set("Content-Type", &content_type)?;
    res.headers_mut()
        .set("Cache-Control", "public, max-age=3600")?;
    Ok(res)
}
// First-page snapshots of uploaded papers. Public like avatars (an <img> can't
// send a bearer token) but only for papers, never personal uploaded books, and
// only reachable by the paper's unguessable id.
async fn upload_cover(env: &Env, book_id: &str) -> Result<Response> {
    if book_id.is_empty() || book_id.len() > 64 {
        return reply(json!({"error":"Not found"}), 404);
    }
    let book = env
        .d1("DB")?
        .prepare("SELECT cover_key FROM books WHERE id=? AND kind='paper'")
        .bind(&[arg(book_id)])?
        .first::<Value>(None)
        .await?;
    let Some(key) = book.and_then(|b| b.get("cover_key").and_then(Value::as_str).map(str::to_string)) else {
        return reply(json!({"error":"Not found"}), 404);
    };
    let Some(object) = env.bucket("UPLOADS")?.get(&key).execute().await? else {
        return reply(json!({"error":"Not found"}), 404);
    };
    let Some(body) = object.body() else {
        return reply(json!({"error":"Not found"}), 404);
    };
    let content_type = object
        .http_metadata()
        .content_type
        .unwrap_or_else(|| "image/jpeg".into());
    let mut res = Response::from_bytes(body.bytes().await?)?;
    res.headers_mut().set("Content-Type", &content_type)?;
    res.headers_mut().set("Cache-Control", "public, max-age=86400")?;
    Ok(res)
}
// Never accept browser-supplied reader IDs. Supabase verifies the bearer token;
// D1 owns the application identity and every reading record.
async fn authenticated(req: &Request, env: &Env) -> Result<Response> {
    let path = req.path();
    if path == "/api/v1/health" {
        return reply(json!({"ok":true,"backend":"rust","version":"0.2.0"}), 200);
    }
    if let Some(cover_id) = path.strip_prefix("/api/v1/covers/") {
        if req.method() == Method::Get {
            return cover(req, cover_id).await;
        }
    }
    if path == "/api/v1/username-available" && req.method() == Method::Get {
        let url = req.url()?;
        let username = url
            .query_pairs()
            .find(|(key, _)| key == "username")
            .map(|(_, value)| value.into_owned())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !valid_username(&username) {
            return reply(json!({"available":false,"valid":false}), 200);
        }
        let db = env.d1("DB")?;
        let found = db
            .prepare("SELECT 1 AS taken FROM readers WHERE username=? COLLATE NOCASE LIMIT 1")
            .bind(&[arg(&username)])?
            .first::<Value>(None)
            .await?;
        return reply(json!({"available":found.is_none(),"valid":true}), 200);
    }
    if let Some(reader_id) = path.strip_prefix("/api/v1/avatar/") {
        if req.method() == Method::Get {
            return avatar(env, reader_id).await;
        }
    }
    if let Some(book_id) = path.strip_prefix("/api/v1/upload-covers/") {
        if req.method() == Method::Get {
            return upload_cover(env, book_id).await;
        }
    }
    let auth_url = env.secret("AUTH_SUPABASE_URL")?.to_string();
    let public_key = env.secret("AUTH_SUPABASE_KEY")?.to_string();
    if path == "/api/v1/auth/config" && req.method() == Method::Get {
        return reply(json!({"url":auth_url,"publishableKey":public_key}), 200);
    }
    let authorization = req.headers().get("Authorization")?.unwrap_or_default();
    let Some(token) = authorization.strip_prefix("Bearer ") else {
        return reply(json!({"error":"Please sign in to continue."}), 401);
    };
    if token.is_empty() || token.len() > 8192 {
        return reply(
            json!({"error":"Invalid session. Please sign in again."}),
            401,
        );
    }
    let headers = Headers::new();
    headers.set("apikey", &public_key)?;
    headers.set("Authorization", &authorization)?;
    let result = Fetch::Request(Request::new_with_init(
        &format!("{auth_url}/auth/v1/user"),
        RequestInit::new().with_headers(headers),
    )?)
    .send()
    .await;
    let mut verified = match result {
        Ok(response) => response,
        Err(_) => {
            return reply(
                json!({"error":"Sign-in service is temporarily unavailable. Please try again."}),
                503,
            )
        }
    };
    if verified.status_code() == 401 || verified.status_code() == 403 {
        return reply(
            json!({"error":"Your session expired. Please sign in again."}),
            401,
        );
    }
    if verified.status_code() != 200 {
        return reply(
            json!({"error":"Sign-in service is temporarily unavailable. Please try again."}),
            503,
        );
    }
    let user: Value = verified.json().await?;
    let auth_id = text(&user, "id");
    if Uuid::parse_str(auth_id).is_err() || text(&user, "role") != "authenticated" {
        return reply(
            json!({"error":"Invalid session. Please sign in again."}),
            401,
        );
    }
    let db = env.d1("DB")?;
    let email = text(&user, "email");
    // Application metadata is exclusively D1-owned, never Supabase user_metadata.
    let name = email
        .split('@')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("Reader");
    let mut reader = db
        .prepare("SELECT id FROM readers WHERE supabase_user_id=?")
        .bind(&[arg(auth_id)])?
        .first::<Value>(None)
        .await?;
    let is_new = reader.is_none();
    if reader.is_none() {
        db.prepare(
            "INSERT OR IGNORE INTO readers(id,supabase_user_id,email,name) VALUES (?,?,?,?)",
        )
        .bind(&[
            arg(&Uuid::new_v4().to_string()),
            arg(auth_id),
            arg(email),
            arg(&name.chars().take(60).collect::<String>()),
        ])?
        .run()
        .await?;
        // Resolve again after insert so concurrent first requests share one D1 reader.
        reader = db
            .prepare("SELECT id FROM readers WHERE supabase_user_id=?")
            .bind(&[arg(auth_id)])?
            .first::<Value>(None)
            .await?;
    }
    let Some(reader) = reader else {
        return Err(Error::RustError("Reader creation failed".into()));
    };
    let id = text(&reader, "id").to_string();
    // Cloudflare's native per-key rate limiter, keyed by D1 reader id (not IP,
    // which is shared/rotating behind NAT and mobile carriers): caps abuse
    // from a single account without needing a KV/D1-backed counter of our own.
    if !env
        .rate_limiter("API_RATE_LIMITER")?
        .limit(id.clone())
        .await?
        .success
    {
        return reply(
            json!({"error":"You're doing that too much. Please slow down and try again shortly."}),
            429,
        );
    }
    // New readers start out friends with the synthetic Shakespeare account,
    // so the feed and friends list are never empty on day one.
    if is_new {
        let _ = db
            .batch(vec![
                db.prepare("INSERT OR IGNORE INTO reader_friends(reader_id,friend_id) VALUES (?,'shakespeare')")
                    .bind(&[arg(&id)])?,
                db.prepare("INSERT OR IGNORE INTO reader_friends(reader_id,friend_id) VALUES ('shakespeare',?)")
                    .bind(&[arg(&id)])?,
            ])
            .await;
    }
    handle(req.clone()?, env, &id).await
}
fn valid_username(username: &str) -> bool {
    (3..=20).contains(&username.len())
        && username
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
}
// D1 enforces foreign keys, so order matters: everything that references the
// reader's uploads, owned groups, or the reader row itself must go first.
// One bound parameter (?1 = reader id) throughout. Exercised against a local
// D1 fixture by scripts/account-delete-check.mjs.
const ACCOUNT_DELETE_SQL: &[&str] = &[
    // Their uploads leave everyone's shelves (the R2 content is deleted too).
    "DELETE FROM group_pick_comments WHERE pick_id IN (SELECT id FROM group_picks WHERE book_id IN (SELECT id FROM books WHERE uploader_reader_id=?1))",
    "DELETE FROM group_picks WHERE book_id IN (SELECT id FROM books WHERE uploader_reader_id=?1)",
    "DELETE FROM library WHERE book_id IN (SELECT id FROM books WHERE uploader_reader_id=?1)",
    "DELETE FROM notes WHERE book_id IN (SELECT id FROM books WHERE uploader_reader_id=?1)",
    "DELETE FROM swipes WHERE book_id IN (SELECT id FROM books WHERE uploader_reader_id=?1)",
    // Groups they own go with them.
    "DELETE FROM group_pick_comments WHERE pick_id IN (SELECT id FROM group_picks WHERE group_id IN (SELECT id FROM groups WHERE created_by=?1))",
    "DELETE FROM group_picks WHERE group_id IN (SELECT id FROM groups WHERE created_by=?1)",
    "DELETE FROM group_members WHERE group_id IN (SELECT id FROM groups WHERE created_by=?1)",
    "DELETE FROM groups WHERE created_by=?1",
    // In other people's groups: comments go, picks stay credited to the owner.
    "DELETE FROM group_pick_comments WHERE reader_id=?1",
    "UPDATE group_picks SET selected_by=(SELECT created_by FROM groups WHERE groups.id=group_picks.group_id) WHERE selected_by=?1",
    "DELETE FROM group_members WHERE reader_id=?1",
    "DELETE FROM library WHERE reader_id=?1",
    "DELETE FROM notes WHERE reader_id=?1",
    "DELETE FROM swipes WHERE reader_id=?1",
    "DELETE FROM likes WHERE reader_id=?1",
    "DELETE FROM reader_friends WHERE reader_id=?1 OR friend_id=?1",
    "DELETE FROM books WHERE uploader_reader_id=?1",
    "DELETE FROM readers WHERE id=?1",
];
// Readers rank finished books against each other instead of picking a number.
// A 1-5 rating is only derived, and only shown, once enough books are ranked.
const RATING_THRESHOLD: i64 = 5;
fn normalize_ratings(library: &mut [Value]) {
    let total = library
        .iter()
        .filter(|l| l["rank_position"].as_i64().is_some())
        .count() as i64;
    for item in library.iter_mut() {
        let normalized = if total >= RATING_THRESHOLD {
            item["rank_position"].as_i64().map(|p| {
                let r = if total > 1 {
                    5.0 - 4.0 * (p as f64) / ((total - 1) as f64)
                } else {
                    5.0
                };
                (r * 10.0).round() / 10.0
            })
        } else {
            None
        };
        item["normalized_rating"] = json!(normalized);
        item["ranked_total"] = json!(total);
    }
}
fn genre_attribute(genre: &str) -> usize {
    match genre {
        "Fiction" | "Memoir" => 0,
        "Sci-fi" => 1,
        "Fantasy" => 2,
        "History" => 3,
        "Growth" => 4,
        _ => 5,
    }
}
// Broad paper domains (src/paperTopics.ts PAPER_DOMAINS), chosen at upload.
const PAPER_TOPICS: [&str; 11] = [
    "Computer Science",
    "Mathematics",
    "Physics",
    "Life Sciences",
    "Medicine & Health",
    "Chemistry & Materials",
    "Earth & Environment",
    "Engineering",
    "Economics & Finance",
    "Social Sciences",
    "Humanities",
];
// A separate radar from the book attributes above: areas of academic learning,
// scored only from papers (kind="paper"), never books. Each paper carries a
// full-text classification, books.topic_signals = {"Domain/Field": share}
// (shares sum to ~100; see src/paperTopics.ts), so the axes are whichever
// specific fields this reader actually reads most, not a fixed list. Each
// paper counts by how far the reader got with it: finished > reading > their
// own unread upload > want-to-read. Papers without a classification yet fall
// back to legacy per-reader signals, then to their upload-time domain. With
// fewer than three distinct fields the radar shows domains instead.
fn paper_attributes(library: &[Value], books: &[Value], reader_id: &str) -> Value {
    use std::collections::HashMap;
    let weight_for = |status: &str| match status {
        "read" => 3.0,
        "reading" => 2.0,
        "want" => 0.5,
        _ => 0.0,
    };
    let mut weighted: Vec<(f64, &Value, Option<&Value>)> = Vec::new();
    for b in books.iter().filter(|b| text(b, "kind") == "paper") {
        let item = library.iter().find(|l| l["book_id"] == b["id"]);
        let w = match item {
            Some(item) => weight_for(text(item, "status")),
            None if text(b, "uploader_reader_id") == reader_id && !reader_id.is_empty() => 1.0,
            None => 0.0,
        };
        if w > 0.0 {
            weighted.push((w, b, item));
        }
    }
    let parse = |v: Option<&Value>| -> Vec<(String, f64)> {
        v.and_then(Value::as_str)
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .and_then(|v| v.as_object().cloned())
            .map(|m| {
                m.into_iter()
                    .filter_map(|(k, v)| v.as_f64().filter(|n| *n > 0.0).map(|n| (k, n)))
                    .collect()
            })
            .unwrap_or_default()
    };
    let mut fields: HashMap<String, f64> = HashMap::new();
    let mut domains: HashMap<String, f64> = HashMap::new();
    for (w, book, item) in &weighted {
        let topic = text(book, "topic");
        let mut signals = parse(book.get("topic_signals"));
        if signals.is_empty() {
            // Legacy per-reader keyword hits keyed by bare subtopic label.
            signals = parse(item.and_then(|i| i.get("topic_signals")))
                .into_iter()
                .map(|(k, n)| (if k.contains('/') || topic.is_empty() { k } else { format!("{topic}/{k}") }, n))
                .collect();
        }
        let total: f64 = signals.iter().map(|(_, n)| n).sum();
        if total > 0.0 {
            for (key, n) in signals {
                let share = w * n / total;
                let domain = key.split('/').next().unwrap_or("").to_string();
                *fields.entry(key).or_insert(0.0) += share;
                *domains.entry(domain).or_insert(0.0) += share;
            }
        } else if !topic.is_empty() {
            *domains.entry(topic.to_string()).or_insert(0.0) += w;
        }
    }
    let scale = |ranked: Vec<(String, f64)>, kind: &str| -> Value {
        let max = ranked.first().map(|r| r.1).unwrap_or(1.0).max(f64::EPSILON);
        let total: f64 = ranked.iter().map(|r| r.1).sum::<f64>().max(f64::EPSILON);
        json!(ranked
            .iter()
            .map(|(key, v)| {
                let mut parts = key.splitn(2, '/');
                let (domain, field) = (parts.next().unwrap_or(""), parts.next());
                json!({
                    "label": field.unwrap_or(domain),
                    "domain": domain,
                    "kind": kind,
                    "value": (15.0 + 84.0 * v / max).round() as i64,
                    "share": (100.0 * v / total).round() as i64,
                })
            })
            .collect::<Vec<_>>())
    };
    let mut ranked_fields: Vec<(String, f64)> = fields.into_iter().filter(|(k, _)| k.contains('/')).collect();
    ranked_fields.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    if let Some(top) = ranked_fields.first().map(|r| r.1) {
        ranked_fields.retain(|r| r.1 >= top * 0.08);
    }
    ranked_fields.truncate(8);
    if ranked_fields.len() >= 3 {
        return scale(ranked_fields, "field");
    }
    // Too few fields for a shape: show domains, padded with the remaining
    // domains at the baseline so a new reader still sees a full radar.
    let mut ranked_domains: Vec<(String, f64)> = domains.into_iter().collect();
    ranked_domains.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    for d in PAPER_TOPICS {
        if ranked_domains.len() >= 6 {
            break;
        }
        if !ranked_domains.iter().any(|r| r.0 == d) {
            ranked_domains.push((d.to_string(), 0.0));
        }
    }
    ranked_domains.truncate(8);
    scale(ranked_domains, "domain")
}
fn attributes(library: &[Value], books: &[Value]) -> Value {
    let mut scores = [15i64; 6];
    for item in library {
        if matches!(text(item, "status"), "want" | "did-not-finish") {
            continue;
        }
        if let Some(b) = books.iter().find(|b| b["id"] == item["book_id"]) {
            let weight = if text(item, "status") == "read" {
                18
            } else {
                8
            };
            scores[genre_attribute(text(b, "genre"))] += weight;
        }
    }
    json!([{"label":"Empathy","value":scores[0].min(99)},{"label":"Curiosity","value":scores[1].min(99)},{"label":"Imagination","value":scores[2].min(99)},{"label":"Perspective","value":scores[3].min(99)},{"label":"Growth","value":scores[4].min(99)},{"label":"Creativity","value":scores[5].min(99)}])
}
fn recommendations(books: &[Value], library: &[Value], swipes: &[Value]) -> Vec<Value> {
    let total_ranked = library
        .iter()
        .filter(|l| l["rank_position"].as_i64().is_some())
        .count() as i64;
    let mut result: Vec<Value> = books
        .iter()
        .filter(|b| {
            int(b, "is_shared") == 1
                && !library.iter().any(|l| l["book_id"] == b["id"])
                && !swipes.iter().any(|s| s["book_id"] == b["id"])
        })
        .map(|b| {
            let affinity: i64 = library
                .iter()
                .filter(|l| {
                    !matches!(text(l, "status"), "want" | "did-not-finish")
                        && books
                            .iter()
                            .any(|x| x["id"] == l["book_id"] && x["genre"] == b["genre"])
                })
                .map(|l| match l["rank_position"].as_i64() {
                    // Top half of a reader's own ranking counts as a favorite.
                    Some(p) if p < (total_ranked + 1) / 2 => 18,
                    _ => 10,
                })
                .sum();
            let score = (54 + affinity + int(b, "friend_count") * 4).min(98);
            let mut out = b.clone();
            out["match_score"] = json!(score);
            out["reason"] = json!(if affinity > 0 {
                format!(
                    "Because you enjoy {} · {} demo friends read it",
                    text(b, "genre").to_lowercase(),
                    int(b, "friend_count")
                )
            } else {
                format!(
                    "{} demo friends read it · Explore {}",
                    int(b, "friend_count"),
                    text(b, "genre").to_lowercase()
                )
            });
            out
        })
        .collect();
    result.sort_by(|a, b| int(b, "match_score").cmp(&int(a, "match_score")));
    result
}
async fn handle(mut req: Request, env: &Env, id: &str) -> Result<Response> {
    let url = req.url()?;
    let path = url.path();
    let method = req.method();
    if path == "/api/v1/health" {
        return reply(json!({"ok":true,"backend":"rust","version":"0.1.0"}), 200);
    }
    let db = env.d1("DB")?;
    if method == Method::Get {
        if let Some(friend_id) = path.strip_prefix("/api/v1/friends/") {
            // Real readers get a v4 UUID id, but the synthetic Shakespeare
            // account (fixed id "shakespeare") is a valid friend too.
            if friend_id != "shakespeare" && Uuid::parse_str(friend_id).is_err() {
                return reply(json!({"error":"Friend not found"}), 404);
            }
            let allowed = db.prepare("SELECT 1 AS connected FROM reader_friends WHERE reader_id=? AND friend_id=?")
                .bind(&[arg(id), arg(friend_id)])?
                .first::<Value>(None).await?;
            if allowed.is_none() {
                return reply(json!({"error":"That reader is not in your friends list."}), 404);
            }
            let profile = db.prepare("SELECT id,name,goal,avatar_key FROM readers WHERE id=?")
                .bind(&[arg(friend_id)])?.first::<Value>(None).await?;
            let mut library = rows(&db, "SELECT l.*,b.title,b.author,b.genre,b.pages,b.rating AS book_rating,b.isbn,b.color,b.description FROM library l JOIN books b ON b.id=l.book_id WHERE l.reader_id=? ORDER BY CASE l.status WHEN 'reading' THEN 0 WHEN 'did-not-finish' THEN 1 WHEN 'want' THEN 2 ELSE 3 END,l.updated_at DESC,b.title", vec![arg(friend_id)]).await?;
            normalize_ratings(&mut library);
            let notes = rows(&db, "SELECT n.id,n.book_id,n.page,n.body,n.spoiler,n.created_at,b.title,b.author FROM notes n JOIN books b ON b.id=n.book_id WHERE n.reader_id=? AND n.visibility='public' ORDER BY n.created_at DESC", vec![arg(friend_id)]).await?;
            return reply(json!({"profile":profile,"library":library,"notes":notes}), 200);
        }
    }
    if method == Method::Get && path == "/api/v1/groups/mine" {
        let groups = rows(&db, "SELECT g.id,g.name,g.description,g.created_by,(SELECT COUNT(*) FROM group_members gm2 WHERE gm2.group_id=g.id) AS member_count,gp.id AS pick_id,gp.book_id AS pick_book_id,b.title AS pick_title,b.author AS pick_author FROM group_members gm JOIN groups g ON g.id=gm.group_id LEFT JOIN group_picks gp ON gp.group_id=g.id AND gp.ends_at IS NULL LEFT JOIN books b ON b.id=gp.book_id WHERE gm.reader_id=? ORDER BY g.created_at DESC", vec![arg(id)]).await?;
        return reply(json!({"groups":groups}), 200);
    }
    if method == Method::Get {
        if let Some(group_id) = path.strip_prefix("/api/v1/groups/") {
            if !group_id.is_empty() && !group_id.contains('/') {
                let member = db
                    .prepare("SELECT role FROM group_members WHERE group_id=? AND reader_id=?")
                    .bind(&[arg(group_id), arg(id)])?
                    .first::<Value>(None)
                    .await?;
                let Some(member) = member else {
                    return reply(json!({"error":"Group not found"}), 404);
                };
                let group = db
                    .prepare("SELECT * FROM groups WHERE id=?")
                    .bind(&[arg(group_id)])?
                    .first::<Value>(None)
                    .await?;
                let Some(group) = group else {
                    return reply(json!({"error":"Group not found"}), 404);
                };
                let members = rows(&db, "SELECT gm.reader_id,gm.role,r.name,r.username FROM group_members gm JOIN readers r ON r.id=gm.reader_id WHERE gm.group_id=? ORDER BY gm.role,r.name", vec![arg(group_id)]).await?;
                let current_pick = db.prepare("SELECT gp.id,gp.book_id,gp.starts_at,gp.selected_by,b.title,b.author,b.pages FROM group_picks gp JOIN books b ON b.id=gp.book_id WHERE gp.group_id=? AND gp.ends_at IS NULL")
                    .bind(&[arg(group_id)])?
                    .first::<Value>(None)
                    .await?;
                let mut progress: Vec<Value> = Vec::new();
                let mut comments: Vec<Value> = Vec::new();
                if let Some(pick) = &current_pick {
                    let pick_book_id = text(pick, "book_id");
                    progress = rows(&db, "SELECT gm.reader_id,r.name,l.status,l.page FROM group_members gm JOIN readers r ON r.id=gm.reader_id LEFT JOIN library l ON l.reader_id=gm.reader_id AND l.book_id=? WHERE gm.group_id=? ORDER BY r.name", vec![arg(pick_book_id), arg(group_id)]).await?;
                    let pick_id = text(pick, "id");
                    comments = rows(&db, "SELECT c.id,c.body,c.created_at,c.reader_id,r.name FROM group_pick_comments c JOIN readers r ON r.id=c.reader_id WHERE c.pick_id=? ORDER BY c.created_at", vec![arg(pick_id)]).await?;
                }
                let past_picks = rows(&db, "SELECT gp.id,gp.book_id,gp.starts_at,gp.ends_at,b.title,b.author FROM group_picks gp JOIN books b ON b.id=gp.book_id WHERE gp.group_id=? AND gp.ends_at IS NOT NULL ORDER BY gp.starts_at DESC", vec![arg(group_id)]).await?;
                return reply(
                    json!({"group":group,"role":text(&member,"role"),"members":members,"current_pick":current_pick,"progress":progress,"comments":comments,"past_picks":past_picks}),
                    200,
                );
            }
        }
    }
    if method == Method::Get && path == "/api/v1/agent-token" {
        let reader = db
            .prepare("SELECT agent_token_created_at FROM readers WHERE id=?")
            .bind(&[arg(id)])?
            .first::<Value>(None)
            .await?;
        let created_at = reader.as_ref().and_then(|r| r["agent_token_created_at"].as_str());
        return reply(json!({"exists":created_at.is_some(),"created_at":created_at}), 200);
    }
    if method == Method::Get && path == "/api/v1/uploads/mine" {
        let mine = rows(
            &db,
            "SELECT * FROM books WHERE uploader_reader_id=? ORDER BY title",
            vec![arg(id)],
        )
        .await?;
        return reply(json!({"books":mine}), 200);
    }
    if method == Method::Get {
        if let Some(book_id) = path
            .strip_prefix("/api/v1/uploads/")
            .and_then(|p| p.strip_suffix("/content"))
        {
            let owner = db
                .prepare("SELECT content_key FROM books WHERE id=? AND uploader_reader_id=?")
                .bind(&[arg(book_id), arg(id)])?
                .first::<Value>(None)
                .await?;
            let Some(owner) = owner else {
                return reply(json!({"error":"Not found"}), 404);
            };
            let key = text(&owner, "content_key");
            let bucket = env.bucket("UPLOADS")?;
            let object = bucket.get(key).execute().await?;
            let Some(object) = object else {
                return reply(json!({"error":"Not found"}), 404);
            };
            let Some(body) = object.body() else {
                return reply(json!({"error":"Not found"}), 404);
            };
            let bytes = body.bytes().await?;
            let mut res = Response::from_bytes(bytes)?;
            res.headers_mut().set("Content-Type", "application/pdf")?;
            res.headers_mut()
                .set("Cache-Control", "private, max-age=3600")?;
            return Ok(res);
        }
    }
    if method == Method::Get && path == "/api/v1/bootstrap" {
        let books = rows(
            &db,
            "SELECT * FROM books WHERE is_shared=1 OR uploader_reader_id=?",
            vec![arg(id)],
        )
        .await?;
        let mut library = rows(
            &db,
            "SELECT * FROM library WHERE reader_id=? ORDER BY updated_at DESC",
            vec![arg(id)],
        )
        .await?;
        normalize_ratings(&mut library);
        let notes = rows(
            &db,
            "SELECT * FROM notes WHERE reader_id=? ORDER BY page",
            vec![arg(id)],
        )
        .await?;
        let swipes = rows(&db, "SELECT * FROM swipes WHERE reader_id=?", vec![arg(id)]).await?;
        let likes = rows(
            &db,
            "SELECT activity_id FROM likes WHERE reader_id=?",
            vec![arg(id)],
        )
        .await?;
        let friends = rows(
            &db,
            "SELECT r.id,r.name,r.avatar_key,(SELECT l.book_id FROM library l WHERE l.reader_id=r.id AND l.status='reading' ORDER BY l.updated_at DESC,l.book_id LIMIT 1) AS book_id,(SELECT b.title FROM library l JOIN books b ON b.id=l.book_id WHERE l.reader_id=r.id AND l.status='reading' ORDER BY l.updated_at DESC,l.book_id LIMIT 1) AS book_title,COALESCE((SELECT CAST(MIN(100,MAX(0,l.page)*100/b.pages) AS INTEGER) FROM library l JOIN books b ON b.id=l.book_id WHERE l.reader_id=r.id AND l.status='reading' ORDER BY l.updated_at DESC,l.book_id LIMIT 1),0) AS progress FROM reader_friends rf JOIN readers r ON r.id=rf.friend_id WHERE rf.reader_id=? ORDER BY r.name",
            vec![arg(id)],
        )
        .await?;
        // The home feed's "latest chapter": friends' public notes, newest
        // first. Private notes never leave their author (filtered in SQL,
        // not just in the client).
        let friend_notes = rows(
            &db,
            "SELECT n.id,n.reader_id,r.name,r.avatar_key,n.book_id,b.title,b.author,n.page,n.body,n.spoiler,n.created_at FROM notes n JOIN readers r ON r.id=n.reader_id JOIN books b ON b.id=n.book_id JOIN reader_friends rf ON rf.friend_id=n.reader_id AND rf.reader_id=? WHERE n.visibility='public' ORDER BY n.created_at DESC LIMIT 30",
            vec![arg(id)],
        )
        .await?;
        let profile = db
            .prepare("SELECT name,username,goal,avatar_key FROM readers WHERE id=?")
            .bind(&[arg(id)])?
            .first::<Value>(None)
            .await?;
        return reply(
            json!({"reader_id":id,"profile":profile,"attributes":attributes(&library,&books),"paper_attributes":paper_attributes(&library,&books,id),"recommendations":recommendations(&books,&library,&swipes),"books":books,"library":library,"notes":notes,"likes":likes,"friends":friends,"friend_notes":friend_notes,"demo_friends":false}),
            200,
        );
    }
    if method == Method::Get && path == "/api/v1/search" {
        let q = url
            .query_pairs()
            .find(|(k, _)| k == "q")
            .map(|(_, v)| v.into_owned())
            .unwrap_or_default();
        if q.trim().len() < 2 || q.len() > 150 {
            return bad("Search must be between 2 and 150 characters");
        }
        return search_books(env, q.trim()).await;
    }
    if !matches!(method, Method::Post | Method::Put | Method::Delete) {
        return reply(json!({"error":"Not found"}), 404);
    }
    if let Some(origin) = req.headers().get("Origin")? {
        if origin != url.origin().ascii_serialization() {
            return reply(json!({"error":"Origin not allowed"}), 403);
        }
    }
    if method == Method::Put {
        if let Some(book_id) = path
            .strip_prefix("/api/v1/uploads/")
            .and_then(|p| p.strip_suffix("/content"))
        {
            let owner = db
                .prepare("SELECT content_key FROM books WHERE id=? AND uploader_reader_id=?")
                .bind(&[arg(book_id), arg(id)])?
                .first::<Value>(None)
                .await?;
            let Some(owner) = owner else {
                return reply(json!({"error":"Not found"}), 404);
            };
            let key = text(&owner, "content_key").to_string();
            let bytes = req.bytes().await?;
            if bytes.len() > 40_000_000 {
                return reply(json!({"error":"PDF is too large (40MB limit)"}), 413);
            }
            if bytes.len() < 4 || &bytes[0..4] != b"%PDF" {
                return bad("File does not look like a PDF");
            }
            let bucket = env.bucket("UPLOADS")?;
            bucket
                .put(&key, bytes)
                .http_metadata(HttpMetadata {
                    content_type: Some("application/pdf".into()),
                    ..Default::default()
                })
                .execute()
                .await?;
            return reply(json!({"ok":true}), 200);
        }
        if let Some(book_id) = path
            .strip_prefix("/api/v1/uploads/")
            .and_then(|p| p.strip_suffix("/cover"))
        {
            let owned = db
                .prepare("SELECT id FROM books WHERE id=? AND uploader_reader_id=? AND kind='paper'")
                .bind(&[arg(book_id), arg(id)])?
                .first::<Value>(None)
                .await?;
            if owned.is_none() {
                return reply(json!({"error":"Not found"}), 404);
            }
            let bytes = req.bytes().await?;
            if bytes.len() > 1_500_000 {
                return reply(json!({"error":"Cover is too large (1.5MB limit)"}), 413);
            }
            let content_type = if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
                "image/jpeg"
            } else if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
                "image/png"
            } else if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
                "image/webp"
            } else {
                return bad("Cover must be a JPEG, PNG or WebP image");
            };
            let key = format!("uploads/{id}/{book_id}.cover");
            env.bucket("UPLOADS")?
                .put(&key, bytes)
                .http_metadata(HttpMetadata {
                    content_type: Some(content_type.into()),
                    ..Default::default()
                })
                .execute()
                .await?;
            db.prepare("UPDATE books SET cover_key=? WHERE id=?")
                .bind(&[arg(&key), arg(book_id)])?
                .run()
                .await?;
            return reply(json!({"ok":true,"cover_key":key}), 200);
        }
        if path == "/api/v1/avatar" {
            let bytes = req.bytes().await?;
            if bytes.len() > 5_000_000 {
                return reply(json!({"error":"Image is too large (5MB limit)"}), 413);
            }
            let content_type = if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
                "image/jpeg"
            } else if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
                "image/png"
            } else {
                return bad("Choose a JPEG or PNG image");
            };
            let key = format!("avatars/{id}");
            let bucket = env.bucket("UPLOADS")?;
            bucket
                .put(&key, bytes)
                .http_metadata(HttpMetadata {
                    content_type: Some(content_type.into()),
                    ..Default::default()
                })
                .execute()
                .await?;
            db.prepare("UPDATE readers SET avatar_key=? WHERE id=?")
                .bind(&[arg(&key), arg(id)])?
                .run()
                .await?;
            return reply(json!({"ok":true,"avatar_key":key}), 200);
        }
    }
    let body = req.text().await?;
    let body_limit = if path == "/api/v1/import/goodreads" { 2_000_000 } else { 16000 };
    if body.len() > body_limit {
        return reply(json!({"error":"Request too large"}), 413);
    }
    let v: Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(_) => return bad("Expected a JSON body"),
    };
    if path == "/api/v1/username" && method == Method::Put {
        let username = text(&v, "username").trim().to_ascii_lowercase();
        if !valid_username(&username) {
            return bad("Username must be 3–20 characters using letters, numbers, or underscores");
        }
        let result = db
            .prepare("UPDATE readers SET username=?,name=? WHERE id=?")
            .bind(&[arg(&username), arg(&username), arg(id)])?
            .run()
            .await;
        if let Err(error) = result {
            if error.to_string().contains("UNIQUE constraint failed") {
                return reply(
                    json!({"error":"That username is already taken. Choose another one."}),
                    409,
                );
            }
            return Err(error);
        }
        return reply(json!({"ok":true}), 200);
    }
    if path == "/api/v1/import/goodreads" && method == Method::Post {
        let Some(records) = v.get("records").and_then(Value::as_array) else {
            return bad("Choose a Goodreads CSV export first");
        };
        if records.is_empty() || records.len() > 2000 {
            return bad("Goodreads imports must contain between 1 and 2,000 books");
        }
        let mut statements = Vec::with_capacity(records.len() * 2);
        let mut imported = 0i64;
        for record in records {
            let source_id = text(record, "goodreads_book_id").trim();
            let title = text(record, "title").trim();
            let author = text(record, "author").trim();
            let status = text(record, "status");
            let pages = int(record, "pages");
            let average = record.get("average_rating").and_then(Value::as_f64).unwrap_or(0.0);
            if source_id.is_empty() || !source_id.chars().all(|c| c.is_ascii_digit()) || title.is_empty() || title.len() > 250 || author.len() > 150 || !["reading", "want", "read", "did-not-finish"].contains(&status) || !(1..=20000).contains(&pages) {
                return bad("One Goodreads row is incomplete or invalid");
            }
            let book_id = format!("goodreads-{source_id}");
            let isbn = text(record, "isbn");
            let description = text(record, "description");
            let review = text(record, "review");
            let started = text(record, "started_at");
            let finished = text(record, "finished_at");
            let history = record.get("history").cloned().unwrap_or_else(|| json!({})).to_string();
            statements.push(db.prepare("INSERT OR IGNORE INTO books(id,title,author,genre,pages,rating,isbn,color,friend_count,description) VALUES (?,?,?,'Uncategorized',?,?,?,'#8f9f70',0,?)").bind(&[arg(&book_id), arg(title), arg(author), num(pages), real(average.clamp(0.0, 5.0)), arg(isbn), arg(description)])?);
            let page = if status == "read" { pages } else { 0 };
            // The imported Goodreads star rating has no equivalent here: ratings are
            // now derived from a reader's own relative ranking, not an absolute number.
            statements.push(db.prepare("INSERT OR IGNORE INTO library(reader_id,book_id,status,page,review,started_at,finished_at,reading_history) VALUES (?,?,?,?,?,?,?,?)").bind(&[arg(id), arg(&book_id), arg(status), num(page), arg(review), if started.is_empty() { wasm_bindgen::JsValue::NULL } else { arg(started) }, if finished.is_empty() { wasm_bindgen::JsValue::NULL } else { arg(finished) }, arg(&history)])?);
            imported += 1;
        }
        db.batch(statements).await?;
        return reply(json!({"ok":true,"records":imported}), 201);
    }
    if path == "/api/v1/profile" && method == Method::Put {
        // Two callers share this endpoint: the reading-goal settings form
        // (name + goal together) and self-serve profile editing (name and/or
        // username, goal untouched) — each field is applied only if present.
        let goal = v.get("goal").and_then(Value::as_i64);
        let name = v.get("name").map(|_| text(&v, "name").trim().to_string());
        let username = v
            .get("username")
            .and_then(Value::as_str)
            .map(|s| s.trim().to_ascii_lowercase());
        if let Some(g) = goal {
            if !(1..=500).contains(&g) {
                return bad("Goal must be between 1 and 500");
            }
        }
        if let Some(ref n) = name {
            if n.is_empty() || n.chars().count() > 60 {
                return bad("Enter a name between 1 and 60 characters");
            }
        }
        if let Some(ref u) = username {
            if !valid_username(u) {
                return bad("Username must be 3–20 characters using letters, numbers, or underscores");
            }
        }
        if goal.is_none() && name.is_none() && username.is_none() {
            return bad("Nothing to update");
        }
        let result = db
            .prepare("UPDATE readers SET name=COALESCE(?,name),goal=COALESCE(?,goal),username=COALESCE(?,username) WHERE id=?")
            .bind(&[
                name.as_deref().map(arg).unwrap_or(wasm_bindgen::JsValue::NULL),
                goal.map(num).unwrap_or(wasm_bindgen::JsValue::NULL),
                username.as_deref().map(arg).unwrap_or(wasm_bindgen::JsValue::NULL),
                arg(id),
            ])?
            .run()
            .await;
        if let Err(error) = result {
            if error.to_string().contains("UNIQUE constraint failed") {
                return reply(
                    json!({"error":"That username is already taken. Choose another one."}),
                    409,
                );
            }
            return Err(error);
        }
        return reply(json!({"ok":true}), 200);
    }
    if path == "/api/v1/likes" && method == Method::Post {
        // Activities are real notes (the reader's own or a friend's public
        // one) — any other id is rejected rather than stored as junk.
        let activity = text(&v, "activity_id");
        let exists = db
            .prepare("SELECT 1 FROM notes WHERE id=?")
            .bind(&[arg(activity)])?
            .first::<Value>(None)
            .await?;
        if exists.is_none() {
            return bad("Unknown activity");
        }
        let liked = v["liked"].as_bool().unwrap_or(false);
        let sql = if liked {
            "INSERT OR IGNORE INTO likes(reader_id,activity_id) VALUES (?,?)"
        } else {
            "DELETE FROM likes WHERE reader_id=? AND activity_id=?"
        };
        db.prepare(sql)
            .bind(&[arg(id), arg(activity)])?
            .run()
            .await?;
        return reply(json!({"ok":true}), 200);
    }
    if path == "/api/v1/books/import" && method == Method::Post {
        let key = text(&v, "key");
        let title = text(&v, "title");
        let author = text(&v, "author");
        let cover = int(&v, "cover_id");
        let pages = int(&v, "pages");
        if !key.starts_with("/works/OL")
            || key.len() > 40
            || title.is_empty()
            || title.len() > 250
            || author.len() > 150
            || !(1..=20000).contains(&pages)
            || cover < 0
        {
            return bad("Invalid book details");
        }
        let book_id = key.replace("/works/", "");
        db.prepare("INSERT OR IGNORE INTO books(id,title,author,genre,pages,rating,isbn,color,friend_count,description) VALUES (?,?,?,'Fiction',?,0,?,'#60786a',0,'Added from Open Library. Reading attributes use Fiction until more genre metadata is available.')").bind(&[arg(&book_id),arg(title),arg(author),num(pages),arg(&format!("cover:{cover}"))])?.run().await?;
        return reply(json!({"id":book_id}), 201);
    }
    if path == "/api/v1/uploads" && method == Method::Post {
        let title = text(&v, "title").trim();
        let author = text(&v, "author").trim();
        let kind = text(&v, "kind");
        let pages = int(&v, "pages");
        let topic = text(&v, "topic");
        if title.is_empty()
            || title.len() > 250
            || author.len() > 150
            || !["book", "paper"].contains(&kind)
            || !(1..=20000).contains(&pages)
            || (kind == "paper" && !PAPER_TOPICS.contains(&topic))
        {
            return bad("Enter a title, author, kind, topic, and valid page count");
        }
        let book_id = Uuid::new_v4().to_string();
        let content_key = format!("uploads/{id}/{book_id}.pdf");
        db.prepare("INSERT INTO books(id,title,author,genre,pages,rating,isbn,color,friend_count,description,kind,content_key,uploader_reader_id,is_shared,topic) VALUES (?,?,?,'Uncategorized',?,0,'','#6b5b4a',0,'',?,?,?,0,?)")
            .bind(&[
                arg(&book_id),
                arg(title),
                arg(author),
                num(pages),
                arg(kind),
                arg(&content_key),
                arg(id),
                if kind == "paper" { arg(topic) } else { wasm_bindgen::JsValue::NULL },
            ])?
            .run()
            .await?;
        return reply(json!({"id":book_id,"content_key":content_key}), 201);
    }
    if path == "/api/v1/agent-token" && method == Method::Post {
        let token = generate_agent_token();
        db.prepare("UPDATE readers SET agent_token_hash=?,agent_token_created_at=CURRENT_TIMESTAMP WHERE id=?")
            .bind(&[arg(&hash_agent_token(&token)), arg(id)])?
            .run()
            .await?;
        let reader = db
            .prepare("SELECT agent_token_created_at FROM readers WHERE id=?")
            .bind(&[arg(id)])?
            .first::<Value>(None)
            .await?;
        let created_at = reader.and_then(|r| r["agent_token_created_at"].as_str().map(str::to_string));
        return reply(json!({"token":token,"created_at":created_at}), 201);
    }
    if path == "/api/v1/agent-token" && method == Method::Delete {
        db.prepare("UPDATE readers SET agent_token_hash=NULL,agent_token_created_at=NULL WHERE id=?")
            .bind(&[arg(id)])?
            .run()
            .await?;
        return reply(json!({"ok":true}), 200);
    }
    if path == "/api/v1/swipes/reset" && method == Method::Post {
        db.prepare("DELETE FROM swipes WHERE reader_id=? AND action='skip'")
            .bind(&[arg(id)])?
            .run()
            .await?;
        return reply(json!({"ok":true}), 200);
    }
    if path == "/api/v1/groups" && method == Method::Post {
        let name = text(&v, "name").trim();
        let description = text(&v, "description").trim();
        if name.is_empty() || name.len() > 100 || description.len() > 500 {
            return bad("Enter a group name (up to 100 characters)");
        }
        let group_id = Uuid::new_v4().to_string();
        db.batch(vec![
            db.prepare("INSERT INTO groups(id,name,description,created_by) VALUES (?,?,?,?)")
                .bind(&[arg(&group_id), arg(name), arg(description), arg(id)])?,
            db.prepare("INSERT INTO group_members(group_id,reader_id,role) VALUES (?,?,'owner')")
                .bind(&[arg(&group_id), arg(id)])?,
        ])
        .await?;
        return reply(json!({"id":group_id}), 201);
    }
    if method == Method::Post {
        if let Some(group_id) = path
            .strip_prefix("/api/v1/groups/")
            .and_then(|p| p.strip_suffix("/members"))
        {
            let role = db
                .prepare("SELECT role FROM group_members WHERE group_id=? AND reader_id=?")
                .bind(&[arg(group_id), arg(id)])?
                .first::<Value>(None)
                .await?;
            let Some(role) = role else {
                return reply(json!({"error":"Group not found"}), 404);
            };
            if text(&role, "role") != "owner" {
                return reply(json!({"error":"Only the group owner can add members"}), 403);
            }
            let username = text(&v, "username").trim().to_ascii_lowercase();
            let reader = db
                .prepare("SELECT id FROM readers WHERE username=?")
                .bind(&[arg(&username)])?
                .first::<Value>(None)
                .await?;
            let Some(reader) = reader else {
                return bad("No reader found with that username");
            };
            let new_member = text(&reader, "id").to_string();
            db.prepare("INSERT OR IGNORE INTO group_members(group_id,reader_id) VALUES (?,?)")
                .bind(&[arg(group_id), arg(&new_member)])?
                .run()
                .await?;
            return reply(json!({"ok":true}), 200);
        }
        if let Some(group_id) = path
            .strip_prefix("/api/v1/groups/")
            .and_then(|p| p.strip_suffix("/pick"))
        {
            let role = db
                .prepare("SELECT role FROM group_members WHERE group_id=? AND reader_id=?")
                .bind(&[arg(group_id), arg(id)])?
                .first::<Value>(None)
                .await?;
            let Some(role) = role else {
                return reply(json!({"error":"Group not found"}), 404);
            };
            if text(&role, "role") != "owner" {
                return reply(json!({"error":"Only the group owner can set the pick"}), 403);
            }
            let pick_book_id = text(&v, "book_id");
            let picked = db
                .prepare("SELECT id FROM books WHERE id=?")
                .bind(&[arg(pick_book_id)])?
                .first::<Value>(None)
                .await?;
            if picked.is_none() {
                return bad("Book not found");
            }
            let pick_id = Uuid::new_v4().to_string();
            db.batch(vec![
                db.prepare("UPDATE group_picks SET ends_at=CURRENT_TIMESTAMP WHERE group_id=? AND ends_at IS NULL")
                    .bind(&[arg(group_id)])?,
                db.prepare("INSERT INTO group_picks(id,group_id,book_id,selected_by) VALUES (?,?,?,?)")
                    .bind(&[arg(&pick_id), arg(group_id), arg(pick_book_id), arg(id)])?,
            ])
            .await?;
            return reply(json!({"id":pick_id}), 201);
        }
        if let Some(group_id) = path
            .strip_prefix("/api/v1/groups/")
            .and_then(|p| p.strip_suffix("/comments"))
        {
            let member = db
                .prepare("SELECT 1 AS ok FROM group_members WHERE group_id=? AND reader_id=?")
                .bind(&[arg(group_id), arg(id)])?
                .first::<Value>(None)
                .await?;
            if member.is_none() {
                return reply(json!({"error":"Group not found"}), 404);
            }
            let pick = db
                .prepare("SELECT id FROM group_picks WHERE group_id=? AND ends_at IS NULL")
                .bind(&[arg(group_id)])?
                .first::<Value>(None)
                .await?;
            let Some(pick) = pick else {
                return bad("This group doesn't have a current pick yet");
            };
            let comment_body = text(&v, "body").trim();
            if comment_body.is_empty() || comment_body.len() > 2000 {
                return bad("A comment needs text, up to 2000 characters");
            }
            let pick_id = text(&pick, "id").to_string();
            let comment_id = Uuid::new_v4().to_string();
            db.prepare("INSERT INTO group_pick_comments(id,pick_id,reader_id,body) VALUES (?,?,?,?)")
                .bind(&[arg(&comment_id), arg(&pick_id), arg(id), arg(comment_body)])?
                .run()
                .await?;
            return reply(json!({"ok":true,"id":comment_id}), 201);
        }
    }
    // A paper's full-text classification (src/paperTopics.ts), saved by its
    // uploader; only the uploader can label their paper.
    if method == Method::Put {
        if let Some(book_id) = path
            .strip_prefix("/api/v1/uploads/")
            .and_then(|p| p.strip_suffix("/topics"))
        {
            let Some(Value::Object(signals)) = v.get("signals") else {
                return bad("Send the paper's field signals");
            };
            let valid = signals.len() <= 12
                && signals.iter().all(|(k, n)| {
                    k.len() <= 80
                        && PAPER_TOPICS.contains(&k.split('/').next().unwrap_or(""))
                        && n.as_f64().is_some_and(|n| (0.0..=100.0).contains(&n))
                });
            if !valid {
                return bad("Unrecognized field signals");
            }
            let encoded = serde_json::to_string(signals).unwrap_or_default();
            let result = db
                .prepare("UPDATE books SET topic_signals=? WHERE id=? AND uploader_reader_id=? AND kind='paper'")
                .bind(&[arg(&encoded), arg(book_id), arg(id)])?
                .run()
                .await?;
            if result.meta()?.and_then(|m| m.changes).unwrap_or(0) == 0 {
                return reply(json!({"error":"Not found"}), 404);
            }
            return reply(json!({"ok":true}), 200);
        }
    }
    if method == Method::Delete {
        if let Some(group_id) = path
            .strip_prefix("/api/v1/groups/")
            .and_then(|p| p.strip_suffix("/members"))
        {
            let requested_target = text(&v, "reader_id");
            let target = if requested_target.is_empty() {
                id
            } else {
                requested_target
            };
            if target != id {
                let role = db
                    .prepare("SELECT role FROM group_members WHERE group_id=? AND reader_id=?")
                    .bind(&[arg(group_id), arg(id)])?
                    .first::<Value>(None)
                    .await?;
                if role.map(|r| text(&r, "role").to_string()).as_deref() != Some("owner") {
                    return reply(
                        json!({"error":"Only the group owner can remove other members"}),
                        403,
                    );
                }
            }
            db.prepare("DELETE FROM group_members WHERE group_id=? AND reader_id=?")
                .bind(&[arg(group_id), arg(target)])?
                .run()
                .await?;
            return reply(json!({"ok":true}), 200);
        }
    }
    let book_id = text(&v, "book_id");
    let book = db
        .prepare("SELECT * FROM books WHERE id=?")
        .bind(&[arg(book_id)])?
        .first::<Value>(None)
        .await?;
    let Some(book) = book else {
        return bad("Book not found");
    };
    let pages = int(&book, "pages");
    if path == "/api/v1/account" && method == Method::Delete {
        // Full self-service erase of everything this app stores for the reader
        // (D1 rows + R2 objects). Deliberately does not touch the Supabase auth
        // identity: the Worker never holds a privileged Supabase key (see
        // AGENTS.md), so a reader who signs back in gets a fresh, empty account.
        let owned = db
            .prepare("SELECT avatar_key, (SELECT GROUP_CONCAT(k) FROM (SELECT content_key AS k FROM books WHERE uploader_reader_id=readers.id AND content_key IS NOT NULL UNION ALL SELECT cover_key FROM books WHERE uploader_reader_id=readers.id AND cover_key IS NOT NULL)) AS upload_keys FROM readers WHERE id=?")
            .bind(&[arg(id)])?
            .first::<Value>(None)
            .await?;
        let mut object_keys: Vec<String> = Vec::new();
        if let Some(owned) = &owned {
            if let Some(avatar_key) = owned.get("avatar_key").and_then(Value::as_str) {
                object_keys.push(avatar_key.to_string());
            }
            if let Some(upload_keys) = owned.get("upload_keys").and_then(Value::as_str) {
                object_keys.extend(upload_keys.split(',').map(str::to_string));
            }
        }
        let mut statements = Vec::with_capacity(ACCOUNT_DELETE_SQL.len());
        for statement in ACCOUNT_DELETE_SQL {
            statements.push(db.prepare(*statement).bind(&[arg(id)])?);
        }
        db.batch(statements).await?;
        if !object_keys.is_empty() {
            if let Ok(bucket) = env.bucket("UPLOADS") {
                // Best-effort: the account's D1 data is already gone, which is
                // what actually matters for "delete my account"; an orphaned
                // R2 object afterward is a storage leak, not a privacy issue.
                let _ = bucket.delete_multiple(object_keys).await;
            }
        }
        return reply(json!({"ok":true}), 200);
    }
    if path == "/api/v1/library" && method == Method::Delete {
        db.batch(vec![
            // Removing a ranked book leaves a gap in the reader's ranking; close it.
            db.prepare("UPDATE library SET rank_position=rank_position-1 WHERE reader_id=? AND rank_position > (SELECT rank_position FROM library WHERE reader_id=? AND book_id=?)")
                .bind(&[arg(id), arg(id), arg(book_id)])?,
            db.prepare("DELETE FROM library WHERE reader_id=? AND book_id=?")
                .bind(&[arg(id), arg(book_id)])?,
            db.prepare("DELETE FROM swipes WHERE reader_id=? AND book_id=?")
                .bind(&[arg(id), arg(book_id)])?,
        ])
        .await?;
        return reply(json!({"ok":true}), 200);
    }
    if path == "/api/v1/library" && method == Method::Put {
        let status = text(&v, "status");
        let page = int(&v, "page");
        let review = text(&v, "review");
        if !["reading", "want", "read", "did-not-finish"].contains(&status)
            || page < 0
            || page > pages
            || review.len() > 5000
        {
            return bad("Invalid shelf, page, or review");
        }
        let p = if status == "read" {
            pages
        } else if status == "want" || status == "did-not-finish" {
            0
        } else {
            page
        };
        // Built up client-side as a paper's pages are read (keyword hits per
        // subtopic); optional, and merged rather than overwritten when absent
        // so a plain progress update never erases prior signal.
        let topic_signals = match v.get("topic_signals") {
            Some(Value::Object(m)) if serde_json::to_string(m).map(|s| s.len()).unwrap_or(9999) <= 3000 => {
                Some(serde_json::to_string(m).unwrap_or_default())
            }
            _ => None,
        };
        db.batch(vec![
            // Leaving the finished shelf also leaves the ranking; close the gap it left behind.
            db.prepare("UPDATE library SET rank_position=rank_position-1 WHERE reader_id=? AND ?!='read' AND rank_position > (SELECT rank_position FROM library WHERE reader_id=? AND book_id=?)")
                .bind(&[arg(id), arg(status), arg(id), arg(book_id)])?,
            db.prepare("INSERT INTO library(reader_id,book_id,status,page,review,topic_signals,started_at,finished_at) VALUES (?,?,?,?,?,COALESCE(?,'{}'),CASE WHEN ? IN ('reading','read','did-not-finish') THEN CURRENT_TIMESTAMP ELSE NULL END,CASE WHEN ?='read' THEN CURRENT_TIMESTAMP ELSE NULL END) ON CONFLICT(reader_id,book_id) DO UPDATE SET status=excluded.status,page=excluded.page,review=excluded.review,topic_signals=COALESCE(?,library.topic_signals),rank_position=CASE WHEN excluded.status='read' THEN library.rank_position ELSE NULL END,updated_at=CURRENT_TIMESTAMP,started_at=CASE WHEN excluded.status='reading' THEN COALESCE(library.started_at,CURRENT_TIMESTAMP) WHEN excluded.status='want' THEN NULL ELSE library.started_at END,finished_at=CASE WHEN excluded.status='read' THEN COALESCE(library.finished_at,CURRENT_TIMESTAMP) ELSE NULL END")
                .bind(&[arg(id),arg(book_id),arg(status),num(p),arg(review),opt_arg(&topic_signals),arg(status),arg(status),opt_arg(&topic_signals)])?,
        ])
        .await?;
        return reply(json!({"ok":true}), 200);
    }
    if path == "/api/v1/library/rank" && method == Method::Put {
        let Some(rank_position) = v["rank_position"].as_i64() else {
            return bad("rank_position is required");
        };
        let existing = db
            .prepare("SELECT status, rank_position FROM library WHERE reader_id=? AND book_id=?")
            .bind(&[arg(id), arg(book_id)])?
            .first::<Value>(None)
            .await?;
        let Some(existing) = existing else {
            return bad("Finish the book before ranking it");
        };
        if text(&existing, "status") != "read" {
            return bad("Finish the book before ranking it");
        }
        let old_rank = existing.get("rank_position").and_then(Value::as_i64);
        let other_ranked = rows(
            &db,
            "SELECT COUNT(*) as n FROM library WHERE reader_id=? AND rank_position IS NOT NULL AND book_id!=?",
            vec![arg(id), arg(book_id)],
        )
        .await?
        .first()
        .map(|r| int(r, "n"))
        .unwrap_or(0);
        if rank_position < 0 || rank_position > other_ranked {
            return bad("Invalid rank position");
        }
        let mut statements = Vec::new();
        if let Some(old) = old_rank {
            // Close the gap this book's previous position leaves before reinserting it.
            statements.push(
                db.prepare("UPDATE library SET rank_position=rank_position-1 WHERE reader_id=? AND rank_position>?")
                    .bind(&[arg(id), num(old)])?,
            );
        }
        statements.push(
            db.prepare("UPDATE library SET rank_position=rank_position+1 WHERE reader_id=? AND rank_position>=? AND book_id!=?")
                .bind(&[arg(id), num(rank_position), arg(book_id)])?,
        );
        statements.push(
            db.prepare("UPDATE library SET rank_position=? WHERE reader_id=? AND book_id=?")
                .bind(&[num(rank_position), arg(id), arg(book_id)])?,
        );
        db.batch(statements).await?;
        return reply(json!({"ok":true}), 200);
    }
    if path == "/api/v1/notes" && method == Method::Post {
        let page = int(&v, "page");
        let note = text(&v, "body").trim();
        let visibility = if text(&v, "visibility") == "private" {
            "private"
        } else {
            "public"
        };
        if page < 0 || page > pages || note.is_empty() || note.len() > 2000 {
            return bad("A thought needs text and a valid page");
        }
        // Optional PDF highlight: the quoted passage plus page-relative rects
        // (fractions 0..1), re-serialized so only well-formed numbers persist.
        let quote = text(&v, "quote").trim();
        let quote = if quote.is_empty() { None } else { Some(quote.chars().take(2000).collect::<String>()) };
        let anchor = v["anchor"]["rects"].as_array().and_then(|list| {
            let rects: Vec<Vec<f64>> = list
                .iter()
                .take(64)
                .filter_map(|r| {
                    let r: Vec<f64> = r.as_array()?.iter().filter_map(Value::as_f64).collect();
                    (r.len() == 4 && r.iter().all(|n| (0.0..=1.0).contains(n))).then_some(r)
                })
                .collect();
            (!rects.is_empty()).then(|| json!({"v":1,"rects":rects}).to_string())
        });
        let note_id = Uuid::new_v4().to_string();
        db.batch(vec![
            // A comment implies the reader is engaging with the book; if it
            // isn't on their shelf yet, put it on "reading" first rather than
            // rejecting the comment outright.
            db.prepare("INSERT OR IGNORE INTO library(reader_id,book_id,status,page,review,started_at) VALUES (?,?,'reading',0,'',CURRENT_TIMESTAMP)")
                .bind(&[arg(id), arg(book_id)])?,
            db.prepare(
                "INSERT INTO notes(id,reader_id,book_id,page,body,spoiler,visibility,quote,anchor) VALUES (?,?,?,?,?,?,?,?,?)",
            )
            .bind(&[
                arg(&note_id),
                arg(id),
                arg(book_id),
                num(page),
                arg(note),
                num(if v["spoiler"].as_bool().unwrap_or(false) {
                    1
                } else {
                    0
                }),
                arg(visibility),
                opt_arg(&quote),
                opt_arg(&anchor),
            ])?,
        ])
        .await?;
        return reply(json!({"ok":true,"id":note_id}), 201);
    }
    if path == "/api/v1/swipes" && method == Method::Post {
        let action = text(&v, "action");
        if !["skip", "want", "read"].contains(&action) {
            return bad("Invalid swipe");
        }
        let mut statements=vec![db.prepare("INSERT INTO swipes(reader_id,book_id,action) VALUES (?,?,?) ON CONFLICT(reader_id,book_id) DO UPDATE SET action=excluded.action").bind(&[arg(id),arg(book_id),arg(action)])?];
        if action != "skip" {
            statements.push(db.prepare("INSERT OR IGNORE INTO library(reader_id,book_id,status,page,finished_at) VALUES (?,?,?,?,CASE WHEN ?='read' THEN CURRENT_TIMESTAMP ELSE NULL END)").bind(&[arg(id),arg(book_id),arg(action),num(if action=="read"{pages}else{0}),arg(action)])?);
        }
        db.batch(statements).await?;
        return reply(json!({"ok":true}), 200);
    }
    reply(json!({"error":"Not found"}), 404)
}
#[event(fetch)]
pub async fn main(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    console_error_panic_hook::set_once();
    if !req.path().starts_with("/api/") {
        return env.assets("ASSETS")?.fetch_request(req).await;
    }
    let response = authenticated(&req, &env).await;
    let mut res = match response {
        Ok(r) => r,
        Err(e) => {
            console_error!("{}", json!({"event":"api_error","message":e.to_string()}));
            reply(
                json!({"error":"Something went wrong. Please try again."}),
                500,
            )?
        }
    };
    if !req.path().starts_with("/api/v1/covers/") {
        res.headers_mut().set("Cache-Control", "no-store")?;
    }
    res.headers_mut().set("X-Content-Type-Options", "nosniff")?;
    Ok(res)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recommendations_exclude_shelves_and_skips() {
        let books = vec![
            json!({"id":"a","genre":"Fiction","friend_count":2,"is_shared":1}),
            json!({"id":"b","genre":"History","friend_count":1,"is_shared":1}),
            json!({"id":"c","genre":"Fiction","friend_count":3,"is_shared":1}),
        ];
        let library = vec![json!({"book_id":"a","status":"read","rank_position":0})];
        let swipes = vec![json!({"book_id":"b"})];
        let result = recommendations(&books, &library, &swipes);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["id"], "c");
        assert_eq!(result[0]["match_score"], 84);
    }
    #[test]
    fn recommendations_exclude_personal_uploads() {
        let books = vec![
            json!({"id":"a","genre":"Fiction","friend_count":2,"is_shared":1}),
            json!({"id":"b","genre":"Fiction","friend_count":5,"is_shared":0}),
        ];
        let result = recommendations(&books, &[], &[]);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["id"], "a");
    }
    #[test]
    fn normalized_ratings_hide_until_threshold_then_spread_one_to_five() {
        let mut library: Vec<Value> = (0..4)
            .map(|p| json!({"book_id":p.to_string(),"rank_position":p}))
            .collect();
        normalize_ratings(&mut library);
        assert!(library.iter().all(|l| l["normalized_rating"].is_null()));
        library.push(json!({"book_id":"4","rank_position":4}));
        normalize_ratings(&mut library);
        assert_eq!(library[0]["normalized_rating"], 5.0);
        assert_eq!(library[4]["normalized_rating"], 1.0);
        assert_eq!(library[2]["ranked_total"], 5);
    }
    #[test]
    fn paper_attributes_only_count_papers_by_topic() {
        let books = vec![
            json!({"id":"a","kind":"paper","topic":"Physics"}),
            json!({"id":"b","kind":"book","genre":"Fiction"}),
        ];
        let library = vec![
            json!({"book_id":"a","status":"read"}),
            json!({"book_id":"b","status":"read"}),
        ];
        let result = paper_attributes(&library, &books, "me");
        assert_eq!(result[0]["label"], "Physics");
        assert_eq!(result[0]["kind"], "domain");
        assert_eq!(result[0]["value"], 99);
        assert_eq!(result.as_array().unwrap().len(), 6);
        assert!(result.as_array().unwrap()[1..].iter().all(|r| r["value"] == 15));
    }
    #[test]
    fn paper_attributes_use_full_text_fields_weighted_by_progress() {
        let books = vec![
            json!({"id":"a","kind":"paper","topic":"Computer Science","topic_signals":"{\"Computer Science/Machine Learning\":60,\"Computer Science/Natural Language Processing\":40}"}),
            json!({"id":"b","kind":"paper","topic":"Mathematics","topic_signals":"{\"Mathematics/Analysis\":100}","uploader_reader_id":"me"}),
            json!({"id":"c","kind":"paper","topic":"Physics","topic_signals":"{\"Physics/Quantum Physics\":100}"}),
        ];
        // a finished, b is my unshelved upload, c is someone else's paper I never shelved.
        let library = vec![json!({"book_id":"a","status":"read"})];
        let result = paper_attributes(&library, &books, "me");
        let labels: Vec<&str> = result.as_array().unwrap().iter().map(|r| r["label"].as_str().unwrap()).collect();
        assert_eq!(labels, ["Machine Learning", "Natural Language Processing", "Analysis"]);
        assert_eq!(result[0]["domain"], "Computer Science");
        assert_eq!(result[0]["value"], 99);
        assert_eq!(result[0]["kind"], "field");
    }
    #[test]
    fn search_queries_drop_stopwords_and_prefix_only_longer_words() {
        assert_eq!(fts_query("Klara and the Sun").as_deref(), Some("\"klara\" \"sun\"*"));
        assert_eq!(fts_query("The Dark Forest").as_deref(), Some("\"dark\" \"forest\"*"));
        assert_eq!(fts_query("dune ha").as_deref(), Some("\"dune\" \"ha\""));
        assert_eq!(fts_query("the"), None);
        assert_eq!(fts_query("\"); DROP TABLE x; --").as_deref(), Some("\"drop\" \"table\" \"x\""));
        assert_eq!(clean_author("by Cixin Liu ; translated by Ken Liu."), "Cixin Liu");
    }
    #[test]
    fn attributes_ignore_wishlist_and_cap_scores() {
        let books = vec![json!({"id":"a","genre":"Fiction"})];
        let want = vec![json!({"book_id":"a","status":"want"})];
        assert_eq!(attributes(&want, &books)[0]["value"], 15);
        let read = vec![json!({"book_id":"a","status":"read"}); 20];
        assert_eq!(attributes(&read, &books)[0]["value"], 99);
    }
}
