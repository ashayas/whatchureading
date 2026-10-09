import { execFileSync } from "node:child_process";
import "./env.mjs";
// Read the staged bytes, not working copies: these are what Git will publish.
const files = execFileSync("git", ["ls-files", "--cached", "-z"])
  .toString()
  .split("\0")
  .filter(Boolean);
const forbiddenPath =
  /(^|\/)(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?|wrangler\.jsonc|worker-configuration\.d\.ts|AGENTS\.md|__pycache__)(?:\/|$)|^(?:artifacts|data|imports|captures|uploads|\.agent-grid|\.wrangler|dist|build|target|node_modules)\/|\.(?:sqlite.*|db(?:-.*)?|dump|csv|tsv|har|mov|mp4|pem|key|pyc)$/i;
const patterns = [
  ["Supabase project URL", /https?:\/\/[a-z0-9.-]+\.supabase\.(?:co|net)\b/i],
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
];
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
  for (const [label, regex] of patterns)
    if (regex.test(text)) {
      console.error(`${label} in ${file}`);
      problems++;
    }
  if (privateValues.some((value) => bytes.includes(Buffer.from(value)))) {
    console.error(`Private environment value in ${file}`);
    problems++;
  }
  if (
    file.endsWith(".sql") &&
    /\b(?:INSERT\s+INTO|COPY\s+\w+\s+FROM)\b/i.test(text)
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
