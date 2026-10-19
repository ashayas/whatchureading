// Framework-free PDF reading engine shared by the web reader (src/PdfReader.tsx)
// and the mobile app's WebView reader (bundled by scripts/build-mobile-reader.mjs).
//
// It owns the page DOM inside a scroll container: lazily rendered canvases
// (crisp at devicePixelRatio, far-off canvases released), a selectable pdf.js
// text layer, persistent highlight marks, find-in-document hits, fit/zoom with
// scroll-position preservation and pinch / ctrl+wheel zoom. The host provides
// chrome (toolbars, composer, outline UI) and reacts to events.
import type {
  PDFDocumentProxy,
  PDFPageProxy,
  PageViewport,
  RenderTask,
  TextLayer as TextLayerType,
} from "pdfjs-dist";

export type PdfjsLib = typeof import("pdfjs-dist");
export type FitMode = "width" | "page" | "custom";
/** Page-relative rect: [x, y, width, height], each a 0..1 fraction. */
export type MarkRect = [number, number, number, number];
export interface PdfMark {
  id: string;
  page: number;
  rects: MarkRect[];
  /** "thought" marks carry a written note; "highlight" is a bare highlight. */
  tone?: "highlight" | "thought";
}
export interface PdfSelection {
  page: number;
  text: string;
  rects: MarkRect[];
  /** Selection bounds in viewport (client) coordinates, for a floating action. */
  box: { left: number; top: number; right: number; bottom: number };
}
export interface OutlineEntry {
  title: string;
  page: number | null;
  depth: number;
}
export interface FindState {
  query: string;
  total: number;
  /** 1-based index of the focused hit, 0 when there are no hits. */
  current: number;
  pending: boolean;
}
export interface EngineEvents {
  onPage?: (page: number, numPages: number) => void;
  onZoom?: (scale: number, mode: FitMode) => void;
  onSelection?: (selection: PdfSelection | null) => void;
  onFind?: (state: FindState) => void;
}
export interface EngineOptions {
  initialPage?: number;
  initialMode?: FitMode;
  /** Horizontal + vertical breathing room around pages, in CSS px. */
  padding?: number;
  /** Vertical gap between pages, in CSS px. */
  gap?: number;
  /** Max pages that keep a rendered canvas alive at once. */
  maxLiveCanvases?: number;
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 6;
// iOS Safari refuses canvases above ~16.7M pixels; stay well under it.
const MAX_CANVAS_PIXELS = 12_000_000;
const ZOOM_STEPS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4,
  5, 6,
];

interface TextIndex {
  /** Raw page text: item strings concatenated, " " after end-of-line items. */
  raw: string;
  /** For each text item i: [start, end) within `raw`. */
  segs: Array<[number, number]>;
  /** Lowercased, whitespace-collapsed text for matching. */
  norm: string;
  /** norm index -> raw index. */
  normToRaw: number[];
}

interface PageState {
  n: number;
  el: HTMLDivElement;
  textEl: HTMLDivElement;
  marksEl: HTMLDivElement;
  hitsEl: HTMLDivElement;
  canvas: HTMLCanvasElement | null;
  /** Unscaled (scale 1) size in PDF units. */
  w: number;
  h: number;
  renderedScale: number;
  task: RenderTask | null;
  textLayer: TextLayerType | null;
  textReady: Promise<void> | null;
}

interface ScrollAnchor {
  index: number;
  fx: number;
  fy: number;
  /** Focal point offset within the scroller's visible box. */
  ox: number;
  oy: number;
}

export class PdfEngine {
  readonly numPages: number;
  scale = 1;
  mode: FitMode;
  currentPage = 1;

  private pages: PageState[] = [];
  private pagesEl: HTMLDivElement;
  private padding: number;
  private gap: number;
  private maxLive: number;
  private lazyObserver: IntersectionObserver;
  private resizeObserver: ResizeObserver;
  private visible = new Set<number>();
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private scrollRaf = 0;
  private selTimer: ReturnType<typeof setTimeout> | undefined;
  private destroyed = false;
  private textCache = new Map<number, Promise<TextIndex>>();
  private textItemsCache = new Map<
    number,
    Promise<Awaited<ReturnType<PDFPageProxy["getTextContent"]>>>
  >();
  private pageCache = new Map<number, Promise<PDFPageProxy>>();
  private marks: PdfMark[] = [];
  private findQuery = "";
  private findSeq = 0;
  private hits: Array<{ page: number; start: number; end: number }> = [];
  private hitIndex = -1;
  private pinch: {
    d0: number;
    startScale: number;
    anchor: ScrollAnchor;
    ratio: number;
    mx: number;
    my: number;
  } | null = null;
  private gesture: {
    startScale: number;
    anchor: ScrollAnchor;
    ratio: number;
    x: number;
    y: number;
  } | null = null;
  private cleanup: Array<() => void> = [];
  private lastWidth = 0;
  private lastHeight = 0;

