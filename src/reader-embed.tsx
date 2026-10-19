// The paper reader, hosted inside the mobile app's WebView (reader.html).
// It never authenticates: the native app fetches the PDF and notes with its
// own session and talks to this page over a small postMessage bridge.
//
//   native → web  {type:"open", book, page, notes, pdf /* base64 */}
//                 {type:"notes", notes}
//                 {type:"noteResult", reqId, ok}
//   web → native  {type:"ready", version}
//                 {type:"page", page}
//                 {type:"createNote", reqId, note}
//                 {type:"chrome", visible}
//                 {type:"close"}
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  PaperReader,
  type CreateNoteInput,
  type ReaderNote,
} from "./pdf/PaperReader";
import "./styles.css";

const BRIDGE_VERSION = 1;

interface OpenMessage {
  type: "open";
  book: { id: string; title: string; author?: string; pages: number };
  page?: number;
  notes?: ReaderNote[];
  pdf: string;
}
type Inbound =
  | OpenMessage
  | { type: "notes"; notes: ReaderNote[] }
  | { type: "noteResult"; reqId: number; ok: boolean };

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (msg: string) => void };
    /** Messages sent to the host; inspectable when testing in a browser. */
    __readerOutbox?: unknown[];
  }
}

function post(msg: Record<string, unknown>) {
  (window.__readerOutbox ??= []).push(msg);
  window.ReactNativeWebView?.postMessage(JSON.stringify(msg));
}

function base64ToBytes(b64: string) {
  const clean = b64.replace(/^data:[^,]*,/, "");
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function EmbedApp() {
  const [doc, setDoc] = useState<OpenMessage | null>(null);
  const [notes, setNotes] = useState<ReaderNote[]>([]);
  const [page, setPage] = useState(1);
  const pending = useRef(new Map<number, (ok: boolean) => void>());
  const nextId = useRef(1);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      let msg: Inbound;
      try {
        msg =
          typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "open") {
        setDoc(msg);
        setNotes(msg.notes ?? []);
        setPage(Math.max(1, msg.page ?? 1));
      } else if (msg.type === "notes") setNotes(msg.notes ?? []);
      else if (msg.type === "noteResult") {
        pending.current.get(msg.reqId)?.(!!msg.ok);
        pending.current.delete(msg.reqId);
      }
    };
    // iOS delivers to window, Android's WebView to document.
    window.addEventListener("message", onMessage);
    document.addEventListener("message", onMessage as EventListener);
    post({ type: "ready", version: BRIDGE_VERSION });
    return () => {
      window.removeEventListener("message", onMessage);
      document.removeEventListener("message", onMessage as EventListener);
    };
  }, []);

  const loadPdf = useCallback(async () => {
    if (!doc) throw new Error("No document");
    return base64ToBytes(doc.pdf);
  }, [doc]);

  const onCreateNote = (note: CreateNoteInput) =>
    new Promise<boolean>((resolve) => {
      const reqId = nextId.current++;
      pending.current.set(reqId, resolve);
      post({ type: "createNote", reqId, note });
      setTimeout(() => {
        if (pending.current.delete(reqId)) resolve(false);
      }, 20000);
    });

  const onChromeChange = useCallback(
    (visible: boolean) => post({ type: "chrome", visible }),
    [],
  );

  if (!doc) return <div className="reader-embed-wait" aria-busy="true" />;
  return (
    <PaperReader
      embedded
      docKey={doc.book.id}
      title={doc.book.title}
      author={doc.book.author}
      pageCount={doc.book.pages}
      loadPdf={loadPdf}
      page={page}
      onPageChange={(n) => {
        setPage(n);
        post({ type: "page", page: n });
      }}
      notes={notes}
      onCreateNote={onCreateNote}
      onClose={() => post({ type: "close" })}
      onChromeChange={onChromeChange}
    />
  );
}

// No StrictMode: its double effects would announce "ready" twice and make the
// native side post the (large) PDF payload twice.
createRoot(document.getElementById("root")!).render(<EmbedApp />);
