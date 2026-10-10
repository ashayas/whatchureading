-- Personal ratings are now relative: readers compare a newly finished book
-- against books they already ranked instead of picking a number. A 1-5
-- rating is derived from rank position once a reader has ranked enough books.
ALTER TABLE library DROP COLUMN rating;
ALTER TABLE library ADD COLUMN rank_position INTEGER;
CREATE UNIQUE INDEX library_reader_rank ON library(reader_id, rank_position) WHERE rank_position IS NOT NULL;
