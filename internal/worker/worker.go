// Package worker is the background job runner (spec §6.2, §6.3, §7 撤回).
package worker

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	mrand "math/rand/v2"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"

	"github.com/timeStarry/frameMark/internal/cdn"
	"github.com/timeStarry/frameMark/internal/clock"
	"github.com/timeStarry/frameMark/internal/config"
	"github.com/timeStarry/frameMark/internal/exposure"
	"github.com/timeStarry/frameMark/internal/jobs"
	"github.com/timeStarry/frameMark/internal/media"
	"github.com/timeStarry/frameMark/internal/storage"
)

const (
	kindProcess      = "process_photo"
	kindRotate       = "rotate_derived"
	kindDelete       = "delete_photo_objects"
	kindReplicate    = "replicate_original"
	kindCleanup      = "cleanup_uploads"
	kindPurge        = "purge_derived"
	msgDead          = "处理失败，请重新上传。"
	msgSHA           = "原图校验失败。"
	msgUnsupported   = "不支持的图片格式。"
	msgAnimated      = "不支持动图。"
	msgPixels        = "图片像素超过上限。"
	msgDecode        = "图片无法解码。"
	cacheControl     = "public, max-age=31536000, immutable"
	heartbeatEvery   = 30 * time.Second
	pollEvery        = time.Second
	cleanupEvery     = time.Hour
	staleUploadAge   = time.Hour
	staleFailedAge   = 24 * time.Hour
	purgeJobAge      = 7 * 24 * time.Hour
	deleteSweepDelay = 20 * time.Minute
	defaultMaxMB     = 60
)

// DeleteSweepDelay is how long a first delete_photo_objects waits before
// the second pass that catches a PUT that landed after the photo was
// deleted. Exported so tests can advance the clock past it.
var DeleteSweepDelay = deleteSweepDelay

var (
	errPermanent = errors.New("worker: permanent")
	errNoop      = errors.New("worker: noop")
)

func isPermanent(err error) bool { return errors.Is(err, errPermanent) }
func isNoop(err error) bool      { return errors.Is(err, errNoop) }

func perm(msg string) error { return fmt.Errorf("%w: %s", errPermanent, msg) }

// Storage is the subset of *storage.Client the worker uses. Tests supply a fake.
type Storage interface {
	Get(ctx context.Context, bucket, key string, maxBytes int64) ([]byte, error)
	Put(ctx context.Context, bucket, key string, body []byte, contentType, cacheControl string) error
	Delete(ctx context.Context, bucket, key string) error
	DeletePrefix(ctx context.Context, bucket, prefix string) (int, error)
	List(ctx context.Context, bucket, prefix string) ([]string, error)
}

var _ Storage = (*storage.Client)(nil)

// ProcessFunc is media.Process; tests replace it to inject sentinels.
type ProcessFunc func(orig []byte, opts media.Options) (*media.Result, error)

// Deps wires the worker. Now is Unix milliseconds; nil means clock.Now.
type Deps struct {
	DB      *sql.DB
	Jobs    *jobs.Queue
	Storage Storage
	Replica Storage // optional; a second client or the same client with a replica bucket
	CDN     cdn.Purger
	Cfg     config.Config
	Now     func() int64
	Log     *slog.Logger
	Process ProcessFunc

	PollEvery, HeartbeatEvery time.Duration
}

// Worker claims jobs and runs the handlers.
type Worker struct {
	db      *sql.DB
	q       *jobs.Queue
	store   Storage
	replica Storage
	cdn     cdn.Purger
	cfg     config.Config
	now     func() int64
	log     *slog.Logger
	process ProcessFunc

	poll, hb time.Duration

	failCommit atomic.Bool
}

// New returns a Worker. It registers the dead-letter hook on Deps.Jobs.
func New(d Deps) *Worker {
	if d.Now == nil {
		d.Now = clock.Now
	}
	if d.Log == nil {
		d.Log = slog.Default()
	}
	if d.Process == nil {
		d.Process = media.Process
	}
	if d.PollEvery <= 0 {
		d.PollEvery = pollEvery
	}
	if d.HeartbeatEvery <= 0 {
		d.HeartbeatEvery = heartbeatEvery
	}
	w := &Worker{
		db: d.DB, q: d.Jobs, store: d.Storage, replica: d.Replica, cdn: d.CDN,
		cfg: d.Cfg, now: d.Now, log: d.Log, process: d.Process,
		poll: d.PollEvery, hb: d.HeartbeatEvery,
	}
	d.Jobs.OnDead(w.onDead)
	return w
}

