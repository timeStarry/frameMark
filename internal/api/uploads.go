package api

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"

	"github.com/timeStarry/frameMark/internal/domain"
	"github.com/timeStarry/frameMark/internal/httperr"
	"github.com/timeStarry/frameMark/internal/storage"
)

const (
	presignTTL    = 15 * time.Minute
	maxFilename   = 255 // bytes
	maxTitleRunes = 120

	statusUploading  = "uploading"
	statusProcessing = "processing"
	statusReady      = "ready"
	statusFailed     = "failed"

	jobProcessPhoto = "process_photo"

	msgContentType = "仅支持 JPEG、PNG、WebP 图片。"
	msgBytes       = "文件大小无效或超过上限。"
	msgSHA256      = "文件校验值无效。"
	msgFilename    = "文件名无效。"
	msgQuota       = "素材数量已达上限。"
	msgIncomplete  = "上传未完成。"
	msgVerifyFail  = "上传校验失败，请重新上传。"
	msgConflict    = "同一文件正在上传，请稍后重试。"

	msgUploadTitle   = "标题需为 0–120 个字符。"
	msgSourceInvalid = "来源照片无效。"
	maxSources       = 12
)

// contentTypes maps the accepted upload content types to photos.format.
var contentTypes = map[string]string{
	"image/jpeg": "jpeg",
	"image/png":  "png",
	"image/webp": "webp",
}

// defaultPublicFields is the upload_prefs snapshot used when a user has no prefs row.
var defaultPublicFields = []string{"aperture", "shutter", "iso", "focal_length"}

// --- response shapes ---

type uploadView struct {
	URL     string            `json:"url"`
	Method  string            `json:"method"`
	Headers map[string]string `json:"headers"`
}

type initiateView struct {
	PhotoID   string     `json:"photoId"`
	Upload    uploadView `json:"upload"`
	ExpiresAt int64      `json:"expiresAt"`
}

// exifView is the owner view of photo_exif; absent values are omitted.
type exifView struct {
	Camera          *string  `json:"camera,omitempty"`
	Lens            *string  `json:"lens,omitempty"`
	FocalLength     *float64 `json:"focalLength,omitempty"`
	FocalLength35mm *float64 `json:"focalLength35mm,omitempty"`
	Aperture        *float64 `json:"aperture,omitempty"`
	Shutter         *string  `json:"shutter,omitempty"`
	ExposureSeconds *float64 `json:"exposureSeconds,omitempty"`
	ISO             *int64   `json:"iso,omitempty"`
	ExposureBias    *float64 `json:"exposureBias,omitempty"`
	TakenAt         *int64   `json:"takenAt,omitempty"`
	// TakenOffsetMinutes is the zone offset of TakenAt, minutes east of UTC.
	TakenOffsetMinutes *int64 `json:"takenOffsetMinutes,omitempty"`
}

// photoView is the owner view of a photo. It never carries location or the
// original object key.
type photoView struct {
	ID               string    `json:"id"`
	Status           string    `json:"status"`
	Error            *string   `json:"error"`
	Title            string    `json:"title"`
	Caption          string    `json:"caption"`
	Width            *int64    `json:"width"`
	Height           *int64    `json:"height"`
	Format           string    `json:"format"`
	CreatedAt        int64     `json:"createdAt"`
	PublicFields     []string  `json:"publicFields"`
	HistogramPublic  bool      `json:"histogramPublic"`
	OriginalDownload bool      `json:"originalDownload"`
	EXIF             *exifView `json:"exif"`
	// Media is null until the photo is ready with a derived hash. In the owner
	// view it has no collection context, so URLs are /m/…?c= (owner only).
	Media *mediaView `json:"media"`
}

// --- POST /api/uploads ---

// createInput is the POST /api/uploads body. The tool fields are raw so an
// explicit null can be told apart from an omitted field (both are optional,
// but null is refused).
type createInput struct {
	Filename    string          `json:"filename"`
	Bytes       int64           `json:"bytes"`
	SHA256      string          `json:"sha256"`
	ContentType string          `json:"contentType"`
	Title       json.RawMessage `json:"title"`
	DerivedFrom json.RawMessage `json:"derivedFrom"`
	ToolOutput  json.RawMessage `json:"toolOutput"`
}

