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
const DATABASE =
  process.env.OPENLIBRARY_D1_DATABASE || "whatchureading-openlibrary";
const BUCKET =
  process.env.OPENLIBRARY_R2_BUCKET || "whatchureading-openlibrary-sync";
const SNAPSHOT_KEY = "snapshot.ndjson.gz";
const MANIFEST_KEY = `${SNAPSHOT_KEY}.manifest`;
const SCHEMA_FILE = path.join(
  import.meta.dirname,
  "..",
  "migrations",
  "openlibrary",
  "0001_init.sql",
);
const WORK_DIR = path.join(os.tmpdir(), "whatchureading-openlibrary-backfill");
const ROWS_PER_INSERT_STATEMENT = 200; // same size already proven safe in openlibrary-sync.mjs
const ROWS_PER_IMPORT_FILE = 1_000_000; // ~250MB/file -> ~23 files for 22M rows, instead of ~4,400 wrangler calls
const SNAPSHOT_CHUNK_BYTES = 250 * 1024 * 1024; // wrangler's `r2 object put` hard-caps a single object at 300MiB

if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
  throw new Error(
    "Set CLOUDFLARE_ACCOUNT_ID (the ashaya account) before running this backfill.",
  );
}

// Each remote call here can be a few-hundred-MB upload plus a server-side D1
// job; a single transient Cloudflare API blip (observed: one-off
// "Authentication error [code: 10000]" against an otherwise-healthy login)
// shouldn't kill a multi-hour run. Every call here (schema, import, R2 put)
// is idempotent/safe to repeat, so retry with backoff before giving up.
async function wrangler(
  args,
  options = {},
  maxAttempts = 4,
  backoffCapMs = 60_000,
) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return execFileSync("npx", ["wrangler", ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
        maxBuffer: 1024 * 1024 * 64,
        ...options,
      });
    } catch (e) {
      if (attempt === maxAttempts) throw e;
      console.log(
        `wrangler ${args.join(" ")}, attempt ${attempt}/${maxAttempts} failed: ${e.message}. Retrying ...`,
      );
      await sleep(Math.min(backoffCapMs, 2 ** attempt * 5000));
    }
  }
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
  const languages = Array.isArray(raw.languages)
    ? raw.languages.map((l) => l?.key)
    : [];
  if (!languages.includes("/languages/eng")) return null;
  return {
    id: raw.key,
    work_key: raw.works?.[0]?.key || null,
    isbn: String(isbn).replace(/\D/g, ""),
    title: raw.title.trim().slice(0, 500),
    author:
      typeof raw.by_statement === "string"
        ? raw.by_statement.trim().slice(0, 300) || null
        : null,
    pages: Number.isInteger(raw.number_of_pages) ? raw.number_of_pages : null,
    publish_date:
      typeof raw.publish_date === "string"
        ? raw.publish_date.slice(0, 50)
        : null,
    cover_id: Number.isInteger(raw.covers?.[0]) ? raw.covers[0] : null,
  };
}

async function writeLine(stream, line) {
  if (!stream.write(line))
    await new Promise((resolve) => stream.once("drain", resolve));
}

// openlibrary.org/data/... is just a redirector (302 -> archive.org/download/...
// -> 302 -> a specific ia*.us.archive.org datanode). Sending a Range header on
// that first hop (as every resumed attempt does) 500s it -- observed directly,
// not theoretical. Resolve the redirect chain once, up front, and do every
// attempt (including Range-based resumes) against the final datanode URL,
// which handles Range correctly.
async function resolveFinalUrl(url, maxAttempts = 5) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url);
      await res.body?.cancel();
      if (res.url && res.url !== url) {
        console.log(`Resolved ${url} -> ${res.url}`);
        return res.url;
      }
      if (res.ok) return url;
    } catch (e) {
      console.log(
        `Resolving final URL, attempt ${attempt}/${maxAttempts} failed: ${e.message}`,
      );
    }
    await sleep(Math.min(30_000, 2 ** attempt * 1000));
  }
  throw new Error(`Could not resolve a redirect target for ${url}.`);
}

