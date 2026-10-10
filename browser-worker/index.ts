import { acquire, connect } from "@cloudflare/playwright";

type Env = {
  BROWSER: any;
  DB: D1Database;
  AUTH_SUPABASE_URL: string;
  AUTH_SUPABASE_KEY: string;
};

async function disconnectConnection(browser: any) {
  // Browser Run's Playwright client exposes disconnect at runtime even though
  // older package typings do not include it. Unlike close(), disconnect keeps
  // the remote session and its tabs alive for the next request / Live View.
  if (typeof browser?.disconnect === "function") {
    await browser.disconnect();
  }
}

const allowedOrigins = new Set(["https://whatchureading.com", "https://www.whatchureading.com"]);
const jsonHeaders = { "Content-Type": "application/json", "Cache-Control": "no-store" };

function response(body: unknown, status = 200, origin = "") {
  const headers = new Headers(jsonHeaders);
  if (allowedOrigins.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Vary", "Origin");
  }
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
}

async function readerFor(request: Request, env: Env) {
  const authorization = request.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) throw new Error("Please sign in to continue.");
  const verified = await fetch(`${env.AUTH_SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.AUTH_SUPABASE_KEY, Authorization: authorization },
  });
  if (!verified.ok) throw new Error("Your session expired. Please sign in again.");
  const user = await verified.json() as { id?: string; email?: string; role?: string };
  if (!user.id || user.role !== "authenticated") throw new Error("Invalid session. Please sign in again.");
  let reader = await env.DB.prepare("SELECT id FROM readers WHERE supabase_user_id=?").bind(user.id).first<{ id: string }>();
  if (!reader) {
    const id = crypto.randomUUID();
    const name = (user.email || "Reader").split("@")[0].slice(0, 80) || "Reader";
    await env.DB.prepare("INSERT OR IGNORE INTO readers(id,name,supabase_user_id,email) VALUES (?,?,?,?)")
      .bind(id, name, user.id, user.email || "").run();
    reader = await env.DB.prepare("SELECT id FROM readers WHERE supabase_user_id=?").bind(user.id).first<{ id: string }>();
  }
  if (!reader) throw new Error("Could not create your reader profile.");
  return reader.id;
}

async function start(request: Request, env: Env, origin: string) {
  const readerId = await readerFor(request, env);
  const importId = crypto.randomUUID();
  const { sessionId } = await acquire(env.BROWSER, { keep_alive: 600000 });
  const browser = await connect(env.BROWSER, sessionId);
  try {
    const context = browser.contexts()[0] || await browser.newContext();
    const page = await context.newPage();
    await page.goto("https://www.goodreads.com/review/import", { waitUntil: "domcontentloaded" });
    const cdp = await context.newCDPSession(page);
    const { devtoolsFrontendUrl } = await cdp.send("Cloudflare.getLiveView", {
      mode: "tab",
      expiresInMs: 3600000,
    });
    await env.DB.prepare("INSERT INTO goodreads_browser_sessions(id,reader_id,browser_session_id,status) VALUES (?,?,?,?)")
      .bind(importId, readerId, sessionId, "awaiting_login").run();
    return response({ import_id: importId, live_view_url: devtoolsFrontendUrl }, 200, origin);
  } finally {
    await disconnectConnection(browser);
  }
}

async function status(request: Request, env: Env, importId: string, origin: string) {
  const readerId = await readerFor(request, env);
  const session = await env.DB.prepare("SELECT * FROM goodreads_browser_sessions WHERE id=? AND reader_id=?")
    .bind(importId, readerId).first<any>();
  if (!session) return response({ error: "Import session not found." }, 404, origin);
  if (session.status === "ready") return response({ status: "ready", csv: session.csv }, 200, origin);
  if (session.status === "error") return response({ status: "error", error: session.error || "Goodreads import failed." }, 200, origin);

  let browser: any;
  try {
    browser = await connect(env.BROWSER, session.browser_session_id);
    const context = browser.contexts()[0];
    const page = context?.pages().find((candidate: any) => candidate.url().includes("goodreads.com")) || context?.pages()[0];
    if (!page) throw new Error("The Goodreads browser page closed.");
    const exportButton = page.locator("button.js-LibraryExport").first();
    if (await exportButton.count() && session.status === "awaiting_login") {
      await exportButton.click();
      await env.DB.prepare("UPDATE goodreads_browser_sessions SET status='exporting',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(importId).run();
      return response({ status: "exporting" }, 200, origin);
    }
    const exportLink = page.locator('a[href*="/review_porter/export/"]').first();
    if (await exportLink.count()) {
      const href = await exportLink.getAttribute("href");
      if (!href) throw new Error("Goodreads returned an empty export link.");
      const result = await page.evaluate(async (url: string) => {
        const exportResponse = await fetch(url, { credentials: "include" });
        return { ok: exportResponse.ok, status: exportResponse.status, body: await exportResponse.text() };
      }, new URL(href, page.url()).href);
      if (!result.ok || !result.body.includes("Book Id") || result.body.length > 20_000_000) {
        throw new Error(`Goodreads export failed (${result.status}).`);
      }
      await env.DB.prepare("UPDATE goodreads_browser_sessions SET status='ready',csv=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .bind(result.body, importId).run();
      return response({ status: "ready", csv: result.body }, 200, origin);
    }
    return response({ status: session.status }, 200, origin);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Goodreads import failed.";
    await env.DB.prepare("UPDATE goodreads_browser_sessions SET status='error',error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(message.slice(0, 500), importId).run();
    return response({ status: "error", error: message }, 200, origin);
  } finally {
    await disconnectConnection(browser);
  }
}

async function close(request: Request, env: Env, importId: string, origin: string) {
  const readerId = await readerFor(request, env);
  const session = await env.DB.prepare("SELECT browser_session_id FROM goodreads_browser_sessions WHERE id=? AND reader_id=?")
    .bind(importId, readerId).first<{ browser_session_id: string }>();
  if (session) {
    try { await env.BROWSER.closeSession(session.browser_session_id); } catch { /* already closed */ }
    await env.DB.prepare("DELETE FROM goodreads_browser_sessions WHERE id=?").bind(importId).run();
  }
  return response({ ok: true }, 200, origin);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return response({}, 204, origin);
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/start" && request.method === "POST") return await start(request, env, origin);
      const match = url.pathname.match(/^\/api\/(status|close)\/([0-9a-f-]{36})$/i);
      if (match && request.method === "GET" && match[1] === "status") return await status(request, env, match[2], origin);
      if (match && request.method === "POST" && match[1] === "close") return await close(request, env, match[2], origin);
      return response({ error: "Not found" }, 404, origin);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Browser session failed.";
      const statusCode = message.startsWith("Please sign in") || message.startsWith("Your session") || message.startsWith("Invalid session") ? 401 : 500;
      return response({ error: message }, statusCode, origin);
    }
  },
};