// Run reconciles dead process_photo jobs, enqueues the first cleanup, and
// then claims jobs until ctx is cancelled. In-flight handlers finish.
func (w *Worker) Run(ctx context.Context) error {
	// Startup work is short and must not be cut off by an early shutdown.
	start := context.WithoutCancel(ctx)
	if err := w.reconcile(start); err != nil {
		return err
	}
	if err := w.scheduleCleanup(start); err != nil {
		return err
	}
	n := w.cfg.Workers
	if n < 1 {
		n = 1
	}
	var wg sync.WaitGroup
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func() {
			defer wg.Done()
			w.loop(ctx)
		}()
	}
	wg.Wait()
	return nil
}

// RunOnce claims at most one due job and runs it. It is for tests.
func (w *Worker) RunOnce(ctx context.Context) (bool, error) {
	j, err := w.q.Claim(ctx, nil)
	if err != nil || j == nil {
		return false, err
	}
	w.handle(ctx, j)
	return true, nil
}

func (w *Worker) loop(ctx context.Context) {
	for {
		if ctx.Err() != nil {
			return
		}
		j, err := w.q.Claim(ctx, nil)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			w.log.Error("worker: claim", "err", err)
			w.sleep(ctx, w.poll)
			continue
		}
		if j == nil {
			w.sleep(ctx, w.poll+jitter(w.poll/4))
			continue
		}
		w.handle(ctx, j)
	}
}

func (w *Worker) handle(ctx context.Context, j *jobs.Job) {
	hctx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	defer cancel()
	stop := w.heartbeat(hctx, cancel, j)
	defer stop()

	var err error
	switch j.Kind {
	case kindProcess:
		err = w.processPhoto(hctx, j.Payload)
	case kindRotate:
		err = w.rotateDerived(hctx, j.Payload)
	case kindDelete:
		err = w.deletePhotoObjects(hctx, j.Payload)
	case kindReplicate:
		err = w.replicateOriginal(hctx, j.Payload)
	case kindCleanup:
		err = w.cleanupUploads(hctx)
	case kindPurge:
		err = w.purgeDerived(hctx, j.Payload)
	default:
		err = perm("unknown kind")
	}

	fin := context.WithoutCancel(ctx)
	switch {
	case err == nil || isNoop(err):
		if derr := w.q.Done(fin, j); derr != nil && !errors.Is(derr, jobs.ErrLeaseLost) {
			w.log.Error("worker: done", "id", j.ID, "kind", j.Kind, "err", derr)
		}
	case isPermanent(err):
		w.log.Warn("worker: job failed permanently", "id", j.ID, "kind", j.Kind, "err", err)
		if ferr := w.q.Fail(fin, j, true, err); ferr != nil && !errors.Is(ferr, jobs.ErrLeaseLost) {
			w.log.Error("worker: fail", "id", j.ID, "kind", j.Kind, "err", ferr)
		}
	default:
		w.log.Warn("worker: job failed, will retry", "id", j.ID, "kind", j.Kind, "attempt", j.Attempts, "err", err)
		if ferr := w.q.Fail(fin, j, false, err); ferr != nil && !errors.Is(ferr, jobs.ErrLeaseLost) {
			w.log.Error("worker: fail", "id", j.ID, "kind", j.Kind, "err", ferr)
		}
	}
}

// heartbeat renews j's lease every w.hb. On ErrLeaseLost another worker may
// own the job, so the handler's ctx is cancelled to stop its storage calls
// and DB writes. Other errors are retried on the next tick.
func (w *Worker) heartbeat(ctx context.Context, cancel context.CancelFunc, j *jobs.Job) func() {
	done := make(chan struct{})
	go func() {
		t := time.NewTicker(w.hb)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			case <-t.C:
				err := w.q.Heartbeat(ctx, j)
				if errors.Is(err, jobs.ErrLeaseLost) {
					w.log.Warn("worker: lease lost; cancelling handler", "id", j.ID, "kind", j.Kind)
					cancel()
					return
				}
				if err != nil && ctx.Err() == nil {
					w.log.Warn("worker: heartbeat failed; retrying", "id", j.ID, "kind", j.Kind, "err", err)
				}
			}
		}
	}()
	return func() { close(done) }
}

func (w *Worker) sleep(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}

func jitter(d time.Duration) time.Duration {
	if d <= 0 {
		return 0
	}
	return time.Duration(mrand.Int64N(int64(d) + 1))
}

// --- dead hook / reconcile ---