func (s *server) createUpload(w http.ResponseWriter, r *http.Request) (int, any, error) {
	owner, err := requireUser(r)
	if err != nil {
		return 0, nil, err
	}
	var in createInput
	if err := decodeJSON(r, &in); err != nil {
		return 0, nil, err
	}
	format, ok := contentTypes[in.ContentType]
	if !ok {
		return 0, nil, httperr.Fail(http.StatusBadRequest, msgContentType)
	}
	if in.Bytes < 1 || in.Bytes > int64(s.cfg.UploadMaxMB)<<20 {
		return 0, nil, httperr.Fail(http.StatusBadRequest, msgBytes)
	}
	if !isLowerHex64(in.SHA256) {
		return 0, nil, httperr.Fail(http.StatusBadRequest, msgSHA256)
	}
	if !validFilename(in.Filename) {
		return 0, nil, httperr.Fail(http.StatusBadRequest, msgFilename)
	}
	title, sources, toolOut, err := parseToolFields(in)
	if err != nil {
		return 0, nil, err
	}
	ctx := r.Context()
	now := s.now()

	id, dup, err := s.reserve(ctx, owner, in, format, title, sources, toolOut, now)
	if err != nil {
		return 0, nil, err
	}
	if dup {
		p, err := s.loadPhoto(ctx, owner, id)
		if err != nil {
			return 0, nil, err
		}
		return http.StatusOK, p, nil
	}
	// Presign after commit so no network call holds the single DB connection.
	// If it fails the row stays uploading and a retry re-presigns it.
	req, err := s.store.PresignPut(ctx, s.cfg.BucketOriginals, originalKey(owner, id), in.ContentType, in.SHA256, presignTTL)
	if err != nil {
		return 0, nil, err
	}
	return http.StatusCreated, initiateView{
		PhotoID:   id,
		Upload:    uploadView{URL: req.URL, Method: req.Method, Headers: req.Headers},
		ExpiresAt: now + presignTTL.Milliseconds(),
	}, nil
}

