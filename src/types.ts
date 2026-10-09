import { authClient } from "./auth";
export type Shelf = "reading" | "want" | "read";
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
}
export interface LibraryItem {
  book_id: string;
  status: Shelf;
  page: number;
  rating: number | null;
  review: string;
  updated_at: string;
  finished_at: string | null;
}
export interface Thought {
  id: string;
  book_id: string;
  page: number;
  body: string;
  spoiler: number;
  created_at: string;
}
export interface Bootstrap {
  reader_id: string;
  profile: { name: string; goal: number };
  attributes: { label: string; value: number }[];
  recommendations: Book[];
  books: Book[];
  library: LibraryItem[];
  notes: Thought[];
  likes: { activity_id: string }[];
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
