import fs from "node:fs";
if (fs.existsSync(".env")) process.loadEnvFile(".env");
export function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} in your ignored .env file.`);
  return value;
}
export function authSettings() {
  const url = requiredEnv("SUPABASE_URL").replace(/\/$/, "");
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  )
    throw new Error("SUPABASE_URL must be an HTTPS project origin.");
  return { url, publishableKey: requiredEnv("SUPABASE_PUBLISHABLE_KEY") };
}
export function cloudflareSettings() {
  const accountId = requiredEnv("CF_ACCOUNT_ID");
  const databaseId = requiredEnv("CF_D1_DATABASE_ID");
  if (
    !/^[a-f0-9]{32}$/i.test(accountId) ||
    !/^[a-f0-9-]{36}$/i.test(databaseId)
  )
    throw new Error(
      "Set valid Cloudflare account and D1 identifiers before setup or deployment.",
    );
  const domain = process.env.CF_CUSTOM_DOMAIN?.trim();
  if (domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain))
    throw new Error("CF_CUSTOM_DOMAIN must be a hostname.");
  return { accountId, databaseId, domain };
}
export function checkedConfig() {
  const config = JSON.parse(fs.readFileSync("wrangler.jsonc", "utf8"));
  const settings = cloudflareSettings();
  if (
    config.account_id !== settings.accountId ||
    config.d1_databases[0].database_id !== settings.databaseId
  )
    throw new Error(
      "Wrangler target differs from .env. Run npm run setup and verify the intended account.",
    );
  if (config.vars?.SUPABASE_URL || config.vars?.SUPABASE_PUBLISHABLE_KEY)
    throw new Error(
      "Auth configuration belongs in .env and Worker secrets, not Wrangler vars.",
    );
  return config;
}