// reserve finds or creates the photo row for an upload in one transaction.
// dup is true when an existing ready/processing photo should be returned
// instead. A failed or uploading row with the same hash is reused (same id,
// same object key) and fully reset: see resetForReuse.
//
// The dedup and quota check-then-write is race-free because db.Open opens
// every transaction with _txlock=immediate (BEGIN IMMEDIATE takes the write
// lock up front) and caps the pool at one connection; either alone suffices.
func (s *server) reserve(ctx context.Context, owner string, in createInput, format, title string, sources []string, toolOut bool, now int64) (id string, dup bool, err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", false, err
	}
	defer tx.Rollback()

	var status string
	err = tx.QueryRowContext(ctx, `SELECT id,status FROM photos WHERE owner_id=? AND original_sha256=?`, owner, in.SHA256).Scan(&id, &status)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		id = ""
	case err != nil:
		return "", false, err
	case status == statusReady || status == statusProcessing:
		return id, true, nil // the tool fields are ignored on a duplicate
	}

	// Sources are checked inside the tx so a source cannot change state
	// between the check and the photo_sources write.
	if err := checkSources(ctx, tx, owner, sources); err != nil {
		return "", false, err
	}
	tool := 0
	if toolOut {
		tool = 1
	}

	// An uploading row already counts toward the quota; a new or failed one would add one.
	if id == "" || status == statusFailed {
		var n int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM photos WHERE owner_id=? AND status!='failed'`, owner).Scan(&n); err != nil {
			return "", false, err
		}
		if n >= s.cfg.QuotaPhotos {
			return "", false, httperr.Fail(http.StatusConflict, msgQuota)
		}
	}

	fields, hist, orig, err := prefsSnapshot(ctx, tx, owner)
	if err != nil {
		return "", false, err
	}
	if id != "" {
		if err := resetForReuse(ctx, tx, id, status, in, format, title, fields, hist, orig, tool, now); err != nil {
			return "", false, err
		}
	} else {
		u, err := uuid.NewV7()
		if err != nil {
			return "", false, err
		}
		id = u.String()
		_, err = tx.ExecContext(ctx, `INSERT INTO photos(id,owner_id,status,original_key,original_sha256,original_bytes,format,
			title,public_fields,histogram_public,original_download,tool_output,derived_salt,created_at,updated_at)
			VALUES(?,?,'uploading',?,?,?,?,?,?,?,?,?,?,?,?)`,
			id, owner, originalKey(owner, id), in.SHA256, in.Bytes, format, title, fields, hist, orig, tool, newSalt(), now, now)
		if isUniqueViolation(err) {
			return "", false, httperr.Fail(http.StatusConflict, msgConflict)
		}
		if err != nil {
			return "", false, err
		}
	}
	if err := insertSources(ctx, tx, id, sources); err != nil {
		return "", false, err
	}
	return id, false, tx.Commit()
}

// resetForReuse returns a failed or uploading row to the state of a fresh
// upload: every derived column (dimensions, location, derived_hash, error)
// is cleared, the prefs snapshot is retaken, and photo_exif and
// photo_histograms rows are deleted so reprocessing starts clean. tool_output
// and photo_sources are replaced by the new request's (sources are written by
// the caller). The id, original_key, created_at and derived_salt are kept.
func resetForReuse(ctx context.Context, tx *sql.Tx, id, status string, in createInput, format, title, fields string, hist, orig, tool int, now int64) error {
	res, err := tx.ExecContext(ctx, `UPDATE photos SET status='uploading',error=NULL,original_bytes=?,format=?,title=?,
		width=NULL,height=NULL,latitude=NULL,longitude=NULL,derived_hash=NULL,
		public_fields=?,histogram_public=?,original_download=?,tool_output=?,updated_at=?
		WHERE id=? AND status=?`, in.Bytes, format, title, fields, hist, orig, tool, now, id, status)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return httperr.Fail(http.StatusConflict, msgConflict)
	}
	for _, q := range []string{
		`DELETE FROM photo_exif WHERE photo_id=?`,
		`DELETE FROM photo_histograms WHERE photo_id=?`,
		`DELETE FROM photo_sources WHERE photo_id=?`,
	} {
		if _, err := tx.ExecContext(ctx, q, id); err != nil {
			return err
		}
	}
	return nil
}

// parseToolFields decodes the optional title, derivedFrom and toolOutput
// fields. An omitted or empty (after cleanText) title falls back to the
// filename; an explicit null in any of them is a 400.
func parseToolFields(in createInput) (title string, sources []string, toolOut bool, err error) {
	bad := httperr.Fail(http.StatusBadRequest, msgBadJSON)
	title = titleFromFilename(in.Filename)
	if in.Title != nil {
		var s string
		if isJSONNull(in.Title) || json.Unmarshal(in.Title, &s) != nil {
			return "", nil, false, bad
		}
		s = cleanText(s, false)
		if utf8.RuneCountInString(s) > maxTitleRunes {
			return "", nil, false, httperr.Fail(http.StatusBadRequest, msgUploadTitle)
		}
		if s != "" {
			title = s
		}
	}
	if in.DerivedFrom != nil && (isJSONNull(in.DerivedFrom) || json.Unmarshal(in.DerivedFrom, &sources) != nil) {
		return "", nil, false, bad
	}
	if in.ToolOutput != nil && (isJSONNull(in.ToolOutput) || json.Unmarshal(in.ToolOutput, &toolOut) != nil) {
		return "", nil, false, bad
	}
	return title, sources, toolOut, nil
}

func isJSONNull(raw json.RawMessage) bool { return string(raw) == "null" }

// checkSources requires ≤ maxSources distinct canonical ids, each the
// owner's own ready photo.
func checkSources(ctx context.Context, tx *sql.Tx, owner string, ids []string) error {
	invalid := httperr.Fail(http.StatusBadRequest, msgSourceInvalid)
	if len(ids) > maxSources {
		return invalid
	}
	seen := make(map[string]bool, len(ids))
	for _, id := range ids {
		if !canonicalUUID(id) || seen[id] {
			return invalid
		}
		seen[id] = true
		var st string
		err := tx.QueryRowContext(ctx, `SELECT status FROM photos WHERE id=? AND owner_id=?`, id, owner).Scan(&st)
		if errors.Is(err, sql.ErrNoRows) {
			return invalid
		}
		if err != nil {
			return err
		}
		if st != statusReady {
			return invalid
		}
	}
	return nil
}

func insertSources(ctx context.Context, tx *sql.Tx, photoID string, ids []string) error {
	for i, src := range ids {
		if _, err := tx.ExecContext(ctx, `INSERT INTO photo_sources(photo_id,source_id,position) VALUES(?,?,?)`, photoID, src, i); err != nil {
			return err
		}
	}
	return nil
}

// prefsSnapshot returns the owner's upload_prefs values to copy onto a new
// photo, or the defaults when there is no prefs row.
func prefsSnapshot(ctx context.Context, tx *sql.Tx, owner string) (fields string, hist, orig int, err error) {
	err = tx.QueryRowContext(ctx, `SELECT public_fields,histogram_public,original_download FROM upload_prefs WHERE user_id=?`, owner).
		Scan(&fields, &hist, &orig)
	if errors.Is(err, sql.ErrNoRows) {
		b, _ := json.Marshal(defaultPublicFields)
		return string(b), 1, 0, nil
	}
	return fields, hist, orig, err
}

// --- POST /api/uploads/{id}/complete ---

func (s *server) completeUpload(w http.ResponseWriter, r *http.Request) (int, any, error) {
	owner, err := requireUser(r)
	if err != nil {
		return 0, nil, err
	}
	id, err := pathID(r)
	if err != nil {
		return 0, nil, err
	}
	// The body is optional; when present it must be {}.
	if err := decodeJSON(r, &struct{}{}); err != nil && err != errEmptyBody {
		return 0, nil, err
	}
	ctx := r.Context()

	var status, sha, format string
	var declared int64
	err = s.db.QueryRowContext(ctx, `SELECT status,original_sha256,original_bytes,format FROM photos WHERE id=? AND owner_id=?`, id, owner).
		Scan(&status, &sha, &declared, &format)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil, httperr.Fail(http.StatusNotFound, msgPhotoAbsent)
	}
	if err != nil {
		return 0, nil, err
	}
	switch status {
	case statusProcessing, statusReady:
		return s.photoResponse(ctx, http.StatusOK, owner, id)
	case statusUploading:
	default:
		return 0, nil, httperr.Fail(http.StatusConflict, msgIncomplete)
	}

	key := originalKey(owner, id)
	obj, err := s.store.Head(ctx, s.cfg.BucketOriginals, key)
	if errors.Is(err, storage.ErrNotFound) {
		return 0, nil, httperr.Fail(http.StatusConflict, msgIncomplete)
	}
	if err != nil {
		return 0, nil, err
	}

	// An empty stored checksum is unverified and fails ChecksumMatches. The
	// stored Content-Type must match the declared format too: a stale presign
	// from an earlier initiate may have been used with another type.
	if obj.Size != declared || !obj.ChecksumMatches(sha) || contentTypes[obj.ContentType] != format {
		return s.failVerification(ctx, owner, id, key)
	}

	started, err := s.startProcessing(ctx, id)
	if err != nil {
		return 0, nil, err
	}
	if !started {
		return s.completedElsewhere(ctx, owner, id) // a concurrent complete won the race
	}
	return s.photoResponse(ctx, http.StatusAccepted, owner, id)
}

// failVerification marks an uploading photo failed and deletes its object.
// The conditional UPDATE runs first so a concurrent complete that already
// moved the photo on keeps its original; that request's photo is returned
// instead. If Delete then fails, the status is rolled back to uploading so a
// failed row never points at a live object and the client can retry.
func (s *server) failVerification(ctx context.Context, owner, id, key string) (int, any, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE photos SET status='failed',error=?,updated_at=? WHERE id=? AND status='uploading'`,
		msgVerifyFail, s.now(), id)
	if err != nil {
		return 0, nil, err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return s.completedElsewhere(ctx, owner, id)
	}
	// The row is already failed; finish the cleanup even if the client has
	// gone away, so a failed row never keeps pointing at a live object.
	cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
	defer cancel()
	if err := s.store.Delete(cleanup, s.cfg.BucketOriginals, key); err != nil {
		if _, rbErr := s.db.ExecContext(cleanup, `UPDATE photos SET status='uploading',error=NULL,updated_at=? WHERE id=? AND status='failed' AND error=?`,
			s.now(), id, msgVerifyFail); rbErr != nil {
			return 0, nil, errors.Join(err, rbErr)
		}
		return 0, nil, err
	}
	return 0, nil, httperr.Fail(http.StatusUnprocessableEntity, msgVerifyFail)
}

