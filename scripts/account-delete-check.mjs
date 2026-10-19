// Runs worker/lib.rs's ACCOUNT_DELETE_SQL (read straight from the source, so
// this can't drift) against a LOCAL D1 fixture covering every foreign key
// that points at a reader or their uploads, and asserts the batch succeeds
// with foreign keys enforced and leaves other readers' data consistent.
import fs from "node:fs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const source = fs.readFileSync("worker/lib.rs", "utf8");
const block = source.match(/const ACCOUNT_DELETE_SQL: &\[&str\] = &\[([\s\S]*?)\n\];/);
assert.ok(block, "ACCOUNT_DELETE_SQL found in worker/lib.rs");
const statements = [...block[1].matchAll(/^\s*"(.*)",$/gm)].map((m) => m[1]);
assert.ok(statements.length > 10, "parsed the delete statements");

function d1(sql) {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--json", "--command", sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out).at(-1).results;
}

assert.equal(d1("PRAGMA foreign_keys")[0].foreign_keys, 1, "local D1 enforces foreign keys, like production");

const A = "chk-reader-a";
const B = "chk-reader-b";
const cleanup = [
  `DELETE FROM group_pick_comments WHERE id LIKE 'chk-%'`,
  `DELETE FROM group_picks WHERE id LIKE 'chk-%'`,
  `DELETE FROM group_members WHERE group_id LIKE 'chk-%'`,
  `DELETE FROM groups WHERE id LIKE 'chk-%'`,
  `DELETE FROM library WHERE reader_id IN ('${A}','${B}')`,
  `DELETE FROM notes WHERE id LIKE 'chk-%'`,
  `DELETE FROM swipes WHERE reader_id IN ('${A}','${B}')`,
  `DELETE FROM likes WHERE reader_id IN ('${A}','${B}')`,
  `DELETE FROM reader_friends WHERE reader_id IN ('${A}','${B}') OR friend_id IN ('${A}','${B}')`,
  `DELETE FROM books WHERE id LIKE 'chk-%'`,
  `DELETE FROM readers WHERE id IN ('${A}','${B}')`,
].join(";\n");

d1(cleanup);
d1(
  [
    `INSERT INTO readers(id,name) VALUES ('${A}','Deleted'),('${B}','Other')`,
    `INSERT INTO books(id,title,author,genre,pages,rating,color,description) VALUES ('chk-catalog','Catalog','X','Fiction',100,4,'#000','')`,
    `INSERT INTO books(id,title,author,genre,pages,rating,color,description,kind,content_key,uploader_reader_id) VALUES ('chk-upload','Upload','A','Fiction',10,0,'#000','','paper','uploads/chk.pdf','${A}')`,
    // A's own data
    `INSERT INTO library(reader_id,book_id,status) VALUES ('${A}','chk-catalog','read'),('${A}','chk-upload','reading')`,
    `INSERT INTO notes(id,reader_id,book_id,page,body) VALUES ('chk-note-a','${A}','chk-catalog',1,'a')`,
    `INSERT INTO swipes(reader_id,book_id,action) VALUES ('${A}','chk-catalog','want')`,
    `INSERT INTO likes(reader_id,activity_id) VALUES ('${A}','x')`,
    `INSERT INTO reader_friends(reader_id,friend_id) VALUES ('${A}','${B}'),('${B}','${A}')`,
    // B shelved, noted and swiped A's upload
    `INSERT INTO library(reader_id,book_id,status) VALUES ('${B}','chk-upload','want'),('${B}','chk-catalog','read')`,
    `INSERT INTO notes(id,reader_id,book_id,page,body) VALUES ('chk-note-b-upload','${B}','chk-upload',1,'b'),('chk-note-b-catalog','${B}','chk-catalog',1,'b')`,
    `INSERT INTO swipes(reader_id,book_id,action) VALUES ('${B}','chk-upload','want')`,
    // Group A owns, B is in, B picked and commented
    `INSERT INTO groups(id,name,created_by) VALUES ('chk-group-a','A club','${A}'),('chk-group-b','B club','${B}')`,
    `INSERT INTO group_members(group_id,reader_id,role) VALUES ('chk-group-a','${A}','owner'),('chk-group-a','${B}','member'),('chk-group-b','${B}','owner'),('chk-group-b','${A}','member')`,
    `INSERT INTO group_picks(id,group_id,book_id,selected_by) VALUES ('chk-pick-a','chk-group-a','chk-catalog','${B}')`,
    `INSERT INTO group_pick_comments(id,pick_id,reader_id,body) VALUES ('chk-c1','chk-pick-a','${B}','b')`,
    // In B's group: A picked a catalog book and commented; B picked A's upload
    `INSERT INTO group_picks(id,group_id,book_id,selected_by,ends_at) VALUES ('chk-pick-b1','chk-group-b','chk-catalog','${A}',CURRENT_TIMESTAMP)`,
    `INSERT INTO group_picks(id,group_id,book_id,selected_by) VALUES ('chk-pick-b2','chk-group-b','chk-upload','${B}')`,
    `INSERT INTO group_pick_comments(id,pick_id,reader_id,body) VALUES ('chk-c2','chk-pick-b1','${A}','a'),('chk-c3','chk-pick-b1','${B}','b'),('chk-c4','chk-pick-b2','${B}','b')`,
  ].join(";\n"),
);

try {
  d1(statements.map((s) => s.replaceAll("?1", `'${A}'`)).join(";\n"));

  const one = (sql) => d1(sql)[0];
  assert.equal(one(`SELECT COUNT(*) n FROM readers WHERE id='${A}'`).n, 0, "reader removed");
  assert.equal(one(`SELECT COUNT(*) n FROM books WHERE id='chk-upload'`).n, 0, "upload removed");
  assert.equal(one(`SELECT COUNT(*) n FROM groups WHERE id='chk-group-a'`).n, 0, "owned group removed");
  assert.equal(one(`SELECT COUNT(*) n FROM groups WHERE id='chk-group-b'`).n, 1, "other reader's group kept");
  assert.equal(one(`SELECT selected_by FROM group_picks WHERE id='chk-pick-b1'`).selected_by, B, "pick re-credited to group owner");
  assert.equal(one(`SELECT COUNT(*) n FROM group_picks WHERE id='chk-pick-b2'`).n, 0, "pick of the deleted upload removed");
  assert.equal(one(`SELECT COUNT(*) n FROM group_pick_comments WHERE id IN ('chk-c2','chk-c4')`).n, 0, "their comments and comments on removed picks gone");
  assert.equal(one(`SELECT COUNT(*) n FROM group_pick_comments WHERE id='chk-c3'`).n, 1, "other reader's comment on a surviving pick kept");
  assert.equal(one(`SELECT COUNT(*) n FROM library WHERE reader_id='${B}'`).n, 1, "other reader keeps their catalog shelf, loses the upload");
  assert.equal(one(`SELECT COUNT(*) n FROM notes WHERE reader_id='${B}'`).n, 1, "other reader keeps catalog note, loses upload note");
  assert.equal(one(`SELECT COUNT(*) n FROM group_members WHERE reader_id='${A}'`).n, 0, "memberships removed");
  assert.equal(one(`SELECT COUNT(*) n FROM reader_friends WHERE reader_id='${A}' OR friend_id='${A}'`).n, 0, "friendships removed");
  console.log(`PASS: account deletion (${statements.length} statements) is foreign-key safe and preserves other readers' data.`);
} finally {
  d1(cleanup);
}
