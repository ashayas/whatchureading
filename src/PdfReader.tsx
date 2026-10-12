import { useEffect, useRef, useState } from "react";
import { MessageCircle } from "lucide-react";
import type { Book, Thought } from "./types";
import { apiUploadPdf, PAPER_SUBTOPICS } from "./types";

// Lazily imported so the (fairly large) pdf.js bundle only loads when a PDF is actually opened.
export async function loadPdfjs() {
  const pdfjsLib = await import("pdfjs-dist");
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url"))
    .default;
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
  return pdfjsLib;
}

export function PdfReader({
  book,
  page,
  onPageChange,
  notes,
  mutate,
}: {
  book: Book;
  page: number;
  onPageChange: (page: number) => void;
  notes: Thought[];
  mutate: (
    path: string,
    method: string,
    body: unknown,
    message?: string,
  ) => Promise<boolean>;
}) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const rendered = useRef<Set<number>>(new Set());
  const lastEmitted = useRef(page);
  const resumedOnce = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  // Subtopic keyword hits accumulated as pages are read, for a smarter
  // per-paper radar than the single topic picked at upload time.
  const topicSignals = useRef<Record<string, number>>({});
  const subtopics =
    book.kind === "paper" && book.topic ? PAPER_SUBTOPICS[book.topic] : [];

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    resumedOnce.current = false;
    rendered.current = new Set();
    pageRefs.current = new Map();
    topicSignals.current = {};
    (async () => {
      try {
        const [pdfjsLib, blob] = await Promise.all([
          loadPdfjs(),
          apiUploadPdf(`uploads/${book.id}/content`, "GET"),
        ]);
        if (cancelled) return;
        const data = await blob.arrayBuffer();
        const doc = await pdfjsLib.getDocument({ data }).promise;
        if (cancelled) return;
        const container = containerRef.current;
        if (!container) return;
        const firstPage = await doc.getPage(1);
        const baseViewport = firstPage.getViewport({ scale: 1 });
        const scale = Math.max(
          0.5,
          (container.clientWidth - 32) / baseViewport.width,
        );
        for (let n = 1; n <= doc.numPages; n++) {
          const pageEl = pageRefs.current.get(n);
          if (!pageEl) continue;
          const canvas = pageEl.querySelector("canvas") as HTMLCanvasElement;
          const viewport =
            n === 1
              ? baseViewport.clone({ scale })
              : (await doc.getPage(n)).getViewport({ scale });
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          pageEl.style.height = `${viewport.height}px`;
        }
        setStatus("ready");
        const renderPage = async (n: number) => {
          if (rendered.current.has(n) || cancelled) return;
          rendered.current.add(n);
          const pdfPage = await doc.getPage(n);
          const pageEl = pageRefs.current.get(n);
          const canvas = pageEl?.querySelector(
            "canvas",
          ) as HTMLCanvasElement | null;
          if (!canvas || cancelled) return;
          const viewport = pdfPage.getViewport({ scale });
          const ctx = canvas.getContext("2d");
          if (!ctx) return;
          await pdfPage.render({ canvas, canvasContext: ctx, viewport })
            .promise;
          if (subtopics.length) {
            try {
              const content = await pdfPage.getTextContent();
              const pageText = content.items
                .map((it) => ("str" in it ? it.str : ""))
                .join(" ")
                .toLowerCase();
              for (const { label, keywords } of subtopics) {
                const hits = keywords.reduce(
                  (sum, kw) => sum + pageText.split(kw).length - 1,
                  0,
                );
                if (hits > 0) {
                  topicSignals.current[label] =
                    (topicSignals.current[label] || 0) + hits;
                }
              }
            } catch {
              // Text extraction is a best-effort enhancement; a scanned or
              // malformed page simply contributes no subtopic signal.
            }
          }
        };
        const lazyObserver = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (entry.isIntersecting) {
                const n = Number((entry.target as HTMLElement).dataset.page);
                renderPage(n);
              }
            }
          },
          { root: container, rootMargin: "800px 0px" },
        );
        const progressObserver = new IntersectionObserver(
          (entries) => {
            const visible = entries
              .filter((e) => e.isIntersecting)
              .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
            if (!visible) return;
            const n = Number((visible.target as HTMLElement).dataset.page);
            if (n === lastEmitted.current) return;
            lastEmitted.current = n;
            onPageChange(n);
            clearTimeout(saveTimer.current);
            saveTimer.current = setTimeout(() => {
              mutate(
                "library",
                "PUT",
                {
                  book_id: book.id,
                  status: "reading",
                  page: n,
                  ...(subtopics.length
                    ? { topic_signals: { ...topicSignals.current } }
                    : {}),
                },
                undefined,
              );
            }, 2000);
          },
          { root: container, threshold: 0.5 },
        );
        pageRefs.current.forEach((el) => {
          lazyObserver.observe(el);
          progressObserver.observe(el);
        });
        if (!resumedOnce.current) {
          resumedOnce.current = true;
          const target = pageRefs.current.get(Math.max(1, page || 1));
          target?.scrollIntoView({ block: "start" });
        }
        return () => {
          lazyObserver.disconnect();
          progressObserver.disconnect();
        };
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id]);

  useEffect(() => {
    if (!resumedOnce.current) return;
    if (page === lastEmitted.current) return;
    lastEmitted.current = page;
    pageRefs.current.get(page)?.scrollIntoView({ block: "start" });
  }, [page]);

  return (
    <div className="pdf-reader">
      <div className="pdf-reader-scroll" ref={containerRef}>
        {status === "error" && (
          <p className="pdf-reader-error">
            This PDF couldn't be loaded. Try reopening it.
          </p>
        )}
        {status === "loading" && (
          <p className="pdf-reader-loading">Opening your PDF…</p>
        )}
        {Array.from({ length: book.pages }, (_, i) => i + 1).map((n) => (
          <div
            key={n}
            className="pdf-page"
            data-page={n}
            ref={(el) => {
              if (el) pageRefs.current.set(n, el);
              else pageRefs.current.delete(n);
            }}
          >
            <canvas />
          </div>
        ))}
      </div>
      <div className="pdf-reader-rail">
        {notes.map((n) => (
          <button
            key={n.id}
            className="thought-marker"
            style={{ top: `${(n.page / book.pages) * 100}%` }}
            title={`Thought at page ${n.page}`}
            aria-label={`Read thought at page ${n.page}`}
            onClick={() => onPageChange(n.page)}
          >
            <MessageCircle size={12} fill="currentColor" />
          </button>
        ))}
      </div>
    </div>
  );
}
