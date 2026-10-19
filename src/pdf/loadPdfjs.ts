// Lazily imported so the (fairly large) pdf.js bundle only loads when a PDF is actually opened.
export async function loadPdfjs() {
  const pdfjsLib = await import("pdfjs-dist");
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url"))
    .default;
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
  return pdfjsLib;
}
