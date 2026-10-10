import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { checkedConfig } from "./env.mjs";

const args = process.argv.slice(2);
function option(name) {
  const i = args.indexOf(name);
  return i < 0 ? null : args[i + 1] || null;
}
const input = option("--input");
const goodreadsId = option("--goodreads-user-id");
const supabaseId = option("--supabase-user-id");
const readerId = option("--reader-id");
const apply = args.includes("--apply");
if (!input || !goodreadsId || !supabaseId || !readerId) {
  throw new Error(
    "Usage: node scripts/goodreads-import.mjs --input FILE --goodreads-user-id ID --supabase-user-id UUID --reader-id UUID [--apply]",
  );
}

const expectedAccount = "REDACTED-CF-ACCOUNT-ID";
const expectedDatabase = "REDACTED-CF-D1-DATABASE-ID";
const config = checkedConfig();
if (
  config.account_id !== expectedAccount ||
  config.d1_databases?.[0]?.database_id !== expectedDatabase
) {
  throw new Error("Refusing import: Wrangler is not pointed at the approved D1 target.");
}
if (!/^\d+$/.test(goodreadsId) || !/^[\da-f-]{36}$/i.test(supabaseId) || !/^[\da-f-]{36}$/i.test(readerId)) {
  throw new Error("Invalid Goodreads user ID or app identity.");
}

const staged = JSON.parse(fs.readFileSync(input, "utf8"));
if (String(staged.goodreads_user_id) !== goodreadsId || !Array.isArray(staged.records)) {
  throw new Error("Staged Goodreads subject does not match --goodreads-user-id.");
}
if (!staged.records.length || new Set(staged.records.map((r) => r.goodreads_review_id)).size !== staged.records.length) {
  throw new Error("Staged file is empty or contains duplicate Goodreads review IDs.");
}

function sqlString(value) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}
function query(sql) {
  const raw = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "DB", "--remote", "--command", sql, "--json"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const parsed = JSON.parse(raw);
  const results = parsed[0]?.results;
  if (!Array.isArray(results)) throw new Error("Unexpected D1 query response.");
  return results;
}

