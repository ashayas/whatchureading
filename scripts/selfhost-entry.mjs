import fs from "node:fs";
import http from "node:http";
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

const publicPort = process.env.PORT || "8787";
const appPort = "18787";
const mcpPort = "18788";
const dataDir = process.env.DATA_DIR || "/data";
const config = "wrangler.selfhost.jsonc";
const mcpConfig = "mcp.wrangler.selfhost.jsonc";
const varsPath = ".dev.vars";
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(
  varsPath,
  `AUTH_SUPABASE_URL=${JSON.stringify(authUrl)}\nAUTH_SUPABASE_KEY=${JSON.stringify(authKey)}\n`,
  { mode: 0o600 },
);

const wrangler = "node_modules/.bin/wrangler";
const children = [];

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

// Starts a long-running `wrangler dev` and resolves once it is accepting
// connections, so the reverse proxy never races either Worker's startup.
function startDevServer(args, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(wrangler, args, { stdio: "inherit" });
    children.push(child);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (!code && !signal) return;
      reject(new Error(`wrangler dev exited (${signal || code})`));
    });
    const deadline = Date.now() + 30000;
    const poll = () => {
      const probe = http.get(
        { host: "127.0.0.1", port, path: "/", timeout: 1000 },
        (res) => {
          res.destroy();
          resolve(child);
        },
      );
      probe.on("error", () => {
        if (Date.now() > deadline)
          return reject(new Error(`Timed out waiting for port ${port}`));
        setTimeout(poll, 300);
      });
    };
    setTimeout(poll, 300);
  });
}

// Multiplexes the app Worker and the MCP Worker onto one public port, since
// the app is Rust/Wasm and the MCP server is a separate TypeScript Worker —
// self-hosters still get both from a single container on a single port.
function startProxy() {
  const server = http.createServer((req, res) => {
    const target = req.url?.startsWith("/mcp") ? mcpPort : appPort;
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: target,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Upstream Worker is not responding." }));
    });
    req.pipe(upstream);
  });
  server.listen(Number(publicPort), "0.0.0.0");
  return server;
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
  await Promise.all([
    startDevServer(
      [
        "dev",
        "--local",
        "--config",
        config,
        "--persist-to",
        dataDir,
        "--ip",
        "127.0.0.1",
        "--port",
        appPort,
        "--inspector-port",
        "9230",
        "--show-interactive-dev-session=false",
      ],
      appPort,
    ),
    startDevServer(
      [
        "dev",
        "--local",
        "--config",
        mcpConfig,
        "--persist-to",
        dataDir,
        "--ip",
        "127.0.0.1",
        "--port",
        mcpPort,
        "--inspector-port",
        "9231",
        "--show-interactive-dev-session=false",
      ],
      mcpPort,
    ),
  ]);
  const proxy = startProxy();
  await new Promise((resolve) => {
    const shutdown = () => {
      proxy.close();
      for (const child of children) child.kill();
      resolve();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
} finally {
  fs.rmSync(varsPath, { force: true });
}
