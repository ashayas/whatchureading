import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import readline from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

// One-time bootstrap of `whatchureading-openlibrary` from a cold-empty table.
// Separate from scripts/openlibrary-sync.mjs (the monthly incremental job)
// because the bootstrap has a fundamentally different shape: every row is an
// insert (no diffing), and the row count is large enough that driving it
// through thousands of small `wrangler d1 execute` subprocess calls (as the
// monthly job does for its much smaller diffs) is too slow. `wrangler d1
// execute --remote --file` already uses D1's Import REST API internally
// (upload to a presigned URL, then a single server-side ingest job) for
// every file regardless of size, authenticated through the existing
// wrangler OAuth login — no separate API token needed. So the fix here is
// simply far fewer, far bigger files: stream rows into ~1M-row SQL files
// instead of the monthly job's small batches, and create the two secondary
// indexes only after the bulk load instead of maintaining them row-by-row.
// See docs/openlibrary-sync.md.
//
// Run with: npm run backfill:openlibrary
// Re-running after a crash resumes from whatever is already on disk in the
// work dir below instead of re-downloading or re-filtering.

const DUMP_URL = "https://openlibrary.org/data/ol_dump_editions_latest.txt.gz";
const DATABASE = process.env.OPENLIBRARY_D1_DATABASE || "whatchureading-openlibrary";
const BUCKET = process.env.OPENLIBRARY_R2_BUCKET || "whatchureading-openlibrary-sync";
const SNAPSHOT_KEY = "snapshot.ndjson.gz";
const SCHEMA_FILE = path.join(import.meta.dirname, "..", "migrations", "openlibrary", "0001_init.sql");
const WORK_DIR = path.join(os.tmpdir(), "whatchureading-openlibrary-backfill");
const ROWS_PER_INSERT_STATEMENT = 200; // same size already proven safe in openlibrary-sync.mjs
const ROWS_PER_IMPORT_FILE = 1_000_000; // ~250MB/file -> ~23 files for 22M rows, instead of ~4,400 wrangler calls

if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
  throw new Error("Set CLOUDFLARE_ACCOUNT_ID (the ashaya account) before running this backfill.");
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

// Same tab-splitting rationale as openlibrary-sync.mjs: the dump's JSON
// column can contain literal `\t` only as an escaped sequence, never raw.
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

async function downloadDumpWithResume(url, gzPath, maxAttempts = 8) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const existing = fs.existsSync(gzPath) ? fs.statSync(gzPath).size : 0;
    let response;
    try {
      response = await fetch(url, existing > 0 ? { headers: { Range: `bytes=${existing}-` } } : {});
    } catch (e) {
      console.log(`Download attempt ${attempt}/${maxAttempts} failed before a response: ${e.message}`);
      await sleep(Math.min(60_000, 2 ** attempt * 1000));
      continue;
    }
    if (existing > 0 && response.status === 416) return;
    if (!response.ok || !response.body) {
      console.log(`Download attempt ${attempt}/${maxAttempts} failed: HTTP ${response.status}`);
      await sleep(Math.min(60_000, 2 ** attempt * 1000));
      continue;
    }
    const resuming = existing > 0 && response.status === 206;
    if (existing > 0 && !resuming) fs.rmSync(gzPath, { force: true });
    const out = fs.createWriteStream(gzPath, { flags: resuming ? "a" : "w" });
    try {
      await pipeline(Readable.fromWeb(response.body), out);
      console.log(`Download complete: ${fs.statSync(gzPath).size} bytes.`);
      return;
    } catch (e) {
      console.log(`Download attempt ${attempt}/${maxAttempts} interrupted at ${fs.statSync(gzPath).size} bytes: ${e.message}`);
      await sleep(Math.min(60_000, 2 ** attempt * 1000));
    }
  }
  throw new Error(`Could not download ${url} after ${maxAttempts} attempts.`);
}

