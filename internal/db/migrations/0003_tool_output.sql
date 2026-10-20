-- Tool output photos (framed / collaged) and the archived photos they came from.
-- source_id is not a foreign key: deleting a source must not delete the derived photo.

ALTER TABLE photos ADD COLUMN tool_output INTEGER NOT NULL DEFAULT 0
    CHECK (tool_output IN (0, 1));

CREATE TABLE photo_sources (
    photo_id TEXT    NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    source_id TEXT    NOT NULL,
    position  INTEGER NOT NULL,
    PRIMARY KEY (photo_id, position)
) STRICT;
