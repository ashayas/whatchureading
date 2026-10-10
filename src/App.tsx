import React, { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Bookmark,
  Check,
  ChevronRight,
  Compass,
  ExternalLink,
  FileSpreadsheet,
  GraduationCap,
  Heart,
  Library,
  Loader2,
  MessageCircle,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Star,
  Users,
  Wind,
  X,
} from "lucide-react";
import type { Book, Bootstrap, FriendProfile, LibraryItem, NoteVisibility, PaperTopic, Shelf, Thought } from "./types";
import { api, apiUploadPdf, PAPER_TOPICS, RATING_THRESHOLD } from "./types";
import { authClient, signOut } from "./auth";
import { PdfReader, loadPdfjs } from "./PdfReader";

type Page = "feed" | "friends" | "discover" | "library" | "papers" | "profile";
type GoodreadsImportRecord = {
  goodreads_book_id: string;
  title: string;
  author: string;
  status: Shelf;
  pages: number;
  rating: number | null;
  average_rating: number;
  isbn: string;
  review: string;
  started_at: string;
  finished_at: string;
  description: string;
  history: Record<string, unknown>;
};
const GOODREADS_BROWSER_URL = "https://browser.whatchureading.com";
async function browserApi<T = unknown>(path: string, method = "GET", body?: unknown): Promise<T> {
  const client = await authClient();
  const { data: { session } } = await client.auth.getSession();
  if (!session) throw new Error("Please sign in to continue.");
  const response = await fetch(`${GOODREADS_BROWSER_URL}/api/${path}`, {
    method,
    headers: { Authorization: `Bearer ${session.access_token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error || "Could not open the Goodreads browser.");
  return data as T;
}
const nav = [
  { id: "feed", name: "The feed", icon: BookOpen },
  { id: "friends", name: "Friends", icon: Users },
  { id: "discover", name: "Discover", icon: Compass },
  { id: "library", name: "Your library", icon: Library },
  { id: "papers", name: "Your papers", icon: GraduationCap },
  { id: "profile", name: "Your profile", icon: Users },
] as const;
function Cover({
  book,
  className = "",
  onClick,
}: {
  book: Pick<Book, "id" | "title" | "author" | "isbn" | "color">;
  className?: string;
  onClick?: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const src = book.isbn?.startsWith("cover:")
    ? `https://covers.openlibrary.org/b/id/${book.isbn.slice(6)}-L.jpg`
    : `/covers/${book.id}.jpg`;
  return (
    <button
      className={"cover " + className}
      style={{ background: book.color }}
      onClick={onClick}
      aria-label={"View " + book.title}
    >
      {!failed ? (
        <img
          src={src}
          loading="lazy"
          decoding="async"
          alt={book.title + " cover"}
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="cover-fallback">
          <BookOpen />
          <b>{book.title}</b>
          <small>{book.author}</small>
        </span>
      )}
    </button>
  );
}
function Avatar({
  name,
  color = "peach",
  small = false,
}: {
  name: string;
  color?: string;
  small?: boolean;
}) {
  return (
    <span className={`avatar ${color} ${small ? "small" : ""}`}>
      {name
        .split(" ")
        .map((s) => s[0])
        .join("")
        .slice(0, 2)}
    </span>
  );
}
function Facepile() {
  return (
    <span className="facepile">
      <Avatar name="Maya" small />
      <Avatar name="James" color="sage" small />
      <Avatar name="Sophie" color="lavender" small />
    </span>
  );
}
function importedComments(item: LibraryItem) {
  try {
    const history = JSON.parse(item.reading_history || "{}");
    const comments = history.goodreads?.comments;
    return Array.isArray(comments) ? comments : [];
  } catch {
    return [];
  }
}
function importedTimeline(item: LibraryItem) {
  try {
    const history = JSON.parse(item.reading_history || "{}");
    const events = history.goodreads?.reading_history;
    return Array.isArray(events) ? events.filter((event) => typeof event?.text === "string").map((event) => event.text as string) : [];
  } catch {
    return [];
  }
}
function Stars({ value }: { value: number }) {
  return (
    <span className="stars">
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          size={13}
          fill={n <= Math.round(value) ? "currentColor" : "none"}
        />
      ))}
    </span>
  );
}
// A reader's personal rating is relative: it comes from ranking finished books
// against each other, not from picking a number directly.
function RatingDisplay({ item }: { item: LibraryItem }) {
  if (item.normalized_rating != null) {
    return (
      <span className="rank-score-inline">
        <Stars value={item.normalized_rating} />
        <small>{item.normalized_rating.toFixed(1)} / 5</small>
      </span>
    );
  }
  const remaining = Math.max(0, RATING_THRESHOLD - item.ranked_total);
  return (
    <span className="rating-pending">
      {item.rank_position != null
        ? `Rate ${remaining} more book${remaining === 1 ? "" : "s"} to unlock your rating`
        : "Compare it to rank it"}
    </span>
  );
}
function RelativeRating({
  book,
  ranked,
  busy,
  onDone,
}: {
  book: Book;
  ranked: { book: Book; rank_position: number }[];
  busy: boolean;
  onDone: (rankPosition: number) => void;
}) {
  const [lo, setLo] = useState(0);
  const [hi, setHi] = useState(ranked.length);
  if (!ranked.length) {
    return (
      <div className="relative-rating">
        <h3>Your first finished book.</h3>
        <p>
          There's nothing to compare <b>{book.title}</b> to yet. Finish a few
          more and you'll start ranking them against each other.
        </p>
        <button className="primary" disabled={busy} onClick={() => onDone(0)}>
          Save to your ranking <Check size={16} />
        </button>
      </div>
    );
  }
  if (lo >= hi) {
    return (
      <div className="relative-rating">
        <h3>Got it.</h3>
        <p>
          <b>{book.title}</b> is ranked against the rest of your finished books.
          Keep reading to unlock your rating out of 5.
        </p>
        <button className="primary" disabled={busy} onClick={() => onDone(lo)}>
          Confirm ranking <Check size={16} />
        </button>
      </div>
    );
  }
  const mid = Math.floor((lo + hi) / 2);
  const against = ranked[mid].book;
  return (
    <div className="relative-rating">
      <span className="eyebrow">RANKING THIS BOOK</span>
      <h3>Did you like it more than this one?</h3>
      <div className="relative-rating-pair">
        <div>
          <Cover book={book} />
          <p>{book.title}</p>
        </div>
        <span>vs</span>
        <div>
          <Cover book={against} />
          <p>{against.title}</p>
        </div>
      </div>
      <div className="relative-rating-actions">
        <button
          className="outline"
          disabled={busy}
          onClick={() => setLo(mid + 1)}
        >
          Liked {against.title} more
        </button>
        <button className="primary" disabled={busy} onClick={() => setHi(mid)}>
          Liked {book.title} more
        </button>
      </div>
    </div>
  );
}
function Radar({
  attributes,
  compact = false,
}: {
  attributes: { label: string; value: number }[];
  compact?: boolean;
}) {
  const cx = 150,
    cy = 132,
    r = 87;
  const step = (2 * Math.PI) / attributes.length;
  const point = (i: number, scale: number) => [
    cx + Math.sin(i * step) * r * scale,
    cy - Math.cos(i * step) * r * scale,
  ];
  const polygon = (scale: number) =>
    attributes.map((_, i) => point(i, scale).join(",")).join(" ");
  return (
    <svg
      className={"radar " + (compact ? "compact" : "")}
      viewBox="0 0 300 280"
      role="img"
      aria-label={
        "Reading attributes: " +
        attributes.map((a) => a.label + " " + a.value).join(", ")
      }
    >
      {[0.25, 0.5, 0.75, 1].map((s) => (
        <polygon key={s} points={polygon(s)} fill="none" stroke="#d9dfd0" />
      ))}
      {attributes.map((a, i) => (
        <line
          key={a.label}
          x1={cx}
          y1={cy}
          x2={point(i, 1)[0]}
          y2={point(i, 1)[1]}
          stroke="#d9dfd0"
        />
      ))}
      <polygon
        points={attributes
          .map((a, i) => point(i, a.value / 100).join(","))
          .join(" ")}
        fill="#b9ce89"
        fillOpacity=".5"
        stroke="#52774f"
        strokeWidth="2"
      />
      {attributes.map((a, i) => {
        const [x, y] = point(i, 1.28);
        const [dx, dy] = point(i, a.value / 100);
        return (
          <g key={a.label}>
            <circle cx={dx} cy={dy} r="3" fill="#365e42" />
            <text x={x} y={y} textAnchor="middle" dominantBaseline="middle">
              {a.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
const demoActivities = [
  {
    id: "maya",
    name: "Maya Chen",
    color: "peach",
    action: "shared a thought",
    time: "2 hours ago",
    book: "tomorrow",
    page: 128,
    quote:
      "“There is no more intimate act than play.” This book gets the beautiful, messy thing that is making something with someone.",
    type: "thought",
  },
  {
    id: "james",
    name: "James Wilson",
    color: "sage",
    action: "finished reading",
    time: "4 hours ago",
    book: "project",
    page: 496,
    quote:
      "Came for the space adventure. Stayed for the most unexpected friendship. I wish I could read this for the first time again.",
    type: "review",
  },
  {
    id: "sophie",
    name: "Sophie Park",
    color: "lavender",
    action: "started reading",
    time: "6 hours ago",
    book: "crawdads",
    page: 34,
    quote:
      "A rainy weekend, a cup of tea, and this. Finally seeing what all the fuss is about.",
    type: "started",
  },
  {
    id: "leo",
    name: "Leo Martin",
    color: "sand",
    action: "added to their shelf",
    time: "Yesterday",
    book: "piranesi",
    page: 0,
    quote: "You all convinced me. This is next on my list.",
    type: "want",
  },
];
export default function App({ initialData }: { initialData: Bootstrap }) {
  const [data, setData] = useState<Bootstrap>(initialData);
  const [page, setPage] = useState<Page>(() =>
    ["feed", "friends", "discover", "library", "papers", "profile"].includes(location.hash.slice(1))
      ? (location.hash.slice(1) as Page)
      : "feed",
  );
  const [selected, setSelected] = useState<Book | null>(null),
    [friendProfile, setFriendProfile] = useState<FriendProfile | null>(null),
    [friendLoading, setFriendLoading] = useState(false),
    [friendShelf, setFriendShelf] = useState<Shelf | "all">("all"),
    [searchOpen, setSearchOpen] = useState(false),
    [toast, setToast] = useState(""),
    [busy, setBusy] = useState(false);
  const [feedFilter, setFeedFilter] = useState("Everyone"),
    [shelf, setShelf] = useState<Shelf>("reading"),
    [genre, setGenre] = useState("All books"),
    [swipeDir, setSwipeDir] = useState(""),
    [paperTopic, setPaperTopic] = useState<PaperTopic | "All">("All");
  const [settings, setSettings] = useState(false),
    [name, setName] = useState(""),
    [goal, setGoal] = useState(24),
    [goodreadsImportOpen, setGoodreadsImportOpen] = useState(() =>
      initialData.library.length === 0 && localStorage.getItem("wcr.goodreads-onboarding-seen") !== "1",
    ),
    [uploadOpen, setUploadOpen] = useState<false | "book" | "paper">(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  async function refresh() {
    const next = await api<Bootstrap>("bootstrap");
    setData(next);
    return next;
  }
  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);
  useEffect(() => {
    const change = () => {
      const h = location.hash.slice(1);
      if (["feed", "friends", "discover", "library", "papers", "profile"].includes(h))
        setPage(h as Page);
    };
    addEventListener("hashchange", change);
    return () => removeEventListener("hashchange", change);
  }, []);
  function navigate(next: Page) {
    setPage(next);
    location.hash = next;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  async function openFriend(friendId: string) {
    setFriendLoading(true);
    setFriendProfile(null);
    setFriendShelf("all");
    navigate("friends");
    try {
      setFriendProfile(await api<FriendProfile>(`friends/${encodeURIComponent(friendId)}`));
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setFriendLoading(false);
    }
  }
  function friendName(value: string) {
    return value ? value[0].toLocaleUpperCase() + value.slice(1) : "Reader";
  }
  function notify(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 3500);
  }
  async function mutate(
    path: string,
    method: string,
    body: unknown,
    message?: string,
  ) {
    setBusy(true);
    try {
      await api(path, method, body);
      await refresh();
      if (message) notify(message);
      return true;
    } catch (e) {
      notify((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  const book = (id: string) => data.books.find((b) => b.id === id)!;
  const current = data.library.filter((l) => l.status === "reading"),
    finished = data.library.filter((l) => l.status === "read"),
    wanted = data.library.filter((l) => l.status === "want"),
    didNotFinish = data.library.filter((l) => l.status === "did-not-finish");
  const papers = data.books.filter((b) => b.kind === "paper");
  const totalPages = data.library.reduce((sum, l) => sum + l.page, 0);
  const recommendations = data.recommendations.filter(
    (b) => genre === "All books" || b.genre === genre,
  );
  const candidate = recommendations[0];
  const finishedThisYear = finished.filter((l) =>
    l.finished_at?.startsWith(String(new Date().getFullYear())),
  ).length;
  const readingCard = (item: LibraryItem, large = false) => (
    <div
      className={"reading-card " + (large ? "large" : "")}
      key={item.book_id}
    >
      <Cover
        book={book(item.book_id)}
        onClick={() => setSelected(book(item.book_id))}
      />
      <div className="reading-info">
        <span className="eyebrow">{book(item.book_id).genre}</span>
        <h3>
          <button onClick={() => setSelected(book(item.book_id))}>
            {book(item.book_id).title}
          </button>
        </h3>
        <p>{book(item.book_id).author}</p>
        {item.started_at && (
          <p className="reading-date">Started {item.started_at}</p>
        )}
        <div className="progress-label">
          <span>
            Page {item.page} of {book(item.book_id).pages}
          </span>
          <b>{Math.round((item.page / book(item.book_id).pages) * 100)}%</b>
        </div>
        <div className="progress-bar">
          <i
            style={{
              width: `${(item.page / book(item.book_id).pages) * 100}%`,
            }}
          />
        </div>
        <button
          className="text-action"
          onClick={() => setSelected(book(item.book_id))}
        >
          Update progress <ArrowRight size={14} />
        </button>
        <button
          className="text-action dnf-action"
          onClick={() =>
            mutate(
              "library",
              "PUT",
              { book_id: item.book_id, status: "did-not-finish", page: 0 },
              "Moved to did not finish",
            )
          }
        >
          Mark did not finish
        </button>
      </div>
    </div>
  );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => navigate("feed")}>
          <img
            src="/logo.png"
            onError={(e) => {
              e.currentTarget.src = "/favicon.svg";
            }}
            alt=""
          />
          <span>
            whatchu
            <br />
            reading<span className="brand-dot">.</span>
          </span>
        </button>
        <div className="sidebar-label">YOUR READING CORNER</div>
        <nav>
          {nav.map((n) => (
            <button
              key={n.id}
              className={page === n.id ? "active" : ""}
              onClick={() => navigate(n.id)}
            >
              <n.icon size={20} />
              <span>{n.name}</span>
              {n.id === "library" && <small>{data.library.length}</small>}
              {n.id === "friends" && <small>{data.friends.length}</small>}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <Sparkles size={20} />
          <h3>
            A little less scrolling.
            <br />A little more reading.
          </h3>
          <p>
            Your next favorite is
            <br />
            waiting to be found.
          </p>
          <button onClick={() => navigate("discover")}>
            Find your next read <ArrowRight size={14} />
          </button>
        </div>
        <div className="sidebar-bottom">
          <span className="demo-label">
            <i /> YOUR READING LIFE
          </span>
          <button className="account" onClick={() => navigate("profile")}>
            <Avatar name={data.profile.name} />
            <span>
              <b>{data.profile.name}</b>
              <small>One chapter at a time</small>
            </span>
            <ChevronRight size={16} />
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="topbar-promise" aria-label="About whatchureading">
            <strong>Free. Open-source. Own your own chapter.</strong>
            <span>No Amazon. No ads.</span>
          </div>
          <button className="search-box" onClick={() => setSearchOpen(true)}>
            <Search size={17} />
            <span>Search books, authors…</span>
            <kbd>⌕</kbd>
          </button>
          <button
            className="top-avatar"
            onClick={() => navigate("profile")}
            aria-label="Your profile"
          >
            <Avatar name={data.profile.name} small />
          </button>
        </header>
        <main>
          {page === "feed" && (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">THE READING ROOM</span>
                  <h1>
                    A good day for a new chapter<span>.</span>
                  </h1>
                  <p>Catch up with your people. Get lost in a good book.</p>
                </div>
                <span className="date-label">
                  {new Intl.DateTimeFormat("en", {
                    month: "long",
                    day: "numeric",
                  }).format(new Date())}{" "}
                  <span>✳</span>
                </span>
              </div>
              <section className="hero">
                <div className="hero-copy">
                  <span className="hero-kicker">
                    <span /> A WORLD BETWEEN THE COVERS
                  </span>
                  <h2>
                    Great stories.
                    <br />
                    Even better company.
                  </h2>
                  <p>
                    Find the books that stay with you.
                    <br />
                    And the people to talk about them with.
                  </p>
                  <button onClick={() => navigate("discover")}>
                    Find your next read <ArrowRight size={17} />
                  </button>
                  <div className="hero-social">
                    <Facepile />
                    <span>A new chapter is better together.</span>
                  </div>
                </div>
                <div className="hero-art" aria-hidden="true">
                  <div className="orbit orbit-one" />
                  <div className="orbit orbit-two" />
                  <span className="art-star">✳</span>
                  <span className="art-spark">✦</span>
                  {book("crawdads") && (
                    <Cover
                      book={book("crawdads")}
                      className="hero-book book-back"
                      onClick={() => setSelected(book("crawdads"))}
                    />
                  )}
                  {book("tomorrow") && (
                    <Cover
                      book={book("tomorrow")}
                      className="hero-book book-front"
                      onClick={() => setSelected(book("tomorrow"))}
                    />
                  )}
                  <span className="art-caption">JUST ONE MORE CHAPTER.</span>
                </div>
              </section>
              <div className="feed-columns">
                <div>
                  <div className="section-heading">
                    <h2>
                      Between your bookmarks{" "}
                      <span className="count">{current.length}</span>
                    </h2>
                    <button onClick={() => navigate("library")}>
                      Your library <ArrowRight size={15} />
                    </button>
                  </div>
                  <div className="current-grid">
                    {current.slice(0, 2).map((l) => readingCard(l))}
                    {current.length === 0 && (
                      <Empty
                        title="A fresh bookmark"
                        text="Pick a book and start your next chapter."
                        action={() => setSearchOpen(true)}
                        label="Find a book"
                      />
                    )}
                  </div>
                  <div className="section-heading feed-title">
                    <h2>The latest chapter</h2>
                    <span className="demo-pill">DEMO FRIENDS</span>
                  </div>
                  <div className="feed-tabs">
                    {["Everyone", "Friends", "Your updates"].map((f) => (
                      <button
                        key={f}
                        onClick={() => setFeedFilter(f)}
                        className={feedFilter === f ? "active" : ""}
                      >
                        {f}
                      </button>
                    ))}
                    <span>
                      <span className="live-dot" /> All caught up feels good
                    </span>
                  </div>
                  <div className="activities">
                    {feedFilter !== "Your updates" &&
                      demoActivities
                        .filter((a) => data.books.some((b) => b.id === a.book))
                        .map((a) => (
                          <article className="activity" key={a.id}>
                            <div className="activity-header">
                              <Avatar name={a.name} color={a.color} />
                              <div>
                                <p>
                                  <b>{a.name}</b> <span>{a.action}</span>
                                </p>
                                <small>
                                  {a.time} <span>· Demo friend</span>
                                </small>
                              </div>
                              <button
                                className="icon-button"
                                aria-label={"View " + book(a.book).title}
                                onClick={() => setSelected(book(a.book))}
                              >
                                <ChevronRight size={18} />
                              </button>
                            </div>
                            <div className="activity-content">
                              <Cover
                                book={book(a.book)}
                                onClick={() => setSelected(book(a.book))}
                              />
                              <div>
                                <h3>
                                  <button
                                    onClick={() => setSelected(book(a.book))}
                                  >
                                    {book(a.book).title}
                                  </button>
                                </h3>
                                <p className="author">{book(a.book).author}</p>
                                {a.type === "review" ? (
                                  <div className="review-rating">
                                    <Stars value={5} />
                                    <span>A new favorite</span>
                                  </div>
                                ) : a.type === "thought" ? (
                                  <span className="page-chip">
                                    <Bookmark size={11} /> A thought on page{" "}
                                    {a.page}
                                  </span>
                                ) : (
                                  <span className="genre-tag">
                                    {a.type === "started"
                                      ? "Currently reading"
                                      : "Want to read"}
                                  </span>
                                )}
                                <p className="activity-quote">{a.quote}</p>
                              </div>
                            </div>
                            <div className="activity-actions">
                              <button
                                className={
                                  data.likes.some((l) => l.activity_id === a.id)
                                    ? "liked"
                                    : ""
                                }
                                disabled={busy}
                                onClick={() =>
                                  mutate("likes", "POST", {
                                    activity_id: a.id,
                                    liked: !data.likes.some(
                                      (l) => l.activity_id === a.id,
                                    ),
                                  })
                                }
                              >
                                <Heart
                                  size={16}
                                  fill={
                                    data.likes.some(
                                      (l) => l.activity_id === a.id,
                                    )
                                      ? "currentColor"
                                      : "none"
                                  }
                                />{" "}
                                {({ maya: 12, james: 24, sophie: 8, leo: 5 }[
                                  a.id
                                ] || 0) +
                                  (data.likes.some(
                                    (l) => l.activity_id === a.id,
                                  )
                                    ? 1
                                    : 0)}
                              </button>
                              <button onClick={() => setSelected(book(a.book))}>
                                <MessageCircle size={16} /> Your thoughts
                              </button>
                              <button
                                className="save-action"
                                disabled={
                                  busy ||
                                  data.library.some((l) => l.book_id === a.book)
                                }
                                onClick={() =>
                                  mutate(
                                    "library",
                                    "PUT",
                                    {
                                      book_id: a.book,
                                      status: "want",
                                      page: 0,
                                    },
                                    "Added to your want-to-read shelf",
                                  )
                                }
                              >
                                <Plus size={15} />{" "}
                                {data.library.some((l) => l.book_id === a.book)
                                  ? "On your shelf"
                                  : "Want to read"}
                              </button>
                            </div>
                          </article>
                        ))}
                    {feedFilter !== "Friends" && (
                      <>
                        {[...data.notes]
                          .sort((a, b) =>
                            b.created_at.localeCompare(a.created_at),
                          )
                          .map((n) => (
                            <article className="activity personal" key={n.id}>
                              <div className="activity-header">
                                <Avatar name={data.profile.name} />
                                <div>
                                  <p>
                                    <b>You</b> shared a thought on{" "}
                                    <b>{book(n.book_id).title}</b>
                                  </p>
                                  <small>
                                    Page {n.page}
                                    {n.spoiler ? " · Contains spoilers" : ""}
                                  </small>
                                </div>
                              </div>
                              <p className="personal-note">{n.body}</p>
                              <button
                                className="text-action"
                                onClick={() => setSelected(book(n.book_id))}
                              >
                                Open your reading timeline{" "}
                                <ArrowRight size={14} />
                              </button>
                            </article>
                          ))}
                        {finished
                          .filter((l) => l.review)
                          .map((l) => (
                            <article className="activity" key={l.book_id}>
                              <span className="eyebrow">
                                YOUR FINAL VERDICT
                              </span>
                              <h3>{book(l.book_id).title}</h3>
                              <RatingDisplay item={l} />
                              <p>{l.review}</p>
                            </article>
                          ))}
                      </>
                    )}
                  </div>
                  <div className="feed-end">
                    <span>✳</span>
                    <p>You're right where you need to be.</p>
                    <small>Maybe it's time for a few pages?</small>
                  </div>
                </div>
                <aside className="right-rail">
                  <section className="goal-card">
                    <div className="section-heading">
                      <span className="eyebrow">
                        {new Date().getFullYear()} READING CHALLENGE
                      </span>
                      <button
                        aria-label="Edit reading goal"
                        onClick={() => {
                          setName(data.profile.name);
                          setGoal(data.profile.goal);
                          setSettings(true);
                        }}
                      >
                        <Settings2 size={16} />
                      </button>
                    </div>
                    <div className="goal-number">
                      {finishedThisYear}
                      <span>/ {data.profile.goal} books</span>
                      <BookOpen size={28} />
                    </div>
                    <div className="progress-bar">
                      <i
                        style={{
                          width: `${Math.min(100, (finishedThisYear / data.profile.goal) * 100)}%`,
                        }}
                      />
                    </div>
                    <p>
                      {finishedThisYear >= data.profile.goal
                        ? "You did it. Every chapter counted."
                        : `${data.profile.goal - finishedThisYear} more adventures to go. You've got this.`}
                    </p>
                  </section>
                  <section className="dna-card">
                    <div className="section-heading">
                      <h3>Your reading DNA</h3>
                      <span>✳</span>
                    </div>
                    <p>A little bit of everything. Entirely you.</p>
                    <Radar attributes={data.attributes} compact />
                    <button onClick={() => navigate("profile")}>
                      Meet your inner reader <ArrowRight size={14} />
                    </button>
                  </section>
                  <section className="friends-card">
                    <div className="section-heading">
                      <h3>Your friends</h3>
                      <span>{data.friends.length}</span>
                    </div>
                    {data.friends.map((friend, index) => (
                        <button
                          className="friend-row"
                          key={friend.id}
                          onClick={() => openFriend(friend.id)}
                        >
                          <Avatar name={friendName(friend.name)} color={["peach", "lavender", "sage"][index % 3]} small />
                          <span>
                            <b>{friendName(friend.name)}</b>
                            <small>{friend.book_title || "No book in progress"}</small>
                          </span>
                          {friend.book_id ? <span className="friend-percent">{friend.progress}%</span> : <ArrowRight size={14} />}
                        </button>
                      ))}
                    {data.friends.length === 0 && <p className="empty-copy">Your reading circle will show up here.</p>}
                  </section>
                  <div className="quote-card">
                    <span>“</span>
                    <p>A reader lives a thousand lives before he dies.</p>
                    <small>GEORGE R. R. MARTIN</small>
                  </div>
                </aside>
              </div>
            </>
          )}

          {page === "friends" && (
            <>
              {friendProfile ? (
                <>
                  <div className="page-heading friend-detail-heading">
                    <div>
                      <button className="text-action" onClick={() => setFriendProfile(null)}><ArrowLeft size={15} /> All friends</button>
                      <span className="eyebrow">YOUR READING CIRCLE</span>
                      <h1>{friendName(friendProfile.profile.name)}<span>.</span></h1>
                      <p>{friendProfile.library.length} books · {friendProfile.notes.length} reading thoughts</p>
                    </div>
                    <Avatar name={friendName(friendProfile.profile.name)} />
                  </div>
                  <div className="friend-detail-columns">
                    <section>
                      <div className="section-heading"><h2>Their bookshelf</h2><span>{friendProfile.library.length} books</span></div>
                      <div className="segmented friend-shelves">
                        {(["all", "reading", "read", "want", "did-not-finish"] as const).map((status) => (
                          <button key={status} className={friendShelf === status ? "active" : ""} onClick={() => setFriendShelf(status)}>
                            {status === "all" ? "All" : status === "want" ? "Want to read" : status === "did-not-finish" ? "Did not finish" : status === "reading" ? "Reading" : "Read"}
                            <small>{status === "all" ? friendProfile.library.length : friendProfile.library.filter((item) => item.status === status).length}</small>
                          </button>
                        ))}
                      </div>
                      <div className="friend-book-list">
                        {friendProfile.library.filter((item) => friendShelf === "all" || item.status === friendShelf).map((item) => (
                          <article className="friend-book-item" key={item.book_id}>
                            <Cover book={{ id: item.book_id, title: item.title, author: item.author, isbn: item.isbn, color: item.color }} />
                            <div>
                              <span className="eyebrow">{item.status === "want" ? "WANT TO READ" : item.status === "did-not-finish" ? "DID NOT FINISH" : item.status.toUpperCase()}</span>
                              <h3>{item.title}</h3><p>{item.author}</p>
                              {item.status === "reading" && <small>Page {item.page} of {item.pages} · {Math.round((item.page / Math.max(item.pages, 1)) * 100)}% through</small>}
                              {(item.started_at || item.finished_at) && <small>{item.started_at && `Started ${item.started_at}`}{item.started_at && item.finished_at && " · "}{item.finished_at && `Finished ${item.finished_at}`}</small>}
                              {importedTimeline(item).length > 0 && <ul className="friend-timeline">{importedTimeline(item).map((event, index) => <li key={`${item.book_id}-event-${index}`}>{event}</li>)}</ul>}
                              <RatingDisplay item={item} />
                              {item.review && <p className="friend-review">{item.review}</p>}
                              {importedComments(item).map((comment: { id?: string; author?: string; date?: string; body?: string }, index: number) => <p className="friend-comment" key={comment.id || index}><b>{comment.author || "Reader"}</b>{comment.date && ` · ${comment.date}`}<br />{comment.body}</p>)}
                            </div>
                          </article>
                        ))}
                        {friendProfile.library.filter((item) => friendShelf === "all" || item.status === friendShelf).length === 0 && <p className="friend-empty">No books on this shelf yet.</p>}
                      </div>
                    </section>
                    <aside className="friend-thoughts">
                      <div className="section-heading"><h2>Reading thoughts</h2><span>{friendProfile.notes.length}</span></div>
                      {friendProfile.notes.length ? friendProfile.notes.map((note) => <article className="friend-thought" key={note.id}><b>{note.title}</b><small>Page {note.page}{note.spoiler ? " · Spoiler" : ""}</small><p>{note.body}</p><time>{new Date(note.created_at).toLocaleDateString()}</time></article>) : <p className="friend-empty">No reading thoughts yet.</p>}
                    </aside>
                  </div>
                </>
              ) : friendLoading ? (
                <div className="page-heading"><h1>Loading your friend’s reading life…</h1></div>
              ) : <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">YOUR READING CIRCLE</span>
                  <h1>Your friends<span>.</span></h1>
                  <p>See what your people are reading and share the next chapter.</p>
                </div>
                <span className="date-label">{data.friends.length} friends <Users size={17} /></span>
              </div>
              {data.friends.length === 0 ? (
                <Empty title="Your circle starts here" text="When you connect with readers, they’ll show up here." action={() => navigate("discover")} label="Find a book" />
              ) : (
                <div className="friends-grid">
                  {data.friends.map((friend, index) => {
                    const friendBook = friend.book_id ? data.books.find((b) => b.id === friend.book_id) : undefined;
                    return (
                      <article className="friend-card" key={friend.id}>
                        <button className="friend-card-heading friend-profile-link" onClick={() => openFriend(friend.id)}>
                          <Avatar name={friendName(friend.name)} color={["peach", "lavender", "sage"][index % 3]} />
                          <div><h2>{friendName(friend.name)}</h2><span>View reading life <ArrowRight size={13} /></span></div>
                        </button>
                        <span className="eyebrow">ON THEIR NIGHTSTAND</span>
                        {friendBook ? (
                          <button className="friend-reading" onClick={() => setSelected(friendBook)}>
                            <Cover book={friendBook} />
                            <span><b>{friendBook.title}</b><small>{friendBook.author}</small><span className="friend-progress"><i style={{ width: `${friend.progress}%` }} /> </span><small>{friend.progress}% through</small></span>
                          </button>
                        ) : (
                          <p className="friend-empty">Nothing in progress right now.</p>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}
              </>}
            </>
          )}

          {page === "discover" && (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">A LITTLE BOOKISH SERENDIPITY</span>
                  <h1>
                    Your next great read awaits<span>.</span>
                  </h1>
                  <p>
                    A familiar favorite or something unexpected. Follow your
                    curiosity.
                  </p>
                </div>
                <button className="outline" onClick={() => setSearchOpen(true)}>
                  <Search size={16} /> Search all books
                </button>
              </div>
              <div className="discover-toolbar">
                <div className="segmented">
                  <span>
                    <Sparkles size={15} /> Picked for you
                  </span>
                </div>
                <label className="select-label">
                  Explore{" "}
                  <select
                    value={genre}
                    onChange={(e) => setGenre(e.target.value)}
                  >
                    {[
                      "All books",
                      ...Array.from(new Set(data.books.map((b) => b.genre))),
                    ].map((g) => (
                      <option key={g}>{g}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="discovery-layout">
                <div className="discovery-stage">
                  <span className="discovery-stage-label">
                    A MATCH MADE BETWEEN THE PAGES
                  </span>
                  {candidate ? (
                    <div
                      className={"swipe-card " + swipeDir}
                      onTouchStart={(e) => {
                        e.currentTarget.dataset.touch = String(
                          e.touches[0].clientX,
                        );
                      }}
                      onTouchEnd={(e) => {
                        const dx =
                          e.changedTouches[0].clientX -
                          Number(e.currentTarget.dataset.touch);
                        if (Math.abs(dx) > 75 && !busy) {
                          const action = dx > 0 ? "want" : "skip";
                          setSwipeDir(dx > 0 ? "swipe-right" : "swipe-left");
                          setTimeout(async () => {
                            await mutate(
                              "swipes",
                              "POST",
                              { book_id: candidate.id, action },
                              action === "want"
                                ? "Saved for a future chapter"
                                : "On to the next book",
                            );
                            setSwipeDir("");
                          }, 250);
                        }
                      }}
                    >
                      <span className="match-pill">
                        <Sparkles size={12} />
                        {candidate.match_score}% your kind of book
                      </span>
                      <Cover
                        book={candidate}
                        onClick={() => setSelected(candidate)}
                      />
                      <span className="eyebrow">{candidate.author}</span>
                      <h2>{candidate.title}</h2>
                      <div className="discovery-meta">
                        <span>
                          <Star size={14} fill="currentColor" />
                          {candidate.rating || "Unrated"}
                        </span>
                        <span>{candidate.genre}</span>
                        <span>{candidate.pages} pages</span>
                      </div>
                      <p>{candidate.description}</p>
                      <div className="discovery-friends">
                        <Facepile />
                        <span>
                          {candidate.friend_count} demo friends read this
                        </span>
                      </div>
                    </div>
                  ) : (
                    <Empty
                      title="You've turned every page"
                      text="Try another genre, search the catalog, or revisit books you passed."
                      action={() =>
                        mutate(
                          "swipes/reset",
                          "POST",
                          {},
                          "Passed books are back in the mix",
                        )
                      }
                      label="Revisit passed books"
                    />
                  )}
                  {candidate && (
                    <>
                      <div className="swipe-controls">
                        <button
                          className="pass"
                          disabled={busy}
                          onClick={async () => {
                            setSwipeDir("swipe-left");
                            setTimeout(async () => {
                              await mutate("swipes", "POST", {
                                book_id: candidate.id,
                                action: "skip",
                              });
                              setSwipeDir("");
                            }, 250);
                          }}
                        >
                          <X size={22} />
                          <span>Pass for now</span>
                        </button>
                        <button
                          className="already"
                          disabled={busy}
                          onClick={() =>
                            mutate(
                              "swipes",
                              "POST",
                              { book_id: candidate.id, action: "read" },
                              "Added to your finished books",
                            )
                          }
                        >
                          <Check size={21} />
                          <span>Already read</span>
                        </button>
                        <button
                          className="want"
                          disabled={busy}
                          onClick={() =>
                            mutate(
                              "swipes",
                              "POST",
                              { book_id: candidate.id, action: "want" },
                              "Added to your want-to-read shelf",
                            )
                          }
                        >
                          <Heart size={22} />
                          <span>Want to read</span>
                        </button>
                      </div>
                      <p className="swipe-hint">
                        <ArrowLeft size={13} /> Swipe to pass <span>·</span>{" "}
                        Swipe to save <ArrowRight size={13} />
                      </p>
                    </>
                  )}
                </div>
                <aside className="discover-aside">
                  <span className="eyebrow">GOOD BOOKS FIND GOOD PEOPLE</span>
                  <h2>
                    A shelf that
                    <br />
                    gets you.
                  </h2>
                  <p>
                    Your taste is more than a genre. Every book you finish and
                    love helps us find your next one.
                  </p>
                  <div className="why-card">
                    <Sparkles />
                    <h3>Why this book?</h3>
                    <p>
                      {candidate?.reason ||
                        "Find more books with a catalog search."}
                    </p>
                    <small>
                      Matches combine your genres, highly rated reads, and
                      demo-friend favorites.
                    </small>
                  </div>
                  <div className="discovery-stats">
                    <span>
                      <b>{finished.length}</b>Books finished
                    </span>
                    <span>
                      <b>{wanted.length}</b>On your wishlist
                    </span>
                  </div>
                  <div className="tip">
                    <BookOpen size={19} />
                    <p>
                      Read it already? Mark it finished to make your reading DNA
                      a little more you.
                    </p>
                  </div>
                </aside>
              </div>
            </>
          )}

          {page === "library" && (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">YOUR VERY OWN SHELF SPACE</span>
                  <h1>
                    A life in books<span>.</span>
                  </h1>
                  <p>
                    The ones you're in. The ones you've loved. The ones still to
                    come.
                  </p>
                </div>
                <div className="page-heading-actions">
                  <button className="outline" onClick={() => setUploadOpen("book")}>
                    <Plus size={17} /> Upload a PDF
                  </button>
                  <button className="primary" onClick={() => setSearchOpen(true)}>
                    <Plus size={17} /> Add a book
                  </button>
                </div>
              </div>
              <div className="library-tabs">
                {(
                  [
                    {
                      id: "reading",
                      name: "Currently reading",
                      count: current.length,
                    },
                    { id: "want", name: "Want to read", count: wanted.length },
                    { id: "read", name: "Finished", count: finished.length },
                    {
                      id: "did-not-finish",
                      name: "Did not finish",
                      count: didNotFinish.length,
                    },
                  ] as const
                ).map((s) => (
                  <button
                    className={shelf === s.id ? "active" : ""}
                    key={s.id}
                    onClick={() => setShelf(s.id)}
                  >
                    {s.name}
                    <span>{s.count}</span>
                  </button>
                ))}
              </div>
              {shelf === "reading" ? (
                <div className="library-reading">
                  {current.map((l) => readingCard(l, true))}
                  {!current.length && (
                    <Empty
                      title="Your next chapter starts here"
                      text="Find a book you can't put down."
                      action={() => setSearchOpen(true)}
                      label="Add a book"
                    />
                  )}
                </div>
              ) : (
                <div className="book-grid">
                  {data.library
                    .filter((l) => l.status === shelf)
                    .map((l) => (
                      <article className="shelf-book" key={l.book_id}>
                        <Cover
                          book={book(l.book_id)}
                          onClick={() => setSelected(book(l.book_id))}
                        />
                        <span className="eyebrow">{book(l.book_id).genre}</span>
                        <h3>
                          <button onClick={() => setSelected(book(l.book_id))}>
                            {book(l.book_id).title}
                          </button>
                        </h3>
                        <p>{book(l.book_id).author}</p>
                        {shelf === "read" ? (
                          <>
                            {(l.started_at || l.finished_at) && (
                              <p className="shelf-dates">
                                {l.started_at && `Started ${l.started_at}`}
                                {l.started_at && l.finished_at && " · "}
                                {l.finished_at && `Finished ${l.finished_at}`}
                              </p>
                            )}
                            <RatingDisplay item={l} />
                            <button
                              className="text-action"
                              onClick={() => setSelected(book(l.book_id))}
                            >
                              {l.review
                                ? "Read your verdict"
                                : "Leave a verdict"}{" "}
                              <ArrowRight size={14} />
                            </button>
                            {importedComments(l).length > 0 && (
                              <div className="shelf-comments">
                                <span className="eyebrow">GOODREADS COMMENTS</span>
                                {importedComments(l).map((comment: { id?: string; author?: string; date?: string; body?: string }, index: number) => (
                                  <p key={comment.id || index}>
                                    <b>{comment.author || "Reader"}</b>
                                    {comment.date && <small> · {comment.date}</small>}
                                    <br />
                                    {comment.body}
                                  </p>
                                ))}
                              </div>
                            )}
                          </>
                        ) : (
                          <>
                            {shelf === "did-not-finish" && l.started_at && (
                              <p className="shelf-dates">
                                Started {l.started_at}
                              </p>
                            )}
                            <button
                              className="outline"
                              disabled={busy}
                              onClick={() =>
                                mutate(
                                  "library",
                                  "PUT",
                                  {
                                    book_id: l.book_id,
                                    status: "reading",
                                    page: 0,
                                  },
                                  "Your next chapter starts now",
                                )
                              }
                            >
                              Start reading <ArrowRight size={14} />
                            </button>
                          </>
                        )}
                      </article>
                    ))}
                  {!data.library.some((l) => l.status === shelf) && (
                    <Empty
                      title={
                        shelf === "want"
                          ? "Make room for possibility"
                          : shelf === "did-not-finish"
                            ? "Every book is a choice"
                            : "The first of many"
                      }
                      text={
                        shelf === "want"
                          ? "Save a few books for a future you."
                          : shelf === "did-not-finish"
                            ? "Some stories aren't yours right now."
                            : "Your finished books will live here."
                      }
                      action={() => navigate("discover")}
                      label="Discover books"
                    />
                  )}
                </div>
              )}
            </>
          )}

          {page === "papers" && (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">AREAS OF ACADEMIC LEARNING</span>
                  <h1>
                    Your papers<span>.</span>
                  </h1>
                  <p>
                    Arxiv preprints, journal articles, anything with a bibliography.
                  </p>
                </div>
                <div className="page-heading-actions">
                  <button className="primary" onClick={() => setUploadOpen("paper")}>
                    <Plus size={17} /> Upload a paper
                  </button>
                </div>
              </div>
              <section className="profile-dna">
                <span className="eyebrow">YOUR ACADEMIC CARD</span>
                <h2>Fields you're exploring.</h2>
                <p>Scored from the papers you're reading and have finished.</p>
                <Radar attributes={data.paper_attributes} />
                <div className="attribute-list">
                  {data.paper_attributes.map((a) => (
                    <span key={a.label}>
                      <span>{a.label}</span>
                      <b>{a.value}</b>
                    </span>
                  ))}
                </div>
                <small>
                  A playful portrait, based on the topics of papers you read.
                  Scores grow as you explore; they aren't a measure of expertise.
                </small>
              </section>
              <div className="library-tabs">
                {(["All", ...PAPER_TOPICS] as const).map((t) => (
                  <button
                    className={paperTopic === t ? "active" : ""}
                    key={t}
                    onClick={() => setPaperTopic(t)}
                  >
                    {t}
                    <span>
                      {t === "All"
                        ? papers.length
                        : papers.filter((p) => p.topic === t).length}
                    </span>
                  </button>
                ))}
              </div>
              <div className="book-grid">
                {papers
                  .filter((p) => paperTopic === "All" || p.topic === paperTopic)
                  .map((p) => {
                    const item = data.library.find((l) => l.book_id === p.id);
                    return (
                      <article className="shelf-book" key={p.id}>
                        <Cover book={p} onClick={() => setSelected(p)} />
                        <span className="eyebrow">{p.topic}</span>
                        <h3>
                          <button onClick={() => setSelected(p)}>
                            {p.title}
                          </button>
                        </h3>
                        <p>{p.author}</p>
                        {item && (
                          <small>
                            Page {item.page} of {p.pages} ·{" "}
                            {Math.round((item.page / Math.max(p.pages, 1)) * 100)}%
                            through
                          </small>
                        )}
                      </article>
                    );
                  })}
                {!papers.length && (
                  <Empty
                    title="Your first paper starts here"
                    text="Upload a PDF — an arXiv preprint, a journal article, anything with a bibliography."
                    action={() => setUploadOpen("paper")}
                    label="Upload a paper"
                  />
                )}
              </div>
            </>
          )}

          {page === "profile" && (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">EVERY READER HAS A STORY</span>
                  <h1>
                    This is your chapter<span>.</span>
                  </h1>
                  <p>Your reading life, in a little more color.</p>
                </div>
                <button
                  className="outline"
                  onClick={() => {
                    setName(data.profile.name);
                    setGoal(data.profile.goal);
                    setSettings(true);
                  }}
                >
                  <Settings2 size={16} /> Edit profile
                </button>
                <button className="primary" onClick={() => setGoodreadsImportOpen(true)}>
                  <FileSpreadsheet size={16} /> Bring in Goodreads
                </button>
              </div>
              <section className="profile-banner">
                <Avatar name={data.profile.name} />
                <div>
                  <span className="eyebrow">THE CURIOUS READER</span>
                  <h2>{data.profile.name}</h2>
                  <p>
                    Collecting stories. Changing perspectives. One page at a
                    time.
                  </p>
                  <span className="profile-tag">
                    <BookOpen size={13} /> A reader since today
                  </span>
                </div>
                <span className="profile-spark">✳</span>
              </section>
              <div className="profile-stats">
                {[
                  { n: finished.length, l: "Books finished", i: BookOpen },
                  {
                    n: totalPages.toLocaleString(),
                    l: "Pages explored",
                    i: Bookmark,
                  },
                  {
                    n: data.notes.length,
                    l: "Thoughts along the way",
                    i: MessageCircle,
                  },
                  {
                    n: new Set(
                      data.library
                        .filter((l) => l.status !== "want")
                        .map((l) => book(l.book_id).genre),
                    ).size,
                    l: "Genres explored",
                    i: Compass,
                  },
                ].map((s) => (
                  <div key={s.l}>
                    <s.i size={20} />
                    <b>{s.n}</b>
                    <span>{s.l}</span>
                  </div>
                ))}
              </div>
              <div className="profile-columns">
                <section className="profile-dna">
                  <span className="eyebrow">YOUR READER CARD</span>
                  <h2>Stories shape us.</h2>
                  <p>Here's how yours are shaping you.</p>
                  <Radar attributes={data.attributes} />
                  <div className="attribute-list">
                    {data.attributes.map((a) => (
                      <span key={a.label}>
                        <span>{a.label}</span>
                        <b>{a.value}</b>
                      </span>
                    ))}
                  </div>
                  <small>
                    A playful portrait, based on the genres you read. Scores
                    grow as you explore; they aren't a measure of ability.
                  </small>
                </section>
                <div>
                  <section className="profile-challenge">
                    <span className="eyebrow">
                      {new Date().getFullYear()} READING CHALLENGE
                    </span>
                    <h2>
                      Make a little time
                      <br />
                      for a lot of worlds.
                    </h2>
                    <div className="challenge-count">
                      <b>{finishedThisYear}</b>
                      <span>
                        of {data.profile.goal}
                        <br />
                        books this year
                      </span>
                      <span className="challenge-art">✳</span>
                    </div>
                    <div className="progress-bar">
                      <i
                        style={{
                          width: `${Math.min(100, (finishedThisYear / data.profile.goal) * 100)}%`,
                        }}
                      />
                    </div>
                    <button
                      className="text-action"
                      onClick={() => {
                        setName(data.profile.name);
                        setGoal(data.profile.goal);
                        setSettings(true);
                      }}
                    >
                      Set your own pace <ArrowRight size={14} />
                    </button>
                  </section>
                  <section className="genre-breakdown">
                    <h3>Your favorite worlds</h3>
                    {Array.from(new Set(data.books.map((b) => b.genre)))
                      .map((g) => ({
                        genre: g,
                        count: data.library.filter(
                          (l) =>
                            l.status !== "want" && book(l.book_id).genre === g,
                        ).length,
                      }))
                      .filter((g) => g.count)
                      .sort((a, b) => b.count - a.count)
                      .map((g) => (
                        <div key={g.genre}>
                          <span>{g.genre}</span>
                          <div className="progress-bar">
                            <i
                              style={{
                                width: `${(g.count / Math.max(1, current.length + finished.length)) * 100}%`,
                              }}
                            />
                          </div>
                          <b>{g.count}</b>
                        </div>
                      ))}
                  </section>
                </div>
              </div>
            </>
          )}
          <footer>
            <span>For the love of a good book.</span>
            <span>
              Made by{" "}
              <a href="https://x.com/ashaya" target="_blank" rel="noreferrer">
                @ashaya <ArrowRight size={12} />
              </a>
              <span className="footer-dot">·</span>
              <a
                href="https://openlibrary.org"
                target="_blank"
                rel="noreferrer"
              >
                Books via Open Library
              </a>
            </span>
          </footer>
        </main>
      </div>
      <nav className="mobile-nav">
        {nav.map((n) => (
          <button
            className={page === n.id ? "active" : ""}
            key={n.id}
            onClick={() => navigate(n.id)}
          >
            <n.icon size={20} />
            <span>{n.name.replace("Your ", "")}</span>
          </button>
        ))}
      </nav>
      {selected && (
        <BookModal
          book={selected}
          item={data.library.find((l) => l.book_id === selected.id)}
          notes={data.notes.filter((n) => n.book_id === selected.id)}
          library={data.library}
          findBook={book}
          close={() => setSelected(null)}
          mutate={mutate}
          busy={busy}
        />
      )}
      {searchOpen && (
        <SearchModal
          books={data.books}
          close={() => setSearchOpen(false)}
          choose={(b) => {
            setSearchOpen(false);
            setSelected(b);
          }}
          refresh={refresh}
          notify={notify}
        />
      )}
      {settings && (
        <Modal close={() => setSettings(false)}>
          <span className="eyebrow">YOUR READING LIFE</span>
          <h2>Set your own pace.</h2>
          <p>Every book counts. Make this space yours.</p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                await mutate(
                  "profile",
                  "PUT",
                  { name, goal },
                  "Profile updated",
                )
              )
                setSettings(false);
            }}
          >
            <label>
              Your name
              <input
                value={name}
                maxLength={60}
                required
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              Books to read this year
              <input
                type="number"
                min={1}
                max={500}
                required
                value={goal}
                onChange={(e) => setGoal(Number(e.target.value))}
              />
            </label>
            <button className="primary" disabled={busy}>
              Save profile <Check size={16} />
            </button>
          </form>
          <button
            className="auth-text-button"
            onClick={() => void signOut().catch((e) => notify(e.message))}
          >
            Sign out
          </button>
        </Modal>
      )}
      {goodreadsImportOpen && (
        <GoodreadsImportModal
          close={() => {
            localStorage.setItem("wcr.goodreads-onboarding-seen", "1");
            setGoodreadsImportOpen(false);
          }}
          refresh={refresh}
          notify={notify}
        />
      )}
      {uploadOpen && (
        <UploadModal
          close={() => setUploadOpen(false)}
          refresh={refresh}
          notify={notify}
          defaultKind={uploadOpen}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
          <button onClick={() => setToast("")} aria-label="Dismiss">
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
function Empty({
  title,
  text,
  action,
  label,
}: {
  title: string;
  text: string;
  action: () => void;
  label: string;
}) {
  return (
    <div className="empty">
      <BookOpen size={35} />
      <h2>{title}</h2>
      <p>{text}</p>
      <button className="primary" onClick={action}>
        {label}
        <ArrowRight size={15} />
      </button>
    </div>
  );
}
function Modal({
  children,
  close,
  wide = false,
}: {
  children: React.ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    el?.showModal();
    const cancel = (e: Event) => {
      e.preventDefault();
      close();
    };
    el?.addEventListener("cancel", cancel);
    return () => el?.removeEventListener("cancel", cancel);
  }, [close]);
  return (
    <dialog
      ref={ref}
      className={"modal " + (wide ? "wide" : "")}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="modal-inner">
        <button
          className="modal-close icon-button"
          onClick={close}
          aria-label="Close dialog"
        >
          <X size={20} />
        </button>
        {children}
      </div>
    </dialog>
  );
}
function csvRows(source: string) {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  const text = source.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += char;
  }
  if (quoted) throw new Error("This CSV has an unfinished quoted field.");
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((entry) => entry.some((value) => value.trim()));
}
function parseGoodreadsDate(value: string) {
  const match = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return match ? `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}` : "";
}
function csvNumber(value: string) {
  const match = value.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}
function GoodreadsImportAnimation({ status }: { status: string }) {
  const books = [
    ["The Atlas of", "Clouds", "#d8e6c2"],
    ["A Brief", "History", "#e6d6be"],
    ["The Secret", "Garden", "#c9dce0"],
    ["Tomorrow,", "and Tomorrow", "#ded0e4"],
    ["The Long", "Way Home", "#e4cfc5"],
  ];
  return (
    <div className="goodreads-import-animation" role="status" aria-live="polite">
      <div className="import-books" aria-hidden="true">
        {books.map(([first, second, color], index) => (
          <div className="import-book" key={first} style={{ background: color, animationDelay: `${index * 0.42}s` }}>
            <span>{first}</span><b>{second}</b><i />
          </div>
        ))}
      </div>
      <div><b>Bringing your shelves home</b><span>{status}</span></div>
    </div>
  );
}
function GoodreadsImportModal({
  close,
  refresh,
  notify,
}: {
  close: () => void;
  refresh: () => Promise<Bootstrap>;
  notify: (message: string) => void;
}) {
  const [records, setRecords] = useState<GoodreadsImportRecord[]>([]);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const [complete, setComplete] = useState(false);
  const [bridgeStatus, setBridgeStatus] = useState("");
  const [browserViewUrl, setBrowserViewUrl] = useState("");
  const [browserImportId, setBrowserImportId] = useState("");
  useEffect(() => {
    if (!browserImportId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const result = await browserApi<{ status: string; csv?: string; error?: string }>(`status/${browserImportId}`);
        if (cancelled) return;
        if (result.status === "awaiting_login") setBridgeStatus("Sign in inside the Goodreads window. We’ll continue automatically…");
        else if (result.status === "exporting") setBridgeStatus("Goodreads is preparing your library export…");
        else if (result.status === "ready" && result.csv) {
          setBridgeStatus("Your books are here. Review the import before adding anything.");
          await chooseFile(new File([result.csv], "goodreads_library_export.csv", { type: "text/csv" }));
          void browserApi(`close/${browserImportId}`, "POST");
          setBrowserImportId("");
        } else if (result.status === "error") {
          setError(result.error || "Goodreads could not finish the export.");
          setBrowserImportId("");
        }
      } catch (error) {
        if (!cancelled) setError((error as Error).message);
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [browserImportId]);
  const connectGoodreads = async () => {
    setError("");
    setBridgeStatus("Opening your private Goodreads browser…");
    try {
      const result = await browserApi<{ import_id: string; live_view_url: string }>("start", "POST", {});
      setBrowserImportId(result.import_id);
      setBrowserViewUrl(result.live_view_url);
      setBridgeStatus("Sign in inside the Goodreads window. We’ll handle the export from there.");
    } catch (error) {
      setError((error as Error).message);
      setBridgeStatus("");
    }
  };
  const dismiss = () => {
    if (browserImportId) void browserApi(`close/${browserImportId}`, "POST");
    close();
  };
  const chooseFile = async (file?: File) => {
    if (!file) return;
    setError("");
    try {
      const rows = csvRows(await file.text());
      if (rows.length < 2) throw new Error("That file does not contain a Goodreads library.");
      const headers = rows[0].map((value) => value.trim());
      for (const required of ["Book Id", "Title", "Author"]) {
        if (!headers.includes(required)) throw new Error(`This export is missing the “${required}” column.`);
      }
      const values = rows.slice(1).map((entry) => Object.fromEntries(headers.map((header, index) => [header, entry[index] || ""])));
      const parsed = values.map((row, index) => {
        const id = String(row["Book Id"] || "").trim();
        const title = String(row.Title || "").trim();
        if (!/^\d+$/.test(id) || !title) throw new Error(`Row ${index + 2} is missing a Goodreads book ID or title.`);
        const shelves = String(row.Bookshelves || "").toLowerCase().split(",").map((s) => s.trim());
        const finished = parseGoodreadsDate(String(row["Date Read"] || ""));
        const status: Shelf = finished || csvNumber(String(row["Read Count"] || "")) > 0 ? "read" : shelves.includes("currently-reading") || shelves.includes("currently reading") ? "reading" : shelves.includes("did-not-finish") || shelves.includes("dnf") ? "did-not-finish" : "want";
        const pages = Math.max(1, Math.min(20000, Math.round(csvNumber(String(row["Number of Pages"] || "")) || 300)));
        const isbn = String(row.ISBN13 || row.ISBN || "").replace(/\D/g, "");
        const added = parseGoodreadsDate(String(row["Date Added"] || ""));
        return {
          goodreads_book_id: id,
          title: title.slice(0, 250),
          author: String(row.Author || "").trim().slice(0, 150),
          status,
          pages,
          rating: csvNumber(String(row["My Rating"] || "")) || null,
          average_rating: Math.max(0, Math.min(5, csvNumber(String(row["Average Rating"] || "")))),
          isbn,
          review: String(row["My Review"] || "").slice(0, 5000),
          started_at: "",
          finished_at: finished,
          description: "",
          history: { source: "goodreads-csv", date_added: added, date_read: finished, shelves, read_count: String(row["Read Count"] || "") },
        };
      });
      if (!parsed.length || parsed.length > 2000) throw new Error("Choose an export containing between 1 and 2,000 books.");
      if (new Set(parsed.map((record) => record.goodreads_book_id)).size !== parsed.length) throw new Error("This export contains duplicate Goodreads book IDs.");
      setFileName(file.name);
      setRecords(parsed);
    } catch (e) {
      setRecords([]);
      setFileName("");
      setError((e as Error).message);
    }
  };
  const submit = async () => {
    setImporting(true);
    try {
      await api("import/goodreads", "POST", { records });
      await refresh();
      setComplete(true);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setImporting(false);
    }
  };
  const counts = records.reduce<Record<string, number>>((all, record) => ({ ...all, [record.status]: (all[record.status] || 0) + 1 }), {});
  return (
      <Modal close={dismiss} wide>
      {!complete ? (
        <>
          <span className="eyebrow">A LITTLE HELP FROM YOUR OLD BOOKSHELF</span>
          <h2>Bring your Goodreads library home.</h2>
          <p className="import-lede">Sign in inside a private Goodreads browser. Your password stays with Goodreads, and we only bring back the export you authorize.</p>
          <div className="goodreads-steps">
            <div className="goodreads-step"><span>1</span><div><b>Open your Goodreads browser</b><small>A private browser window opens right here for your Goodreads sign-in.</small></div><button className="outline" onClick={() => void connectGoodreads()}>Start import <ExternalLink size={14} /></button></div>
            <div className="goodreads-step"><span>2</span><div><b>Sign in and we’ll export</b><small>After you sign in, the browser handles Goodreads’ visible library export.</small></div></div>
            <div className="goodreads-step"><span>3</span><div><b>Review and import</b><small>We preview everything and add only books you haven’t imported yet.</small></div></div>
          </div>
          {bridgeStatus && <p className="import-bridge-status" role="status"><Wind size={14} /> {bridgeStatus}</p>}
          {browserImportId && bridgeStatus && !records.length && <GoodreadsImportAnimation status={bridgeStatus} />}
          {browserViewUrl && browserImportId && <div className="goodreads-browser-view"><iframe src={browserViewUrl} title="Private Goodreads browser" allow="clipboard-read; clipboard-write" /><a href={browserViewUrl} target="_blank" rel="noreferrer">Open browser in a new tab <ExternalLink size={13} /></a></div>}
          <label className="goodreads-dropzone">
            <FileSpreadsheet size={28} />
            <b>{fileName || "Choose your Goodreads CSV"}</b>
            <span>{fileName ? "Ready to preview" : "CSV files only · nothing uploads until you confirm"}</span>
            <input type="file" accept=".csv,text/csv" onChange={(e) => void chooseFile(e.target.files?.[0])} />
          </label>
          {error && <p className="import-error" role="alert">{error}</p>}
          {records.length > 0 && <div className="import-preview"><b>{records.length} books ready</b><span>{counts.read || 0} read · {counts.reading || 0} reading · {counts.want || 0} to read{counts["did-not-finish"] ? ` · ${counts["did-not-finish"]} did not finish` : ""}</span></div>}
          <div className="modal-actions"><button className="outline" onClick={dismiss}>Cancel</button><button className="primary" disabled={!records.length || importing} onClick={() => void submit()}>{importing ? <><Loader2 className="spin" size={16} /> Bringing them in…</> : <>Import my books <ArrowRight size={16} /></>}</button></div>
        </>
      ) : (
          <div className="import-complete"><span className="import-check"><Check size={26} /></span><span className="eyebrow">YOUR SHELVES ARE HERE</span><h2>Welcome back, books.</h2><p>{records.length} books are now part of your reading life. You can update any shelf whenever you like.</p><button className="primary" onClick={dismiss}>See my library <ArrowRight size={16} /></button></div>
      )}
    </Modal>
  );
}
function UploadModal({
  close,
  refresh,
  notify,
  defaultKind = "book",
}: {
  close: () => void;
  refresh: () => Promise<Bootstrap>;
  notify: (msg: string) => void;
  defaultKind?: "book" | "paper";
}) {
  const [file, setFile] = useState<File | null>(null),
    [title, setTitle] = useState(""),
    [author, setAuthor] = useState(""),
    [kind, setKind] = useState<"book" | "paper">(defaultKind),
    [topic, setTopic] = useState<PaperTopic>(PAPER_TOPICS[0]),
    [pages, setPages] = useState(0),
    [error, setError] = useState(""),
    [uploading, setUploading] = useState(false);
  async function chooseFile(f?: File) {
    if (!f) return;
    if (f.type !== "application/pdf" && !f.name.toLowerCase().endsWith(".pdf")) {
      setError("Choose a PDF file");
      return;
    }
    setError("");
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.pdf$/i, ""));
    try {
      const pdfjsLib = await loadPdfjs();
      const data = await f.arrayBuffer();
      const doc = await pdfjsLib.getDocument({ data }).promise;
      setPages(doc.numPages);
      const meta = await doc.getMetadata().catch(() => null);
      const info = meta?.info as { Title?: string; Author?: string } | undefined;
      if (info?.Title && !title) setTitle(info.Title);
      if (info?.Author && !author) setAuthor(info.Author);
    } catch {
      setError("That PDF couldn't be read. Try another file.");
      setFile(null);
    }
  }
  async function submit() {
    if (!file || !pages) return;
    setUploading(true);
    try {
      const created = await api<{ id: string }>("uploads", "POST", {
        title: title.trim(),
        author: author.trim(),
        kind,
        pages,
        ...(kind === "paper" ? { topic } : {}),
      });
      await apiUploadPdf(`uploads/${created.id}/content`, "PUT", file);
      await refresh();
      notify("Your PDF is ready to read");
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }
  return (
    <Modal close={close}>
      <span className="eyebrow">READ ANYTHING, ANYWHERE</span>
      <h2>Upload a PDF.</h2>
      <p className="import-lede">
        Books and papers you bring in sync across your devices, right where you left off.
      </p>
      <label className="file-drop">
        <FileSpreadsheet size={28} />
        <b>{file ? file.name : "Choose a PDF"}</b>
        <span>{file ? `${pages} pages · ready to upload` : "PDF files only · nothing uploads until you confirm"}</span>
        <input
          type="file"
          accept="application/pdf"
          onChange={(e) => void chooseFile(e.target.files?.[0])}
        />
      </label>
      {error && (
        <p className="import-error" role="alert">
          {error}
        </p>
      )}
      {file && (
        <>
          <div className="thought-visibility">
            <button
              type="button"
              className={kind === "book" ? "active" : ""}
              onClick={() => setKind("book")}
            >
              Book
            </button>
            <button
              type="button"
              className={kind === "paper" ? "active" : ""}
              onClick={() => setKind("paper")}
            >
              Paper
            </button>
          </div>
          <label>
            Title
            <input
              value={title}
              maxLength={250}
              required
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label>
            Author
            <input
              value={author}
              maxLength={150}
              onChange={(e) => setAuthor(e.target.value)}
            />
          </label>
          {kind === "paper" && (
            <label>
              Field
              <select
                value={topic}
                onChange={(e) => setTopic(e.target.value as PaperTopic)}
              >
                {PAPER_TOPICS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
          )}
        </>
      )}
      <div className="modal-actions">
        <button className="outline" onClick={close}>
          Cancel
        </button>
        <button
          className="primary"
          disabled={!file || !title.trim() || uploading}
          onClick={() => void submit()}
        >
          {uploading ? (
            <>
              <Loader2 className="spin" size={16} /> Uploading…
            </>
          ) : (
            <>
              Add to library <ArrowRight size={16} />
            </>
          )}
        </button>
      </div>
    </Modal>
  );
}
function BookModal({
  book,
  item,
  notes,
  library,
  findBook,
  close,
  mutate,
  busy,
}: {
  book: Book;
  item?: LibraryItem;
  notes: Thought[];
  library: LibraryItem[];
  findBook: (id: string) => Book;
  close: () => void;
  mutate: (
    path: string,
    method: string,
    body: unknown,
    message?: string,
  ) => Promise<boolean>;
  busy: boolean;
}) {
  const [tab, setTab] = useState("Progress"),
    [page, setPage] = useState(item?.page || 0),
    [body, setBody] = useState(""),
    [spoiler, setSpoiler] = useState(false),
    [visibility, setVisibility] = useState<NoteVisibility>("public"),
    [review, setReview] = useState(item?.review || ""),
    [reranking, setReranking] = useState(false),
    [revealed, setRevealed] = useState<string[]>([]);
  const [status, setStatus] = useState<Shelf>(item?.status || "want");
  const publicNotes = notes.filter((n) => n.visibility !== "private");
  const privateNotes = notes.filter((n) => n.visibility === "private");
  const isUpload = book.kind !== "catalog";
  const ranked = library
    .filter(
      (l) =>
        l.status === "read" && l.rank_position != null && l.book_id !== book.id,
    )
    .sort((a, b) => (a.rank_position as number) - (b.rank_position as number))
    .map((l) => ({
      book: findBook(l.book_id),
      rank_position: l.rank_position as number,
    }));
  const save = async () => {
    if (
      await mutate(
        "library",
        "PUT",
        { book_id: book.id, status, page, review },
        "Your shelf is up to date",
      )
    )
      setPage(status === "read" ? book.pages : status === "want" ? 0 : page);
  };
  return (
    <Modal close={close} wide>
      <div className="book-modal-header">
        <Cover book={book} />
        <div>
          <span className="eyebrow">
            {isUpload
              ? book.kind === "paper"
                ? (book.topic || "PAPER").toUpperCase()
                : "YOUR UPLOAD"
              : book.genre} ·{" "}
            {book.pages} PAGES
          </span>
          <h2>{book.title}</h2>
          <p>{book.author}</p>
          {!isUpload && (
            <span className="book-rating">
              <Star size={14} fill="currentColor" />
              {book.rating || "Not rated"} <small>Catalog rating</small>
            </span>
          )}
        </div>
      </div>
      <p className="book-description">{book.description}</p>
      <div className="shelf-select">
        <label>
          On your shelf
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as Shelf)}
          >
            <option value="want">Want to read</option>
            <option value="reading">Currently reading</option>
            <option value="read">Finished reading</option>
          </select>
        </label>
        <button className="primary" disabled={busy} onClick={save}>
          {item ? "Save shelf" : "Add to library"} <Plus size={15} />
        </button>
      </div>
      <div className="modal-tabs">
        {["Progress", "Your thoughts", "Private notes", "Final verdict"].map(
          (t) => (
            <button
              className={tab === t ? "active" : ""}
              key={t}
              onClick={() => setTab(t)}
            >
              {t}
              {t === "Your thoughts" && <span>{publicNotes.length}</span>}
              {t === "Private notes" && <span>{privateNotes.length}</span>}
            </button>
          ),
        )}
      </div>
      {tab === "Progress" && (
        <div className="progress-panel">
          <div className="section-heading">
            <h3>Every page has a moment.</h3>
            <span className="page-chip">
              {Math.round((page / book.pages) * 100)}%
            </span>
          </div>
          <p>Scrub to a page. Leave a thought. Remember how it felt.</p>
          {isUpload ? (
            <PdfReader
              book={book}
              page={page}
              onPageChange={setPage}
              notes={publicNotes}
              mutate={mutate}
            />
          ) : (
            <div className="waveform">
              <div className="wave-bars">
                {Array.from({ length: 72 }, (_, i) => (
                  <i
                    key={i}
                    style={{
                      height: `${18 + Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.4)) * 56}px`,
                      background:
                        i / 72 <= page / book.pages ? "#52734c" : "#dedfd4",
                    }}
                  />
                ))}
              </div>
              <input
                aria-label="Reading timeline"
                type="range"
                min={0}
                max={book.pages}
                value={page}
                onChange={(e) => setPage(Number(e.target.value))}
              />
              {publicNotes.map((n) => (
                <button
                  key={n.id}
                  className="thought-marker"
                  style={{ left: `${(n.page / book.pages) * 100}%` }}
                  title={`Thought at page ${n.page}`}
                  aria-label={`Read thought at page ${n.page}`}
                  onClick={() => {
                    setPage(n.page);
                    setTab("Your thoughts");
                  }}
                >
                  <MessageCircle size={12} fill="currentColor" />
                </button>
              ))}
            </div>
          )}
          <div className="timeline-labels">
            <span>Page 1</span>
            <label>
              You're on page{" "}
              <input
                aria-label="Current page"
                type="number"
                min={0}
                max={book.pages}
                value={page}
                onChange={(e) =>
                  setPage(
                    Math.max(0, Math.min(book.pages, Number(e.target.value))),
                  )
                }
              />
            </label>
            <span>{book.pages}</span>
          </div>
          <button
            className="outline full"
            disabled={busy}
            onClick={async () => {
              if (
                await mutate(
                  "library",
                  "PUT",
                  {
                    book_id: book.id,
                    status: page === book.pages ? "read" : "reading",
                    page,
                    review,
                  },
                  page === book.pages
                    ? "Another world explored. Leave your final verdict!"
                    : "Progress saved. One chapter closer.",
                )
              )
                setStatus(page === book.pages ? "read" : "reading");
            }}
          >
            Save progress <Bookmark size={15} />
          </button>
          <form
            className="thought-form"
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                await mutate(
                  "notes",
                  "POST",
                  { book_id: book.id, page, body, spoiler, visibility },
                  visibility === "private"
                    ? "A private thought, just for you"
                    : "A thought, saved between the pages",
                )
              ) {
                setBody("");
                setSpoiler(false);
              }
            }}
          >
            <label>
              A thought on page {page}
              <textarea
                placeholder="A line that stayed with you? A theory? A feeling?"
                maxLength={2000}
                required
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </label>
            <div className="thought-visibility">
              <button
                type="button"
                className={visibility === "public" ? "active" : ""}
                onClick={() => setVisibility("public")}
              >
                Public
              </button>
              <button
                type="button"
                className={visibility === "private" ? "active" : ""}
                onClick={() => setVisibility("private")}
              >
                Private
              </button>
            </div>
            <div>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={spoiler}
                  onChange={(e) => setSpoiler(e.target.checked)}
                />{" "}
                Contains spoilers
              </label>
              <button className="primary" disabled={busy || !body.trim()}>
                Leave a thought <ArrowRight size={15} />
              </button>
            </div>
          </form>
        </div>
      )}
      {(tab === "Your thoughts" || tab === "Private notes") && (
        <div className="thought-list">
          {(tab === "Your thoughts" ? publicNotes : privateNotes).length ? (
            (tab === "Your thoughts" ? publicNotes : privateNotes).map((n) => (
              <article key={n.id}>
                <span className="page-chip">
                  <Bookmark size={12} />
                  Page {n.page}
                </span>
                <small>
                  {new Date(
                    n.created_at.replace(" ", "T") + "Z",
                  ).toLocaleDateString()}
                </small>
                {n.spoiler && !revealed.includes(n.id) ? (
                  <button
                    className="spoiler-cover"
                    onClick={() => setRevealed([...revealed, n.id])}
                  >
                    This thought contains spoilers. Click to reveal.
                  </button>
                ) : (
                  <p>{n.body}</p>
                )}
              </article>
            ))
          ) : (
            <Empty
              title={
                tab === "Your thoughts"
                  ? "Catch a passing thought"
                  : "Private thoughts, just for you"
              }
              text={
                tab === "Your thoughts"
                  ? "Use the progress timeline to leave your first note."
                  : "Mark a thought private and only you will ever see it."
              }
              action={() => setTab("Progress")}
              label="Leave a thought"
            />
          )}
        </div>
      )}
      {tab === "Final verdict" && (
        <div className="verdict-panel">
          <form
            className="verdict-form"
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                await mutate(
                  "library",
                  "PUT",
                  {
                    book_id: book.id,
                    status: "read",
                    page: book.pages,
                    review,
                  },
                  "Your final verdict is on the shelf",
                )
              ) {
                setStatus("read");
                setPage(book.pages);
              }
            }}
          >
            <h3>How did this one leave you?</h3>
            <p>Some stories stay. Give this one its last word.</p>
            <label>
              Your final verdict
              <textarea
                placeholder="What will you remember about this book?"
                maxLength={5000}
                value={review}
                onChange={(e) => setReview(e.target.value)}
              />
            </label>
            <button className="primary" disabled={busy}>
              Finish & save verdict <Check size={16} />
            </button>
          </form>
          {status === "read" && (item?.rank_position == null || reranking) && (
            <RelativeRating
              key={reranking ? "rerank" : "rank"}
              book={book}
              ranked={ranked}
              busy={busy}
              onDone={async (rankPosition) => {
                if (
                  await mutate(
                    "library/rank",
                    "PUT",
                    { book_id: book.id, rank_position: rankPosition },
                    "Your ranking is updated",
                  )
                )
                  setReranking(false);
              }}
            />
          )}
          {status === "read" && item?.rank_position != null && !reranking && (
            <div className="rank-summary">
              <span className="eyebrow">YOUR RANKING</span>
              <p>
                #{item.rank_position + 1} of {item.ranked_total} finished books
                you've ranked
              </p>
              <RatingDisplay item={item} />
              <button
                className="text-action"
                onClick={() => setReranking(true)}
              >
                Compare it again <ArrowRight size={14} />
              </button>
            </div>
          )}
        </div>
      )}
      {item && (
        <button
          className="remove-book"
          disabled={busy}
          onClick={async () => {
            if (
              await mutate(
                "library",
                "DELETE",
                { book_id: book.id },
                "Book removed from your shelf",
              )
            )
              close();
          }}
        >
          Remove from shelf
        </button>
      )}
    </Modal>
  );
}
interface SearchResult {
  key: string;
  title: string;
  author_name?: string[];
  cover_i?: number;
  number_of_pages_median?: number;
}
function SearchModal({
  books,
  close,
  choose,
  refresh,
  notify,
}: {
  books: Book[];
  close: () => void;
  choose: (b: Book) => void;
  refresh: () => Promise<Bootstrap>;
  notify: (s: string) => void;
}) {
  const [query, setQuery] = useState(""),
    [remote, setRemote] = useState<SearchResult[]>([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [importing, setImporting] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    if (query.trim().length < 2) {
      setRemote([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    const timer = setTimeout(async () => {
      try {
        const data = await api<{ results?: SearchResult[] }>(
          "search?q=" + encodeURIComponent(query),
          "GET",
          undefined,
          controller.signal,
        );
        setRemote(data.results || []);
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 550);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);
  const local = books.filter(
    (b) =>
      !query ||
      `${b.title} ${b.author}`.toLowerCase().includes(query.toLowerCase()),
  );
  async function importBook(r: SearchResult) {
    setImporting(true);
    try {
      const result = await api<{ id: string }>("books/import", "POST", {
        key: r.key,
        title: r.title,
        author: r.author_name?.[0] || "Unknown author",
        cover_id: r.cover_i || 0,
        pages: r.number_of_pages_median || 300,
      });
      const next = await refresh();
      const b = next.books.find((b) => b.id === result.id);
      if (b) choose(b);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setImporting(false);
    }
  }
  return (
    <Modal close={close} wide>
      <span className="eyebrow">SO MANY WORLDS. ONE SEARCH.</span>
      <h2>What are you curious about?</h2>
      <label className="search-input">
        <Search size={20} />
        <input
          autoFocus
          placeholder="Search a title or author…"
          value={query}
          maxLength={150}
          onChange={(e) => setQuery(e.target.value)}
        />
        {loading && <Loader2 className="spin" size={18} />}
      </label>
      <div className="search-results">
        <h3>{query ? "On our shelves" : "A few good places to start"}</h3>
        {local.slice(0, 8).map((b) => (
          <button
            className="search-result"
            onClick={() => choose(b)}
            key={b.id}
          >
            <span className="search-cover" style={{ background: b.color }}>
              <BookOpen size={18} />
            </span>
            <span>
              <b>{b.title}</b>
              <small>
                {b.author} · {b.genre}
              </small>
            </span>
            <ChevronRight size={16} />
          </button>
        ))}
        {query.length >= 2 && (
          <>
            <h3>From Open Library {loading && <small>Searching…</small>}</h3>
            {error && <p className="search-error">{error}</p>}
            {remote
              .filter(
                (r) =>
                  !books.some(
                    (b) =>
                      b.id === r.key.replace("/works/", "") ||
                      b.title.toLowerCase() === r.title.toLowerCase(),
                  ),
              )
              .map((r) => (
                <button
                  className="search-result"
                  disabled={importing}
                  onClick={() => importBook(r)}
                  key={r.key}
                >
                  <span className="search-cover">
                    <BookOpen size={18} />
                  </span>
                  <span>
                    <b>{r.title}</b>
                    <small>
                      {r.author_name?.join(", ") || "Unknown author"}
                      {!r.number_of_pages_median
                        ? " · Page count estimated: 300"
                        : ""}
                    </small>
                  </span>
                  <Plus size={17} />
                </button>
              ))}
            {!loading && !remote.length && !local.length && !error && (
              <p>No books found. Try another title or author.</p>
            )}
            <small className="catalog-note">
              Book details and covers from Open Library. Missing page counts use
              an estimate of 300 pages.
            </small>
          </>
        )}
      </div>
    </Modal>
  );
}
