use serde_json::{json, Value};
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
fn num(n: i64) -> wasm_bindgen::JsValue {
    (n as f64).into()
}
fn real(n: f64) -> wasm_bindgen::JsValue {
    n.into()
}
// Never accept browser-supplied reader IDs. Supabase verifies the bearer token;
// D1 owns the application identity and every reading record.
async fn authenticated(req: &Request, env: &Env) -> Result<Response> {
    let path = req.path();
    if path == "/api/v1/health" {
        return reply(json!({"ok":true,"backend":"rust","version":"0.2.0"}), 200);
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
    let id = text(&reader, "id");
    handle(req.clone()?, env, id).await
}
fn valid_username(username: &str) -> bool {
    (3..=20).contains(&username.len())
        && username
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
}
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
const PAPER_TOPICS: [&str; 6] = [
    "Computer Science",
    "Physics & Math",
    "Life Sciences",
    "Social Sciences",
    "Economics",
    "Humanities",
];
fn topic_attribute(topic: &str) -> usize {
    PAPER_TOPICS.iter().position(|t| *t == topic).unwrap_or(5)
}
// A separate radar from the book attributes above: areas of academic learning,
// scored only from uploaded papers (kind="paper"), never books.
fn paper_attributes(library: &[Value], books: &[Value]) -> Value {
    let mut scores = [15i64; 6];
    for item in library {
        if matches!(text(item, "status"), "want" | "did-not-finish") {
            continue;
        }
        if let Some(b) = books
            .iter()
            .find(|b| b["id"] == item["book_id"] && text(b, "kind") == "paper")
        {
            let weight = if text(item, "status") == "read" {
                18
            } else {
                8
            };
            scores[topic_attribute(text(b, "topic"))] += weight;
        }
    }
    json!(PAPER_TOPICS
        .iter()
        .enumerate()
        .map(|(i, label)| json!({"label":label,"value":scores[i].min(99)}))
        .collect::<Vec<_>>())
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
            if Uuid::parse_str(friend_id).is_err() {
                return reply(json!({"error":"Friend not found"}), 404);
            }
            let allowed = db.prepare("SELECT 1 AS connected FROM reader_friends WHERE reader_id=? AND friend_id=?")
                .bind(&[arg(id), arg(friend_id)])?
                .first::<Value>(None).await?;
            if allowed.is_none() {
                return reply(json!({"error":"That reader is not in your friends list."}), 404);
            }
            let profile = db.prepare("SELECT id,name,goal FROM readers WHERE id=?")
                .bind(&[arg(friend_id)])?.first::<Value>(None).await?;
            let mut library = rows(&db, "SELECT l.*,b.title,b.author,b.genre,b.pages,b.rating AS book_rating,b.isbn,b.color,b.description FROM library l JOIN books b ON b.id=l.book_id WHERE l.reader_id=? ORDER BY CASE l.status WHEN 'reading' THEN 0 WHEN 'did-not-finish' THEN 1 WHEN 'want' THEN 2 ELSE 3 END,l.updated_at DESC,b.title", vec![arg(friend_id)]).await?;
            normalize_ratings(&mut library);
            let notes = rows(&db, "SELECT n.id,n.book_id,n.page,n.body,n.spoiler,n.created_at,b.title,b.author FROM notes n JOIN books b ON b.id=n.book_id WHERE n.reader_id=? AND n.visibility='public' ORDER BY n.created_at DESC", vec![arg(friend_id)]).await?;
            return reply(json!({"profile":profile,"library":library,"notes":notes}), 200);
        }
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
            "SELECT r.id,r.name,(SELECT l.book_id FROM library l WHERE l.reader_id=r.id AND l.status='reading' ORDER BY l.updated_at DESC,l.book_id LIMIT 1) AS book_id,(SELECT b.title FROM library l JOIN books b ON b.id=l.book_id WHERE l.reader_id=r.id AND l.status='reading' ORDER BY l.updated_at DESC,l.book_id LIMIT 1) AS book_title,COALESCE((SELECT CAST(MIN(100,MAX(0,l.page)*100/b.pages) AS INTEGER) FROM library l JOIN books b ON b.id=l.book_id WHERE l.reader_id=r.id AND l.status='reading' ORDER BY l.updated_at DESC,l.book_id LIMIT 1),0) AS progress FROM reader_friends rf JOIN readers r ON r.id=rf.friend_id WHERE rf.reader_id=? ORDER BY r.name",
            vec![arg(id)],
        )
        .await?;
        let profile = db
            .prepare("SELECT name,username,goal FROM readers WHERE id=?")
            .bind(&[arg(id)])?
            .first::<Value>(None)
            .await?;
        return reply(
            json!({"reader_id":id,"profile":profile,"attributes":attributes(&library,&books),"paper_attributes":paper_attributes(&library,&books),"recommendations":recommendations(&books,&library,&swipes),"books":books,"library":library,"notes":notes,"likes":likes,"friends":friends,"demo_friends":false}),
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
        let mut upstream = Url::parse("https://openlibrary.org/search.json")?;
        upstream
            .query_pairs_mut()
            .append_pair("q", q.trim())
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
            return reply(
                json!({"error":"The book catalog is taking a break. Try again shortly."}),
                502,
            );
        }
        let data: Value = res.json().await?;
        return reply(json!({"results":data["docs"],"source":"Open Library"}), 200);
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
        let goal = int(&v, "goal");
        let name = text(&v, "name").trim();
        if !(1..=500).contains(&goal) || name.is_empty() || name.len() > 60 {
            return bad("Enter a name and a goal between 1 and 500");
        }
        db.prepare("UPDATE readers SET name=?,goal=? WHERE id=?")
            .bind(&[arg(name), num(goal), arg(id)])?
            .run()
            .await?;
        return reply(json!({"ok":true}), 200);
    }
    if path == "/api/v1/likes" && method == Method::Post {
        let activity = text(&v, "activity_id");
        if !["maya", "james", "sophie", "leo"].contains(&activity) {
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
    if path == "/api/v1/swipes/reset" && method == Method::Post {
        db.prepare("DELETE FROM swipes WHERE reader_id=? AND action='skip'")
            .bind(&[arg(id)])?
            .run()
            .await?;
        return reply(json!({"ok":true}), 200);
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
        db.batch(vec![
            // Leaving the finished shelf also leaves the ranking; close the gap it left behind.
            db.prepare("UPDATE library SET rank_position=rank_position-1 WHERE reader_id=? AND ?!='read' AND rank_position > (SELECT rank_position FROM library WHERE reader_id=? AND book_id=?)")
                .bind(&[arg(id), arg(status), arg(id), arg(book_id)])?,
            db.prepare("INSERT INTO library(reader_id,book_id,status,page,review,started_at,finished_at) VALUES (?,?,?,?,?,CASE WHEN ? IN ('reading','read','did-not-finish') THEN CURRENT_TIMESTAMP ELSE NULL END,CASE WHEN ?='read' THEN CURRENT_TIMESTAMP ELSE NULL END) ON CONFLICT(reader_id,book_id) DO UPDATE SET status=excluded.status,page=excluded.page,review=excluded.review,rank_position=CASE WHEN excluded.status='read' THEN library.rank_position ELSE NULL END,updated_at=CURRENT_TIMESTAMP,started_at=CASE WHEN excluded.status='reading' THEN COALESCE(library.started_at,CURRENT_TIMESTAMP) WHEN excluded.status='want' THEN NULL ELSE library.started_at END,finished_at=CASE WHEN excluded.status='read' THEN COALESCE(library.finished_at,CURRENT_TIMESTAMP) ELSE NULL END")
                .bind(&[arg(id),arg(book_id),arg(status),num(p),arg(review),arg(status),arg(status)])?,
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
        let note_id = Uuid::new_v4().to_string();
        db.prepare(
            "INSERT INTO notes(id,reader_id,book_id,page,body,spoiler,visibility) VALUES (?,?,?,?,?,?,?)",
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
        ])?
        .run()
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
    res.headers_mut().set("Cache-Control", "no-store")?;
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
            json!({"id":"a","kind":"paper","topic":"Physics & Math"}),
            json!({"id":"b","kind":"book","genre":"Fiction"}),
        ];
        let library = vec![
            json!({"book_id":"a","status":"read"}),
            json!({"book_id":"b","status":"read"}),
        ];
        let result = paper_attributes(&library, &books);
        assert_eq!(result[1]["label"], "Physics & Math");
        assert_eq!(result[1]["value"], 33);
        assert_eq!(result[0]["value"], 15);
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