func (w *Worker) onDead(ctx context.Context, j jobs.Job) {
	switch j.Kind {
	case kindRotate, kindPurge:
		// A withdrawn photo may still serve its published hash, or old
		// objects may linger. Startup reconcile re-enqueues a purge.
		w.log.Error("worker: privacy job dead", "id", j.ID, "kind", j.Kind)
		return
	case kindProcess:
	default:
		return
	}
	id, err := photoID(j.Payload)
	if err != nil {
		return
	}
	if err := w.failPhoto(ctx, id, msgDead); err != nil {
		w.log.Error("worker: dead hook", "id", j.ID, "err", err)
	}
}

func (w *Worker) reconcile(ctx context.Context) error {
	if err := w.reconcilePurges(ctx); err != nil {
		return err
	}
	dead, err := w.q.DeadSince(ctx, 0, kindProcess)
	if err != nil {
		return err
	}
	for _, j := range dead {
		id, err := photoID(j.Payload)
		if err != nil {
			continue
		}
		var n int
		if err := w.db.QueryRowContext(ctx, `SELECT count(*) FROM jobs WHERE kind=? AND state IN ('queued','running') AND json_extract(payload,'$.photoId')=?`,
			kindProcess, id).Scan(&n); err != nil {
			return err
		}
		if n > 0 {
			continue
		}
		if err := w.failPhoto(ctx, id, msgDead); err != nil {
			return err
		}
	}
	return nil
}

// reconcilePurges enqueues one purge_derived per photo whose rotate_derived
// or purge_derived died in the last 7 days, unless a purge is already
// queued or running for it. purge_derived computes the stale set itself,
// so a redundant run is harmless.
func (w *Worker) reconcilePurges(ctx context.Context) error {
	since := w.now() - purgeJobAge.Milliseconds()
	// Old prefixes from dead purge jobs are carried forward: their objects
	// may already be gone, so listing alone would not find them to purge.
	prefixes := map[string][]string{}
	var order []string
	for _, kind := range []string{kindRotate, kindPurge} {
		dead, err := w.q.DeadSince(ctx, since, kind)
		if err != nil {
			return err
		}
		for _, j := range dead {
			id, err := photoID(j.Payload)
			if err != nil {
				continue
			}
			if _, ok := prefixes[id]; !ok {
				prefixes[id] = []string{}
				order = append(order, id)
			}
			if kind == kindPurge {
				if pp, err := parsePurge(j.Payload); err == nil {
					prefixes[id] = append(prefixes[id], pp.Prefixes...)
				}
			}
		}
	}
	for _, id := range order {
		var n int
		if err := w.db.QueryRowContext(ctx, `SELECT count(*) FROM jobs WHERE kind=? AND state IN ('queued','running') AND json_extract(payload,'$.photoId')=?`,
			kindPurge, id).Scan(&n); err != nil {
			return err
		}
		if n > 0 {
			continue
		}
		if _, err := w.q.Enqueue(ctx, kindPurge, map[string]any{"photoId": id, "prefixes": prefixes[id]}); err != nil {
			return err
		}
	}
	return nil
}

func (w *Worker) failPhoto(ctx context.Context, id, msg string) error {
	_, err := w.db.ExecContext(ctx, `UPDATE photos SET status='failed', error=?, updated_at=? WHERE id=? AND status='processing'`,
		msg, w.now(), id)
	return err
}

// --- payloads ---

