-- 0001_init: initial schema (spec §4). IDs are TEXT (UUIDv7), timestamps are
-- INTEGER Unix milliseconds, booleans are INTEGER 0/1, JSON is TEXT checked by
-- json_valid.

CREATE TABLE users (
    id         TEXT    NOT NULL PRIMARY KEY,
    email      TEXT    NOT NULL UNIQUE,
    password   TEXT    NOT NULL,
    created_at INTEGER NOT NULL
) STRICT;

-- user_id NULL = anonymous CSRF session.
CREATE TABLE sessions (
    hash       TEXT    NOT NULL PRIMARY KEY,
    user_id    TEXT    NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf       TEXT    NOT NULL,
    expires_at INTEGER NOT NULL,
    touched_at INTEGER NOT NULL
) STRICT;

CREATE TABLE pending_verifications (
    email      TEXT    NOT NULL PRIMARY KEY,
    hash       TEXT    NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL
) STRICT;

CREATE TABLE rate_limits (
    key        TEXT    NOT NULL PRIMARY KEY,
    count      INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL
) STRICT;

CREATE TABLE profiles (
    user_id     TEXT    NOT NULL PRIMARY KEY REFERENCES users(id),
    name        TEXT    NOT NULL DEFAULT '',
    bio         TEXT    NOT NULL DEFAULT '',
    wall_layout TEXT    NOT NULL DEFAULT 'salon' CHECK (wall_layout IN ('salon', 'grid')),
    updated_at  INTEGER NOT NULL
) STRICT;

CREATE TABLE upload_prefs (
    user_id                TEXT    NOT NULL PRIMARY KEY REFERENCES users(id),
    public_fields          TEXT    NOT NULL CHECK (json_valid(public_fields)),
    histogram_public       INTEGER NOT NULL DEFAULT 0 CHECK (histogram_public IN (0, 1)),
    original_download      INTEGER NOT NULL DEFAULT 0 CHECK (original_download IN (0, 1)),
    watermark              TEXT    NULL CHECK (watermark IS NULL OR json_valid(watermark)),
    default_license        TEXT    NULL CHECK (default_license IS NULL OR default_license IN ('by', 'by-sa', 'by-nd', 'by-nc', 'by-nc-sa', 'by-nc-nd')),
    default_ai_declaration TEXT    NULL CHECK (default_ai_declaration IS NULL OR default_ai_declaration IN ('no-generative-ai')),
    location_mode          TEXT    NOT NULL DEFAULT 'off' CHECK (location_mode IN ('off', 'archive')),
    updated_at             INTEGER NOT NULL
) STRICT;

CREATE TABLE photos (
    id                TEXT    NOT NULL PRIMARY KEY,
    owner_id          TEXT    NOT NULL REFERENCES users(id),
    status            TEXT    NOT NULL CHECK (status IN ('uploading', 'processing', 'ready', 'failed')),
    original_key      TEXT    NOT NULL,
    original_sha256   TEXT    NOT NULL,
    original_bytes    INTEGER NOT NULL,
    format            TEXT    NOT NULL,
    width             INTEGER NULL,  -- upright dimensions; known after processing
    height            INTEGER NULL,
    derived_hash      TEXT    NULL,
    derived_salt      TEXT    NOT NULL DEFAULT '',
    title             TEXT    NOT NULL DEFAULT '',
    caption           TEXT    NOT NULL DEFAULT '',
    public_fields     TEXT    NOT NULL CHECK (json_valid(public_fields)),
    histogram_public  INTEGER NOT NULL CHECK (histogram_public IN (0, 1)),
    original_download INTEGER NOT NULL CHECK (original_download IN (0, 1)),
    latitude          REAL    NULL,  -- only written when location_mode = 'archive'
    longitude         REAL    NULL,
    error             TEXT    NULL,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    UNIQUE (owner_id, original_sha256)
) STRICT;
CREATE INDEX photos_owner_created ON photos(owner_id, created_at);

CREATE TABLE photo_exif (
    photo_id          TEXT    NOT NULL PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
    camera_make       TEXT    NULL,
    camera_model      TEXT    NULL,
    lens_model        TEXT    NULL,
    focal_length_mm   REAL    NULL,
    focal_length_35mm REAL    NULL,
    aperture          REAL    NULL,
    exposure_time     TEXT    NULL,
    exposure_seconds  REAL    NULL,
    iso               INTEGER NULL,
    exposure_bias     REAL    NULL,
    taken_at          INTEGER NULL
) STRICT;
CREATE INDEX photo_exif_camera_model ON photo_exif(camera_model);
CREATE INDEX photo_exif_lens_model ON photo_exif(lens_model);
CREATE INDEX photo_exif_focal_length_mm ON photo_exif(focal_length_mm);
CREATE INDEX photo_exif_taken_at ON photo_exif(taken_at);

