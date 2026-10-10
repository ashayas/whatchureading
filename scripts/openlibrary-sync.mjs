import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import readline from "node:readline";
import { Readable } from "node:stream";
import { execFileSync } from "node:child_process";

// Owns a monthly-refreshed, flattened slice of Open Library's edition dump in
// a dedicated D1 database (never the app's primary DB), keeping cost down by
// writing only the rows that actually changed since last month's run. See
// docs/openlibrary-sync.md for the design and cost reasoning.
//
// Scope, by design, to keep this small and cheap: editions only (not works or
// authors), English-language, with at least one ISBN. Author names come from
// `by_statement` (free text on the edition itself) rather than joining the
// separate, much larger authors dump.

const DUMP_URL = "https://openlibrary.org/data/ol_dump_editions_latest.txt.gz";
const DATABASE = process.env.OPENLIBRARY_D1_DATABASE || "whatchureading-openlibrary";
const BUCKET = process.env.OPENLIBRARY_R2_BUCKET || "whatchureading-openlibrary-sync";
const SNAPSHOT_KEY = "snapshot.ndjson.gz";
const SCHEMA_FILE = path.join(import.meta.dirname, "..", "migrations", "openlibrary", "0001_init.sql");
const ROWS_PER_UPSERT_STATEMENT = 200;
const STATEMENTS_PER_FILE = 25;
const IDS_PER_DELETE_STATEMENT = 400;

if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
  throw new Error("Set CLOUDFLARE_ACCOUNT_ID (the ashaya account) before running this sync.");
}

function wrangler(args, options = {}) {
  return execFileSync("npx", ["wrangler", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 1024 * 1024 * 64,
    ...options,
  });
}