// completedElsewhere answers a complete whose photo left uploading while it
// was being checked: 200 with the photo once processing or ready, else 409.
func (s *server) completedElsewhere(ctx context.Context, owner, id string) (int, any, error) {
	p, err := s.loadPhoto(ctx, owner, id)
	if err != nil {
		return 0, nil, err
	}
	if p.Status == statusProcessing || p.Status == statusReady {
		return http.StatusOK, p, nil
	}
	return 0, nil, httperr.Fail(http.StatusConflict, msgIncomplete)
}

// startProcessing moves an uploading photo to processing and enqueues its
// process_photo job atomically. It reports false when the photo was no longer
// uploading.
func (s *server) startProcessing(ctx context.Context, id string) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `UPDATE photos SET status='processing',error=NULL,updated_at=? WHERE id=? AND status='uploading'`, s.now(), id)
	if err != nil {
		return false, err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return false, nil
	}
	if _, err := s.q.EnqueueTx(ctx, tx, jobProcessPhoto, map[string]string{"photoId": id}); err != nil {
		return false, err
	}
	return true, tx.Commit()
}

// --- GET /api/photos/{id} ---

func (s *server) getPhoto(w http.ResponseWriter, r *http.Request) (int, any, error) {
	owner, err := requireUser(r)
	if err != nil {
		return 0, nil, err
	}
	id, err := pathID(r)
	if err != nil {
		return 0, nil, err
	}
	return s.photoResponse(r.Context(), http.StatusOK, owner, id)
}

