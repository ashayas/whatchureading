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
const ROWS_PER_UPSERT_STATEMENT = 200;
const STATEMENTS_PER_FILE = 25;
const IDS_PER_DELETE_STATEMENT = 400;
const SNAPSHOT_CHUNK_BYTES = 250 * 1024 * 1024; // wrangler's `r2 object put` hard-caps a single object at 300MiB

if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
  throw new Error(
    "Set CLOUDFLARE_ACCOUNT_ID (the ashaya account) before running this sync.",
  );
}

// A single transient Cloudflare API blip (observed in practice: a one-off
// "Authentication error [code: 10000]" against an otherwise-healthy login)
// shouldn't fail an entire monthly run. Every call here (schema, diff
// upsert/delete, R2 put) is idempotent/safe to repeat, so retry with backoff.
async function wrangler(args, options = {}, maxAttempts = 4) {
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
      await sleep(Math.min(60_000, 2 ** attempt * 5000));
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

// The compressed dump is multiple gigabytes; a single HTTP connection held
// open for an hour-plus to transfer it is liable to be reset partway through
// (observed: a clean socket close ~40% in, after ~96 minutes). Downloading to
// a local file with Range-request resume, retried with backoff, means a
// transient reset costs only the retry wait, not the whole download.
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
    if (existing > 0 && response.status === 416) return; // Already have the whole file.
    if (!response.ok || !response.body) {
      console.log(
        `Download attempt ${attempt}/${maxAttempts} failed: HTTP ${response.status}`,
      );
      await sleep(Math.min(60_000, 2 ** attempt * 1000));
      continue;
    }
    const resuming = existing > 0 && response.status === 206;
    if (existing > 0 && !resuming) fs.rmSync(gzPath, { force: true }); // Server ignored our Range request.
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

// The snapshot is uploaded as fixed-size parts plus a manifest (see
// uploadSnapshot below) since wrangler's `r2 object put` refuses any single
// file over 300MiB. Download each part and concatenate them back into one
// gzip file before diffing against it.
async function downloadSnapshot(destGzPath, tmpDir) {
  const manifestPath = path.join(tmpDir, "snapshot-manifest.tmp");
  await wrangler([
    "r2",
    "object",
    "get",
    `${BUCKET}/${MANIFEST_KEY}`,
    "--file",
    manifestPath,
    "--remote",
  ]);
  const { parts } = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  fs.rmSync(manifestPath, { force: true });

  const fd = fs.openSync(destGzPath, "w");
  try {
    for (let i = 0; i < parts; i++) {
      const partPath = path.join(tmpDir, `snapshot-part-${i}.tmp`);
      await wrangler([
        "r2",
        "object",
        "get",
        `${BUCKET}/${SNAPSHOT_KEY}.part${String(i).padStart(3, "0")}`,
        "--file",
        partPath,
        "--remote",
      ]);
      fs.writeSync(fd, fs.readFileSync(partPath));
      fs.rmSync(partPath, { force: true });
    }
  } finally {
    fs.closeSync(fd);
  }
}

// See uploadSnapshot's twin in scripts/openlibrary-backfill.mjs for the
// upload side -- this is the download/reassembly counterpart.
async function uploadSnapshot(localGzPath, tmpDir) {
  const size = fs.statSync(localGzPath).size;
  const partCount = Math.max(1, Math.ceil(size / SNAPSHOT_CHUNK_BYTES));

  let oldPartCount = 0;
  const oldManifestPath = path.join(tmpDir, "old-manifest.tmp");
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
    // No previous manifest: nothing to clean up.
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
      const partPath = path.join(tmpDir, `snapshot-part-${i}.tmp`);
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

  const manifestPath = path.join(tmpDir, "snapshot-manifest.tmp");
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

async function loadPreviousFingerprints(tmpDir) {
  const gzPath = path.join(tmpDir, "previous.ndjson.gz");
  try {
    await downloadSnapshot(gzPath, tmpDir);
  } catch {
    return new Map(); // No prior snapshot yet: first run, everything is an insert.
  }
  const map = new Map();
  const rl = readline.createInterface({
    input: fs.createReadStream(gzPath).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line) continue;
    const record = JSON.parse(line);
    map.set(record.id, record.fingerprint);
  }
  return map;
}

function upsertStatement(rows) {
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
          new Date().toISOString(),
        ]
          .map((v, i) => (i === 5 || i === 7 ? v : sqlString(v)))
          .join(",")})`,
    )
    .join(",");
  return `INSERT INTO editions(id,work_key,isbn,title,author,pages,publish_date,cover_id,fingerprint,updated_at) VALUES ${values} ON CONFLICT(id) DO UPDATE SET work_key=excluded.work_key,isbn=excluded.isbn,title=excluded.title,author=excluded.author,pages=excluded.pages,publish_date=excluded.publish_date,cover_id=excluded.cover_id,fingerprint=excluded.fingerprint,updated_at=excluded.updated_at;`;
}

function deleteStatement(ids) {
  return `DELETE FROM editions WHERE id IN (${ids.map(sqlString).join(",")});`;
}

// Writes statements to disk and applies them to D1 as it goes, STATEMENTS_PER_FILE
// at a time, instead of buffering every statement for the whole diff in memory
// first. A monthly diff is normally small, but this keeps an unusually large
// diff (e.g. an upstream Open Library reformat) from repeating the backfill's
// OOM failure mode.
function makeBatchApplier(tmpDir, label) {
  let fileIndex = 0;
  let countInFile = 0;
  let filePath = path.join(tmpDir, `diff-${label}-${fileIndex}.sql`);
  let out = fs.createWriteStream(filePath);
  return {
    async add(statement) {
      out.write(statement + "\n");
      countInFile++;
      if (countInFile === STATEMENTS_PER_FILE) await this.flush();
    },
    async flush() {
      if (countInFile === 0) return;
      await new Promise((resolve, reject) =>
        out.end((err) => (err ? reject(err) : resolve())),
      );
      await wrangler([
        "d1",
        "execute",
        DATABASE,
        "--remote",
        "--file",
        filePath,
      ]);
      fs.rmSync(filePath, { force: true });
      fileIndex++;
      countInFile = 0;
      filePath = path.join(tmpDir, `diff-${label}-${fileIndex}.sql`);
      out = fs.createWriteStream(filePath);
    },
  };
}

async function main() {
  await wrangler([
    "d1",
    "execute",
    DATABASE,
    "--remote",
    "--file",
    SCHEMA_FILE,
  ]);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openlibrary-sync-"));
  try {
    const currentPath = path.join(tmpDir, "current.ndjson");
    const rawGzPath = path.join(tmpDir, "editions-dump.txt.gz");
    console.log(`Downloading ${DUMP_URL} ...`);
    await downloadDumpWithResume(DUMP_URL, rawGzPath);
    console.log("Filtering the dump ...");
    const { scanned, kept } = await filterDump(rawGzPath, currentPath);
    fs.rmSync(rawGzPath, { force: true });
    console.log(
      `Scanned ${scanned} dump records, kept ${kept} English editions with an ISBN.`,
    );

    console.log("Loading previous month's snapshot for diffing ...");
    const previous = await loadPreviousFingerprints(tmpDir);
    console.log(`Previous snapshot had ${previous.size} editions.`);

    const upsertApplier = makeBatchApplier(tmpDir, "upsert");
    const upsertRows = [];
    let inserted = 0;
    let updated = 0;
    const rl = readline.createInterface({
      input: fs.createReadStream(currentPath),
      crlfDelay: Infinity,
    });
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
        await upsertApplier.add(upsertStatement(upsertRows.splice(0)));
      }
    }
    if (upsertRows.length) await upsertApplier.add(upsertStatement(upsertRows));
    await upsertApplier.flush();

    const deleteApplier = makeBatchApplier(tmpDir, "delete");
    const removedIds = [...previous.keys()];
    for (let i = 0; i < removedIds.length; i += IDS_PER_DELETE_STATEMENT) {
      await deleteApplier.add(
        deleteStatement(removedIds.slice(i, i + IDS_PER_DELETE_STATEMENT)),
      );
    }
    await deleteApplier.flush();

    console.log(
      `Diff applied: ${inserted} new, ${updated} changed, ${removedIds.length} removed.`,
    );

    console.log(
      "Publishing this month's snapshot to R2 for next month's diff ...",
    );
    const snapshotGz = path.join(tmpDir, "snapshot.ndjson.gz");
    await new Promise((resolve, reject) => {
      const gzip = zlib.createGzip();
      fs.createReadStream(currentPath)
        .pipe(gzip)
        .pipe(fs.createWriteStream(snapshotGz))
        .on("finish", resolve)
        .on("error", reject);
    });
    await uploadSnapshot(snapshotGz, tmpDir);

    console.log(
      "PASS: Open Library edition index synced with diff-only D1 writes.",
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

await main();