func photoID(raw json.RawMessage) (string, error) {
	var p struct {
		PhotoID string `json:"photoId"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return "", perm("invalid payload")
	}
	if _, err := uuid.Parse(p.PhotoID); err != nil {
		return "", perm("invalid photoId")
	}
	return p.PhotoID, nil
}

type deletePayload struct {
	PhotoID       string `json:"photoId"`
	OriginalKey   string `json:"originalKey"`
	DerivedPrefix string `json:"derivedPrefix"`
	Sweep         bool   `json:"sweep,omitempty"`
}

func parseDelete(raw json.RawMessage) (deletePayload, error) {
	var p deletePayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return p, perm("invalid payload")
	}
	if _, err := uuid.Parse(p.PhotoID); err != nil {
		return p, perm("invalid photoId")
	}
	if !validOriginalKey(p.OriginalKey, p.PhotoID) || !validDerivedPrefix(p.DerivedPrefix, p.PhotoID) {
		return p, perm("invalid object keys")
	}
	return p, nil
}

func validOriginalKey(key, id string) bool {
	// o/{owner}/{photoId} — owner is a uuid, so three slash-free segments.
	if !strings.HasPrefix(key, "o/") || !strings.HasSuffix(key, "/"+id) {
		return false
	}
	rest := strings.TrimSuffix(strings.TrimPrefix(key, "o/"), "/"+id)
	return rest != "" && !strings.ContainsAny(rest, "/\\")
}

func validDerivedPrefix(prefix, id string) bool {
	return prefix == "d/"+id+"/"
}

// purgePayload names the photo. Prefixes are the old prefixes known at
// enqueue time, kept as an audit trail; the stale set is computed at run
// time (see purgeDerived).
type purgePayload struct {
	PhotoID  string   `json:"photoId"`
	Prefixes []string `json:"prefixes"`
}

func parsePurge(raw json.RawMessage) (purgePayload, error) {
	var p purgePayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return p, perm("invalid payload")
	}
	if _, err := uuid.Parse(p.PhotoID); err != nil {
		return p, perm("invalid photoId")
	}
	for _, pfx := range p.Prefixes {
		if err := checkPurgePrefix(p.PhotoID, pfx); err != nil {
			return p, err
		}
	}
	return p, nil
}

func checkPurgePrefix(id, pfx string) error {
	head := "d/" + id + "/"
	if pfx == head {
		return perm("refusing photo-wide prefix")
	}
	if !strings.HasPrefix(pfx, head) || !strings.HasSuffix(pfx, "/") {
		return perm("invalid purge prefix")
	}
	rest := strings.TrimSuffix(strings.TrimPrefix(pfx, head), "/")
	if rest == "" || strings.Contains(rest, "/") {
		return perm("invalid purge prefix")
	}
	hash, _, _ := strings.Cut(rest, "-wm")
	if len(hash) != 16 {
		return perm("invalid purge prefix")
	}
	for _, r := range hash {
		ok := r >= '0' && r <= '9' || r >= 'a' && r <= 'f'
		if !ok {
			return perm("invalid purge prefix")
		}
	}
	if strings.Contains(rest, "-wm") {
		wm := strings.TrimPrefix(rest, hash+"-wm")
		if len(wm) != 16 {
			return perm("invalid purge prefix")
		}
		for _, r := range wm {
			ok := r >= '0' && r <= '9' || r >= 'a' && r <= 'f'
			if !ok {
				return perm("invalid purge prefix")
			}
		}
	}
	return nil
}

// --- process_photo ---

func (w *Worker) processPhoto(ctx context.Context, raw json.RawMessage) error {
	id, err := photoID(raw)
	if err != nil {
		return err
	}
	row, err := w.loadPhoto(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return errNoop
		}
		return err
	}
	if row.status != "processing" {
		return errNoop
	}
	body, err := w.store.Get(ctx, w.cfg.BucketOriginals, row.key, w.maxBytes())
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) || errors.Is(err, storage.ErrTooLarge) {
			return w.failPermanently(ctx, id, msgSHA)
		}
		return err
	}
	if sha256Hex(body) != row.sha {
		return w.failPermanently(ctx, id, msgSHA)
	}
	mode, wm, err := w.loadPrefs(ctx, row.owner)
	if err != nil {
		return err
	}
	res, err := w.runProcess(body, media.Options{LocationMode: mode, MaxPixels: w.cfg.MaxPixels, Salt: row.salt, Watermark: wm})
	if err != nil {
		if msg, ok := permanentMedia(err); ok {
			return w.failPermanently(ctx, id, msg)
		}
		return err
	}
	// Objects first, then the row: a reader never sees a hash whose
	// objects are missing.
	if err := w.putAll(ctx, id, res, wm); err != nil {
		return err
	}
	outcome, err := w.commitProcess(ctx, id, res, mode)
	if err != nil {
		return err
	}
	switch outcome {
	case commitGone:
		// Deleted while we worked: its delete_photo_objects may already
		// have run, so remove what we just wrote.
		return w.removeAll(ctx, id)
	case commitSkipped:
		// Another attempt moved the row on. Keys are deterministic, so the
		// objects may be in use; leave them.
		return errNoop
	}
	return nil
}

type commitOutcome int

const (
	commitDone commitOutcome = iota
	commitSkipped
	commitGone
)

// removeAll deletes every derived object of a photo that no longer exists.
func (w *Worker) removeAll(ctx context.Context, id string) error {
	if _, err := w.store.DeletePrefix(ctx, w.cfg.BucketDerived, "d/"+id+"/"); err != nil {
		return err
	}
	return errNoop
}

func (w *Worker) runProcess(body []byte, opts media.Options) (*media.Result, error) {
	res, err := w.process(body, opts)
	if err == nil {
		return res, nil
	}
	if errors.Is(err, media.ErrWatermark) && opts.Watermark != nil {
		w.log.Warn("worker: watermark failed; publishing without the variant")
		opts.Watermark = nil
		return w.process(body, opts)
	}
	return nil, err
}

func permanentMedia(err error) (string, bool) {
	switch {
	case errors.Is(err, media.ErrUnsupported):
		return msgUnsupported, true
	case errors.Is(err, media.ErrAnimated):
		return msgAnimated, true
	case errors.Is(err, media.ErrTooManyPixels):
		return msgPixels, true
	case errors.Is(err, media.ErrDecode):
		return msgDecode, true
	}
	return "", false
}

func (w *Worker) failPermanently(ctx context.Context, id, msg string) error {
	if err := w.failPhoto(ctx, id, msg); err != nil {
		return err
	}
	return perm(msg)
}

func (w *Worker) putAll(ctx context.Context, id string, res *media.Result, wm *media.Watermark) error {
	for _, o := range res.Outputs {
		key := "d/" + id + "/" + res.DerivedHash + "/" + o.Key
		if err := w.store.Put(ctx, w.cfg.BucketDerived, key, o.Bytes, o.ContentType, cacheControl); err != nil {
			return err
		}
	}
	if res.WatermarkOutput != nil && wm != nil {
		key := "d/" + id + "/" + res.DerivedHash + "-wm" + media.WatermarkHash(*wm) + "/" + res.WatermarkOutput.Key
		if err := w.store.Put(ctx, w.cfg.BucketDerived, key, res.WatermarkOutput.Bytes, res.WatermarkOutput.ContentType, cacheControl); err != nil {
			return err
		}
	}
	return nil
}

// commitProcess writes the result in one tx, after re-checking the photo
// still exists and is processing. Location is written only in archive mode.
func (w *Worker) commitProcess(ctx context.Context, id string, res *media.Result, mode string) (commitOutcome, error) {
	tx, err := w.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	var status string
	err = tx.QueryRowContext(ctx, `SELECT status FROM photos WHERE id=?`, id).Scan(&status)
	if errors.Is(err, sql.ErrNoRows) {
		return commitGone, nil
	}
	if err != nil {
		return 0, err
	}
	if status != "processing" {
		return commitSkipped, nil
	}

	var lat, lon any
	if mode == media.LocationArchive && res.EXIF.Latitude != nil && res.EXIF.Longitude != nil {
		lat, lon = *res.EXIF.Latitude, *res.EXIF.Longitude
	}
	now := w.now()
	if _, err := tx.ExecContext(ctx, `UPDATE photos SET width=?, height=?, format=?, derived_hash=?,
		latitude=?, longitude=?, status='ready', error=NULL, updated_at=? WHERE id=? AND status='processing'`,
		res.Width, res.Height, res.Format, res.DerivedHash, lat, lon, now, id); err != nil {
		return 0, err
	}
	if err := upsertEXIF(ctx, tx, id, res.EXIF); err != nil {
		return 0, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO photo_histograms(photo_id,bins) VALUES(?,?)
		ON CONFLICT(photo_id) DO UPDATE SET bins=excluded.bins`, id, media.EncodeHistogram(res.Histogram)); err != nil {
		return 0, err
	}
	if w.cfg.ReplicaBucket != "" && w.replica != nil {
		if _, err := w.q.EnqueueTx(ctx, tx, kindReplicate, map[string]string{"photoId": id}); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return commitDone, nil
}

func upsertEXIF(ctx context.Context, tx *sql.Tx, id string, e media.EXIF) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO photo_exif(photo_id,camera_make,camera_model,lens_model,
		focal_length_mm,focal_length_35mm,aperture,exposure_time,exposure_seconds,iso,exposure_bias,taken_at)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(photo_id) DO UPDATE SET camera_make=excluded.camera_make,camera_model=excluded.camera_model,
		lens_model=excluded.lens_model,focal_length_mm=excluded.focal_length_mm,focal_length_35mm=excluded.focal_length_35mm,
		aperture=excluded.aperture,exposure_time=excluded.exposure_time,exposure_seconds=excluded.exposure_seconds,
		iso=excluded.iso,exposure_bias=excluded.exposure_bias,taken_at=excluded.taken_at`,
		id, nullStr(e.CameraMake), nullStr(e.CameraModel), nullStr(e.LensModel),
		nullF(e.FocalLengthMM), nullF(e.FocalLength35mm), nullF(e.Aperture),
		nullStr(e.ExposureTime), nullF(e.ExposureSeconds), nullI(e.ISO), nullF(e.ExposureBias), nullI(e.TakenAt))
	return err
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}
func nullF(p *float64) any {
	if p == nil {
		return nil
	}
	return *p
}
func nullI(p *int64) any {
	if p == nil {
		return nil
	}
	return *p
}

type photoMeta struct {
	owner, status, key, sha, salt, hash string
	format                              string
}

func (w *Worker) loadPhoto(ctx context.Context, id string) (photoMeta, error) {
	var m photoMeta
	var hash sql.NullString
	err := w.db.QueryRowContext(ctx, `SELECT owner_id,status,original_key,original_sha256,derived_salt,COALESCE(derived_hash,''),format
		FROM photos WHERE id=?`, id).Scan(&m.owner, &m.status, &m.key, &m.sha, &m.salt, &hash, &m.format)
	m.hash = hash.String
	return m, err
}

func (w *Worker) loadPrefs(ctx context.Context, owner string) (string, *media.Watermark, error) {
	var mode sql.NullString
	var wmJSON sql.NullString
	err := w.db.QueryRowContext(ctx, `SELECT location_mode, watermark FROM upload_prefs WHERE user_id=?`, owner).Scan(&mode, &wmJSON)
	if errors.Is(err, sql.ErrNoRows) {
		return media.LocationOff, nil, nil
	}
	if err != nil {
		return "", nil, err
	}
	loc := mode.String
	if loc == "" {
		loc = media.LocationOff
	}
	if !wmJSON.Valid || wmJSON.String == "" {
		return loc, nil, nil
	}
	var wm media.Watermark
	if err := json.Unmarshal([]byte(wmJSON.String), &wm); err != nil || wm.Validate() != nil {
		w.log.Warn("worker: ignoring invalid stored watermark")
		return loc, nil, nil
	}
	return loc, &wm, nil
}

func (w *Worker) maxBytes() int64 {
	mb := w.cfg.UploadMaxMB
	if mb <= 0 {
		mb = defaultMaxMB
	}
	return int64(mb) << 20
}

func sha256Hex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// --- rotate_derived ---

func (w *Worker) rotateDerived(ctx context.Context, raw json.RawMessage) error {
	id, err := photoID(raw)
	if err != nil {
		return err
	}
	row, err := w.loadPhoto(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return errNoop
		}
		return err
	}
	if row.status != "ready" {
		return errNoop
	}
	exposed, err := exposure.Photo(ctx, w.db, id)
	if err != nil {
		return err
	}
	if exposed {
		return errNoop
	}
	body, err := w.store.Get(ctx, w.cfg.BucketOriginals, row.key, w.maxBytes())
	if err != nil {
		return err
	}
	salt, err := newSalt()
	if err != nil {
		return err
	}
	mode, wm, err := w.loadPrefs(ctx, row.owner)
	if err != nil {
		return err
	}
	res, err := w.runProcess(body, media.Options{LocationMode: mode, MaxPixels: w.cfg.MaxPixels, Salt: salt, Watermark: wm})
	if err != nil {
		return err
	}
	if err := w.putAll(ctx, id, res, wm); err != nil {
		return err
	}
	old := row.hash
	prefixes, err := w.oldPrefixes(ctx, id, old)
	if err != nil {
		return err
	}
	outcome, err := w.commitRotate(ctx, id, salt, old, res.DerivedHash, prefixes)
	if err != nil {
		return err
	}
	switch outcome {
	case commitGone:
		return w.removeAll(ctx, id)
	case commitSkipped:
		// Re-exposed or changed meanwhile: drop only what this attempt
		// wrote under its fresh, never-published hash.
		if _, err := w.store.DeletePrefix(ctx, w.cfg.BucketDerived, "d/"+id+"/"+res.DerivedHash+"/"); err != nil {
			return err
		}
		if wm != nil {
			if _, err := w.store.DeletePrefix(ctx, w.cfg.BucketDerived, "d/"+id+"/"+res.DerivedHash+"-wm"+media.WatermarkHash(*wm)+"/"); err != nil {
				return err
			}
		}
		return errNoop
	}
	return nil
}

// oldPrefixes is every derived prefix of the old hash: the plain one and
// every -wm variant actually stored (the watermark may have changed since).
func (w *Worker) oldPrefixes(ctx context.Context, id, old string) ([]string, error) {
	if old == "" {
		return nil, nil
	}
	plain := "d/" + id + "/" + old + "/"
	out := []string{plain}
	keys, err := w.store.List(ctx, w.cfg.BucketDerived, "d/"+id+"/")
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{plain: true}
	for _, k := range keys {
		rest := strings.TrimPrefix(k, "d/"+id+"/")
		seg, _, ok := strings.Cut(rest, "/")
		if !ok || !strings.HasPrefix(seg, old+"-wm") {
			continue
		}
		pfx := "d/" + id + "/" + seg + "/"
		if !seen[pfx] && checkPurgePrefix(id, pfx) == nil {
			seen[pfx] = true
			out = append(out, pfx)
		}
	}
	return out, nil
}

// commitRotate swaps salt and hash in one tx after re-checking that the
// photo is still ready and still not exposed, and enqueues purge_derived
// for the old prefixes in the same tx, so the old objects are always
// cleaned up once the new hash is live.
func (w *Worker) commitRotate(ctx context.Context, id, salt, old, hash string, oldPrefixes []string) (commitOutcome, error) {
	if w.failCommit.CompareAndSwap(true, false) {
		return 0, errors.New("worker: injected commit failure")
	}
	tx, err := w.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	var status string
	var cur sql.NullString
	err = tx.QueryRowContext(ctx, `SELECT status, derived_hash FROM photos WHERE id=?`, id).Scan(&status, &cur)
	if errors.Is(err, sql.ErrNoRows) {
		return commitGone, nil
	}
	if err != nil {
		return 0, err
	}
	// A concurrent rotate committed first: this attempt's hash is never
	// published, so it is dropped (and its prefix deleted by the caller).
	if status != "ready" || cur.String != old {
		return commitSkipped, nil
	}
	exposed, err := exposure.Photo(ctx, tx, id)
	if err != nil {
		return 0, err
	}
	if exposed {
		return commitSkipped, nil
	}
	if _, err := tx.ExecContext(ctx, `UPDATE photos SET derived_salt=?, derived_hash=?, updated_at=? WHERE id=? AND status='ready'`,
		salt, hash, w.now(), id); err != nil {
		return 0, err
	}
	if len(oldPrefixes) > 0 {
		if _, err := w.q.EnqueueTx(ctx, tx, kindPurge, map[string]any{"photoId": id, "prefixes": oldPrefixes}); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return commitDone, nil
}

func newSalt() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// --- purge_derived ---

// purgeDerived deletes and CDN-purges every derived prefix of a photo that
// is not its current hash. The stale set is listed at run time, so prefixes
// orphaned by a crashed or superseded rotate are cleaned up too. Objects go
// first, so a CDN refetch after the purge finds nothing. Idempotent.
func (w *Worker) purgeDerived(ctx context.Context, raw json.RawMessage) error {
	p, err := parsePurge(raw)
	if err != nil {
		return err
	}
	var cur sql.NullString
	err = w.db.QueryRowContext(ctx, `SELECT derived_hash FROM photos WHERE id=?`, p.PhotoID).Scan(&cur)
	if errors.Is(err, sql.ErrNoRows) {
		// Deleted photos are handled by delete_photo_objects.
		return errNoop
	}
	if err != nil {
		return err
	}
	head := "d/" + p.PhotoID + "/"
	keys, err := w.store.List(ctx, w.cfg.BucketDerived, head)
	if err != nil {
		return err
	}
	seen := map[string]bool{}
	var stale []string
	// The payload's prefixes (already validated) are always included, so
	// a retry after a failed CDN purge still purges prefixes whose objects
	// were deleted on the previous attempt.
	for _, pfx := range p.Prefixes {
		seg := strings.TrimSuffix(strings.TrimPrefix(pfx, head), "/")
		hash, _, _ := strings.Cut(seg, "-wm")
		if seen[pfx] || (cur.Valid && hash == cur.String) {
			continue
		}
		seen[pfx] = true
		stale = append(stale, pfx)
	}
	for _, k := range keys {
		seg, _, ok := strings.Cut(strings.TrimPrefix(k, head), "/")
		if !ok {
			continue
		}
		pfx := head + seg + "/"
		if seen[pfx] {
			continue
		}
		seen[pfx] = true
		hash, _, _ := strings.Cut(seg, "-wm")
		if cur.Valid && hash == cur.String {
			continue
		}
		if checkPurgePrefix(p.PhotoID, pfx) != nil {
			w.log.Warn("worker: skipping unexpected derived prefix", "photo", p.PhotoID)
			continue
		}
		stale = append(stale, pfx)
	}
	if len(stale) == 0 {
		return errNoop
	}
	for _, pfx := range stale {
		if _, err := w.store.DeletePrefix(ctx, w.cfg.BucketDerived, pfx); err != nil {
			return err
		}
	}
	return w.cdn.PurgePrefixes(ctx, stale)
}

// --- delete_photo_objects ---

func (w *Worker) deletePhotoObjects(ctx context.Context, raw json.RawMessage) error {
	p, err := parseDelete(raw)
	if err != nil {
		return err
	}
	if err := w.store.Delete(ctx, w.cfg.BucketOriginals, p.OriginalKey); err != nil {
		return err
	}
	if w.replica != nil && w.cfg.ReplicaBucket != "" {
		if err := w.replica.Delete(ctx, w.cfg.ReplicaBucket, p.OriginalKey); err != nil {
			return err
		}
	}
	if _, err := w.store.DeletePrefix(ctx, w.cfg.BucketDerived, p.DerivedPrefix); err != nil {
		return err
	}
	if err := w.cdn.PurgePrefixes(ctx, []string{p.DerivedPrefix}); err != nil {
		return err
	}
	if !p.Sweep {
		when := w.now() + DeleteSweepDelay.Milliseconds()
		payload := map[string]any{"photoId": p.PhotoID, "originalKey": p.OriginalKey, "derivedPrefix": p.DerivedPrefix, "sweep": true}
		if _, err := w.q.EnqueueAt(ctx, kindDelete, payload, when); err != nil {
			return err
		}
	}
	return nil
}

// --- replicate_original ---

func (w *Worker) replicateOriginal(ctx context.Context, raw json.RawMessage) error {
	if w.replica == nil || w.cfg.ReplicaBucket == "" {
		return errNoop
	}
	id, err := photoID(raw)
	if err != nil {
		return err
	}
	row, err := w.loadPhoto(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return errNoop
		}
		return err
	}
	if row.status != "ready" && row.status != "processing" {
		return errNoop
	}
	// Get from the primary and Put to the replica, which may be another
	// endpoint, so a server-side copy is not assumed.
	body, err := w.store.Get(ctx, w.cfg.BucketOriginals, row.key, w.maxBytes())
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			return errNoop
		}
		return err
	}
	return w.replica.Put(ctx, w.cfg.ReplicaBucket, row.key, body, contentType(row.format), "")
}

func contentType(format string) string {
	switch format {
	case "jpeg":
		return "image/jpeg"
	case "png":
		return "image/png"
	case "webp":
		return "image/webp"
	}
	return "application/octet-stream"
}

// --- cleanup_uploads ---

func (w *Worker) scheduleCleanup(ctx context.Context) error {
	var n int
	if err := w.db.QueryRowContext(ctx, `SELECT count(*) FROM jobs WHERE kind=? AND state IN ('queued','running')`, kindCleanup).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	_, err := w.q.Enqueue(ctx, kindCleanup, struct{}{})
	return err
}

func (w *Worker) cleanupUploads(ctx context.Context) error {
	now := w.now()
	upCut := now - staleUploadAge.Milliseconds()
	failCut := now - staleFailedAge.Milliseconds()

	rows, err := w.db.QueryContext(ctx, `SELECT id, original_key FROM photos
		WHERE (status='uploading' AND updated_at<?) OR (status='failed' AND updated_at<?)`, upCut, failCut)
	if err != nil {
		return err
	}
	type row struct{ id, key string }
	var stale []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.id, &r.key); err != nil {
			rows.Close()
			return err
		}
		stale = append(stale, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	for _, r := range stale {
		tx, err := w.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		// The full age predicate is repeated: a row reused (bumped to a
		// fresh uploading) since the SELECT must survive.
		res, err := tx.ExecContext(ctx, `DELETE FROM photos WHERE id=?
			AND ((status='uploading' AND updated_at<?) OR (status='failed' AND updated_at<?))`, r.id, upCut, failCut)
		if err != nil {
			tx.Rollback()
			return err
		}
		if n, _ := res.RowsAffected(); n == 1 {
			payload := map[string]any{"photoId": r.id, "originalKey": r.key, "derivedPrefix": "d/" + r.id + "/"}
			if _, err := w.q.EnqueueTx(ctx, tx, kindDelete, payload); err != nil {
				tx.Rollback()
				return err
			}
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}

	if _, err := w.q.PurgeDone(ctx, now-purgeJobAge.Milliseconds()); err != nil {
		return err
	}

	// Schedule the next hourly pass unless one is already queued.
	var n int
	if err := w.db.QueryRowContext(ctx, `SELECT count(*) FROM jobs WHERE kind=? AND state='queued'`, kindCleanup).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		if _, err := w.q.EnqueueAt(ctx, kindCleanup, struct{}{}, now+cleanupEvery.Milliseconds()); err != nil {
			return err
		}
	}
	return nil
}

// FailNextCommit makes the next rotate commit fail once with a transient
// error, after the new objects are written. It is a test hook that
// simulates a crash between putAll and the commit.
func (w *Worker) FailNextCommit() { w.failCommit.Store(true) }