func (s *server) photoResponse(ctx context.Context, code int, owner, id string) (int, any, error) {
	p, err := s.loadPhoto(ctx, owner, id)
	if err != nil {
		return 0, nil, err
	}
	return code, p, nil
}

// loadPhoto returns the owner view of a photo, or 404 when it does not exist
// or belongs to someone else. EXIF is included only once the photo is ready.
func (s *server) loadPhoto(ctx context.Context, owner, id string) (*photoView, error) {
	var (
		p                        photoView
		errMsg                   sql.NullString
		width, height            sql.NullInt64
		fields                   string
		hist, orig               int
		exifRow                  sql.NullString
		mk, model, lens, shutter sql.NullString
		focal, focal35, ap, secs sql.NullFloat64
		bias                     sql.NullFloat64
		iso, taken, offset       sql.NullInt64
		hash                     sql.NullString
	)
	err := s.db.QueryRowContext(ctx, `SELECT p.id,p.status,p.error,p.title,p.caption,p.width,p.height,p.format,p.created_at,
			p.public_fields,p.histogram_public,p.original_download,p.derived_hash,
			e.photo_id,e.camera_make,e.camera_model,e.lens_model,e.focal_length_mm,e.focal_length_35mm,e.aperture,
			e.exposure_time,e.exposure_seconds,e.iso,e.exposure_bias,e.taken_at,e.taken_offset_min
		FROM photos p LEFT JOIN photo_exif e ON e.photo_id=p.id
		WHERE p.id=? AND p.owner_id=?`, id, owner).Scan(
		&p.ID, &p.Status, &errMsg, &p.Title, &p.Caption, &width, &height, &p.Format, &p.CreatedAt,
		&fields, &hist, &orig, &hash,
		&exifRow, &mk, &model, &lens, &focal, &focal35, &ap, &shutter, &secs, &iso, &bias, &taken, &offset)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, httperr.Fail(http.StatusNotFound, msgPhotoAbsent)
	}
	if err != nil {
		return nil, err
	}
	if errMsg.Valid {
		p.Error = &errMsg.String
	}
	if width.Valid {
		p.Width = &width.Int64
	}
	if height.Valid {
		p.Height = &height.Int64
	}
	p.PublicFields = parsePublicFields(fields)
	p.HistogramPublic, p.OriginalDownload = hist == 1, orig == 1
	p.Media = s.mediaFor(mediaSource{ID: p.ID, Status: p.Status, Width: width, Height: height, Hash: hash}, nil)
	if exifRow.Valid && p.Status == statusReady {
		p.EXIF = &exifView{
			Camera:             cameraName(mk.String, model.String),
			Lens:               nonEmpty(lens),
			FocalLength:        floatPtr(focal),
			FocalLength35mm:    floatPtr(focal35),
			Aperture:           floatPtr(ap),
			Shutter:            nonEmpty(shutter),
			ExposureSeconds:    floatPtr(secs),
			ISO:                intPtr(iso),
			ExposureBias:       floatPtr(bias),
			TakenAt:            intPtr(taken),
			TakenOffsetMinutes: intPtr(offset),
		}
	}
	return &p, nil
}

