import fs from "node:fs";
import { authSettings, cloudflareSettings } from "./env.mjs";
const auth = authSettings();
const cloudflare = cloudflareSettings();
const config = JSON.parse(fs.readFileSync("wrangler.example.jsonc", "utf8"));
config.account_id = cloudflare.accountId;
config.d1_databases[0].database_id = cloudflare.databaseId;
if (cloudflare.domain)
  config.routes = [cloudflare.domain, `www.${cloudflare.domain}`].map(
    (pattern) => ({ pattern, custom_domain: true }),
  );
fs.writeFileSync("wrangler.jsonc", JSON.stringify(config, null, 2) + "\n", {
  mode: 0o600,
});
fs.writeFileSync(
  ".dev.vars",
  `AUTH_SUPABASE_URL=${JSON.stringify(auth.url)}\nAUTH_SUPABASE_KEY=${JSON.stringify(auth.publishableKey)}\n`,
  { mode: 0o600 },
);
fs.chmodSync("wrangler.jsonc", 0o600);
fs.chmodSync(".dev.vars", 0o600);
console.log(
  "Generated ignored Wrangler configuration and local auth bindings. No remote resources changed.",
);
