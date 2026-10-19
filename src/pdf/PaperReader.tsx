// Host-agnostic PDF/paper reader UI. The web book modal (src/PdfReader.tsx)
// and the mobile app's WebView entry (src/reader-embed.tsx) both render this,
// supplying how to load bytes and persist notes/progress.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Coffee,
  Highlighter,
  ListTree,
  Maximize2,
  MessageCircle,
  MessageSquarePlus,
  Minimize2,
  Moon,
  MoveHorizontal,
  Scan,
  Search,
  Sun,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  parseAnchor,
  PdfEngine,
  type FindState,
  type FitMode,
  type MarkRect,
  type OutlineEntry,
  type PdfMark,
  type PdfSelection,
} from "./engine";
import { loadPdfjs } from "./loadPdfjs";

export type ReaderVisibility = "public" | "private";
export interface ReaderNote {
  id: string;
  page: number;
  body: string;
  visibility?: ReaderVisibility;
  quote?: string | null;
  anchor?: string | null;
}
export interface NoteDraft {
  page: number;
  quote: string;
  rects: MarkRect[];
}
export interface CreateNoteInput {
  page: number;
  body: string;
  quote?: string;
  anchor?: { rects: MarkRect[] };
  visibility: ReaderVisibility;
  spoiler: boolean;
}
export interface PaperReaderProps {
  docKey: string;
  title: string;
  author?: string;
  /** Page count known before the PDF loads (used for the thought rail). */
  pageCount: number;
  loadPdf: () => Promise<ArrayBuffer | Uint8Array>;
  page: number;
  onPageChange: (page: number) => void;
  notes: ReaderNote[];
  onCreateNote: (input: CreateNoteInput) => Promise<boolean>;
  /**
   * When provided, "Add thought" outside the full-screen view hands the quote
   * to the host's own composer instead of the reader's built-in one.
   */
  onAddThought?: (draft: NoteDraft) => void;
  /** Mobile WebView: always full-viewport, no Fullscreen API, close = exit. */
  embedded?: boolean;
  onClose?: () => void;
  onChromeChange?: (visible: boolean) => void;
}

type Tone = "paper" | "sepia" | "night";
const TONES: Tone[] = ["paper", "sepia", "night"];
const TONE_KEY = "wr-reader-tone";
const CHROME_IDLE_MS = 2800;

function readTone(): Tone {
  try {
    const t = localStorage.getItem(TONE_KEY) as Tone | null;
    return t && TONES.includes(t) ? t : "paper";
  } catch {
    return "paper";
  }
}

const isPhone = () =>
  typeof matchMedia === "function" && matchMedia("(max-width: 700px)").matches;

type FsDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void>;
};
type FsElement = HTMLElement & {
  webkitRequestFullscreen?: (opts?: FullscreenOptions) => Promise<void>;
};
const fullscreenElement = () =>
  document.fullscreenElement ??
  (document as FsDocument).webkitFullscreenElement;

