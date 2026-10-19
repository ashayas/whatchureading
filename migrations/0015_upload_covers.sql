-- First-page snapshot for uploaded papers, rendered client-side with pdf.js
-- and stored in R2 at this key. NULL means no snapshot yet (the UI shows a
-- typeset title page instead).
ALTER TABLE books ADD COLUMN cover_key TEXT;
