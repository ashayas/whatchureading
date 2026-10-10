// Real Supabase identities for end-to-end checks. No credentials are logged.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { authSettings, checkedConfig } from "./env.mjs";
const config = checkedConfig();
const { url: authUrl, publishableKey: publicKey } = authSettings();
const created = [];
let adminKey;
export const base = process.env.TEST_BASE_URL || "http://127.0.0.1:8787";
async function admin() {
  if (adminKey) return adminKey;
  if (!process.env.SB_TOKEN) process.loadEnvFile(".env");
  const ref = new URL(authUrl).hostname.split(".")[0];
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${ref}/api-keys`,
    { headers: { Authorization: `Bearer ${process.env.SB_TOKEN}` } },
  );
  assert.equal(
    response.status,
    200,
    "Management token must be allowed to read API keys for test cleanup",
  );
  const keys = await response.json();
  adminKey = keys.find((k) => k.name === "service_role")?.api_key;
  assert.ok(adminKey, "Test admin key is available");
  return adminKey;
}
let preparedCatalog = false;
function prepareLocalCatalog() {
  if (
    preparedCatalog ||
    !["localhost", "127.0.0.1"].includes(new URL(base).hostname)
  )
    return;
  const output = execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "DB",
      "--local",
      "--command",
      "SELECT COUNT(*) AS count FROM books",
      "--json",
    ],
    { stdio: "pipe" },
  ).toString();
  if (JSON.parse(output)[0].results[0].count === 0) {
    // Fictional, generated test fixtures; never copy someone's reading/catalog export.
    const ids = [
      "midnight",
      "creative",
      "crawdads",
      "tomorrow",
      "atomic",
      "educated",
      "normal",
      "dune",
      "piranesi",
      "project",
      "fixture-a",
      "fixture-b",
      "fixture-c",
      "fixture-d",
      "fixture-e",
      "fixture-f",
    ];
    const values = ids
      .map(
        (id, i) =>
          `('${id}','Fixture Book ${i + 1}','Test Author','Fiction',600,4,NULL,'#60786a',0,'Generated test fixture.')`,
      )
      .join(",");
    execFileSync(
      "npx",
      [
        "wrangler",
        "d1",
        "execute",
        "DB",
        "--local",
        "--command",
        `INSERT INTO books(id,title,author,genre,pages,rating,isbn,color,friend_count,description) VALUES ${values}`,
      ],
      { stdio: "pipe" },
    );
  }
  preparedCatalog = true;
}
export async function createTestUser({ signup = false } = {}) {
  const host = new URL(base).hostname;
  if (!["localhost", "127.0.0.1"].includes(host)) {
    assert.equal(
      process.env.TEST_ALLOW_REMOTE,
      "1",
      "Remote data tests require TEST_ALLOW_REMOTE=1",
    );
    assert.ok(
      [
        process.env.CF_CUSTOM_DOMAIN,
        `www.${process.env.CF_CUSTOM_DOMAIN}`,
      ].includes(host),
    );
  }
  prepareLocalCatalog();
  const key = await admin(); // Ensure cleanup can run before creating a user.
  const email = `wcr-test-${crypto.randomUUID()}@example.com`;
  const password = `Wcr!${crypto.randomUUID()}9`;
  const response = await fetch(
    authUrl + (signup ? "/auth/v1/signup" : "/auth/v1/admin/users"),
    {
      method: "POST",
      headers: {
        apikey: signup ? publicKey : key,
        Authorization: `Bearer ${signup ? publicKey : key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        password,
        ...(signup ? {} : { email_confirm: true }),
      }),
    },
  );
  assert.ok(response.ok, `Create test account (${response.status})`);
  const data = await response.json();
  const id = data.user?.id || data.id;
  assert.match(id, /^[0-9a-f-]{36}$/);
  created.push(id);
  const login = await fetch(authUrl + "/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: { apikey: publicKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(login.status, 200, "Password login works");
  const session = await login.json();
  assert.ok(session.access_token);
  return { id, email, password, token: session.access_token };
}
export async function cleanupTestUsers() {
  if (!created.length) return;
  const key = await admin();
  // Only our just-created UUIDs; never clean by name/email patterns.
  const ids = created
    .map((id) => {
      assert.match(id, /^[0-9a-f-]{36}$/);
      return `'${id}'`;
    })
    .join(",");
  const readerIds = `(SELECT id FROM readers WHERE supabase_user_id IN (${ids}))`;
  const where = `reader_id IN ${readerIds}`;
  const sql =
    ["library", "notes", "swipes", "likes"]
      .map((table) => `DELETE FROM ${table} WHERE ${where};`)
      .join("\n") +
    `\nDELETE FROM reader_friends WHERE reader_id IN ${readerIds} OR friend_id IN ${readerIds};` +
    `\nDELETE FROM books WHERE uploader_reader_id IN ${readerIds};` +
    `\nDELETE FROM readers WHERE supabase_user_id IN (${ids});`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wcr-auth-cleanup-"));
  const file = path.join(dir, "cleanup.sql");
  fs.writeFileSync(file, sql, { mode: 0o600 });
  try {
    const url = new URL(base);
    const remote = !["localhost", "127.0.0.1"].includes(url.hostname);
    if (remote) {
      assert.equal(
        process.env.TEST_ALLOW_REMOTE,
        "1",
        "Remote data tests require TEST_ALLOW_REMOTE=1",
      );
      assert.ok(
        [
          process.env.CF_CUSTOM_DOMAIN,
          `www.${process.env.CF_CUSTOM_DOMAIN}`,
        ].includes(url.hostname),
        "Remote test host must match configured domain",
      );
    }
    checkedConfig();
    execFileSync(
      "npx",
      [
        "wrangler",
        "d1",
        "execute",
        "DB",
        remote ? "--remote" : "--local",
        "--file",
        file,
      ],
      { stdio: "pipe" },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const id of created) {
      const result = await fetch(`${authUrl}/auth/v1/admin/users/${id}`, {
        method: "DELETE",
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
      assert.ok(result.ok, "Temporary auth account removed");
    }
    created.length = 0;
  }
}
export async function recoveryLink(email) {
  const key = await admin();
  const response = await fetch(
    `${authUrl}/auth/v1/admin/generate_link?redirect_to=${encodeURIComponent(base + "/auth/callback?recovery=1")}`,
    {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "recovery", email }),
    },
  );
  assert.equal(
    response.status,
    200,
    "Recovery link can be generated without sending email",
  );
  const data = await response.json();
  assert.ok(data.action_link);
  assert.ok(data.hashed_token);
  return `${base}/auth/callback?token_hash=${encodeURIComponent(data.hashed_token)}&type=recovery`;
}
