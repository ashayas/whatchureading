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
// Never accept browser-supplied reader IDs. Supabase verifies the bearer token;
// D1 owns the application identity and every reading record.
async fn authenticated(req: &Request, env: &Env) -> Result<Response> {
    let path = req.path();
    if path == "/api/v1/health" {
        return reply(json!({"ok":true,"backend":"rust","version":"0.2.0"}), 200);
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
fn attributes(library: &[Value], books: &[Value]) -> Value {
    let mut scores = [15i64; 6];
    for item in library {
        if text(item, "status") == "want" {
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
    let mut result: Vec<Value> = books
        .iter()
        .filter(|b| {
            !library.iter().any(|l| l["book_id"] == b["id"])
                && !swipes.iter().any(|s| s["book_id"] == b["id"])
        })
        .map(|b| {
            let affinity: i64 = library
                .iter()
                .filter(|l| {
                    text(l, "status") != "want"
                        && books
                            .iter()
                            .any(|x| x["id"] == l["book_id"] && x["genre"] == b["genre"])
                })
                .map(|l| if int(l, "rating") >= 4 { 18 } else { 10 })
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
    if method == Method::Get && path == "/api/v1/bootstrap" {
        let books = rows(&db, "SELECT * FROM books", vec![]).await?;
        let library = rows(
            &db,
            "SELECT * FROM library WHERE reader_id=? ORDER BY updated_at DESC",
            vec![arg(id)],
        )
        .await?;
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
        let profile = db
            .prepare("SELECT name,goal FROM readers WHERE id=?")
            .bind(&[arg(id)])?
            .first::<Value>(None)
            .await?;
        return reply(
            json!({"reader_id":id,"profile":profile,"attributes":attributes(&library,&books),"recommendations":recommendations(&books,&library,&swipes),"books":books,"library":library,"notes":notes,"likes":likes,"demo_friends":true}),
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
    let body = req.text().await?;
    if body.len() > 16000 {
        return reply(json!({"error":"Request too large"}), 413);
    }
    let v: Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(_) => return bad("Expected a JSON body"),
    };
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
        let rating = v["rating"].as_i64();
        let review = text(&v, "review");
        if !["reading", "want", "read"].contains(&status)
            || page < 0
            || page > pages
            || review.len() > 5000
            || rating.is_some_and(|r| !(1..=5).contains(&r))
        {
            return bad("Invalid shelf, page, rating, or review");
        }
        let p = if status == "read" {
            pages
        } else if status == "want" {
            0
        } else {
            page
        };
        db.prepare("INSERT INTO library(reader_id,book_id,status,page,rating,review,finished_at) VALUES (?,?,?,?,?,?,CASE WHEN ?='read' THEN CURRENT_TIMESTAMP ELSE NULL END) ON CONFLICT(reader_id,book_id) DO UPDATE SET status=excluded.status,page=excluded.page,rating=excluded.rating,review=excluded.review,updated_at=CURRENT_TIMESTAMP,finished_at=CASE WHEN excluded.status='read' THEN COALESCE(library.finished_at,CURRENT_TIMESTAMP) ELSE NULL END").bind(&[arg(id),arg(book_id),arg(status),num(p),rating.map(num).unwrap_or(wasm_bindgen::JsValue::NULL),arg(review),arg(status)])?.run().await?;
        return reply(json!({"ok":true}), 200);
    }
    if path == "/api/v1/notes" && method == Method::Post {
        let page = int(&v, "page");
        let note = text(&v, "body").trim();
        if page < 0 || page > pages || note.is_empty() || note.len() > 2000 {
            return bad("A thought needs text and a valid page");
        }
        let note_id = Uuid::new_v4().to_string();
        db.prepare(
            "INSERT INTO notes(id,reader_id,book_id,page,body,spoiler) VALUES (?,?,?,?,?,?)",
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
            json!({"id":"a","genre":"Fiction","friend_count":2}),
            json!({"id":"b","genre":"History","friend_count":1}),
            json!({"id":"c","genre":"Fiction","friend_count":3}),
        ];
        let library = vec![json!({"book_id":"a","status":"read","rating":5})];
        let swipes = vec![json!({"book_id":"b"})];
        let result = recommendations(&books, &library, &swipes);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["id"], "c");
        assert_eq!(result[0]["match_score"], 84);
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