function sqlString(value) {
  return value == null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`;
}

function fingerprintOf(record) {
  const canonical = JSON.stringify([
    record.title,
    record.isbn,
    record.author,
    record.pages,
    record.publish_date,
    record.cover_id,
    record.work_key,
  ]);
  return crypto.createHash("sha1").update(canonical).digest("hex");
}

// Open Library's dump rows are `type\tkey\trevision\tlast_modified\tjson`;
// the JSON payload can itself contain literal tab bytes inside string values
// only as the escaped sequence `\t`, never raw, so splitting on the first
// four literal tabs is safe and keeps the JSON column intact.
function splitDumpLine(line) {
  const parts = [];
  let idx = 0;
  for (let i = 0; i < 4; i++) {
    const next = line.indexOf("\t", idx);
    if (next === -1) return null;
    parts.push(line.slice(idx, next));
    idx = next + 1;
  }
  parts.push(line.slice(idx));
  return parts;
}

function flattenEdition(raw) {
  if (!raw.title || typeof raw.title !== "string") return null;
  const isbn = raw.isbn_13?.[0] || raw.isbn_10?.[0];
  if (!isbn) return null;
  const languages = Array.isArray(raw.languages) ? raw.languages.map((l) => l?.key) : [];
  if (!languages.includes("/languages/eng")) return null;
  return {
    id: raw.key,
    work_key: raw.works?.[0]?.key || null,
    isbn: String(isbn).replace(/\D/g, ""),
    title: raw.title.trim().slice(0, 500),
    author: typeof raw.by_statement === "string" ? raw.by_statement.trim().slice(0, 300) || null : null,
    pages: Number.isInteger(raw.number_of_pages) ? raw.number_of_pages : null,
    publish_date: typeof raw.publish_date === "string" ? raw.publish_date.slice(0, 50) : null,
    cover_id: Number.isInteger(raw.covers?.[0]) ? raw.covers[0] : null,
  };
}

async function writeLine(stream, line) {
  if (!stream.write(line)) await new Promise((resolve) => stream.once("drain", resolve));
}

async function downloadAndFilter(destPath) {
  const response = await fetch(DUMP_URL);
  if (!response.ok || !response.body) throw new Error(`Dump download failed: HTTP ${response.status}`);
  const gunzip = zlib.createGunzip();
  Readable.fromWeb(response.body).pipe(gunzip);
  const rl = readline.createInterface({ input: gunzip, crlfDelay: Infinity });
  const out = fs.createWriteStream(destPath);
  let scanned = 0;
  let kept = 0;
  for await (const line of rl) {
    scanned++;
    const parts = splitDumpLine(line);
    if (!parts || parts[0] !== "/type/edition") continue;
    let raw;
    try {
      raw = JSON.parse(parts[4]);
    } catch {
      continue;
    }
    const flat = flattenEdition(raw);
    if (!flat) continue;
    flat.fingerprint = fingerprintOf(flat);
    kept++;
    await writeLine(out, JSON.stringify(flat) + "\n");
  }
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  return { scanned, kept };
}

async function loadPreviousFingerprints(tmpDir) {
  const gzPath = path.join(tmpDir, "previous.ndjson.gz");
  try {
    wrangler(["r2", "object", "get", `${BUCKET}/${SNAPSHOT_KEY}`, "--file", gzPath, "--remote"]);
  } catch {
    return new Map(); // No prior snapshot yet: first run, everything is an insert.
  }
  const map = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(gzPath).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const record = JSON.parse(line);
    map.set(record.id, record.fingerprint);
  }
  return map;
}

function upsertStatement(rows) {
  const values = rows
    .map((r) =>
      `(${[r.id, r.work_key, r.isbn, r.title, r.author, r.pages ?? "NULL", r.publish_date, r.cover_id ?? "NULL", r.fingerprint, new Date().toISOString()]
        .map((v, i) => (i === 5 || i === 7 ? v : sqlString(v)))
        .join(",")})`,
    )
    .join(",");
  return `INSERT INTO editions(id,work_key,isbn,title,author,pages,publish_date,cover_id,fingerprint,updated_at) VALUES ${values} ON CONFLICT(id) DO UPDATE SET work_key=excluded.work_key,isbn=excluded.isbn,title=excluded.title,author=excluded.author,pages=excluded.pages,publish_date=excluded.publish_date,cover_id=excluded.cover_id,fingerprint=excluded.fingerprint,updated_at=excluded.updated_at;`;
}

function deleteStatement(ids) {
  return `DELETE FROM editions WHERE id IN (${ids.map(sqlString).join(",")});`;
}

function applyStatements(statements, tmpDir, label) {
  for (let i = 0; i < statements.length; i += STATEMENTS_PER_FILE) {
    const chunk = statements.slice(i, i + STATEMENTS_PER_FILE);
    const file = path.join(tmpDir, `diff-${label}-${i}.sql`);
    fs.writeFileSync(file, chunk.join("\n"));
    wrangler(["d1", "execute", DATABASE, "--remote", "--file", file]);
  }
}

async function main() {
  wrangler(["d1", "execute", DATABASE, "--remote", "--file", SCHEMA_FILE]);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openlibrary-sync-"));
  try {
    const currentPath = path.join(tmpDir, "current.ndjson");
    console.log(`Downloading and filtering ${DUMP_URL} ...`);
    const { scanned, kept } = await downloadAndFilter(currentPath);
    console.log(`Scanned ${scanned} dump records, kept ${kept} English editions with an ISBN.`);

    console.log("Loading previous month's snapshot for diffing ...");
    const previous = await loadPreviousFingerprints(tmpDir);
    console.log(`Previous snapshot had ${previous.size} editions.`);

    const upsertRows = [];
    const upsertStatements = [];
    let inserted = 0;
    let updated = 0;
    const rl = readline.createInterface({ input: fs.createReadStream(currentPath), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      const record = JSON.parse(line);
      const prevFingerprint = previous.get(record.id);
      if (prevFingerprint === undefined) inserted++;
      else if (prevFingerprint !== record.fingerprint) updated++;
      else {
        previous.delete(record.id);
        continue; // Unchanged: nothing to write.
      }
      previous.delete(record.id);
      upsertRows.push(record);
      if (upsertRows.length === ROWS_PER_UPSERT_STATEMENT) {
        upsertStatements.push(upsertStatement(upsertRows.splice(0)));
      }
    }
    if (upsertRows.length) upsertStatements.push(upsertStatement(upsertRows));

    const removedIds = [...previous.keys()];
    const deleteStatements = [];
    for (let i = 0; i < removedIds.length; i += IDS_PER_DELETE_STATEMENT) {
      deleteStatements.push(deleteStatement(removedIds.slice(i, i + IDS_PER_DELETE_STATEMENT)));
    }

    console.log(`Diff: ${inserted} new, ${updated} changed, ${removedIds.length} removed.`);
    console.log(`Applying ${upsertStatements.length} upsert statement(s) ...`);
    applyStatements(upsertStatements, tmpDir, "upsert");
    console.log(`Applying ${deleteStatements.length} delete statement(s) ...`);
    applyStatements(deleteStatements, tmpDir, "delete");

    console.log("Publishing this month's snapshot to R2 for next month's diff ...");
    const snapshotGz = path.join(tmpDir, "snapshot.ndjson.gz");
    await new Promise((resolve, reject) => {
      const gzip = zlib.createGzip();
      fs.createReadStream(currentPath)
        .pipe(gzip)
        .pipe(fs.createWriteStream(snapshotGz))
        .on("finish", resolve)
        .on("error", reject);
    });
    wrangler(["r2", "object", "put", `${BUCKET}/${SNAPSHOT_KEY}`, "--file", snapshotGz, "--remote"]);

    console.log("PASS: Open Library edition index synced with diff-only D1 writes.");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

await main();
