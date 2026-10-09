import assert from "node:assert/strict";
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
