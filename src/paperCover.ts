import { loadPdfjs } from "./PdfReader";
import { api, apiUploadPdf } from "./types";
import { analyzePdf, type PaperAnalysis } from "./paperTopics";

// A paper's cover is a snapshot of its own first page, rendered here with
// pdf.js (the Worker never parses PDFs) and stored next to the upload in R2.
const COVER_WIDTH = 600;

async function renderFirstPage(data: ArrayBuffer): Promise<Blob> {
  const pdfjsLib = await loadPdfjs();
  const task = pdfjsLib.getDocument({ data });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: COVER_WIDTH / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Snapshot failed"))), "image/jpeg", 0.82),
    );
  } finally {
    void task.destroy();
  }
}

export async function uploadPaperCover(bookId: string, pdf: Blob): Promise<void> {
  const snapshot = await renderFirstPage(await pdf.arrayBuffer());
  await apiUploadPdf(`uploads/${bookId}/cover`, "PUT", snapshot);
}

export async function savePaperTopics(bookId: string, analysis: PaperAnalysis): Promise<void> {
  if (!Object.keys(analysis.signals).length) return;
  await api(`uploads/${bookId}/topics`, "PUT", { signals: analysis.signals });
}

// Papers uploaded before snapshots and full-text classification existed (or
// from the mobile app, which can't render PDFs natively) get both the next
// time their owner views their papers. One download serves both.
export async function backfillPapers(
  papers: { id: string; cover_key?: string | null; topic_signals?: string | null }[],
): Promise<boolean> {
  let changed = false;
  for (const paper of papers) {
    const needsCover = !paper.cover_key;
    const needsTopics = !paper.topic_signals;
    if (!needsCover && !needsTopics) continue;
    try {
      const pdf = await apiUploadPdf(`uploads/${paper.id}/content`, "GET");
      if (needsCover) await uploadPaperCover(paper.id, pdf);
      if (needsTopics) await savePaperTopics(paper.id, await analyzePdf(await pdf.arrayBuffer()));
      changed = true;
    } catch {
      // Best-effort: retried on a later visit.
    }
  }
  return changed;
}
