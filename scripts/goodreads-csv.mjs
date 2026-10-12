#!/usr/bin/env node
/**
 * Convert a Goodreads "Export Library" CSV into the staging format consumed by
 * goodreads-import.mjs. The CSV is supplied by the account owner; this script
 * never asks for or stores Goodreads credentials/cookies.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  return index < 0 ? null : args[index + 1] || null;
}

const input = option("--input");
const output = option("--output");
const userId = option("--goodreads-user-id");
const name = option("--name") || "Goodreads reader";
const apply = args.includes("--apply");
const supabaseId = option("--supabase-user-id");
const readerId = option("--reader-id");

if (!input || !output || !userId) {
  throw new Error(
    "Usage: node scripts/goodreads-csv.mjs --input EXPORT.csv --output STAGED.json --goodreads-user-id ID [--name NAME] [--apply --supabase-user-id UUID --reader-id UUID]",
  );
}
if (!/^\d+$/.test(userId))
  throw new Error(
    "--goodreads-user-id must be the numeric ID from the Goodreads profile URL.",
  );
if (apply && (!supabaseId || !readerId)) {
  throw new Error(
    "--apply also requires --supabase-user-id and --reader-id; omit --apply for staging only.",
  );
}

function csvRows(source) {
  const rows = [];
  let row = [],
    field = "",
    quoted = false;
  const text = source.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (quoted) throw new Error("CSV has an unterminated quoted field.");
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((entry) => entry.some((value) => value.trim() !== ""));
}

function clean(value) {
  return String(value ?? "").trim();
}
function key(value) {
  return clean(value).toLowerCase().replace(/\s+/g, " ");
}
function isbn(value) {
  return clean(value)
    .replace(/^=\"?/, "")
    .replace(/\"?$/, "")
    .replace(/\D/g, "");
}

function csvDate(value) {
  const raw = clean(value);
  if (!raw) return null;
  const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return { value: null, precision: "unknown", raw };
  const [, month, day, year] = match;
  const parsed = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day)),
  );
  if (
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() !== Number(month) - 1 ||
    parsed.getUTCDate() !== Number(day)
  ) {
    throw new Error(`Invalid Goodreads date: ${raw}`);
  }
  return {
    value: `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`,
    precision: "day",
    raw,
  };
}

function number(value) {
  const match = clean(value).match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

const rows = csvRows(fs.readFileSync(input, "utf8"));
if (rows.length < 2)
  throw new Error("The input is empty or is not a Goodreads library export.");
const headers = rows[0].map((value) => clean(value));
const required = ["Book Id", "Title", "Author", "Bookshelves"];
for (const field of required)
  if (!headers.includes(field))
    throw new Error(`Missing Goodreads CSV column: ${field}`);
const records = rows
  .slice(1)
  .map((values, index) =>
    Object.fromEntries(headers.map((header, i) => [header, values[i] ?? ""])),
  );

const seenBooks = new Set();
const staged = records.map((row, index) => {
  const bookId = clean(row["Book Id"]);
  if (!/^\d+$/.test(bookId))
    throw new Error(`Row ${index + 2}: invalid Book Id.`);
  if (seenBooks.has(bookId))
    throw new Error(
      `Duplicate Goodreads Book Id ${bookId}; refusing ambiguous export.`,
    );
  seenBooks.add(bookId);

  const shelves = key(row.Bookshelves)
    .split(",")
    .map((shelf) => shelf.trim())
    .filter(Boolean);
  const readCount = number(row["Read Count"]);
  const dateRead = csvDate(row["Date Read"]);
  const status =
    dateRead || readCount > 0
      ? "read"
      : shelves.includes("currently-reading") ||
          shelves.includes("currently reading")
        ? "reading"
        : shelves.includes("did-not-finish") || shelves.includes("dnf")
          ? "did-not-finish"
          : shelves.includes("to-read") ||
              shelves.includes("want-to-read") ||
              shelves.includes("owned")
            ? "want"
            : null;
  if (!status)
    throw new Error(
      `Row ${index + 2} (${row.Title || bookId}): no supported shelf or read evidence; refusing to guess.`,
    );

  const isbn13 = isbn(row.ISBN13);
  const isbn10 = isbn(row.ISBN);
  const rating = number(row["My Rating"]);
  const average = number(row["Average Rating"]);
  const title = clean(row.Title);
  const author = clean(row.Author);
  return {
    goodreads_book_id: bookId,
    goodreads_review_id: `csv-${bookId}`,
    book_url: `https://www.goodreads.com/book/show/${bookId}`,
    title,
    author,
    shelves: [
      status === "read"
        ? "read"
        : status === "reading"
          ? "currently-reading"
          : status === "want"
            ? "to-read"
            : "did-not-finish",
      ...shelves,
    ],
    rating: rating > 0 ? rating : null,
    review_text: clean(row["My Review"]),
    review_url: null,
    comment_count: 0,
    like_count: 0,
    cover_url: null,
    dates: {
      date_started: [],
      date_read: dateRead ? [dateRead] : [],
      date_added: csvDate(row["Date Added"]),
    },
    fields: {
      isbn: isbn10,
      isbn13,
      num_pages: clean(row["Number of Pages"]),
      avg_rating: average ? String(average) : "",
      date_pub: clean(row["Year Published"]),
      date_pub_edition: clean(row["Original Publication Year"]),
      notes: clean(row["Private Notes"]),
      read_count: clean(row["Read Count"]),
      owned: clean(row["Owned Copies"]),
      format: clean(row.Binding),
    },
  };
});

const result = {
  schema_version: 2,
  source: "goodreads-csv",
  goodreads_user_id: userId,
  name,
  expected_books: staged.length,
  records: staged,
  retrieval: {
    bulk_transport: "Goodreads Export Library CSV",
    retrieved_at: new Date().toISOString(),
    limitations: [
      "Goodreads CSV does not include comments, likes, or repeated reading-history slots.",
      "Date Read is treated as evidence of the read shelf because Goodreads exports do not reliably include a read shelf name.",
    ],
  },
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, {
  mode: 0o600,
});
console.log(
  JSON.stringify(
    {
      name,
      records: staged.length,
      output,
      read: staged.filter((r) => r.shelves.includes("read")).length,
      reading: staged.filter((r) => r.shelves.includes("currently-reading"))
        .length,
      want: staged.filter((r) => r.shelves.includes("to-read")).length,
      did_not_finish: staged.filter((r) => r.shelves.includes("did-not-finish"))
        .length,
    },
    null,
    2,
  ),
);

if (apply) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wcr-goodreads-csv-"));
  const stagedPath = path.join(tempDir, "library.json");
  fs.copyFileSync(output, stagedPath);
  try {
    execFileSync(
      process.execPath,
      [
        path.join(import.meta.dirname, "goodreads-import.mjs"),
        "--input",
        stagedPath,
        "--goodreads-user-id",
        userId,
        "--supabase-user-id",
        supabaseId,
        "--reader-id",
        readerId,
        "--apply",
      ],
      { stdio: "inherit" },
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
