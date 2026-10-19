-- Optional highlight anchoring for thoughts left from the PDF reader:
-- `quote` is the selected passage, `anchor` is JSON of page-relative rects
-- ({"v":1,"rects":[[x,y,w,h],...]}, each value a 0..1 fraction of the page).
ALTER TABLE notes ADD COLUMN quote TEXT;
ALTER TABLE notes ADD COLUMN anchor TEXT;