export function PaperReader({
  docKey,
  title,
  author,
  pageCount,
  loadPdf,
  page,
  onPageChange,
  notes,
  onCreateNote,
  onAddThought,
  embedded = false,
  onClose,
  onChromeChange,
}: PaperReaderProps) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [engine, setEngine] = useState<PdfEngine | null>(null);
  const [numPages, setNumPages] = useState(pageCount);
  const [current, setCurrent] = useState(Math.max(1, page || 1));
  const [zoom, setZoom] = useState<{ scale: number; mode: FitMode }>({
    scale: 1,
    mode: "width",
  });
  const [focus, setFocus] = useState(embedded);
  const [chrome, setChrome] = useState(true);
  const [panel, setPanel] = useState<null | "outline" | "pages">(null);
  const [outline, setOutline] = useState<OutlineEntry[] | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findState, setFindState] = useState<FindState | null>(null);
  const [selection, setSelection] = useState<PdfSelection | null>(null);
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const [tone, setTone] = useState<Tone>(readTone);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const engineRef = useRef<PdfEngine | null>(null);
  // Starts at the host's page (0 = never opened) so the first page the
  // engine lands on is reported, as the old reader did.
  const lastEmitted = useRef(page);
  const findTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const lastSearched = useRef("");
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const nativeFs = useRef(false);
  // Latest callbacks, so the engine (created once per document) never calls
  // a stale closure.
  const cb = useRef({ onPageChange, loadPdf, page });
  cb.current = { onPageChange, loadPdf, page };

  // ------------------------------------------------------------ lifecycle
  useEffect(() => {
    let cancelled = false;
    let opened: PdfEngine | null = null;
    setStatus("loading");
    setOutline(null);
    setSelection(null);
    setFindState(null);
    lastSearched.current = "";
    // The engine builds and owns the page DOM inside the scroller, so page
    // shells exist (and are observed) before any render: no ref-map timing.
    (async () => {
      try {
        const [lib, data] = await Promise.all([
          loadPdfjs(),
          cb.current.loadPdf(),
        ]);
        if (cancelled || !scrollerRef.current) return;
        const scroller = scrollerRef.current;
        const narrow = scroller.clientWidth < 520;
        opened = await PdfEngine.open(
          lib,
          data,
          scroller,
          {
            onPage: (n) => {
              setCurrent(n);
              if (n === lastEmitted.current) return;
              lastEmitted.current = n;
              cb.current.onPageChange(n);
            },
            onZoom: (scale, mode) => setZoom({ scale, mode }),
            onSelection: setSelection,
            onFind: setFindState,
          },
          {
            initialPage: Math.max(1, cb.current.page || 1),
            padding: narrow ? 8 : 20,
            gap: narrow ? 10 : 16,
          },
        );
        if (cancelled) {
          opened.destroy();
          return;
        }
        engineRef.current = opened;
        lastEmitted.current = opened.currentPage;
        setEngine(opened);
        setNumPages(opened.numPages);
        setStatus("ready");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
      opened?.destroy();
      engineRef.current = null;
      setEngine(null);
    };
  }, [docKey]);

  // External page changes (rail marker, the host's page input).
  useEffect(() => {
    const e = engineRef.current;
    if (!e || !page || page === lastEmitted.current) return;
    lastEmitted.current = page;
    e.goToPage(page, true);
  }, [page]);

  const marks = useMemo<PdfMark[]>(
    () =>
      notes
        .map((n) => ({ n, rects: parseAnchor(n.anchor) }))
        .filter(({ rects }) => rects.length > 0)
        .map(({ n, rects }) => ({
          id: n.id,
          page: n.page,
          rects,
          tone:
            n.quote && n.body.trim() !== n.quote.trim()
              ? ("thought" as const)
              : ("highlight" as const),
        })),
    [notes],
  );
  useEffect(() => {
    engine?.setMarks(marks);
  }, [engine, marks]);

  useEffect(() => {
    try {
      localStorage.setItem(TONE_KEY, tone);
    } catch {
      // private mode: tone just isn't remembered
    }
  }, [tone]);

  // ---------------------------------------------------------- full screen
  const enterFocus = useCallback(() => {
    setFocus(true);
    setChrome(true);
    const root = rootRef.current as FsElement | null;
    if (embedded || !root) return;
    const request =
      root.requestFullscreen?.bind(root) ??
      root.webkitRequestFullscreen?.bind(root);
    if (!request) return; // iPhone Safari: the fixed overlay is the full screen
    request({ navigationUI: "hide" })
      .then(() => {
        nativeFs.current = true;
      })
      .catch(() => {
        nativeFs.current = false;
      });
  }, [embedded]);

  const exitFocus = useCallback(() => {
    if (embedded) {
      onClose?.();
      return;
    }
    setFocus(false);
    setPanel(null);
    setChrome(true);
    if (fullscreenElement()) {
      const doc = document as FsDocument;
      (
        document.exitFullscreen?.bind(document) ??
        doc.webkitExitFullscreen?.bind(doc)
      )?.().catch(() => {});
    }
    nativeFs.current = false;
  }, [embedded, onClose]);

  useEffect(() => {
    const onChange = () => {
      // Leaving native full screen (Esc / browser UI) also leaves focus mode.
      if (nativeFs.current && !fullscreenElement()) {
        nativeFs.current = false;
        setFocus(false);
        setPanel(null);
      }
    };
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, []);

  // ---------------------------------------------------- auto-hiding chrome
  // Chrome stays put while loading and while any panel/popover is open.
  const pinned =
    !!(panel || findOpen || draft || selection) || status !== "ready";
  const poke = useCallback(() => {
    setChrome(true);
    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setChrome(false), CHROME_IDLE_MS);
  }, []);
  useEffect(() => {
    if (!focus) {
      clearTimeout(idleTimer.current);
      setChrome(true);
      return;
    }
    if (pinned) {
      clearTimeout(idleTimer.current);
      setChrome(true);
    } else poke();
    return () => clearTimeout(idleTimer.current);
  }, [focus, pinned, poke]);
  const chromeVisible = !focus || chrome || pinned;
  useEffect(() => {
    onChromeChange?.(chromeVisible);
  }, [chromeVisible, onChromeChange]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !focus) return;
    let lastTop = scroller.scrollTop;
    // Only the reader's own scrolling hides the chrome — not refits, jumps
    // or the resize when entering full screen.
    let userInputAt = 0;
    const markInput = () => {
      userInputAt = performance.now();
    };
    const inputEvents = ["wheel", "touchmove", "keydown"] as const;
    inputEvents.forEach((t) =>
      scroller.addEventListener(t, markInput, { passive: true }),
    );
    const onScroll = () => {
      const delta = scroller.scrollTop - lastTop;
      lastTop = scroller.scrollTop;
      if (pinned || performance.now() - userInputAt > 500) return;
      if (delta > 6) {
        clearTimeout(idleTimer.current);
        setChrome(false);
      } else if (delta < -24) poke();
    };
    // A quick tap (no drag, no text selected) toggles the chrome on touch.
    let down: { x: number; y: number; t: number } | null = null;
    const onDown = (e: PointerEvent) => {
      down =
        e.pointerType === "mouse"
          ? null
          : { x: e.clientX, y: e.clientY, t: performance.now() };
    };
    const onUp = (e: PointerEvent) => {
      if (!down) return;
      const tap =
        Math.hypot(e.clientX - down.x, e.clientY - down.y) < 8 &&
        performance.now() - down.t < 320;
      down = null;
      if (!tap || document.getSelection()?.toString()) return;
      setChrome((v) => {
        if (v) clearTimeout(idleTimer.current);
        return !v;
      });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.addEventListener("pointerdown", onDown);
    scroller.addEventListener("pointerup", onUp);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      inputEvents.forEach((t) => scroller.removeEventListener(t, markInput));
      scroller.removeEventListener("pointerdown", onDown);
      scroller.removeEventListener("pointerup", onUp);
    };
  }, [focus, pinned, poke]);

  // ----------------------------------------------------------------- find
  const openFind = useCallback(() => {
    setFindOpen(true);
    setPanel((p) => (isPhone() ? null : p));
    requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  }, []);
  const closeFind = useCallback(() => {
    clearTimeout(findTimer.current);
    lastSearched.current = "";
    setFindOpen(false);
    setFindQuery("");
    engineRef.current?.clearFind();
    scrollerRef.current?.focus({ preventScroll: true });
  }, []);
  const runFind = useCallback((q: string, direction: 1 | -1 = 1) => {
    clearTimeout(findTimer.current);
    lastSearched.current = q;
    engineRef.current?.find(q, direction);
  }, []);
  const onFindInput = (q: string) => {
    setFindQuery(q);
    clearTimeout(findTimer.current);
    findTimer.current = setTimeout(() => {
      if (q !== lastSearched.current) runFind(q);
    }, 220);
  };

  // ------------------------------------------------------------- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const root = rootRef.current;
      const e2 = engineRef.current;
      if (!root) return;
      const within = root.contains(document.activeElement);
      if (!focus && !within) return;
      const target = e.target as HTMLElement | null;
      const typing = !!target?.closest?.(
        "input, textarea, select, [contenteditable='true']",
      );
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "f") {
        e.preventDefault();
        openFind();
        return;
      }
      if (e.key === "Escape") {
        // Swallow Esc so the surrounding <dialog> doesn't close underneath us.
        if (findOpen) closeFind();
        else if (draft) setDraft(null);
        else if (selection) e2?.clearSelection();
        else if (panel) setPanel(null);
        else if (focus && !embedded) exitFocus();
        else return;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (typing || !e2) return;
      if (mod) {
        if (e.key === "=" || e.key === "+") e2.zoomIn();
        else if (e.key === "-") e2.zoomOut();
        else if (e.key === "0") e2.fit("width");
        else return;
        e.preventDefault();
        return;
      }
      if (e.altKey) return;
      switch (e.key) {
        case "ArrowRight":
        case "PageDown":
          e2.nextPage();
          break;
        case "ArrowLeft":
        case "PageUp":
          e2.prevPage();
          break;
        case " ":
          e2.scrollScreen(e.shiftKey ? -1 : 1);
          break;
        case "ArrowDown":
          e2.scroller.scrollBy({ top: 64 });
          break;
        case "ArrowUp":
          e2.scroller.scrollBy({ top: -64 });
          break;
        case "Home":
          e2.goToPage(1);
          break;
        case "End":
          e2.goToPage(e2.numPages);
          break;
        case "f":
        case "F":
          if (focus) exitFocus();
          else enterFocus();
          break;
        case "+":
        case "=":
          e2.zoomIn();
          break;
        case "-":
          e2.zoomOut();
          break;
        default:
          return;
      }
      e.preventDefault();
      if (focus) poke();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [
    focus,
    findOpen,
    draft,
    selection,
    panel,
    embedded,
    openFind,
    closeFind,
    enterFocus,
    exitFocus,
    poke,
  ]);

  // ------------------------------------------------------------ actions
  const togglePanel = () => {
    setPanel((p) => {
      if (p) return null;
      return outline && outline.length === 0 ? "pages" : "outline";
    });
  };
  useEffect(() => {
    if (!panel || !engine || outline) return;
    let live = true;
    engine.getOutline().then((o) => {
      if (!live) return;
      setOutline(o);
      if (!o.length) setPanel((p) => (p === "outline" ? "pages" : p));
    });
    return () => {
      live = false;
    };
  }, [panel, engine, outline]);

  const jump = (n: number | null) => {
    if (!n) return;
    engineRef.current?.goToPage(n, true);
    if (isPhone()) setPanel(null);
  };

  const highlight = async () => {
    if (!selection) return;
    const sel = selection;
    engineRef.current?.clearSelection();
    await onCreateNote({
      page: sel.page,
      body: sel.text,
      quote: sel.text,
      anchor: { rects: sel.rects },
      visibility: "private",
      spoiler: false,
    });
  };

  const addThought = () => {
    if (!selection) return;
    const d = {
      page: selection.page,
      quote: selection.text,
      rects: selection.rects,
    };
    engineRef.current?.clearSelection();
    if (onAddThought && !focus) onAddThought(d);
    else setDraft(d);
  };

  const cycleTone = () =>
    setTone((t) => TONES[(TONES.indexOf(t) + 1) % TONES.length]);
  const ToneIcon = tone === "paper" ? Sun : tone === "sepia" ? Coffee : Moon;
  const zoomPct = `${Math.round(zoom.scale * 100)}%`;
  const progress = numPages > 1 ? (current - 1) / (numPages - 1) : 1;

  const zoomGroup = (where: "top" | "bottom") => (
    <div
      className={`pdf-zoom pdf-zoom-${where}`}
      role="group"
      aria-label="Zoom"
    >
      <button
        className="pdf-tool"
        onClick={() => engine?.zoomOut()}
        aria-label="Zoom out"
        title="Zoom out (−)"
      >
        <ZoomOut size={17} />
      </button>
      <button
        className="pdf-tool pdf-zoom-label"
        onClick={() => engine?.fit(zoom.mode === "width" ? "page" : "width")}
        aria-label={`Zoom ${zoomPct}. Switch to ${zoom.mode === "width" ? "fit page" : "fit width"}`}
        title={zoom.mode === "width" ? "Fit page" : "Fit width"}
      >
        {zoomPct}
      </button>
      <button
        className="pdf-tool"
        onClick={() => engine?.zoomIn()}
        aria-label="Zoom in"
        title="Zoom in (+)"
      >
        <ZoomIn size={17} />
      </button>
      <button
        className={`pdf-tool pdf-fit ${zoom.mode === "width" ? "active" : ""}`}
        onClick={() => engine?.fit("width")}
        aria-label="Fit width"
        aria-pressed={zoom.mode === "width"}
        title="Fit width"
      >
        <MoveHorizontal size={17} />
      </button>
      <button
        className={`pdf-tool pdf-fit ${zoom.mode === "page" ? "active" : ""}`}
        onClick={() => engine?.fit("page")}
        aria-label="Fit page"
        aria-pressed={zoom.mode === "page"}
        title="Fit page"
      >
        <Scan size={17} />
      </button>
    </div>
  );

  const popStyle = selection ? selectionPopStyle(selection) : undefined;

  return (
    <div
      ref={rootRef}
      className={[
        "pdf-reader",
        focus ? "is-focus" : "",
        embedded ? "is-embedded" : "",
        `tone-${tone}`,
        chromeVisible ? "" : "chrome-hidden",
        panel ? "has-panel" : "",
      ].join(" ")}
      onMouseMove={focus ? poke : undefined}
    >
      <div className="pdf-toolbar" role="toolbar" aria-label="Reader controls">
        {focus && (
          <button
            className="pdf-tool"
            onClick={exitFocus}
            aria-label={embedded ? "Close reader" : "Exit full screen"}
            title={embedded ? "Close" : "Exit full screen (f)"}
          >
            {embedded ? <ArrowLeft size={19} /> : <Minimize2 size={18} />}
          </button>
        )}
        <button
          className={`pdf-tool ${panel ? "active" : ""}`}
          onClick={togglePanel}
          aria-label="Contents and pages"
          aria-expanded={!!panel}
          title="Contents & pages"
        >
          <ListTree size={18} />
        </button>
        {focus ? (
          <div className="pdf-title">
            <strong>{title}</strong>
            {author && <span>{author}</span>}
          </div>
        ) : (
          <span className="pdf-spacer" />
        )}
        <span className="pdf-page-count" aria-live="polite">
          <b>{current}</b> / {numPages}
        </span>
        {zoomGroup("top")}
        <button
          className={`pdf-tool ${findOpen ? "active" : ""}`}
          onClick={() => (findOpen ? closeFind() : openFind())}
          aria-label="Find in paper"
          title="Find (⌘F / Ctrl+F)"
        >
          <Search size={18} />
        </button>
        {focus && (
          <button
            className="pdf-tool pdf-tone"
            onClick={cycleTone}
            aria-label={`Page tone: ${tone}. Change tone`}
            title="Page tone"
          >
            <ToneIcon size={18} />
          </button>
        )}
        {!focus && (
          <button
            className="pdf-tool"
            onClick={enterFocus}
            aria-label="Read full screen"
            title="Full screen (f)"
          >
            <Maximize2 size={17} />
          </button>
        )}
      </div>

      <div className="pdf-body">
        {panel && (
          <>
            <div
              className="pdf-panel-backdrop"
              onClick={() => setPanel(null)}
              aria-hidden="true"
            />
            <aside className="pdf-panel" aria-label="Contents and pages">
              <div className="pdf-panel-grip" aria-hidden="true" />
              <div className="pdf-panel-tabs" role="tablist">
                <button
                  role="tab"
                  aria-selected={panel === "outline"}
                  className={panel === "outline" ? "active" : ""}
                  onClick={() => setPanel("outline")}
                >
                  Contents
                </button>
                <button
                  role="tab"
                  aria-selected={panel === "pages"}
                  className={panel === "pages" ? "active" : ""}
                  onClick={() => setPanel("pages")}
                >
                  Pages
                </button>
                <button
                  className="pdf-tool pdf-panel-close"
                  onClick={() => setPanel(null)}
                  aria-label="Close panel"
                >
                  <X size={17} />
                </button>
              </div>
              {panel === "outline" ? (
                <ol className="pdf-panel-list pdf-outline">
                  {outline === null && (
                    <li className="pdf-panel-empty">Reading contents…</li>
                  )}
                  {outline?.length === 0 && (
                    <li className="pdf-panel-empty">
                      This PDF has no table of contents.
                    </li>
                  )}
                  {outline?.map((o, i) => (
                    <li key={i}>
                      <button
                        style={{ paddingLeft: 12 + o.depth * 14 }}
                        className={
                          o.page && o.page <= current ? "is-read" : undefined
                        }
                        disabled={!o.page}
                        onClick={() => jump(o.page)}
                      >
                        <span>{o.title}</span>
                        {o.page && <small>{o.page}</small>}
                      </button>
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="pdf-panel-list pdf-thumbs">
                  {engine &&
                    Array.from({ length: numPages }, (_, i) => i + 1).map(
                      (n) => (
                        <Thumb
                          key={n}
                          n={n}
                          engine={engine}
                          active={n === current}
                          onPick={jump}
                        />
                      ),
                    )}
                </div>
              )}
            </aside>
          </>
        )}

        <div className="pdf-stage">
          <div
            className="pdf-reader-scroll"
            ref={scrollerRef}
            tabIndex={0}
            aria-label={`${title}, page ${current} of ${numPages}`}
          />
          {status === "error" && (
            <p className="pdf-reader-error">
              This PDF couldn't be loaded. Try reopening it.
            </p>
          )}
          {status === "loading" && (
            <p className="pdf-reader-loading">Opening your PDF…</p>
          )}

          {findOpen && (
            <div className="pdf-find" role="search">
              <Search size={15} aria-hidden="true" />
              <input
                ref={findInputRef}
                type="search"
                inputMode="search"
                enterKeyHint="search"
                placeholder="Find in paper"
                aria-label="Find in paper"
                value={findQuery}
                onChange={(e) => onFindInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    runFind(findQuery, e.shiftKey ? -1 : 1);
                  }
                }}
              />
              <span className="pdf-find-count" aria-live="polite">
                {findState?.query
                  ? findState.total
                    ? `${findState.current} of ${findState.total}${findState.pending ? "+" : ""}`
                    : findState.pending
                      ? "Searching…"
                      : "No results"
                  : ""}
              </span>
              <button
                className="pdf-tool"
                onClick={() => runFind(findQuery, -1)}
                disabled={!findState?.total}
                aria-label="Previous match"
                title="Previous (Shift+Enter)"
              >
                <ChevronUp size={17} />
              </button>
              <button
                className="pdf-tool"
                onClick={() => runFind(findQuery, 1)}
                disabled={!findState?.total}
                aria-label="Next match"
                title="Next (Enter)"
              >
                <ChevronDown size={17} />
              </button>
              <button
                className="pdf-tool"
                onClick={closeFind}
                aria-label="Close find"
                title="Close (Esc)"
              >
                <X size={17} />
              </button>
            </div>
          )}

          <div className="pdf-reader-rail" aria-label="Thoughts in this paper">
            {notes.map((n) => (
              <button
                key={n.id}
                className={`thought-marker ${n.visibility === "private" ? "is-private" : ""}`}
                style={{
                  top: `${(Math.max(1, n.page) / Math.max(1, numPages)) * 100}%`,
                }}
                title={`${n.quote ? "Highlight" : "Thought"} at page ${n.page}`}
                aria-label={`Go to ${n.quote ? "highlight" : "thought"} at page ${n.page}`}
                onClick={() => {
                  const e = engineRef.current;
                  if (!e) return;
                  if (!e.revealMark(n.id)) e.goToPage(n.page, true);
                }}
              >
                <MessageCircle size={12} fill="currentColor" />
              </button>
            ))}
          </div>
        </div>
      </div>

      {focus && (
        <div className="pdf-bottombar">
          <div className="pdf-scrubber">
            <div
              className="pdf-scrubber-fill"
              style={{ transform: `scaleX(${progress})` }}
              aria-hidden="true"
            />
            {notes.map((n) => (
              <i
                key={n.id}
                className="pdf-scrubber-tick"
                style={{
                  left: `${((Math.max(1, n.page) - 1) / Math.max(1, numPages - 1)) * 100}%`,
                }}
                aria-hidden="true"
              />
            ))}
            <input
              type="range"
              min={1}
              max={Math.max(1, numPages)}
              value={current}
              aria-label="Page"
              aria-valuetext={`Page ${current} of ${numPages}`}
              onChange={(e) => {
                const n = Number(e.target.value);
                setCurrent(n);
                engine?.goToPage(n);
              }}
            />
          </div>
          <div className="pdf-bottom-row">
            <span className="pdf-page-count">
              <b>{current}</b> / {numPages}
            </span>
            {zoomGroup("bottom")}
            <button
              className="pdf-tool pdf-tone"
              onClick={cycleTone}
              aria-label={`Page tone: ${tone}. Change tone`}
            >
              <ToneIcon size={18} />
            </button>
          </div>
        </div>
      )}

      {selection && popStyle && (
        <div
          className="pdf-selection-pop"
          style={popStyle}
          role="toolbar"
          aria-label="Selected text"
          onPointerDown={(e) => e.preventDefault()}
        >
          <button onClick={highlight}>
            <Highlighter size={15} /> Highlight
          </button>
          <button onClick={addThought}>
            <MessageSquarePlus size={15} /> Add thought
          </button>
        </div>
      )}

      {draft && (
        <ReaderComposer
          draft={draft}
          close={() => setDraft(null)}
          save={async (body, visibility) => {
            const ok = await onCreateNote({
              page: draft.page,
              body,
              quote: draft.quote,
              anchor: { rects: draft.rects },
              visibility,
              spoiler: false,
            });
            if (ok) setDraft(null);
            return ok;
          }}
        />
      )}
    </div>
  );
}

