import { authClient } from "./auth";
export type Shelf = "reading" | "want" | "read" | "did-not-finish";
export type BookKind = "catalog" | "book" | "paper";
export interface Book {
  id: string;
  title: string;
  author: string;
  genre: string;
  pages: number;
  rating: number;
  isbn: string;
  color: string;
  friend_count: number;
  description: string;
  match_score?: number;
  reason?: string;
  kind: BookKind;
  content_key: string | null;
  uploader_reader_id: string | null;
  is_shared: number;
}
// Must match RATING_THRESHOLD in worker/lib.rs: how many books a reader must
// rank before a normalized out-of-5 rating is derived and shown.
export const RATING_THRESHOLD = 5;
export interface LibraryItem {
  book_id: string;
  status: Shelf;
  page: number;
  rank_position: number | null;
  normalized_rating: number | null;
  ranked_total: number;
  review: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  reading_history: string;
}
export type NoteVisibility = "public" | "private";
export interface Thought {
  id: string;
  book_id: string;
  page: number;
  body: string;
  spoiler: number;
  visibility: NoteVisibility;
  created_at: string;
}
export interface Friend {
  id: string;
  name: string;
  book_id: string | null;
  book_title: string | null;
  progress: number;
}
export interface FriendProfile {
  profile: { id: string; name: string; goal: number };
  library: Array<
    LibraryItem & {
      title: string;
      author: string;
      genre: string;
      pages: number;
      book_rating: number;
      isbn: string;
      color: string;
      description: string;
    }
  >;
  notes: Array<Thought & { title: string; author: string }>;
}
export interface Bootstrap {
  reader_id: string;
  profile: { name: string; username?: string | null; goal: number };
  attributes: { label: string; value: number }[];
  recommendations: Book[];
  books: Book[];
  library: LibraryItem[];
  notes: Thought[];
  likes: { activity_id: string }[];
  friends: Friend[];
}
export async function api<T = unknown>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const client = await authClient();
  const {
    data: { session },
  } = await client.auth.getSession();
  if (!session) throw new Error("Please sign in to continue.");
  const res = await fetch("/api/v1/" + path, {
    method,
    signal,
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json()) as T & { error?: string };
  if (res.status === 401) {
    await client.auth.signOut({ scope: "local" });
  }
  if (!res.ok)
    throw new Error(data.error || "Could not save. Please try again.");
  return data as T;
}
export async function apiUploadPdf(
  path: string,
  method: "GET" | "PUT",
  body?: Blob,
): Promise<Blob> {
  const client = await authClient();
  const {
    data: { session },
  } = await client.auth.getSession();
  if (!session) throw new Error("Please sign in to continue.");
  const res = await fetch("/api/v1/" + path, {
    method,
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      ...(body ? { "Content-Type": "application/pdf" } : {}),
    },
    body,
  });
  if (res.status === 401) {
    await client.auth.signOut({ scope: "local" });
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || "Could not load the PDF. Please try again.");
  }
  return res.blob();
}
