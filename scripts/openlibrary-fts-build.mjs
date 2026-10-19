import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

// Populates the owned Open Library index's full-text table (editions_fts,
// defined in migrations/openlibrary/0001_init.sql) from rows already in
// `editions`. One FTS5 'rebuild' over ~22M rows exceeds D1's per-query time
// limit, so this inserts in rowid batches and records progress in a local
// state file, making it safe to interrupt and rerun. After this one-time
// build, the schema's triggers keep the index current as the monthly sync
// upserts and deletes rows.
//
//   CLOUDFLARE_ACCOUNT_ID=... node scripts/openlibrary-fts-build.mjs
//
// Cost: about one D1 row written per edition (~22M for the full index).

const DATABASE = process.env.OPENLIBRARY_D1_DATABASE || "whatchureading-openlibrary";
const BATCH = Number(process.env.FTS_BATCH_ROWS || 250_000);
const STATE = path.join(os.tmpdir(), "whatchureading-openlibrary-fts-build.json");

if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
  throw new Error("Set CLOUDFLARE_ACCOUNT_ID (the ashaya account) before running this build.");
}

async function d1(sql, maxAttempts = 5) {
  for (let attempt = 1; ; attempt++) {
    try {
      const out = execFileSync("npx", ["wrangler", "d1", "execute", DATABASE, "--remote", "--json", "--command", sql], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 1024 * 1024 * 16,
      });
      return JSON.parse(out).at(-1);
    } catch (e) {
      if (attempt === maxAttempts) throw e;
      console.log(`  attempt ${attempt}/${maxAttempts} failed (${e.message.split("\n")[0]}); retrying ...`);
      await sleep(Math.min(60_000, 2 ** attempt * 5000));
    }
  }
}

const [{ hi }] = (await d1("SELECT MAX(rowid) AS hi FROM editions")).results;
let next = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")).next : 1;
if (process.env.FTS_START_ROWID) next = Number(process.env.FTS_START_ROWID);
console.log(`Indexing editions rowid ${next}..${hi} in batches of ${BATCH} (progress: ${STATE})`);

let written = 0;
const started = Date.now();
while (next <= hi) {
  const end = Math.min(hi, next + BATCH - 1);
  const { meta } = await d1(
    `INSERT INTO editions_fts(rowid, title, author) SELECT rowid, title, author FROM editions WHERE rowid BETWEEN ${next} AND ${end}`,
  );
  written += meta.rows_written;
  next = end + 1;
  fs.writeFileSync(STATE, JSON.stringify({ next, hi }));
  const pct = ((100 * (end / hi)) | 0).toString().padStart(3);
  console.log(`${pct}%  rowid ≤ ${end}  (+${meta.rows_written} rows, ${Math.round(meta.duration)}ms, db ${(meta.size_after / 1e9).toFixed(2)} GB)`);
}
console.log(`Done: ${written} rows written in ${Math.round((Date.now() - started) / 60000)} min. Optimizing segments ...`);
// Merges FTS5's incremental segments so queries read fewer b-tree pages.
await d1("INSERT INTO editions_fts(editions_fts) VALUES('optimize')").catch((e) =>
  console.log(`optimize skipped (${e.message.split("\n")[0]}); queries still work, just slightly slower.`),
);
fs.rmSync(STATE, { force: true });
