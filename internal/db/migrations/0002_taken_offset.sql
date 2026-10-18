-- Zone offset of DateTimeOriginal in minutes, from OffsetTimeOriginal.
-- NULL when the camera wrote no valid offset; taken_at keeps its meaning.
ALTER TABLE photo_exif ADD COLUMN taken_offset_min INTEGER NULL
    CHECK (taken_offset_min IS NULL OR taken_offset_min BETWEEN -840 AND 840);