const reader = query(
  `SELECT id FROM readers WHERE id=${sqlString(readerId)} AND supabase_user_id=${sqlString(supabaseId)}`,
);
if (reader.length !== 1) throw new Error("App reader and Supabase user do not match exactly.");
const catalog = query("SELECT id,title,author,isbn FROM books");
const byIsbn = new Map();
const byTitle = new Map();
function normalize(value) {
  return String(value || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
}
function titleKeys(value) {
  const title = String(value || "");
  // Keep subtitles: stripping at ':' collapses unrelated series entries such
  // as Dune: The Duke of Caladan and Dune: The Lady of Caladan.
  const variants = [title, title.split(" (", 1)[0]];
  return [...new Set(variants.map(normalize).filter(Boolean))];
}
function authorKey(value) {
  const names = String(value || "").split(",").map((part) => part.trim());
  return normalize(names.length === 2 ? `${names[1]} ${names[0]}` : value);
}
for (const book of catalog) {
  const isbn = String(book.isbn || "").replace(/\D/g, "");
  if (isbn) byIsbn.set(isbn, [...(byIsbn.get(isbn) || []), book]);
  for (const title of titleKeys(book.title)) {
    byTitle.set(title, [...(byTitle.get(title) || []), book]);
  }
}

function sourceDate(record, slot) {
  const dates = record.dates?.[slot];
  return Array.isArray(dates) ? dates.find((date) => date?.value)?.value || null : null;
}
function pagesOf(record) {
  const raw = String(record.fields?.num_pages || record.rss?.pages || "");
  const pages = Number.parseInt(raw.replaceAll(",", "").match(/\d+/)?.[0] || "", 10);
  return Number.isFinite(pages) && pages > 0 ? pages : 300;
}
function ratingOf(record) {
  const rating = Number.parseFloat(String(record.fields?.avg_rating || ""));
  return Number.isFinite(rating) && rating >= 0 && rating <= 5 ? rating : 0;
}
function bookFor(record) {
  const fields = record.fields || {};
  const isbns = [fields.isbn13, fields.isbn].filter((x) => x && x !== "None").map((x) => String(x).replace(/\D/g, ""));
  for (const isbn of isbns) {
    const matches = byIsbn.get(isbn) || [];
    if (matches.length === 1) return { id: matches[0].id, insert: null };
    if (matches.length > 1) throw new Error(`Ambiguous ISBN match for Goodreads book ${record.goodreads_book_id}.`);
  }
  const matches = [...new Map(titleKeys(record.title).flatMap((key) => byTitle.get(key) || []).map((book) => [book.id, book])).values()];
  if (matches.length === 1) return { id: matches[0].id, insert: null };
  if (matches.length > 1) {
    const authorMatches = matches.filter((book) => authorKey(book.author) === authorKey(record.author));
    if (authorMatches.length === 1) return { id: authorMatches[0].id, insert: null };
  }
  if (matches.length > 1) throw new Error(`Ambiguous title match for Goodreads book ${record.goodreads_book_id}.`);

  const id = `goodreads-${record.goodreads_book_id}`;
  const isbn = String(fields.isbn13 || fields.isbn || "");
  const description = record.rss?.book_description_text || "";
  const values = [
    id,
    record.title,
    record.author,
    "Uncategorized",
    pagesOf(record),
    ratingOf(record),
    isbn,
    "#8f9f70",
    0,
    description,
  ];
  const insert = `INSERT OR IGNORE INTO books(id,title,author,genre,pages,rating,isbn,color,friend_count,description) VALUES (${values.map((v) => typeof v === "number" ? String(v) : sqlString(v)).join(",")});`;
  return { id, insert };
}

const rows = [];
const newBooks = [];
const mappedBookIds = [];
const mappedSources = new Map();
const shelfCounts = { read: 0, want: 0, reading: 0, "did-not-finish": 0 };
for (const record of staged.records) {
  const shelves = record.shelves || [];
  const status = shelves.includes("read")
    ? "read"
    : shelves.includes("currently-reading") || shelves.includes("currently reading")
      ? "reading"
      : shelves.includes("did-not-finish")
        ? "did-not-finish"
        : shelves.includes("to-read") || shelves.includes("want-to-read")
          ? "want"
          : null;
  if (!status) throw new Error(`Unsupported or missing Goodreads shelf for ${record.goodreads_review_id}.`);
  const mapped = bookFor(record);
  mappedSources.set(mapped.id, [...(mappedSources.get(mapped.id) || []), `${record.goodreads_book_id}:${record.title}`]);
  mappedBookIds.push(mapped.id);
  if (mapped.insert) newBooks.push(mapped.insert);
  const pages = pagesOf(record);
  const page = status === "read" ? pages : 0;
  const rating = record.rating == null ? "NULL" : String(Math.trunc(Number(record.rating)) || "NULL");
  const review = record.review_text || "";
  const started = sourceDate(record, "date_started");
  const finished = sourceDate(record, "date_read");
  const history = JSON.stringify({
    date_started: record.dates?.date_started || [],
    date_read: record.dates?.date_read || [],
    date_added: record.dates?.date_added || null,
    goodreads: {
      book_id: record.goodreads_book_id,
      review_id: record.goodreads_review_id,
      book_url: record.book_url || null,
      review_url: record.review_url || null,
      shelves,
      like_count: Number(record.like_count || 0),
      comments: record.discussion?.comments || [],
      reading_history: record.discussion?.reading_history || [],
    },
  });
  rows.push(`INSERT OR IGNORE INTO library(reader_id,book_id,status,page,rating,review,started_at,finished_at,reading_history) VALUES (${[
    sqlString(readerId),
    sqlString(mapped.id),
    sqlString(status),
    String(page),
    rating,
    sqlString(review),
    started == null ? "NULL" : sqlString(started),
    finished == null ? "NULL" : sqlString(finished),
    sqlString(history),
  ].join(",")});`);
  shelfCounts[status]++;
}
if (new Set(mappedBookIds).size !== staged.records.length) {
  const collisions = [...mappedSources.entries()].filter(([, sources]) => sources.length > 1).map(([id, sources]) => `${id} <= ${sources.join(" | ")}`);
  throw new Error(`Multiple Goodreads entries map to the same app book; refusing to merge them. Collisions: ${collisions.slice(0, 12).join("; ")}`);
}

const sql = [...newBooks, ...rows].join("\n");
const summary = {
  goodreads_user_id: goodreadsId,
  records: staged.records.length,
  shelves: shelfCounts,
  new_catalog_books: newBooks.length,
  date_started: staged.records.filter((r) => sourceDate(r, "date_started")).length,
  date_read: staged.records.filter((r) => sourceDate(r, "date_read")).length,
  ratings: staged.records.filter((r) => r.rating != null).length,
  reviews: staged.records.filter((r) => String(r.review_text || "").trim()).length,
  comments: staged.records.reduce((sum, r) => sum + (r.discussion?.comments || []).length, 0),
  apply,
};
if (!apply) {
  console.log(JSON.stringify(summary, null, 2));
  console.log("Dry run only. Add --apply to merge into the approved remote D1 database.");
  process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wcr-goodreads-import-"));
const file = path.join(dir, "import.sql");
fs.writeFileSync(file, sql, { mode: 0o600 });
try {
  execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "DB", "--remote", "--file", file, "--json"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const ids = `(${mappedBookIds.map(sqlString).join(",")})`;
  const verification = query(
    `SELECT status,COUNT(*) AS count FROM library WHERE reader_id=${sqlString(readerId)} AND book_id IN ${ids} GROUP BY status`,
  );
  const importedCount = verification.reduce((sum, row) => sum + Number(row.count), 0);
  if (importedCount !== staged.records.length) {
    throw new Error(`Import verification found ${importedCount} of ${staged.records.length} reader-book entries.`);
  }
  const dateCounts = query(
    `SELECT SUM(CASE WHEN started_at IS NOT NULL THEN 1 ELSE 0 END) AS started,SUM(CASE WHEN finished_at IS NOT NULL THEN 1 ELSE 0 END) AS finished,SUM(CASE WHEN rating IS NOT NULL THEN 1 ELSE 0 END) AS rated,SUM(CASE WHEN review<>'' THEN 1 ELSE 0 END) AS reviewed FROM library WHERE reader_id=${sqlString(readerId)} AND book_id IN ${ids}`,
  )[0];
  const commentCounts = query(
    `SELECT SUM(json_array_length(json_extract(reading_history,'$.goodreads.comments'))) AS comments FROM library WHERE reader_id=${sqlString(readerId)} AND book_id IN ${ids}`,
  )[0];
  console.log(JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ verified_reader_book_entries: importedCount, app_shelf_counts: verification, stored_start_dates: Number(dateCounts.started || 0), stored_finish_dates: Number(dateCounts.finished || 0), stored_personal_ratings: Number(dateCounts.rated || 0), stored_reviews: Number(dateCounts.reviewed || 0), stored_comments: Number(commentCounts.comments || 0) }, null, 2));
  console.log("Imported without overwriting existing reader-book rows.");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