function selectionPopStyle(sel: PdfSelection): React.CSSProperties {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const coarse = matchMedia("(pointer: coarse)").matches;
  const width = 260;
  const center = (sel.box.left + sel.box.right) / 2;
  const left = Math.min(vw - width / 2 - 8, Math.max(width / 2 + 8, center));
  // Touch platforms draw their own callout above a selection; sit below it.
  const above = !coarse && sel.box.top > 120;
  const top = above
    ? sel.box.top - 54
    : Math.min(vh - 64, sel.box.bottom + (coarse ? 34 : 10));
  return { left, top: Math.max(8, top) };
}

function Thumb({
  n,
  engine,
  active,
  onPick,
}: {
  n: number;
  engine: PdfEngine;
  active: boolean;
  onPick: (n: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let rendered = false;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !rendered) {
          rendered = true;
          engine.renderThumbnail(n, canvas, 112);
        } else if (!entry.isIntersecting && rendered) {
          // Release thumbnails scrolled far away so long PDFs stay light.
          rendered = false;
          canvas.width = 0;
          canvas.height = 0;
        }
      },
      { root: canvas.closest(".pdf-panel-list"), rootMargin: "400px 0px" },
    );
    io.observe(canvas);
    return () => io.disconnect();
  }, [engine, n]);
  useEffect(() => {
    if (active)
      btnRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);
  return (
    <button
      ref={btnRef}
      className={`pdf-thumb ${active ? "active" : ""}`}
      onClick={() => onPick(n)}
      aria-label={`Page ${n}`}
      aria-current={active ? "page" : undefined}
    >
      <canvas
        ref={canvasRef}
        style={{ aspectRatio: `1 / ${engine.pageAspect(n)}` }}
      />
      <span>{n}</span>
    </button>
  );
}

