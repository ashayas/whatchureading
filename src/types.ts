import { authClient } from "./auth";
export type Shelf = "reading" | "want" | "read" | "did-not-finish";
export type BookKind = "catalog" | "book" | "paper";
// Broad paper domains, chosen (or suggested from the paper's text) at upload.
// The specific fields within each live in src/paperTopics.ts.
export const PAPER_TOPICS = [
  "Computer Science",
  "Mathematics",
  "Physics",
  "Life Sciences",
  "Medicine & Health",
  "Chemistry & Materials",
  "Earth & Environment",
  "Engineering",
  "Economics & Finance",
  "Social Sciences",
  "Humanities",
] as const;
export type PaperTopic = (typeof PAPER_TOPICS)[number];
// Deprecated: per-page keyword counting in the reader was replaced by
// full-text classification at upload (src/paperTopics.ts). Kept empty so the
// reader extracts nothing until it stops referencing this.
export const PAPER_SUBTOPICS: Record<string, { label: string; keywords: string[] }[]> =
  Object.fromEntries(PAPER_TOPICS.map((t) => [t, []]));
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
  topic: PaperTopic | null;
  // R2 key of an uploaded paper's first-page snapshot, if one exists.
  cover_key?: string | null;
  // Full-text classification, JSON {"Domain/Field": share} (src/paperTopics.ts).
  topic_signals?: string | null;
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
  topic_signals: string;
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
  /** Passage quoted from a PDF, when the thought came from a highlight. */
  quote?: string | null;
  /** JSON {"v":1,"rects":[[x,y,w,h],...]} of page-relative highlight rects. */
  anchor?: string | null;
}
export interface Friend {
  id: string;
  name: string;
  avatar_key: string | null;
  book_id: string | null;
  book_title: string | null;
  progress: number;
}
export interface FriendNote {
  id: string;
  reader_id: string;
  name: string;
  avatar_key: string | null;
  book_id: string;
  title: string;
  author: string;
  page: number;
  body: string;
  spoiler: number;
  created_at: string;
}
export interface FriendProfile {
  profile: {
    id: string;
    name: string;
    goal: number;
    avatar_key: string | null;
  };
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
export type GroupRole = "owner" | "member";
export interface GroupSummary {
  id: string;
  name: string;
  description: string;
  created_by: string;
  member_count: number;
  pick_id: string | null;
  pick_book_id: string | null;
  pick_title: string | null;
  pick_author: string | null;
}
export interface GroupMember {
  reader_id: string;
  role: GroupRole;
  name: string;
  username: string | null;
}
export interface GroupPick {
  id: string;
  book_id: string;
  starts_at: string;
  ends_at?: string | null;
  selected_by?: string;
  title: string;
  author: string;
  pages?: number;
}
export interface GroupProgress {
  reader_id: string;
  name: string;
  status: Shelf | null;
  page: number | null;
}
export interface GroupComment {
  id: string;
  body: string;
  created_at: string;
  reader_id: string;
  name: string;
}
export interface GroupDetail {
  group: {
    id: string;
    name: string;
    description: string;
    created_by: string;
    created_at: string;
  };
  role: GroupRole;
  members: GroupMember[];
  current_pick: GroupPick | null;
  progress: GroupProgress[];
  comments: GroupComment[];
  past_picks: GroupPick[];
}
export interface Bootstrap {
  reader_id: string;
  profile: {
    name: string;
    username?: string | null;
    goal: number;
    avatar_key?: string | null;
  };
  attributes: { label: string; value: number }[];
  paper_attributes: {
    label: string;
    value: number;
    domain?: string;
    kind?: "field" | "domain";
    share?: number;
  }[];
  recommendations: Book[];
  books: Book[];
  library: LibraryItem[];
  notes: Thought[];
  likes: { activity_id: string }[];
  friends: Friend[];
  friend_notes: FriendNote[];
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
export async function apiUploadAvatar(file: Blob): Promise<void> {
  const client = await authClient();
  const {
    data: { session },
  } = await client.auth.getSession();
  if (!session) throw new Error("Please sign in to continue.");
  const res = await fetch("/api/v1/avatar", {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": file.type || "image/jpeg",
    },
    body: file,
  });
  if (res.status === 401) {
    await client.auth.signOut({ scope: "local" });
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || "Could not upload your picture. Try again.");
  }
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