async function downloadDumpWithResume(url, gzPath, maxAttempts = 8) {
  const finalUrl = await resolveFinalUrl(url);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const existing = fs.existsSync(gzPath) ? fs.statSync(gzPath).size : 0;
    let response;
    try {
      response = await fetch(
        finalUrl,
        existing > 0 ? { headers: { Range: `bytes=${existing}-` } } : {},
      );
    } catch (e) {
      console.log(
        `Download attempt ${attempt}/${maxAttempts} failed before a response: ${e.message}`,
      );
      await sleep(Math.min(60_000, 2 ** attempt * 1000));
      continue;
    }
    if (existing > 0 && response.status === 416) return;
    if (!response.ok || !response.body) {
      console.log(
        `Download attempt ${attempt}/${maxAttempts} failed: HTTP ${response.status}`,
      );
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
      console.log(
        `Download attempt ${attempt}/${maxAttempts} interrupted at ${fs.statSync(gzPath).size} bytes: ${e.message}`,
      );
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
    if (scanned % 2_000_000 === 0)
      console.log(`Scanned ${scanned} lines so far, kept ${kept}...`);
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
  await new Promise((resolve, reject) =>
    out.end((err) => (err ? reject(err) : resolve())),
  );
  return { scanned, kept };
}

function insertStatement(rows, updatedAt) {
  const values = rows
    .map(
      (r) =>
        `(${[
          r.id,
          r.work_key,
          r.isbn,
          r.title,
          r.author,
          r.pages ?? "NULL",
          r.publish_date,
          r.cover_id ?? "NULL",
          r.fingerprint,
          updatedAt,
        ]
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
// These imports have been observed hitting repeated transient capacity
// errors from Cloudflare's D1 import backend ("Upstream service unavailable
// [code: 7009]") on a run that otherwise succeeds on retry a file or two
// later -- give these specifically more attempts and a longer backoff cap
// than the smaller schema/R2 calls.
async function importSqlFile(filePath) {
  await wrangler(
    ["d1", "execute", DATABASE, "--remote", "--file", filePath],
    {},
    8,
    180_000,
  );
}

// wrangler's `r2 object put` refuses any single file over 300MiB, but a
// gzipped snapshot of the full edition set is well over a gigabyte -- split
// it into fixed-size parts (uploaded as `${SNAPSHOT_KEY}.partNNN`) plus a
// small manifest naming the part count, and clean up any stale parts left
// over from a previous, larger snapshot.
async function uploadSnapshot(localGzPath, workDir) {
  const size = fs.statSync(localGzPath).size;
  const partCount = Math.max(1, Math.ceil(size / SNAPSHOT_CHUNK_BYTES));

  let oldPartCount = 0;
  const oldManifestPath = path.join(workDir, "old-manifest.tmp");
  try {
    await wrangler(
      [
        "r2",
        "object",
        "get",
        `${BUCKET}/${MANIFEST_KEY}`,
        "--file",
        oldManifestPath,
        "--remote",
      ],
      {},
      1,
    );
    oldPartCount =
      JSON.parse(fs.readFileSync(oldManifestPath, "utf8")).parts || 0;
  } catch {
    // No previous manifest (first run): nothing to clean up.
  }
  fs.rmSync(oldManifestPath, { force: true });

  console.log(
    `Uploading snapshot in ${partCount} part(s) of up to ${(SNAPSHOT_CHUNK_BYTES / 1024 / 1024).toFixed(0)}MiB ...`,
  );
  const fd = fs.openSync(localGzPath, "r");
  try {
    for (let i = 0; i < partCount; i++) {
      const start = i * SNAPSHOT_CHUNK_BYTES;
      const length = Math.min(SNAPSHOT_CHUNK_BYTES, size - start);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      const partPath = path.join(workDir, `snapshot-part-${i}.tmp`);
      fs.writeFileSync(partPath, buffer);
      await wrangler([
        "r2",
        "object",
        "put",
        `${BUCKET}/${SNAPSHOT_KEY}.part${String(i).padStart(3, "0")}`,
        "--file",
        partPath,
        "--remote",
      ]);
      fs.rmSync(partPath, { force: true });
    }
  } finally {
    fs.closeSync(fd);
  }

  for (let i = partCount; i < oldPartCount; i++) {
    try {
      await wrangler(
        [
          "r2",
          "object",
          "delete",
          `${BUCKET}/${SNAPSHOT_KEY}.part${String(i).padStart(3, "0")}`,
          "--remote",
        ],
        {},
        1,
      );
    } catch {
      // Best-effort cleanup of a stale part from a previous, larger snapshot.
    }
  }

  const manifestPath = path.join(workDir, "snapshot-manifest.tmp");
  fs.writeFileSync(manifestPath, JSON.stringify({ parts: partCount }));
  await wrangler([
    "r2",
    "object",
    "put",
    `${BUCKET}/${MANIFEST_KEY}`,
    "--file",
    manifestPath,
    "--remote",
  ]);
  fs.rmSync(manifestPath, { force: true });
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

async function runStatements(statements, label) {
  if (!statements.length) return;
  const file = path.join(WORK_DIR, `${label}.sql`);
  fs.writeFileSync(file, statements.join(";\n") + ";");
  await wrangler(["d1", "execute", DATABASE, "--remote", "--file", file]);
  fs.rmSync(file, { force: true });
}

async function smokeTest() {
  const { table } = splitSchema();
  console.log("Ensuring the editions table exists ...");
  await runStatements(table, "smoke-test-schema");

  fs.mkdirSync(WORK_DIR, { recursive: true });
  const testFile = path.join(WORK_DIR, "smoke-test.sql");
  const now = new Date().toISOString();
  const probeId = `/books/OL_SMOKE_TEST_${Date.now()}M`;
  fs.writeFileSync(
    testFile,
    insertStatement(
      [
        {
          id: probeId,
          work_key: null,
          isbn: "0000000000",
          title: "Smoke test row",
          author: null,
          pages: null,
          publish_date: null,
          cover_id: null,
          fingerprint: "smoke",
        },
      ],
      now,
    ),
  );

  console.log("Importing a single-row test file ...");
  await importSqlFile(testFile);

  console.log("Verifying the row landed, then cleaning it up ...");
  await wrangler([
    "d1",
    "execute",
    DATABASE,
    "--remote",
    "--command",
    `SELECT id FROM editions WHERE id = '${probeId}'`,
  ]);
  await wrangler([
    "d1",
    "execute",
    DATABASE,
    "--remote",
    "--command",
    `DELETE FROM editions WHERE id = '${probeId}'`,
  ]);
  fs.rmSync(testFile, { force: true });
  console.log(
    "PASS: wrangler d1 execute --remote --file works end-to-end against this database. Safe to run the full backfill.",
  );
}

async function main() {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  console.log(`Work dir (resumable across crashes): ${WORK_DIR}`);

  const { table, indexes } = splitSchema();
  console.log(
    "Creating the editions table (without indexes, for faster bulk insert) ...",
  );
  await runStatements(table, "schema-table");

  const currentPath = path.join(WORK_DIR, "current.ndjson");
  const rawGzPath = path.join(WORK_DIR, "editions-dump.txt.gz");

  if (fs.existsSync(currentPath)) {
    console.log(`Reusing already-filtered ${currentPath} from a previous run.`);
  } else {
    const t0 = Date.now();
    console.log(`Downloading ${DUMP_URL} ...`);
    await downloadDumpWithResume(DUMP_URL, rawGzPath);
    console.log(
      `Download phase took ${((Date.now() - t0) / 60000).toFixed(1)} min.`,
    );

    const t1 = Date.now();
    console.log("Filtering the dump ...");
    const { scanned, kept } = await filterDump(rawGzPath, currentPath);
    fs.rmSync(rawGzPath, { force: true });
    console.log(
      `Scanned ${scanned} dump records, kept ${kept} English editions with an ISBN.`,
    );
    console.log(
      `Filter phase took ${((Date.now() - t1) / 60000).toFixed(1)} min.`,
    );
  }

  const t2 = Date.now();
  console.log(
    `Streaming inserts to D1 in ~${ROWS_PER_IMPORT_FILE.toLocaleString()}-row files via the Import API ...`,
  );
  const now = new Date().toISOString();
  const rl = readline.createInterface({
    input: fs.createReadStream(currentPath),
    crlfDelay: Infinity,
  });

  // Plain INSERT with no ON CONFLICT: a file already committed to D1 must
  // never be sent again on resume, or its rows collide on primary key. Track
  // how many files/rows are already committed so a relaunch after a mid-run
  // crash skips straight past them instead of restarting the whole insert
  // loop from row 0.
  const progressPath = path.join(WORK_DIR, "insert-progress.json");
  const progress = fs.existsSync(progressPath)
    ? JSON.parse(fs.readFileSync(progressPath, "utf8"))
    : { completedFiles: 0, completedRows: 0 };
  if (progress.completedRows > 0) {
    console.log(
      `Resuming insert phase: skipping ${progress.completedRows.toLocaleString()} already-committed rows (${progress.completedFiles} files) ...`,
    );
  }

  let fileIndex = progress.completedFiles;
  let rowsInFile = 0;
  let totalRows = progress.completedRows;
  let skipRemaining = progress.completedRows;
  let rowBuffer = [];
  let currentFilePath = path.join(
    WORK_DIR,
    `insert-${String(++fileIndex).padStart(4, "0")}.sql`,
  );
  let out = fs.createWriteStream(currentFilePath);

  const flushStatement = () => {
    if (!rowBuffer.length) return;
    out.write(insertStatement(rowBuffer, now) + "\n");
    rowsInFile += rowBuffer.length;
    rowBuffer = [];
  };
  const finishFile = async () => {
    flushStatement();
    await new Promise((resolve, reject) =>
      out.end((err) => (err ? reject(err) : resolve())),
    );
    if (rowsInFile === 0) {
      fs.rmSync(currentFilePath, { force: true });
      return;
    }
    console.log(
      `Importing ${path.basename(currentFilePath)} (${rowsInFile.toLocaleString()} rows, ${totalRows.toLocaleString()} total so far) ...`,
    );
    const fileT0 = Date.now();
    await importSqlFile(currentFilePath);
    console.log(`  -> done in ${((Date.now() - fileT0) / 1000).toFixed(0)}s`);
    fs.rmSync(currentFilePath, { force: true });
    fs.writeFileSync(
      progressPath,
      JSON.stringify({ completedFiles: fileIndex, completedRows: totalRows }),
    );
  };

  for await (const line of rl) {
    if (!line) continue;
    if (skipRemaining > 0) {
      skipRemaining--;
      continue;
    }
    rowBuffer.push(JSON.parse(line));
    totalRows++;
    if (rowBuffer.length === ROWS_PER_INSERT_STATEMENT) flushStatement();
    if (rowsInFile >= ROWS_PER_IMPORT_FILE) {
      await finishFile();
      fileIndex++;
      rowsInFile = 0;
      currentFilePath = path.join(
        WORK_DIR,
        `insert-${String(fileIndex).padStart(4, "0")}.sql`,
      );
      out = fs.createWriteStream(currentFilePath);
    }
  }
  await finishFile();
  fs.rmSync(progressPath, { force: true });
  console.log(
    `Insert phase: ${totalRows.toLocaleString()} rows total in D1 (${((Date.now() - t2) / 60000).toFixed(1)} min this run).`,
  );

  console.log("Creating indexes now that the bulk load is done ...");
  const t3 = Date.now();
  await runStatements(indexes, "schema-indexes");
  console.log(
    `Index build took ${((Date.now() - t3) / 60000).toFixed(1)} min.`,
  );

  console.log(
    "Publishing this run's snapshot to R2 so next month's incremental sync diffs against it ...",
  );
  const snapshotGz = path.join(WORK_DIR, "snapshot.ndjson.gz");
  await new Promise((resolve, reject) => {
    const gzip = zlib.createGzip();
    fs.createReadStream(currentPath)
      .pipe(gzip)
      .pipe(fs.createWriteStream(snapshotGz))
      .on("finish", resolve)
      .on("error", reject);
  });
  await uploadSnapshot(snapshotGz, WORK_DIR);

  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  console.log(
    "PASS: Open Library edition index backfilled. The monthly sync job will diff against this run's snapshot from next month on.",
  );
}

if (process.argv[2] === "smoke-test") {
  await smokeTest();
} else {
  await main();
}