function ReaderComposer({
  draft,
  close,
  save,
}: {
  draft: NoteDraft;
  close: () => void;
  save: (body: string, visibility: ReaderVisibility) => Promise<boolean>;
}) {
  const [body, setBody] = useState("");
  const [visibility, setVisibility] = useState<ReaderVisibility>("public");
  const [saving, setSaving] = useState(false);
  const formRef = useRef<HTMLFormElement | null>(null);
  // Keep the sheet above the on-screen keyboard (iOS Safari / WKWebView
  // overlay the keyboard instead of resizing the layout viewport).
  useEffect(() => {
    const vv = window.visualViewport;
    const form = formRef.current;
    if (!vv || !form) return;
    const update = () => {
      const covered = Math.max(
        0,
        window.innerHeight - vv.height - vv.offsetTop,
      );
      form.style.setProperty("--pdf-kb", `${covered}px`);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
  return (
    <form
      ref={formRef}
      className="pdf-composer"
      aria-label={`A thought on page ${draft.page}`}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!body.trim()) return;
        setSaving(true);
        await save(body.trim(), visibility);
        setSaving(false);
      }}
    >
      <header>
        <span>A thought on page {draft.page}</span>
        <button
          type="button"
          className="pdf-tool"
          onClick={close}
          aria-label="Discard thought"
        >
          <X size={17} />
        </button>
      </header>
      <blockquote>{draft.quote}</blockquote>
      <textarea
        autoFocus
        maxLength={2000}
        required
        placeholder="What does this passage make you think?"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="pdf-composer-row">
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
        <button className="primary" disabled={saving || !body.trim()}>
          Save thought
        </button>
      </div>
    </form>
  );
}
