import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { authSettings, cloudflareSettings } from "./env.mjs";

const auth = authSettings();
const { accountId, databaseId } = cloudflareSettings();
const config = JSON.parse(await readFile("browser.wrangler.jsonc", "utf8"));
if (
  config.account_id !== accountId ||
  config.d1_databases[0].database_id !== databaseId
) {
  throw new Error(
    "Browser Worker target differs from the configured personal Cloudflare account.",
  );
}
execFileSync(
  "npx",
  ["wrangler", "secret", "bulk", "--config", "browser.wrangler.jsonc"],
  {
    input: JSON.stringify({
      AUTH_SUPABASE_URL: auth.url,
      AUTH_SUPABASE_KEY: auth.publishableKey,
    }),
    stdio: ["pipe", "inherit", "inherit"],
  },
);
execFileSync(
  "npx",
  ["wrangler", "deploy", "--config", "browser.wrangler.jsonc"],
  { stdio: "inherit" },
);