-- bins: 4x64 uint16 (luma, R, G, B), normalised to 0-65535 by max.
CREATE TABLE photo_histograms (
    photo_id TEXT NOT NULL PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
    bins     BLOB NOT NULL
) STRICT;

CREATE TABLE collections (
    id                TEXT    NOT NULL PRIMARY KEY,
    owner_id          TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title             TEXT    NOT NULL DEFAULT '',
    intro             TEXT    NOT NULL DEFAULT '',
    status            TEXT    NOT NULL CHECK (status IN ('draft', 'published')),
    visibility        TEXT    NOT NULL CHECK (visibility IN ('private', 'unlisted', 'public')),
    distribute        INTEGER NOT NULL DEFAULT 1 CHECK (distribute IN (0, 1)),
    original_download INTEGER NOT NULL DEFAULT 0 CHECK (original_download IN (0, 1)),
    license           TEXT    NULL CHECK (license IS NULL OR license IN ('by', 'by-sa', 'by-nd', 'by-nc', 'by-nc-sa', 'by-nc-nd')),
    ai_declaration    TEXT    NULL CHECK (ai_declaration IS NULL OR ai_declaration IN ('no-generative-ai')),
    cover_photo_id    TEXT    NULL REFERENCES photos(id),
    featured_rank     INTEGER NULL,
    wall_rank         INTEGER NOT NULL,
    published_at      INTEGER NULL,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
) STRICT;

CREATE TABLE frames (
    id            TEXT    NOT NULL PRIMARY KEY,
    collection_id TEXT    NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    position      INTEGER NOT NULL,
    layout        TEXT    NOT NULL CHECK (layout IN ('full', 'matted', 'pair', 'text')),
    matte_ratio   REAL    NULL CHECK (matte_ratio IS NULL OR (matte_ratio BETWEEN 0.5 AND 0.95)),
    text          TEXT    NULL,
    UNIQUE (collection_id, position)
) STRICT;

-- full/matted: 1 photo, pair: 2-3 photos, text: 0 photos. Deleting a photo
-- cascades its slots; the app layer cleans up frames left with too few slots.
CREATE TABLE frame_photos (
    frame_id TEXT    NOT NULL REFERENCES frames(id) ON DELETE CASCADE,
    slot     INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 2),
    photo_id TEXT    NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    PRIMARY KEY (frame_id, slot)
) STRICT;

-- Per-collection overrides of a photo's snapshot ("edit in collection").
CREATE TABLE photo_overrides (
    collection_id    TEXT    NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    photo_id         TEXT    NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    public_fields    TEXT    NULL CHECK (public_fields IS NULL OR json_valid(public_fields)),
    histogram_public INTEGER NULL CHECK (histogram_public IS NULL OR histogram_public IN (0, 1)),
    PRIMARY KEY (collection_id, photo_id)
) STRICT;

CREATE TABLE albums (
    id         TEXT    NOT NULL PRIMARY KEY,
    owner_id   TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      TEXT    NOT NULL DEFAULT '',
    intro      TEXT    NOT NULL DEFAULT '',
    visibility TEXT    NOT NULL CHECK (visibility IN ('private', 'unlisted', 'public')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE album_items (
    album_id      TEXT    NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    position      INTEGER NOT NULL,
    collection_id TEXT    NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    PRIMARY KEY (album_id, position)
) STRICT;

-- Third-party source and licence (e.g. demo seed).
CREATE TABLE attributions (
    photo_id TEXT NOT NULL PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
    source   TEXT NOT NULL CHECK (json_valid(source))
) STRICT;

CREATE TABLE jobs (
    id          TEXT    NOT NULL PRIMARY KEY,
    kind        TEXT    NOT NULL,
    payload     TEXT    NOT NULL CHECK (json_valid(payload)),
    state       TEXT    NOT NULL CHECK (state IN ('queued', 'running', 'done', 'dead')),
    attempts    INTEGER NOT NULL DEFAULT 0,
    run_after   INTEGER NOT NULL,
    lease_until INTEGER NULL,
    last_error  TEXT    NULL,
    created_at  INTEGER NOT NULL
) STRICT;
CREATE INDEX jobs_state_run_after ON jobs(state, run_after);
