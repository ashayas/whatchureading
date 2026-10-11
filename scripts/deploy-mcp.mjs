import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { cloudflareSettings } from "./env.mjs";

const { accountId, databaseId } = cloudflareSettings();
const config = JSON.parse(await readFile("mcp.wrangler.jsonc", "utf8"));
if (config.account_id !== accountId || config.d1_databases[0].database_id !== databaseId) {
  throw new Error("MCP Worker target differs from the configured personal Cloudflare account.");
}
execFileSync("npx", ["wrangler", "deploy", "--config", "mcp.wrangler.jsonc"], { stdio: "inherit" });