  private constructor(
    private lib: PdfjsLib,
    readonly doc: PDFDocumentProxy,
    readonly scroller: HTMLElement,
    private events: EngineEvents,
    sizes: Array<{ w: number; h: number }>,
    opts: EngineOptions,
  ) {
    this.numPages = doc.numPages;
    this.mode = opts.initialMode ?? "width";
    this.padding = opts.padding ?? 16;
    this.gap = opts.gap ?? 14;
    this.maxLive = opts.maxLiveCanvases ?? 10;
    this.pagesEl = document.createElement("div");
    this.pagesEl.className = "pdf-pages";
    // Exposed as a variable so host CSS can add room for overlaid chrome and
    // safe areas; fit calculations read the computed padding back.
    this.pagesEl.style.setProperty("--pdf-pad", `${this.padding}px`);
    this.pagesEl.style.setProperty("--pdf-gap", `${this.gap}px`);
    for (let i = 0; i < this.numPages; i++) {
      const el = document.createElement("div");
      el.className = "pdf-page";
      el.dataset.page = String(i + 1);
      el.setAttribute("role", "region");
      el.setAttribute("aria-label", `Page ${i + 1}`);
      const marksEl = document.createElement("div");
      marksEl.className = "pdf-marks";
      const hitsEl = document.createElement("div");
      hitsEl.className = "pdf-hits";
      const textEl = document.createElement("div");
      textEl.className = "textLayer pdf-text-layer";
      el.appendChild(marksEl);
      el.appendChild(hitsEl);
      el.appendChild(textEl);
      this.pagesEl.appendChild(el);
      this.pages.push({
        n: i + 1,
        el,
        textEl,
        marksEl,
        hitsEl,
        canvas: null,
        w: sizes[i]?.w ?? sizes[0].w,
        h: sizes[i]?.h ?? sizes[0].h,
        renderedScale: 0,
        task: null,
        textLayer: null,
        textReady: null,
      });
    }
    scroller.appendChild(this.pagesEl);

    this.lazyObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const n = Number((entry.target as HTMLElement).dataset.page);
          if (entry.isIntersecting) this.visible.add(n);
          else this.visible.delete(n);
        }
        this.scheduleRender(0);
      },
      { root: scroller, rootMargin: "120% 40%" },
    );
    for (const p of this.pages) this.lazyObserver.observe(p.el);

    this.resizeObserver = new ResizeObserver(() => {
      const { clientWidth: w, clientHeight: h } = scroller;
      if (!w || !h) return;
      if (Math.abs(w - this.lastWidth) < 2 && Math.abs(h - this.lastHeight) < 2)
        return;
      this.lastWidth = w;
      this.lastHeight = h;
      if (this.mode !== "custom") {
        const box = scroller.getBoundingClientRect();
        this.setScale(
          this.fitScale(this.mode),
          this.anchorAt({ x: box.left + w / 2, y: box.top + 1 }),
          this.mode,
        );
      }
    });
    this.resizeObserver.observe(scroller);

    this.listen(scroller, "scroll", () => this.onScroll(), { passive: true });
    this.listen(document, "selectionchange", () => this.onSelectionChange());
    // Like pdf.js' viewer: while dragging a selection, stretch the layer's
    // end-of-content node so the selection doesn't jump to the page end.
    this.listen(scroller, "pointerdown", (e) => {
      const layer = (e.target as Element | null)?.closest?.(".textLayer");
      layer?.classList.add("selecting");
    });
    this.listen(document, "pointerup", () => {
      this.pagesEl
        .querySelectorAll(".textLayer.selecting")
        .forEach((el) => el.classList.remove("selecting"));
    });
    this.listen(scroller, "pointerup", () => this.onSelectionChange(30));
    this.listen(scroller, "wheel", (e) => this.onWheel(e as WheelEvent), {
      passive: false,
    });
    this.listen(
      scroller,
      "touchstart",
      (e) => this.onTouchStart(e as TouchEvent),
      {
        passive: false,
      },
    );
    this.listen(
      scroller,
      "touchmove",
      (e) => this.onTouchMove(e as TouchEvent),
      {
        passive: false,
      },
    );
    this.listen(scroller, "touchend", (e) => this.onTouchEnd(e as TouchEvent));
    this.listen(scroller, "touchcancel", (e) =>
      this.onTouchEnd(e as TouchEvent),
    );
    // Desktop Safari trackpad pinch arrives as proprietary gesture events.
    this.listen(scroller, "gesturestart", (e) => this.onGesture(e, "start"), {
      passive: false,
    });
    this.listen(scroller, "gesturechange", (e) => this.onGesture(e, "change"), {
      passive: false,
    });
    this.listen(scroller, "gestureend", (e) => this.onGesture(e, "end"), {
      passive: false,
    });

    this.lastWidth = scroller.clientWidth;
    this.lastHeight = scroller.clientHeight;
    const startScale =
      this.mode === "custom" ? 1 : this.fitScale(this.mode as "width" | "page");
    this.applyScale(startScale);
    const start = Math.min(Math.max(1, opts.initialPage || 1), this.numPages);
    if (start > 1) this.goToPage(start, false);
    this.currentPage = start;
    this.events.onZoom?.(this.scale, this.mode);
    this.events.onPage?.(this.currentPage, this.numPages);
  }

  static async open(
    lib: PdfjsLib,
    data: ArrayBuffer | Uint8Array,
    scroller: HTMLElement,
    events: EngineEvents = {},
    opts: EngineOptions = {},
  ): Promise<PdfEngine> {
    const doc = await lib.getDocument({ data }).promise;
    const sizes: Array<{ w: number; h: number }> = [];
    // Page sizes are cheap to read (no rendering) and let every page shell be
    // laid out at its true size up front, so the scroll position never jumps.
    const BATCH = 40;
    for (let start = 1; start <= doc.numPages; start += BATCH) {
      const batch = await Promise.all(
        Array.from(
          { length: Math.min(BATCH, doc.numPages - start + 1) },
          (_, i) => doc.getPage(start + i),
        ),
      );
      for (const page of batch) {
        const vp = page.getViewport({ scale: 1 });
        sizes.push({ w: vp.width, h: vp.height });
      }
    }
    return new PdfEngine(lib, doc, scroller, events, sizes, opts);
  }

  // ---------------------------------------------------------------- zoom

  private fitScale(mode: "width" | "page") {
    const cs = getComputedStyle(this.pagesEl);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    // Hosts may cap the fitted page width (e.g. full screen on a wide
    // monitor) via --pdf-max-fit for a comfortable line length.
    const maxFit = parseFloat(cs.getPropertyValue("--pdf-max-fit")) || Infinity;
    const availW = Math.max(
      120,
      Math.min(
        maxFit,
        this.scroller.clientWidth -
          (Number.isFinite(padX) ? padX : this.padding * 2),
      ),
    );
    const availH = Math.max(
      120,
      this.scroller.clientHeight -
        (Number.isFinite(padY) ? padY : this.padding * 2),
    );
    const ref = this.pages[this.currentPage - 1] ?? this.pages[0];
    const maxW = Math.max(...this.pages.map((p) => p.w));
    const byWidth = availW / maxW;
    const s = mode === "width" ? byWidth : Math.min(byWidth, availH / ref.h);
    return clamp(s, MIN_SCALE, MAX_SCALE);
  }

  fit(mode: "width" | "page") {
    this.mode = mode;
    const anchor = mode === "page" ? this.pageTopAnchor() : this.anchorAt(null);
    this.setScale(this.fitScale(mode), anchor, mode);
  }

  zoomIn() {
    const next = ZOOM_STEPS.find((s) => s > this.scale + 0.001) ?? MAX_SCALE;
    this.setScale(next, this.anchorAt(null), "custom");
  }

  zoomOut() {
    const prev =
      [...ZOOM_STEPS].reverse().find((s) => s < this.scale - 0.001) ??
      MIN_SCALE;
    this.setScale(prev, this.anchorAt(null), "custom");
  }

  /** Set an absolute zoom (1 = 100% of the PDF's point size). */
  zoomTo(scale: number) {
    this.setScale(scale, this.anchorAt(null), "custom");
  }

  private setScale(scale: number, anchor: ScrollAnchor | null, mode: FitMode) {
    scale = clamp(scale, MIN_SCALE, MAX_SCALE);
    this.mode = mode;
    if (Math.abs(scale - this.scale) < 0.0005) {
      this.events.onZoom?.(this.scale, this.mode);
      return;
    }
    this.applyScale(scale);
    if (anchor) this.restoreAnchor(anchor);
    this.events.onZoom?.(this.scale, this.mode);
    this.scheduleRender(140);
  }

  private applyScale(scale: number) {
    this.scale = scale;
    this.pagesEl.style.setProperty("--total-scale-factor", String(scale));
    this.pagesEl.style.setProperty("--scale-factor", String(scale));
    for (const p of this.pages) {
      p.el.style.width = `${Math.floor(p.w * scale)}px`;
      p.el.style.height = `${Math.floor(p.h * scale)}px`;
    }
  }

  // Scroll anchors keep the same document point under a focal point (viewport
  // centre, pinch midpoint, or cursor) across a zoom change.
  private anchorAt(client: { x: number; y: number } | null): ScrollAnchor {
    const box = this.scroller.getBoundingClientRect();
    const ox = client ? client.x - box.left : this.scroller.clientWidth / 2;
    const oy = client ? client.y - box.top : this.scroller.clientHeight / 2;
    const y = this.scroller.scrollTop + oy;
    const x = this.scroller.scrollLeft + ox;
    let index = this.pages.length - 1;
    for (let i = 0; i < this.pages.length; i++) {
      const el = this.pages[i].el;
      if (el.offsetTop + el.offsetHeight + this.gap >= y) {
        index = i;
        break;
      }
    }
    const el = this.pages[index].el;
    return {
      index,
      fx: (x - el.offsetLeft) / Math.max(1, el.offsetWidth),
      fy: (y - el.offsetTop) / Math.max(1, el.offsetHeight),
      ox,
      oy,
    };
  }

  private pageTopAnchor(): ScrollAnchor {
    return {
      index: this.currentPage - 1,
      fx: 0.5,
      fy: 0,
      ox: this.scroller.clientWidth / 2,
      oy: this.padding,
    };
  }

  private restoreAnchor(a: ScrollAnchor) {
    const el = this.pages[a.index]?.el;
    if (!el) return;
    this.scroller.scrollTop = el.offsetTop + a.fy * el.offsetHeight - a.oy;
    this.scroller.scrollLeft = el.offsetLeft + a.fx * el.offsetWidth - a.ox;
  }

  private onWheel(e: WheelEvent) {
    // Trackpad pinch (Chrome/Firefox/Edge) and ctrl+wheel arrive with ctrlKey.
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const factor = Math.exp(-clamp(e.deltaY, -60, 60) * 0.01);
    this.setScale(
      this.scale * factor,
      this.anchorAt({ x: e.clientX, y: e.clientY }),
      "custom",
    );
  }

  private onTouchStart(e: TouchEvent) {
    if (e.touches.length !== 2) return;
    const [a, b] = [e.touches[0], e.touches[1]];
    const mx = (a.clientX + b.clientX) / 2;
    const my = (a.clientY + b.clientY) / 2;
    this.pinch = {
      d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1,
      startScale: this.scale,
      anchor: this.anchorAt({ x: mx, y: my }),
      ratio: 1,
      mx,
      my,
    };
    const rect = this.pagesEl.getBoundingClientRect();
    this.pagesEl.style.transformOrigin = `${mx - rect.left}px ${my - rect.top}px`;
    this.pagesEl.classList.add("pinching");
  }

  private onTouchMove(e: TouchEvent) {
    if (!this.pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const [a, b] = [e.touches[0], e.touches[1]];
    const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const target = clamp(
      this.pinch.startScale * (d / this.pinch.d0),
      MIN_SCALE,
      MAX_SCALE,
    );
    this.pinch.ratio = target / this.pinch.startScale;
    this.pagesEl.style.transform = `scale(${this.pinch.ratio})`;
  }

  private onTouchEnd(e: TouchEvent) {
    if (!this.pinch || e.touches.length >= 2) return;
    const { startScale, ratio, anchor } = this.pinch;
    this.pinch = null;
    this.pagesEl.style.transform = "";
    this.pagesEl.classList.remove("pinching");
    if (Math.abs(ratio - 1) > 0.01)
      this.setScale(startScale * ratio, anchor, "custom");
  }

  private onGesture(e: Event, phase: "start" | "change" | "end") {
    e.preventDefault();
    if (this.pinch) return; // touch pinch (iOS) already handles it
    const g = e as Event & { scale: number; clientX: number; clientY: number };
    if (phase === "start") {
      this.gesture = {
        startScale: this.scale,
        anchor: this.anchorAt({ x: g.clientX, y: g.clientY }),
        ratio: 1,
        x: g.clientX,
        y: g.clientY,
      };
      return;
    }
    if (!this.gesture) return;
    this.gesture.ratio = g.scale || 1;
    const scale = this.gesture.startScale * this.gesture.ratio;
    this.setScale(scale, { ...this.gesture.anchor }, "custom");
    if (phase === "end") this.gesture = null;
  }

  // ------------------------------------------------------------ navigation

  goToPage(n: number, smooth = false, offsetFraction = 0) {
    const p = this.pages[clamp(Math.round(n), 1, this.numPages) - 1];
    if (!p) return;
    const top =
      p.el.offsetTop + offsetFraction * p.el.offsetHeight - this.gap / 2;
    this.scroller.scrollTo({
      top: Math.max(0, top),
      behavior: smooth && !prefersReducedMotion() ? "smooth" : "auto",
    });
  }

  nextPage() {
    this.goToPage(this.currentPage + 1, true);
  }

  prevPage() {
    // From mid-page, "previous" first returns to the top of the current page.
    const p = this.pages[this.currentPage - 1];
    const intoPage = this.scroller.scrollTop - (p.el.offsetTop - this.gap / 2);
    if (intoPage > 24) this.goToPage(this.currentPage, true);
    else this.goToPage(this.currentPage - 1, true);
  }

  /** Scroll by most of a screen, like Space / Shift+Space. */
  scrollScreen(direction: 1 | -1) {
    this.scroller.scrollBy({
      top: direction * this.scroller.clientHeight * 0.88,
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }

  private onScroll() {
    if (this.scrollRaf) return;
    this.scrollRaf = requestAnimationFrame(() => {
      this.scrollRaf = 0;
      const probe = this.scroller.scrollTop + this.scroller.clientHeight * 0.35;
      let page = this.numPages;
      for (const p of this.pages) {
        if (p.el.offsetTop + p.el.offsetHeight + this.gap / 2 > probe) {
          page = p.n;
          break;
        }
      }
      if (
        this.scroller.scrollTop + this.scroller.clientHeight >=
        this.scroller.scrollHeight - 4
      )
        page = this.numPages;
      if (page !== this.currentPage) {
        this.currentPage = page;
        this.events.onPage?.(page, this.numPages);
      }
    });
  }

  // ------------------------------------------------------------- rendering

  private scheduleRender(delay: number) {
    clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => this.renderVisible(), delay);
  }

  private async renderVisible() {
    if (this.destroyed) return;
    // Nearest-to-current first so the page being read sharpens first.
    const order = [...this.visible].sort(
      (a, b) => Math.abs(a - this.currentPage) - Math.abs(b - this.currentPage),
    );
    for (const n of order) {
      if (this.destroyed) return;
      await this.renderPage(this.pages[n - 1]);
    }
    this.releaseFarCanvases();
  }

  private getPage(n: number) {
    let page = this.pageCache.get(n);
    if (!page) {
      page = this.doc.getPage(n);
      this.pageCache.set(n, page);
    }
    return page;
  }

  private async renderPage(p: PageState) {
    if (p.renderedScale === this.scale && p.canvas) return;
    p.task?.cancel();
    const scale = this.scale;
    const page = await this.getPage(p.n);
    if (this.destroyed || scale !== this.scale) return;
    const viewport = page.getViewport({ scale });
    const dpr = window.devicePixelRatio || 1;
    const pixels = viewport.width * viewport.height;
    const outputScale = Math.min(dpr, Math.sqrt(MAX_CANVAS_PIXELS / pixels));
    // Render into a fresh canvas and swap on completion, so a zoom change
    // shows the stretched previous bitmap instead of flashing blank.
    const canvas = document.createElement("canvas");
    canvas.className = "pdf-canvas";
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.setAttribute("aria-hidden", "true");
    const task = page.render({
      canvas,
      viewport,
      transform:
        outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
    });
    p.task = task;
    try {
      await task.promise;
    } catch {
      return; // cancelled by a newer zoom, or a page-level render error
    } finally {
      if (p.task === task) p.task = null;
    }
    if (this.destroyed || scale !== this.scale) return;
    if (p.canvas) p.canvas.replaceWith(canvas);
    else p.el.insertBefore(canvas, p.el.firstChild);
    releaseCanvas(p.canvas);
    p.canvas = canvas;
    p.renderedScale = scale;
    p.el.classList.add("rendered");
    this.ensureTextLayer(p, viewport);
  }

  private ensureTextLayer(p: PageState, viewport: PageViewport) {
    if (p.textLayer) {
      p.textLayer.update({ viewport });
      return;
    }
    p.textReady = (async () => {
      try {
        const content = await this.getTextItems(p.n);
        if (this.destroyed || p.textLayer) return;
        const layer = new this.lib.TextLayer({
          textContentSource: content,
          container: p.textEl,
          viewport,
        });
        p.textLayer = layer;
        await layer.render();
        const end = document.createElement("div");
        end.className = "endOfContent";
        p.textEl.appendChild(end);
        if (this.findQuery) this.paintHits(p.n);
      } catch {
        // Scanned pages simply have no selectable text.
      }
    })();
  }

  private releaseFarCanvases() {
    const live = this.pages.filter((p) => p.canvas);
    if (live.length <= this.maxLive) return;
    live
      .filter((p) => !this.visible.has(p.n))
      .sort(
        (a, b) =>
          Math.abs(b.n - this.currentPage) - Math.abs(a.n - this.currentPage),
      )
      .slice(0, live.length - this.maxLive)
      .forEach((p) => {
        p.task?.cancel();
        releaseCanvas(p.canvas);
        p.canvas?.remove();
        p.canvas = null;
        p.renderedScale = 0;
        p.el.classList.remove("rendered");
      });
  }

  /** Render a small preview of page `n` into `canvas` at `cssWidth` px wide. */
  async renderThumbnail(
    n: number,
    canvas: HTMLCanvasElement,
    cssWidth: number,
  ) {
    const page = await this.getPage(n);
    if (this.destroyed) return;
    const base = page.getViewport({ scale: 1 });
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const viewport = page.getViewport({ scale: (cssWidth / base.width) * dpr });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    try {
      await page.render({ canvas, viewport }).promise;
    } catch {
      // thumbnails are decorative
    }
  }

  pageAspect(n: number) {
    const p = this.pages[n - 1];
    return p ? p.h / p.w : 1.294;
  }

  async getOutline(): Promise<OutlineEntry[]> {
    const outline = await this.doc.getOutline().catch(() => null);
    if (!outline?.length) return [];
    const out: OutlineEntry[] = [];
    const walk = async (
      items: Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>,
      depth: number,
    ) => {
      for (const item of items) {
        out.push({
          title: item.title?.trim() || "Untitled",
          page: await this.resolveDest(item.dest),
          depth,
        });
        if (item.items?.length && depth < 4) await walk(item.items, depth + 1);
      }
    };
    await walk(outline, 0);
    return out;
  }

  private async resolveDest(dest: unknown): Promise<number | null> {
    try {
      let explicit = dest;
      if (typeof dest === "string")
        explicit = await this.doc.getDestination(dest);
      if (!Array.isArray(explicit) || explicit.length === 0) return null;
      const ref = explicit[0];
      if (typeof ref === "number") return ref + 1;
      if (ref && typeof ref === "object")
        return (await this.doc.getPageIndex(ref as never)) + 1;
    } catch {
      // unresolvable destination: shown without a page
    }
    return null;
  }

  // ------------------------------------------------------------------ text

  private getTextItems(n: number) {
    let items = this.textItemsCache.get(n);
    if (!items) {
      items = this.getPage(n).then((page) => page.getTextContent());
      this.textItemsCache.set(n, items);
    }
    return items;
  }

  private getTextIndex(n: number): Promise<TextIndex> {
    let index = this.textCache.get(n);
    if (!index) {
      index = this.getTextItems(n).then((content) => {
        let raw = "";
        const segs: Array<[number, number]> = [];
        for (const item of content.items) {
          if (!("str" in item)) continue;
          const start = raw.length;
          raw += item.str;
          segs.push([start, raw.length]);
          if (item.hasEOL) raw += " ";
        }
        let norm = "";
        const normToRaw: number[] = [];
        let prevSpace = true;
        for (let i = 0; i < raw.length; i++) {
          const ch = raw[i];
          if (/\s/.test(ch)) {
            if (prevSpace) continue;
            prevSpace = true;
            norm += " ";
          } else {
            prevSpace = false;
            norm += ch.toLowerCase();
          }
          normToRaw.push(i);
        }
        return { raw, segs, norm, normToRaw };
      });
      this.textCache.set(n, index);
    }
    return index;
  }

  private rangeFor(p: PageState, idx: TextIndex, start: number, end: number) {
    const divs = p.textLayer?.textDivs;
    if (!divs?.length) return null;
    const locate = (pos: number, isEnd: boolean) => {
      for (let i = 0; i < idx.segs.length; i++) {
        const [s, e] = idx.segs[i];
        if (pos < s) {
          // Position fell in a separator; snap to the adjacent item.
          if (isEnd && i > 0)
            return { i: i - 1, off: idx.segs[i - 1][1] - idx.segs[i - 1][0] };
          return { i, off: 0 };
        }
        if (pos < e || (isEnd && pos === e)) return { i, off: pos - s };
      }
      const last = idx.segs.length - 1;
      return { i: last, off: idx.segs[last][1] - idx.segs[last][0] };
    };
    const a = locate(start, false);
    const b = locate(end, true);
    const na = divs[a.i]?.firstChild;
    const nb = divs[b.i]?.firstChild;
    if (!na || !nb) return null;
    const range = document.createRange();
    try {
      range.setStart(na, Math.min(a.off, na.textContent?.length ?? 0));
      range.setEnd(nb, Math.min(b.off, nb.textContent?.length ?? 0));
    } catch {
      return null;
    }
    return range;
  }

  private rectsIn(p: PageState, rects: Iterable<DOMRect>): MarkRect[] {
    const box = p.el.getBoundingClientRect();
    if (!box.width || !box.height) return [];
    const out: MarkRect[] = [];
    for (const r of rects) {
      if (r.width < 1 || r.height < 1) continue;
      const left = Math.max(r.left, box.left);
      const right = Math.min(r.right, box.right);
      const top = Math.max(r.top, box.top);
      const bottom = Math.min(r.bottom, box.bottom);
      if (right - left < 1 || bottom - top < 1) continue;
      out.push([
        (left - box.left) / box.width,
        (top - box.top) / box.height,
        (right - left) / box.width,
        (bottom - top) / box.height,
      ]);
    }
    return mergeRects(out);
  }

  // ------------------------------------------------------------- selection

  private onSelectionChange(delay = 140) {
    clearTimeout(this.selTimer);
    this.selTimer = setTimeout(() => this.readSelection(), delay);
  }

  private readSelection() {
    if (this.destroyed) return;
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      this.events.onSelection?.(null);
      return;
    }
    const range = sel.getRangeAt(0);
    const startEl =
      range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
    const pageEl = startEl?.closest<HTMLElement>(".pdf-page");
    if (!pageEl || !this.pagesEl.contains(pageEl)) {
      this.events.onSelection?.(null);
      return;
    }
    const text = sel.toString().replace(/\s+/g, " ").trim();
    if (!text) {
      this.events.onSelection?.(null);
      return;
    }
    const p = this.pages[Number(pageEl.dataset.page) - 1];
    const clientRects = [...range.getClientRects()];
    const rects = this.rectsIn(p, clientRects);
    if (!rects.length) {
      this.events.onSelection?.(null);
      return;
    }
    const pageBox = p.el.getBoundingClientRect();
    const inPage = clientRects.filter(
      (r) => r.width > 0 && r.bottom > pageBox.top && r.top < pageBox.bottom,
    );
    const box = {
      left: Math.min(...inPage.map((r) => r.left)),
      top: Math.min(...inPage.map((r) => r.top)),
      right: Math.max(...inPage.map((r) => r.right)),
      bottom: Math.max(...inPage.map((r) => r.bottom)),
    };
    this.events.onSelection?.({
      page: p.n,
      text: text.slice(0, 2000),
      rects,
      box,
    });
  }

  clearSelection() {
    document.getSelection()?.removeAllRanges();
    this.events.onSelection?.(null);
  }

  // ----------------------------------------------------------------- marks

  setMarks(marks: PdfMark[]) {
    this.marks = marks;
    for (const p of this.pages) p.marksEl.replaceChildren();
    for (const mark of marks) {
      const p = this.pages[mark.page - 1];
      if (!p) continue;
      for (const [x, y, w, h] of mark.rects) {
        const el = document.createElement("div");
        el.className = `pdf-mark ${mark.tone === "thought" ? "is-thought" : "is-highlight"}`;
        el.dataset.mark = mark.id;
        place(el, x, y, w, h);
        p.marksEl.appendChild(el);
      }
    }
  }

  /** Scroll to a stored mark's first rect (falls back to the page top). */
  revealMark(id: string) {
    const mark = this.marks.find((m) => m.id === id);
    if (!mark) return false;
    const first = mark.rects[0];
    this.revealFraction(mark.page, first ? first[1] : 0);
    const els = this.pages[mark.page - 1]?.marksEl.querySelectorAll(
      `[data-mark="${CSS.escape(id)}"]`,
    );
    els?.forEach((el) => {
      el.classList.remove("flash");
      void (el as HTMLElement).offsetWidth;
      el.classList.add("flash");
    });
    return true;
  }

  private revealFraction(page: number, fy: number) {
    const p = this.pages[page - 1];
    if (!p) return;
    const target =
      p.el.offsetTop +
      fy * p.el.offsetHeight -
      this.scroller.clientHeight * 0.3;
    this.scroller.scrollTo({
      top: Math.max(0, target),
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }

  // ------------------------------------------------------------------ find

  async find(query: string, direction: 1 | -1 = 1) {
    const q = query.replace(/\s+/g, " ").trim().toLowerCase();
    if (!q) {
      this.clearFind();
      return;
    }
    if (q === this.findQuery && this.hits.length) {
      this.stepHit(direction);
      return;
    }
    const seq = ++this.findSeq;
    this.findQuery = q;
    this.hits = [];
    this.hitIndex = -1;
    this.emitFind(true);
    for (let n = 1; n <= this.numPages; n++) {
      const idx = await this.getTextIndex(n);
      if (seq !== this.findSeq || this.destroyed) return;
      let from = 0;
      for (;;) {
        const at = idx.norm.indexOf(q, from);
        if (at < 0) break;
        const start = idx.normToRaw[at];
        const end = idx.normToRaw[at + q.length - 1] + 1;
        this.hits.push({ page: n, start, end });
        from = at + Math.max(1, q.length);
      }
      // Focus the first hit at/after the reading position as soon as it exists.
      if (this.hitIndex < 0 && this.hits.length && n >= this.currentPage) {
        this.hitIndex = this.hits.findIndex((h) => h.page >= this.currentPage);
        this.focusHit();
      }
      if (n % 25 === 0) this.emitFind(true);
    }
    if (this.hitIndex < 0 && this.hits.length) {
      this.hitIndex = 0;
      this.focusHit();
    }
    for (const p of this.pages) this.paintHits(p.n);
    this.emitFind(false);
  }

  findNext() {
    this.stepHit(1);
  }

  findPrev() {
    this.stepHit(-1);
  }

  private stepHit(direction: 1 | -1) {
    if (!this.hits.length) return;
    this.hitIndex =
      (this.hitIndex + direction + this.hits.length) % this.hits.length;
    this.focusHit();
    this.emitFind(false);
  }

  clearFind() {
    this.findSeq++;
    this.findQuery = "";
    this.hits = [];
    this.hitIndex = -1;
    for (const p of this.pages) p.hitsEl.replaceChildren();
    this.emitFind(false);
  }

  private emitFind(pending: boolean) {
    this.events.onFind?.({
      query: this.findQuery,
      total: this.hits.length,
      current: this.hitIndex + 1,
      pending,
    });
  }

  private async focusHit() {
    const hit = this.hits[this.hitIndex];
    if (!hit) return;
    const p = this.pages[hit.page - 1];
    // Bring the page near first so its text layer renders, then refine.
    if (!p.textLayer) {
      this.goToPage(hit.page, false);
      this.visible.add(hit.page);
      await this.renderPage(p);
      await p.textReady;
    }
    this.paintHits(hit.page);
    const current = p.hitsEl.querySelector<HTMLElement>(".pdf-hit.current");
    const fy = current ? parseFloat(current.style.top) / 100 : 0;
    this.revealFraction(hit.page, fy);
    // Repaint the previously focused page so only one hit is "current".
    for (const other of this.pages)
      if (other.n !== hit.page && other.hitsEl.querySelector(".current"))
        this.paintHits(other.n);
  }

  private async paintHits(n: number) {
    const p = this.pages[n - 1];
    p.hitsEl.replaceChildren();
    if (!this.findQuery || !p.textLayer) return;
    const pageHits = this.hits
      .map((h, i) => ({ ...h, i }))
      .filter((h) => h.page === n);
    if (!pageHits.length) return;
    const idx = await this.getTextIndex(n);
    for (const hit of pageHits) {
      const range = this.rangeFor(p, idx, hit.start, hit.end);
      if (!range) continue;
      for (const [x, y, w, h] of this.rectsIn(p, range.getClientRects())) {
        const el = document.createElement("div");
        el.className = `pdf-hit${hit.i === this.hitIndex ? " current" : ""}`;
        place(el, x, y, w, h);
        p.hitsEl.appendChild(el);
      }
    }
  }

  // --------------------------------------------------------------- cleanup

  private listen(
    target: EventTarget,
    type: string,
    handler: (e: Event) => void,
    opts?: AddEventListenerOptions,
  ) {
    target.addEventListener(type, handler, opts);
    this.cleanup.push(() => target.removeEventListener(type, handler, opts));
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.renderTimer);
    clearTimeout(this.selTimer);
    cancelAnimationFrame(this.scrollRaf);
    this.lazyObserver.disconnect();
    this.resizeObserver.disconnect();
    this.cleanup.forEach((fn) => fn());
    for (const p of this.pages) {
      p.task?.cancel();
      p.textLayer?.cancel();
      releaseCanvas(p.canvas);
    }
    this.pagesEl.remove();
    this.doc.loadingTask.destroy().catch(() => {});
  }
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

function prefersReducedMotion() {
  return (
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function releaseCanvas(canvas: HTMLCanvasElement | null) {
  // Shrinking to zero frees the backing store immediately (notably on iOS).
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

function place(el: HTMLElement, x: number, y: number, w: number, h: number) {
  el.style.left = `${(x * 100).toFixed(3)}%`;
  el.style.top = `${(y * 100).toFixed(3)}%`;
  el.style.width = `${(w * 100).toFixed(3)}%`;
  el.style.height = `${(h * 100).toFixed(3)}%`;
}

/** Merge rects on the same line that touch/overlap; round to 4 decimals. */
export function mergeRects(rects: MarkRect[]): MarkRect[] {
  const sorted = [...rects].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const out: MarkRect[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last) {
      const sameLine =
        Math.abs(last[1] - r[1]) < Math.min(last[3], r[3]) * 0.5 &&
        Math.abs(last[3] - r[3]) < Math.max(last[3], r[3]) * 0.6;
      const touches = r[0] <= last[0] + last[2] + 0.012;
      if (sameLine && touches) {
        const left = Math.min(last[0], r[0]);
        const top = Math.min(last[1], r[1]);
        const right = Math.max(last[0] + last[2], r[0] + r[2]);
        const bottom = Math.max(last[1] + last[3], r[1] + r[3]);
        out[out.length - 1] = [left, top, right - left, bottom - top];
        continue;
      }
      // Fully contained duplicates (nested spans) add nothing.
      if (
        r[0] >= last[0] &&
        r[1] >= last[1] &&
        r[0] + r[2] <= last[0] + last[2] &&
        r[1] + r[3] <= last[1] + last[3]
      )
        continue;
    }
    out.push(r);
  }
  return out
    .slice(0, 64)
    .map(
      (r) =>
        r.map((v) => Math.round(clamp(v, 0, 1) * 10000) / 10000) as MarkRect,
    );
}

/** Parse a note's stored anchor JSON into rects (empty when absent/invalid). */
export function parseAnchor(anchor: unknown): MarkRect[] {
  try {
    const value = typeof anchor === "string" ? JSON.parse(anchor) : anchor;
    const rects = (value as { rects?: unknown })?.rects;
    if (!Array.isArray(rects)) return [];
    return rects.filter(
      (r): r is MarkRect =>
        Array.isArray(r) &&
        r.length === 4 &&
        r.every((v) => typeof v === "number"),
    );
  } catch {
    return [];
  }
}
