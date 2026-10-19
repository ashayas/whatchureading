import { useCallback, useEffect, useRef } from "react";
import type { Book, Thought } from "./types";
import { apiUploadPdf } from "./types";
import {
  PaperReader,
  type CreateNoteInput,
  type NoteDraft,
} from "./pdf/PaperReader";

export { loadPdfjs } from "./pdf/loadPdfjs";
export type { NoteDraft } from "./pdf/PaperReader";

// The book modal's PDF reader: wires the shared PaperReader to the
// authenticated API (PDF bytes, notes, reading progress).
export function PdfReader({
  book,
  page,
  onPageChange,
  notes,
  mutate,
  onAddThought,
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
  onAddThought?: (draft: NoteDraft) => void;
}) {
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  // Paper topic signals are computed once from the full text elsewhere
  // (src/paperTopics.ts); progress saves deliberately send only the page.
  const latest = useRef(mutate);
  latest.current = mutate;

  useEffect(() => () => clearTimeout(saveTimer.current), [book.id]);

  const loadPdf = useCallback(
    async () =>
      (await apiUploadPdf(`uploads/${book.id}/content`, "GET")).arrayBuffer(),
    [book.id],
  );

  const handlePage = (n: number) => {
    onPageChange(n);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      latest.current(
        "library",
        "PUT",
        { book_id: book.id, status: "reading", page: n },
        undefined,
      );
    }, 2000);
  };

  const onCreateNote = (input: CreateNoteInput) =>
    mutate(
      "notes",
      "POST",
      { book_id: book.id, ...input },
      input.body === input.quote
        ? "Highlighted — saved to your private notes"
        : input.visibility === "private"
          ? "A private thought, just for you"
          : "A thought, saved between the pages",
    );

  return (
    <PaperReader
      docKey={book.id}
      title={book.title}
      author={book.author}
      pageCount={book.pages}
      loadPdf={loadPdf}
      page={page}
      onPageChange={handlePage}
      notes={notes}
      onCreateNote={onCreateNote}
      onAddThought={onAddThought}
    />
  );
}
