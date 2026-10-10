import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  base,
  createTestUser,
  cleanupTestUsers,
} from "./auth-test-helpers.mjs";
let user;
async function request(
  path,
  method = "GET",
  body,
  token = user?.token,
  extraHeaders = {},
) {
  const r = await fetch(base + "/api/v1/" + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json() };
}
try {
  user = await createTestUser({ signup: true });
  const other = await createTestUser();
  assert.equal((await request("bootstrap", "GET", undefined, "")).status, 401);
  assert.equal(
    (await request("bootstrap", "GET", undefined, "forged-token")).status,
    401,
  );
  assert.equal(
    (
      await request("bootstrap", "GET", undefined, "", {
        "X-Reader-Id": crypto.randomUUID(),
        Cookie: `wcr_reader=${crypto.randomUUID()}`,
      })
    ).status,
    401,
  );
  assert.equal(
    (await request("library", "PUT", { book_id: "atomic", status: "read" }, ""))
      .status,
    401,
  );
  let r = await request("health");
  assert.equal(r.data.backend, "rust");
  r = await request("bootstrap");
  assert.equal(r.status, 200);
  assert.equal(r.data.books.length >= 16, true);
  assert.equal(r.data.library.length, 0);
  assert.equal(r.data.notes.length, 0);
  assert.notEqual(r.data.reader_id, user.id);
  const username = `reader_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  r = await request(
    `username-available?username=${username}`,
    "GET",
    undefined,
    "",
  );
  assert.equal(r.data.available, true);
  assert.equal((await request("username", "PUT", { username })).status, 200);
  r = await request(
    `username-available?username=${username}`,
    "GET",
    undefined,
    "",
  );
  assert.equal(r.data.available, false);
  assert.equal(
    (await request("username", "PUT", { username }, other.token)).status,
    409,
  );
  r = await request("bootstrap");
  assert.equal(r.data.profile.username, username);
  await request("library", "PUT", {
    book_id: "midnight",
    status: "reading",
    page: 190,
  });
  r = await request("bootstrap");
  assert.equal(r.data.library.find((b) => b.book_id === "midnight").page, 190);
  r = await request("notes", "POST", {
    book_id: "midnight",
    page: 190,
    body: "A test thought at page 190",
    spoiler: true,
  });
  assert.equal(r.status, 201);
  r = await request("library", "PUT", {
    book_id: "midnight",
    status: "read",
    page: 304,
    rating: 5,
    review: "Beautiful and thoughtful.",
  });
  assert.equal(r.status, 200);
  r = await request("bootstrap");
  assert.equal(
    r.data.library.find((b) => b.book_id === "midnight").review,
    "Beautiful and thoughtful.",
  );
  assert.equal(
    r.data.notes.find((n) => n.body === "A test thought at page 190").spoiler,
    1,
  );
  assert.equal(
    r.data.library.find((b) => b.book_id === "midnight").finished_at?.length >
      0,
    true,
  );
  r = await request("library", "PUT", {
    book_id: "midnight",
    status: "reading",
    page: 9999,
  });
  assert.equal(r.status, 400);
  r = await request("notes", "POST", {
    book_id: "midnight",
    page: 10,
    body: " ",
  });
  assert.equal(r.status, 400);
  r = await request("swipes", "POST", { book_id: "crawdads", action: "want" });
  assert.equal(r.status, 200);
  r = await request("swipes", "POST", { book_id: "project", action: "skip" });
  assert.equal(r.status, 200);
  r = await request("bootstrap");
  assert.equal(
    r.data.library.some((b) => b.book_id === "crawdads" && b.status === "want"),
    true,
  );
  assert.equal(
    r.data.recommendations.some((b) => b.id === "project"),
    false,
  );
  r = await request("profile", "PUT", { name: "Test Reader", goal: 30 });
  assert.equal(r.status, 200);
  r = await request("bootstrap");
  assert.equal(r.data.profile.goal, 30);
  const reader = r.data.reader_id;
  r = await request("bootstrap", "GET", undefined, other.token, {
    "X-Reader-Id": reader,
    Cookie: `wcr_reader=${reader}`,
  });
  assert.equal(r.data.library.length, 0);
  assert.equal(r.data.notes.length, 0);
  assert.notEqual(r.data.reader_id, reader);
  assert.notEqual(r.data.profile.name, "Test Reader");
  // A body-supplied reader ID cannot redirect writes to another account.
  r = await request(
    "profile",
    "PUT",
    { reader_id: reader, name: "Other Reader", goal: 12 },
    other.token,
  );
  assert.equal(r.status, 200);
  r = await request("bootstrap");
  assert.equal(r.data.profile.name, "Test Reader");
  assert.equal(r.data.profile.goal, 30);
  r = await request("library", "DELETE", { book_id: "crawdads" });
  assert.equal(r.status, 200);
  console.log(
    "PASS: real Supabase signup/login, anonymous & forged-token rejection, D1 persistence, notes, reviews, validation, swipes, profile, and two-account isolation.",
  );
} finally {
  await cleanupTestUsers();
}
try {
  const owner = await createTestUser();
  const friend = await createTestUser();
  const stranger = await createTestUser();
  async function req(path, method, body, token, extraHeaders = {}) {
    const r = await fetch(base + "/api/v1/" + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...extraHeaders,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: await r.json() };
  }
  // Let `friend` see `owner`'s profile via the friends endpoint.
  const ownerBoot = await req("bootstrap", "GET", undefined, owner.token);
  const friendBoot = await req("bootstrap", "GET", undefined, friend.token);
  execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "DB",
      "--local",
      "--command",
      `INSERT INTO reader_friends(reader_id,friend_id) VALUES ('${friendBoot.data.reader_id}','${ownerBoot.data.reader_id}')`,
    ],
    { stdio: "pipe" },
  );
  let r = await req("uploads", "POST", {
    title: "My Uploaded Paper",
    author: "Test Author",
    kind: "paper",
    pages: 3,
    topic: "Physics & Math",
  }, owner.token);
  assert.equal(r.status, 201);
  const bookId = r.data.id;
  const pdfBytes = Buffer.concat([
    Buffer.from("%PDF-1.4\n"),
    Buffer.alloc(16, 0),
  ]);
  const putRes = await fetch(`${base}/api/v1/uploads/${bookId}/content`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${owner.token}`,
      "Content-Type": "application/pdf",
    },
    body: pdfBytes,
  });
  assert.equal(putRes.status, 200);
  const getRes = await fetch(`${base}/api/v1/uploads/${bookId}/content`, {
    headers: { Authorization: `Bearer ${owner.token}` },
  });
  assert.equal(getRes.status, 200);
  assert.equal(getRes.headers.get("content-type"), "application/pdf");
  const roundTrip = Buffer.from(await getRes.arrayBuffer());
  assert.equal(roundTrip.equals(pdfBytes), true);
  // A different reader can never fetch another reader's uploaded content.
  const forbidden = await fetch(`${base}/api/v1/uploads/${bookId}/content`, {
    headers: { Authorization: `Bearer ${stranger.token}` },
  });
  assert.equal(forbidden.status, 404);
  // Personal uploads never leak into another reader's shared catalog/discovery.
  r = await req("bootstrap", "GET", undefined, stranger.token);
  assert.equal(r.data.books.some((b) => b.id === bookId), false);
  assert.equal(r.data.recommendations.some((b) => b.id === bookId), false);
  r = await req("bootstrap", "GET", undefined, owner.token);
  assert.equal(r.data.books.some((b) => b.id === bookId), true);
  r = await req("uploads/mine", "GET", undefined, owner.token);
  assert.equal(r.data.books.some((b) => b.id === bookId), true);
  assert.equal(
    r.data.books.find((b) => b.id === bookId).topic,
    "Physics & Math",
  );
  // A paper upload without a valid topic is rejected.
  r = await req("uploads", "POST", {
    title: "Missing Topic",
    author: "Test Author",
    kind: "paper",
    pages: 2,
  }, owner.token);
  assert.equal(r.status, 400);
  // Finishing a paper feeds the paper-specific academic radar, not the book one.
  r = await req("library", "PUT", { book_id: bookId, status: "read", page: 3 }, owner.token);
  assert.equal(r.status, 200);
  r = await req("bootstrap", "GET", undefined, owner.token);
  assert.equal(
    r.data.paper_attributes.find((a) => a.label === "Physics & Math").value > 15,
    true,
  );
  // Public vs. private notes.
  r = await req(
    "notes",
    "POST",
    { book_id: bookId, page: 1, body: "A public thought", visibility: "public" },
    owner.token,
  );
  assert.equal(r.status, 201);
  r = await req(
    "notes",
    "POST",
    { book_id: bookId, page: 2, body: "A private thought", visibility: "private" },
    owner.token,
  );
  assert.equal(r.status, 201);
  r = await req("bootstrap", "GET", undefined, owner.token);
  assert.equal(
    r.data.notes.find((n) => n.body === "A public thought").visibility,
    "public",
  );
  assert.equal(
    r.data.notes.find((n) => n.body === "A private thought").visibility,
    "private",
  );
  r = await req(`friends/${ownerBoot.data.reader_id}`, "GET", undefined, friend.token);
  assert.equal(r.status, 200);
  assert.equal(r.data.notes.some((n) => n.body === "A public thought"), true);
  assert.equal(r.data.notes.some((n) => n.body === "A private thought"), false);
  console.log(
    "PASS: PDF upload content round-trip, cross-account upload isolation, and public/private note visibility.",
  );
} finally {
  await cleanupTestUsers();
}