async function filterDump(gzPath, destPath) {
  const gunzip = zlib.createGunzip();
  fs.createReadStream(gzPath).pipe(gunzip);
  const rl = readline.createInterface({ input: gunzip, crlfDelay: Infinity });
  const out = fs.createWriteStream(destPath);
  let scanned = 0;
  let kept = 0;
  for await (const line of rl) {
    scanned++;
    if (scanned % 2_000_000 === 0) console.log(`Scanned ${scanned} lines so far, kept ${kept}...`);
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

function insertStatement(rows, updatedAt) {
  const values = rows
    .map((r) =>
      `(${[r.id, r.work_key, r.isbn, r.title, r.author, r.pages ?? "NULL", r.publish_date, r.cover_id ?? "NULL", r.fingerprint, updatedAt]
        .map((v, i) => (i === 5 || i === 7 ? v : sqlString(v)))
        .join(",")})`,
    )
    .join(",");
  return `INSERT INTO editions(id,work_key,isbn,title,author,pages,publish_date,cover_id,fingerprint,updated_at) VALUES ${values};`;
}

// wrangler d1 execute --remote --file already routes through D1's Import
// REST API internally (upload to a presigned URL, then a single server-side
// ingest job) for every file regardless of size — see uploadAndBeginIngestion
// in wrangler's own source. So the win here is just fewer, bigger files, not
// a different transport.
function importSqlFile(filePath) {
  wrangler(["d1", "execute", DATABASE, "--remote", "--file", filePath]);
}

function splitSchema() {
  const sql = fs.readFileSync(SCHEMA_FILE, "utf8");
  const statements = sql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    table: statements.filter((s) => /^CREATE TABLE/i.test(s)),
    indexes: statements.filter((s) => /^CREATE INDEX/i.test(s)),
  };
}

function runStatements(statements, label) {
  if (!statements.length) return;
  const file = path.join(WORK_DIR, `${label}.sql`);
  fs.writeFileSync(file, statements.join(";\n") + ";");
  wrangler(["d1", "execute", DATABASE, "--remote", "--file", file]);
  fs.rmSync(file, { force: true });
}

async function smokeTest() {
  const { table } = splitSchema();
  console.log("Ensuring the editions table exists ...");
  runStatements(table, "smoke-test-schema");

  fs.mkdirSync(WORK_DIR, { recursive: true });
  const testFile = path.join(WORK_DIR, "smoke-test.sql");
  const now = new Date().toISOString();
  const probeId = `/books/OL_SMOKE_TEST_${Date.now()}M`;
  fs.writeFileSync(
    testFile,
    insertStatement(
      [{ id: probeId, work_key: null, isbn: "0000000000", title: "Smoke test row", author: null, pages: null, publish_date: null, cover_id: null, fingerprint: "smoke" }],
      now,
    ),
  );

  console.log("Importing a single-row test file ...");
  importSqlFile(testFile);

  console.log("Verifying the row landed, then cleaning it up ...");
  wrangler(["d1", "execute", DATABASE, "--remote", "--command", `SELECT id FROM editions WHERE id = '${probeId}'`]);
  wrangler(["d1", "execute", DATABASE, "--remote", "--command", `DELETE FROM editions WHERE id = '${probeId}'`]);
  fs.rmSync(testFile, { force: true });
  console.log("PASS: wrangler d1 execute --remote --file works end-to-end against this database. Safe to run the full backfill.");
}

async function main() {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  console.log(`Work dir (resumable across crashes): ${WORK_DIR}`);

  const { table, indexes } = splitSchema();
  console.log("Creating the editions table (without indexes, for faster bulk insert) ...");
  runStatements(table, "schema-table");

  const currentPath = path.join(WORK_DIR, "current.ndjson");
  const rawGzPath = path.join(WORK_DIR, "editions-dump.txt.gz");

  if (fs.existsSync(currentPath)) {
    console.log(`Reusing already-filtered ${currentPath} from a previous run.`);
  } else {
    const t0 = Date.now();
    console.log(`Downloading ${DUMP_URL} ...`);
    await downloadDumpWithResume(DUMP_URL, rawGzPath);
    console.log(`Download phase took ${((Date.now() - t0) / 60000).toFixed(1)} min.`);

    const t1 = Date.now();
    console.log("Filtering the dump ...");
    const { scanned, kept } = await filterDump(rawGzPath, currentPath);
    fs.rmSync(rawGzPath, { force: true });
    console.log(`Scanned ${scanned} dump records, kept ${kept} English editions with an ISBN.`);
    console.log(`Filter phase took ${((Date.now() - t1) / 60000).toFixed(1)} min.`);
  }

  const t2 = Date.now();
  console.log(`Streaming inserts to D1 in ~${ROWS_PER_IMPORT_FILE.toLocaleString()}-row files via the Import API ...`);
  const now = new Date().toISOString();
  const rl = readline.createInterface({ input: fs.createReadStream(currentPath), crlfDelay: Infinity });

  let fileIndex = 0;
  let rowsInFile = 0;
  let totalRows = 0;
  let rowBuffer = [];
  let currentFilePath = path.join(WORK_DIR, `insert-${String(++fileIndex).padStart(4, "0")}.sql`);
  let out = fs.createWriteStream(currentFilePath);

  const flushStatement = () => {
    if (!rowBuffer.length) return;
    out.write(insertStatement(rowBuffer, now) + "\n");
    rowsInFile += rowBuffer.length;
    rowBuffer = [];
  };
  const finishFile = async () => {
    flushStatement();
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    if (rowsInFile === 0) {
      fs.rmSync(currentFilePath, { force: true });
      return;
    }
    console.log(`Importing ${path.basename(currentFilePath)} (${rowsInFile.toLocaleString()} rows, ${totalRows.toLocaleString()} total so far) ...`);
    const fileT0 = Date.now();
    importSqlFile(currentFilePath);
    console.log(`  -> done in ${((Date.now() - fileT0) / 1000).toFixed(0)}s`);
    fs.rmSync(currentFilePath, { force: true });
  };

  for await (const line of rl) {
    if (!line) continue;
    rowBuffer.push(JSON.parse(line));
    totalRows++;
    if (rowBuffer.length === ROWS_PER_INSERT_STATEMENT) flushStatement();
    if (rowsInFile >= ROWS_PER_IMPORT_FILE) {
      await finishFile();
      fileIndex++;
      rowsInFile = 0;
      currentFilePath = path.join(WORK_DIR, `insert-${String(fileIndex).padStart(4, "0")}.sql`);
      out = fs.createWriteStream(currentFilePath);
    }
  }
  await finishFile();
  console.log(`Insert phase: ${totalRows.toLocaleString()} rows in ${((Date.now() - t2) / 60000).toFixed(1)} min.`);

  console.log("Creating indexes now that the bulk load is done ...");
  const t3 = Date.now();
  runStatements(indexes, "schema-indexes");
  console.log(`Index build took ${((Date.now() - t3) / 60000).toFixed(1)} min.`);

  console.log("Publishing this run's snapshot to R2 so next month's incremental sync diffs against it ...");
  const snapshotGz = path.join(WORK_DIR, "snapshot.ndjson.gz");
  await new Promise((resolve, reject) => {
    const gzip = zlib.createGzip();
    fs.createReadStream(currentPath).pipe(gzip).pipe(fs.createWriteStream(snapshotGz)).on("finish", resolve).on("error", reject);
  });
  wrangler(["r2", "object", "put", `${BUCKET}/${SNAPSHOT_KEY}`, "--file", snapshotGz, "--remote"]);

  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  console.log("PASS: Open Library edition index backfilled. The monthly sync job will diff against this run's snapshot from next month on.");
}

if (process.argv[2] === "smoke-test") {
  await smokeTest();
} else {
  await main();
}