// --- helpers ---

func originalKey(owner, id string) string { return "o/" + owner + "/" + id }

// newSalt is a random 16-byte hex derived_salt for a new photo, so its
// derived hash (and so its media URLs) cannot be computed from the
// original's sha256. Reused rows keep theirs.
func newSalt() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b) // crypto/rand.Read never returns an error
	return hex.EncodeToString(b)
}

func isLowerHex64(s string) bool {
	if len(s) != 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// validFilename: 1–255 bytes of valid UTF-8, no control characters, no path
// separators. U+FFFD is refused too: encoding/json substitutes it for
// invalid input, so it signals a mangled name.
func validFilename(name string) bool {
	if name == "" || len(name) > maxFilename || !utf8.ValidString(name) {
		return false
	}
	for _, r := range name {
		if r == '/' || r == '\\' || r == utf8.RuneError || unicode.IsControl(r) {
			return false
		}
	}
	return true
}

// titleFromFilename derives the default title: the name without its last
// extension (a leading dot is not an extension), with format characters
// (bidi controls, zero-width) removed, trimmed, at most 120 runes.
func titleFromFilename(name string) string {
	if i := strings.LastIndexByte(name, '.'); i > 0 {
		name = name[:i]
	}
	name = strings.Map(func(r rune) rune {
		if unicode.Is(unicode.Cf, r) || unicode.IsControl(r) {
			return -1
		}
		return r
	}, name)
	name = strings.TrimSpace(name)
	if utf8.RuneCountInString(name) > maxTitleRunes {
		name = string([]rune(name)[:maxTitleRunes])
		name = strings.TrimSpace(name)
	}
	return name
}

// parsePublicFields decodes a stored public_fields array, keeping only valid keys.
func parsePublicFields(raw string) []string {
	var in []string
	_ = json.Unmarshal([]byte(raw), &in)
	out := make([]string, 0, len(in))
	for _, f := range in {
		if domain.ValidPublicField(f) {
			out = append(out, f)
		}
	}
	return out
}

// cameraName joins make and model, using the model alone when it already
// starts with the make (e.g. "Canon" + "Canon EOS R5").
func cameraName(mk, model string) *string {
	mk, model = strings.TrimSpace(mk), strings.TrimSpace(model)
	var s string
	switch {
	case mk == "":
		s = model
	case model == "":
		s = mk
	case strings.HasPrefix(strings.ToLower(model), strings.ToLower(mk)):
		s = model
	default:
		s = mk + " " + model
	}
	if s == "" {
		return nil
	}
	return &s
}

func nonEmpty(v sql.NullString) *string {
	if !v.Valid || v.String == "" {
		return nil
	}
	return &v.String
}

func floatPtr(v sql.NullFloat64) *float64 {
	if !v.Valid {
		return nil
	}
	return &v.Float64
}

func intPtr(v sql.NullInt64) *int64 {
	if !v.Valid {
		return nil
	}
	return &v.Int64
}

// isUniqueViolation reports a SQLite UNIQUE or PRIMARY KEY constraint failure
// by the driver's extended result code.
func isUniqueViolation(err error) bool {
	var se *sqlite.Error
	if !errors.As(err, &se) {
		return false
	}
	return se.Code() == sqlite3.SQLITE_CONSTRAINT_UNIQUE || se.Code() == sqlite3.SQLITE_CONSTRAINT_PRIMARYKEY
}
