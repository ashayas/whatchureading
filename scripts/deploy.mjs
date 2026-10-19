import { execFileSync } from "node:child_process";
import { authSettings, checkedConfig } from "./env.mjs";
checkedConfig();
const auth = authSettings();
execFileSync("npm", ["run", "build"], { stdio: "inherit" });
// Supply only auth bindings via stdin; never upload management/database credentials.
execFileSync("npx", ["wrangler", "secret", "bulk"], {
  input: JSON.stringify({
    AUTH_SUPABASE_URL: auth.url,
    AUTH_SUPABASE_KEY: auth.publishableKey,
  }),
  stdio: ["pipe", "inherit", "inherit"],
});
execFileSync("npx", ["wrangler", "deploy"], { stdio: "inherit" });
execFileSync("npm", ["run", "deploy:mcp"], { stdio: "inherit" });
