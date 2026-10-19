-- What a paper is about, classified from its full text in the browser
-- (src/paperTopics.ts): {"Domain/Field": share} with shares summing to ~100.
-- Stored on the paper, not per reader, since it describes the paper itself.
ALTER TABLE books ADD COLUMN topic_signals TEXT;
-- Paper topics widened from 6 to 11 domains; carry the old names over.
UPDATE books SET topic='Physics' WHERE topic='Physics & Math';
UPDATE books SET topic='Economics & Finance' WHERE topic='Economics';
