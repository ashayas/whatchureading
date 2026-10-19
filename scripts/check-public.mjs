import { execFileSync } from "node:child_process";
import "./env.mjs";
// Read the staged bytes, not working copies: these are what Git will publish.
const files = execFileSync("git", ["ls-files", "--cached", "-z"])
  .toString()
  .split("\0")
  .filter(Boolean);
const forbiddenPath =
  /(^|\/)(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?|wrangler\.jsonc|worker-configuration\.d\.ts|AGENTS\.md|__pycache__|mobile-app)(?:\/|$)|^(?:artifacts|data|imports|captures|uploads|\.agent-grid|\.wrangler|dist|build|target|node_modules|mobile-app)\/|\.(?:sqlite.*|db(?:-.*)?|dump|csv|tsv|har|mov|mp4|pem|key|pyc)$/i;
// Placeholder hostnames used in docs/examples, never a real project ref.
const supabasePlaceholders = /^(?:your|example|my)-?project$/i;
const patterns = [
  [
    "Supabase project URL",
    /https?:\/\/([a-z0-9.-]+)\.supabase\.(?:co|net)\b/i,
    (match) => !supabasePlaceholders.test(match[1]),
  ],
  ["Supabase key", /\b(?:sbp_|sb_secret_|sb_publishable_)[A-Za-z0-9_-]{20,}\b/],
  [
    "JWT credential",
    /\beyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/,
  ],
  [
    "GitHub credential",
    /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/,
  ],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
].map(([label, regex, extra]) => [label, regex, extra || (() => true)]);
const privateValues = [
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SB_TOKEN",
  "PG_PW",
  "CF_ACCOUNT_ID",
  "CF_D1_DATABASE_ID",
]
  .map((name) => process.env[name])
  .filter((value) => value && value.length >= 8);
if (process.env.SUPABASE_URL)
  privateValues.push(new URL(process.env.SUPABASE_URL).hostname.split(".")[0]);
let problems = 0;
for (const file of files) {
  if (
    file !== ".env.example" &&
    (forbiddenPath.test(file) ||
      file === "src/catalog.json" ||
      file === "docs/goodreads-import.md" ||
      file === "migrations/0002_catalog.sql" ||
      file.startsWith("public/covers/"))
  ) {
    console.error(`Private/generated/data file staged: ${file}`);
    problems++;
  }
  const bytes = execFileSync("git", ["show", `:${file}`]);
  const text = bytes.toString();
  for (const [label, regex, isReal] of patterns) {
    const match = regex.exec(text);
    if (match && isReal(match)) {
      console.error(`${label} in ${file}`);
      problems++;
    }
  }
  if (privateValues.some((value) => bytes.includes(Buffer.from(value)))) {
    console.error(`Private environment value in ${file}`);
    problems++;
  }
  // INSERT...SELECT (a schema-migration table rebuild copying existing rows
  // by query) carries no literal data; only INSERT...VALUES or COPY...FROM do.
  // Trigger bodies are skipped: their VALUES are new./old. row references.
  const sql = text.replace(/\bCREATE\s+TRIGGER\b[\s\S]*?\bEND\s*;/gi, "");
  if (
    file.endsWith(".sql") &&
    (/\bINSERT\s+INTO\s+\S+[\s\S]*?\bVALUES\s*\(/i.test(sql) ||
      /\bCOPY\s+\w+\s+FROM\b/i.test(sql))
  ) {
    console.error(`Data-bearing SQL in ${file}`);
    problems++;
  }
}
if (!files.length) throw new Error("No staged/tracked files to check.");
if (problems) process.exit(1);
console.log(
  `PASS: ${files.length} staged files contain no detected credentials, private project URL, data exports, or generated runtime configuration.`,
);
