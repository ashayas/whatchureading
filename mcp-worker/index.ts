import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

type Env = { DB: D1Database };
type Book = { id: string; title: string; author: string; pages: number };
type LibraryRow = { book_id: string; status: string; page: number; review: string; rank_position: number | null };

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function textContent(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

// Mirrors the Rust worker's book catalog import at POST /api/v1/books/import —
// same defaulted genre/color/description for Open Library imports — so a book
// an agent adds looks identical to one added from the web/mobile app.
async function importBook(db: D1Database, key: string, title: string, author: string, pages: number, coverId: number) {
  if (!key.startsWith("/works/OL") || key.length > 40 || !title || title.length > 250 || author.length > 150 || pages < 1 || pages > 20000 || coverId < 0) {
    throw new Error("Invalid book details");
  }
  const bookId = key.replace("/works/", "");
  await db
    .prepare(
      "INSERT OR IGNORE INTO books(id,title,author,genre,pages,rating,isbn,color,friend_count,description) VALUES (?,?,?,'Fiction',?,0,?,'#60786a',0,'Added from Open Library. Reading attributes use Fiction until more genre metadata is available.')",
    )
    .bind(bookId, title, author, pages, `cover:${coverId}`)
    .run();
  return bookId;
}

function createServer(db: D1Database, readerId: string) {
  const server = new McpServer({ name: "whatchureading", version: "1.0.0" });

  server.registerTool(
    "search_books",
    {
      description: "Search Open Library for a book by title/author. Returns candidates with the open_library_key needed by add_to_want_to_read.",
      inputSchema: { query: z.string().min(2).max(150) },
    },
    async ({ query }) => {
      const upstream = new URL("https://openlibrary.org/search.json");
      upstream.searchParams.set("q", query);
      upstream.searchParams.set("limit", "12");
      upstream.searchParams.set("fields", "key,title,author_name,cover_i,number_of_pages_median");
      const res = await fetch(upstream, { headers: { "User-Agent": "whatchureading.com/0.1 (mcp)" } });
      if (!res.ok) return textContent("The book catalog is taking a break. Try again shortly.");
      const data = (await res.json()) as { docs?: unknown[] };
      const results = (data.docs || []).map((doc) => {
        const d = doc as Record<string, unknown>;
        return {
          open_library_key: d.key,
          title: d.title,
          author: (d.author_name as string[] | undefined)?.[0],
          cover_id: d.cover_i,
          pages: d.number_of_pages_median,
        };
      });
      return textContent(JSON.stringify(results));
    },
  );

  server.registerTool(
    "get_library",
    { description: "List the reader's bookshelf: status, page, and review for every book they've added.", inputSchema: {} },
    async () => {
      const { results } = await db
        .prepare(
          "SELECT l.book_id,l.status,l.page,l.review,l.rank_position,b.title,b.author,b.pages FROM library l JOIN books b ON b.id=l.book_id WHERE l.reader_id=? ORDER BY l.updated_at DESC",
        )
        .bind(readerId)
        .all();
      return textContent(JSON.stringify(results));
    },
  );

  server.registerTool(
    "add_to_want_to_read",
    {
      description: "Add a book to the reader's \"want to read\" shelf. Use search_books first to get open_library_key, title, author, pages, and cover_id.",
      inputSchema: {
        open_library_key: z.string(),
        title: z.string().max(250),
        author: z.string().max(150),
        pages: z.number().int().min(1).max(20000),
        cover_id: z.number().int().min(0).default(0),
      },
    },
    async ({ open_library_key, title, author, pages, cover_id }) => {
      const bookId = await importBook(db, open_library_key, title, author, pages, cover_id ?? 0);
      await db
        .prepare(
          "INSERT INTO library(reader_id,book_id,status,page,review) VALUES (?,?,'want',0,'') ON CONFLICT(reader_id,book_id) DO UPDATE SET status='want',page=0,updated_at=CURRENT_TIMESTAMP,started_at=NULL,rank_position=NULL",
        )
        .bind(readerId, bookId)
        .run();
      return textContent(`Added "${title}" to want-to-read.`);
    },
  );

  server.registerTool(
    "update_reading_progress",
    {
      description: "Update the reader's shelf for a book they already have (from get_library or add_to_want_to_read): status, current page, and optionally a review. Omitting review keeps the existing one.",
      inputSchema: {
        book_id: z.string(),
        status: z.enum(["reading", "want", "read", "did-not-finish"]),
        page: z.number().int().min(0),
        review: z.string().max(5000).optional(),
      },
    },
    async ({ book_id, status, page, review }) => {
      const book = await db.prepare("SELECT pages FROM books WHERE id=?").bind(book_id).first<Book>();
      if (!book) return textContent("Book not found. Use search_books / add_to_want_to_read first.");
      if (page > book.pages) return textContent(`That book only has ${book.pages} pages.`);
      let finalReview = review;
      if (finalReview === undefined) {
        const existing = await db.prepare("SELECT review FROM library WHERE reader_id=? AND book_id=?").bind(readerId, book_id).first<LibraryRow>();
        finalReview = existing?.review ?? "";
      }
      const finalPage = status === "read" ? book.pages : status === "want" || status === "did-not-finish" ? 0 : page;
      await db.batch([
        db
          .prepare(
            "UPDATE library SET rank_position=rank_position-1 WHERE reader_id=? AND ?!='read' AND rank_position > (SELECT rank_position FROM library WHERE reader_id=? AND book_id=?)",
          )
          .bind(readerId, status, readerId, book_id),
        db
          .prepare(
            "INSERT INTO library(reader_id,book_id,status,page,review,started_at,finished_at) VALUES (?,?,?,?,?,CASE WHEN ? IN ('reading','read','did-not-finish') THEN CURRENT_TIMESTAMP ELSE NULL END,CASE WHEN ?='read' THEN CURRENT_TIMESTAMP ELSE NULL END) ON CONFLICT(reader_id,book_id) DO UPDATE SET status=excluded.status,page=excluded.page,review=excluded.review,rank_position=CASE WHEN excluded.status='read' THEN library.rank_position ELSE NULL END,updated_at=CURRENT_TIMESTAMP,started_at=CASE WHEN excluded.status='reading' THEN COALESCE(library.started_at,CURRENT_TIMESTAMP) WHEN excluded.status='want' THEN NULL ELSE library.started_at END,finished_at=CASE WHEN excluded.status='read' THEN COALESCE(library.finished_at,CURRENT_TIMESTAMP) ELSE NULL END",
          )
          .bind(readerId, book_id, status, finalPage, finalReview, status, status),
      ]);
      return textContent(`Updated shelf: ${status} at page ${finalPage}.`);
    },
  );

  server.registerTool(
    "add_comment",
    {
      description: "Leave a page-anchored comment/thought on a book the reader has on their shelf. Public by default.",
      inputSchema: {
        book_id: z.string(),
        page: z.number().int().min(0),
        body: z.string().min(1).max(2000),
        spoiler: z.boolean().optional().default(false),
        visibility: z.enum(["public", "private"]).optional().default("public"),
      },
    },
    async ({ book_id, page, body, spoiler, visibility }) => {
      const book = await db.prepare("SELECT pages FROM books WHERE id=?").bind(book_id).first<Book>();
      if (!book) return textContent("Book not found. Use search_books / add_to_want_to_read first.");
      if (page > book.pages) return textContent(`That book only has ${book.pages} pages.`);
      await db
        .prepare("INSERT INTO notes(id,reader_id,book_id,page,body,spoiler,visibility) VALUES (?,?,?,?,?,?,?)")
        .bind(crypto.randomUUID(), readerId, book_id, page, body.trim(), spoiler ? 1 : 0, visibility)
        .run();
      return textContent("Comment added.");
    },
  );

  return server;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const authorization = request.headers.get("Authorization") || "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!token) {
      return new Response(JSON.stringify({ error: "Missing bearer token. Grab one from whatchureading.com settings." }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    const hash = await sha256Hex(token);
    const reader = await env.DB.prepare("SELECT id FROM readers WHERE agent_token_hash=?").bind(hash).first<{ id: string }>();
    if (!reader) {
      return new Response(JSON.stringify({ error: "Invalid or revoked token." }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    const handler = createMcpHandler(() => createServer(env.DB, reader.id));
    return handler(request, env, ctx);
  },
};
