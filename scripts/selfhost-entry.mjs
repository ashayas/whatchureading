import fs from "node:fs";
import { spawn } from "node:child_process";

const authUrl = process.env.SUPABASE_URL?.trim();
const authKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim();
if (!authUrl || !authKey) {
  throw new Error(
    "Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY for self-hosted auth.",
  );
}
const parsed = new URL(authUrl);
if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
  throw new Error("SUPABASE_URL must use HTTPS, except for localhost.");
}
if (
  parsed.username ||
  parsed.password ||
  parsed.pathname !== "/" ||
  parsed.search ||
  parsed.hash
) {
  throw new Error("SUPABASE_URL must be a project origin without a path.");
}

const port = process.env.PORT || "8787";
const dataDir = process.env.DATA_DIR || "/data";
const config = "wrangler.selfhost.jsonc";
const varsPath = ".dev.vars";
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(
  varsPath,
  `AUTH_SUPABASE_URL=${JSON.stringify(authUrl)}\nAUTH_SUPABASE_KEY=${JSON.stringify(authKey)}\n`,
  { mode: 0o600 },
);

const wrangler = "node_modules/.bin/wrangler";
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(wrangler, args, { stdio: "inherit" });
    const stop = (signal) => child.kill(signal);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      if (code === 0) resolve();
      else reject(new Error(`wrangler exited (${signal || code})`));
    });
  });
}

try {
  await run([
    "d1",
    "migrations",
    "apply",
    "DB",
    "--local",
    "--config",
    config,
    "--persist-to",
    dataDir,
  ]);
  await run([
    "dev",
    "--local",
    "--config",
    config,
    "--persist-to",
    dataDir,
    "--ip",
    "0.0.0.0",
    "--port",
    port,
    "--show-interactive-dev-session=false",
  ]);
} finally {
  fs.rmSync(varsPath, { force: true });
}
