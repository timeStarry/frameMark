package worker_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"log/slog"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/timeStarry/frameMark/internal/cdn"
	"github.com/timeStarry/frameMark/internal/config"
	"github.com/timeStarry/frameMark/internal/db"
	"github.com/timeStarry/frameMark/internal/jobs"
	"github.com/timeStarry/frameMark/internal/media"
	"github.com/timeStarry/frameMark/internal/storage"
	"github.com/timeStarry/frameMark/internal/worker"
)

const (
	t0        = int64(1_700_000_000_000)
	origB     = "originals"
	derB      = "derived"
	replB     = "replica"
	owner     = "01890000-0000-7000-8000-000000000001"
	immutable = "public, max-age=31536000, immutable"
	hour      = int64(3_600_000)
)

// --- fake storage ---

type object struct {
	body       []byte
	ct, cc     string
	putCounter int
}

type fakeStore struct {
	mu      sync.Mutex
	objects map[string]object // bucket + "/" + key
	putErr  func(bucket, key string) error
	gets    int
}

func newStore() *fakeStore { return &fakeStore{objects: map[string]object{}} }

func (f *fakeStore) Get(_ context.Context, bucket, key string, maxBytes int64) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.gets++
	o, ok := f.objects[bucket+"/"+key]
	if !ok {
		return nil, storage.ErrNotFound
	}
	if int64(len(o.body)) > maxBytes {
		return nil, storage.ErrTooLarge
	}
	return append([]byte(nil), o.body...), nil
}

func (f *fakeStore) Put(_ context.Context, bucket, key string, body []byte, ct, cc string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.putErr != nil {
		if err := f.putErr(bucket, key); err != nil {
			return err
		}
	}
	f.objects[bucket+"/"+key] = object{body: append([]byte(nil), body...), ct: ct, cc: cc}
	return nil
}

func (f *fakeStore) Delete(_ context.Context, bucket, key string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.objects, bucket+"/"+key)
	return nil
}

func (f *fakeStore) DeletePrefix(_ context.Context, bucket, prefix string) (int, error) {
	if prefix == "" || !strings.HasSuffix(prefix, "/") {
		return 0, errors.New("bad prefix")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for k := range f.objects {
		if strings.HasPrefix(k, bucket+"/"+prefix) {
			delete(f.objects, k)
			n++
		}
	}
	return n, nil
}

func (f *fakeStore) List(_ context.Context, bucket, prefix string) ([]string, error) {
	if prefix == "" || !strings.HasSuffix(prefix, "/") {
		return nil, errors.New("bad prefix")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for k := range f.objects {
		if strings.HasPrefix(k, bucket+"/"+prefix) {
			out = append(out, strings.TrimPrefix(k, bucket+"/"))
		}
	}
	sort.Strings(out)
	return out, nil
}

func (f *fakeStore) put(bucket, key string, body []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.objects[bucket+"/"+key] = object{body: body}
}

func (f *fakeStore) get(bucket, key string) (object, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	o, ok := f.objects[bucket+"/"+key]
	return o, ok
}

func (f *fakeStore) keys(bucket, prefix string) []string {
	ks, _ := f.List(context.Background(), bucket, prefix)
	return ks
}

func (e *env) derivedHashes(id string) []string {
	e.t.Helper()
	seen := map[string]struct{}{}
	for _, k := range e.st.keys(derB, "d/"+id+"/") {
		rest := strings.TrimPrefix(k, "d/"+id+"/")
		seg, _, _ := strings.Cut(rest, "/")
		hash, _, _ := strings.Cut(seg, "-wm")
		if hash != "" {
			seen[hash] = struct{}{}
		}
	}
	out := make([]string, 0, len(seen))
	for h := range seen {
		out = append(out, h)
	}
	sort.Strings(out)
	return out
}

// --- env ---

type env struct {
	t     *testing.T
	d     *sql.DB
	q     *jobs.Queue
	st    *fakeStore
	repl  *fakeStore
	cdn   *cdn.Fake
	now   atomic.Int64
	cfg   config.Config
	w     *worker.Worker
	procs atomic.Pointer[func([]byte, media.Options) (*media.Result, error)]
}

func newEnv(t *testing.T, mod func(*env, *config.Config, *worker.Deps)) *env {
	t.Helper()
	d, err := db.Open(filepath.Join(t.TempDir(), "markr.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	if err := db.Migrate(d); err != nil {
		t.Fatal(err)
	}
	e := &env{t: t, d: d, st: newStore(), repl: newStore(), cdn: &cdn.Fake{}}
	e.now.Store(t0)
	e.q = jobs.New(d, e.now.Load)
	e.cfg = config.Config{BucketOriginals: origB, BucketDerived: derB, UploadMaxMB: 2, Workers: 1}
	deps := worker.Deps{
		DB: d, Jobs: e.q, Storage: e.st, CDN: e.cdn, Now: e.now.Load,
		Log:     slog.New(slog.NewTextHandler(io.Discard, nil)),
		Process: func(b []byte, o media.Options) (*media.Result, error) { return (*e.procs.Load())(b, o) },
	}
	real := media.Process
	e.procs.Store(&real)
	if mod != nil {
		mod(e, &e.cfg, &deps)
	}
	deps.Cfg = e.cfg
	e.w = worker.New(deps)
	e.exec(`INSERT INTO users(id,email,password,created_at) VALUES(?,?,?,?)`, owner, "a@example.com", "!", t0)
	return e
}

func withReplica(e *env, c *config.Config, d *worker.Deps) {
	c.ReplicaBucket = replB
	d.Replica = e.repl
}

func (e *env) setProcess(fn func([]byte, media.Options) (*media.Result, error)) { e.procs.Store(&fn) }

func (e *env) exec(q string, args ...any) {
	e.t.Helper()
	if _, err := e.d.Exec(q, args...); err != nil {
		e.t.Fatal(err)
	}
}

func sum(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

var idSeq atomic.Int64

func newID() string {
	n := idSeq.Add(1) + 100
	return "01890000-0000-7000-8000-" + strings.Repeat("0", 12-len(itoa(n))) + itoa(n) + ""
}

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

// addPhoto inserts a photo row and stores body as its original.
func (e *env) addPhoto(status string, body []byte) string {
	e.t.Helper()
	id := newID()
	key := "o/" + owner + "/" + id
	e.exec(`INSERT INTO photos(id,owner_id,status,original_key,original_sha256,original_bytes,format,public_fields,
		histogram_public,original_download,derived_salt,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		id, owner, status, key, sum(body), len(body), "jpeg", `["iso"]`, 0, 0, "salt0", t0, t0)
	e.st.put(origB, key, body)
	return id
}

func (e *env) prefs(location string, wm string) {
	var w any
	if wm != "" {
		w = wm
	}
	e.exec(`INSERT INTO upload_prefs(user_id,public_fields,location_mode,watermark,updated_at) VALUES(?,?,?,?,?)
		ON CONFLICT(user_id) DO UPDATE SET location_mode=excluded.location_mode, watermark=excluded.watermark`,
		owner, `[]`, location, w, t0)
}

func (e *env) enqueue(kind string, payload any) string {
	e.t.Helper()
	id, err := e.q.Enqueue(context.Background(), kind, payload)
	if err != nil {
		e.t.Fatal(err)
	}
	return id
}

// runOne claims and runs one job synchronously; it fails the test if none is due.
func (e *env) runOne() {
	e.t.Helper()
	ran, err := e.w.RunOnce(context.Background())
	if err != nil {
		e.t.Fatal(err)
	}
	if !ran {
		e.t.Fatal("no job was due")
	}
}

type photoRow struct {
	status        string
	err           sql.NullString
	hash          sql.NullString
	salt          string
	width, height sql.NullInt64
	lat, lon      sql.NullFloat64
	format        string
}

func (e *env) photo(id string) (photoRow, bool) {
	e.t.Helper()
	var p photoRow
	err := e.d.QueryRow(`SELECT status,error,derived_hash,derived_salt,width,height,latitude,longitude,format FROM photos WHERE id=?`, id).
		Scan(&p.status, &p.err, &p.hash, &p.salt, &p.width, &p.height, &p.lat, &p.lon, &p.format)
	if errors.Is(err, sql.ErrNoRows) {
		return p, false
	}
	if err != nil {
		e.t.Fatal(err)
	}
	return p, true
}

type jobRow struct {
	id, kind, state, payload string
	attempts                 int
	runAfter                 int64
	lastErr                  sql.NullString
}

func (e *env) jobs(kind string) []jobRow {
	e.t.Helper()
	rows, err := e.d.Query(`SELECT id,kind,state,payload,attempts,run_after,last_error FROM jobs WHERE kind=? ORDER BY created_at, id`, kind)
	if err != nil {
		e.t.Fatal(err)
	}
	defer rows.Close()
	var out []jobRow
	for rows.Next() {
		var j jobRow
		if err := rows.Scan(&j.id, &j.kind, &j.state, &j.payload, &j.attempts, &j.runAfter, &j.lastErr); err != nil {
			e.t.Fatal(err)
		}
		out = append(out, j)
	}
	return out
}

func (e *env) jobState(id string) string {
	e.t.Helper()
	var s string
	if err := e.d.QueryRow(`SELECT state FROM jobs WHERE id=?`, id).Scan(&s); err != nil {
		e.t.Fatal(err)
	}
	return s
}

// --- fixtures ---

// testJPEG is a 64x48 gradient JPEG. With gps, it carries an EXIF APP1 with
// Make "Sony", ISO 400 and a GPS IFD at 35N 139E.
func testJPEG(t *testing.T, gps bool) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 64, 48))
	for y := 0; y < 48; y++ {
		for x := 0; x < 64; x++ {
			img.Set(x, y, color.RGBA{uint8(x * 4), uint8(y * 5), 128, 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatal(err)
	}
	b := buf.Bytes()
	if !gps {
		return b
	}
	payload := append([]byte("Exif\x00\x00"), exifTIFF()...)
	seg := []byte{0xFF, 0xE1, 0, 0}
	binary.BigEndian.PutUint16(seg[2:], uint16(len(payload)+2))
	out := append([]byte{0xFF, 0xD8}, seg...)
	out = append(out, payload...)
	return append(out, b[2:]...)
}

// exifTIFF builds a big-endian TIFF: IFD0 {Make, ExifIFD, GPSIFD},
// Exif {ISO}, GPS {LatRef N, Lat 35/1 0/1 0/1, LonRef E, Lon 139/1 0/1 0/1}.
func exifTIFF() []byte {
	be := binary.BigEndian
	type ent struct {
		tag, typ uint16
		count    uint32
		val      []byte // inline if <= 4 bytes
	}
	u32 := func(v uint32) []byte { b := make([]byte, 4); be.PutUint32(b, v); return b }
	u16 := func(v uint16) []byte { b := make([]byte, 4); be.PutUint16(b, v); return b }
	rat3 := func(a uint32) []byte {
		var b []byte
		for _, v := range []uint32{a, 1, 0, 1, 0, 1} {
			b = append(b, u32(v)...)
		}
		return b
	}
	ifdSize := func(n int) int { return 2 + 12*n + 4 }

	// Layout: header(8) | IFD0 | Exif IFD | GPS IFD | data area.
	ifd0Off := 8
	exifOff := ifd0Off + ifdSize(3)
	gpsOff := exifOff + ifdSize(1)
	dataOff := gpsOff + ifdSize(4)

	var data []byte
	place := func(v []byte) uint32 {
		off := dataOff + len(data)
		data = append(data, v...)
		return uint32(off)
	}
	mk := place([]byte("Sony\x00"))
	lat := place(rat3(35))
	lon := place(rat3(139))

	ifd0 := []ent{
		{0x010F, 2, 5, u32(mk)},
		{0x8769, 4, 1, u32(uint32(exifOff))},
		{0x8825, 4, 1, u32(uint32(gpsOff))},
	}
	exif := []ent{{0x8827, 3, 1, u16(400)}}
	gpsE := []ent{
		{1, 2, 2, []byte{'N', 0, 0, 0}},
		{2, 5, 3, u32(lat)},
		{3, 2, 2, []byte{'E', 0, 0, 0}},
		{4, 5, 3, u32(lon)},
	}
	enc := func(es []ent) []byte {
		b := make([]byte, 2)
		be.PutUint16(b, uint16(len(es)))
		for _, e := range es {
			x := make([]byte, 12)
			be.PutUint16(x[0:], e.tag)
			be.PutUint16(x[2:], e.typ)
			be.PutUint32(x[4:], e.count)
			copy(x[8:], e.val)
			b = append(b, x...)
		}
		return append(b, 0, 0, 0, 0)
	}
	out := []byte{'M', 'M', 0, 42}
	out = append(out, u32(uint32(ifd0Off))...)
	out = append(out, enc(ifd0)...)
	out = append(out, enc(exif)...)
	out = append(out, enc(gpsE)...)
	return append(out, data...)
}

// --- process_photo ---

func assertDerived(t *testing.T, e *env, id, hash string) {
	t.Helper()
	keys := e.st.keys(derB, "d/"+id+"/"+hash+"/")
	if len(keys) != 12 {
		t.Fatalf("derived keys = %v", keys)
	}
	for _, k := range keys {
		o, _ := e.st.get(derB, k)
		if o.cc != immutable || o.ct == "" || len(o.body) == 0 {
			t.Errorf("%s: cc=%q ct=%q len=%d", k, o.cc, o.ct, len(o.body))
		}
	}
	if o, ok := e.st.get(derB, "d/"+id+"/"+hash+"/w480.avif"); !ok || o.ct != "image/avif" {
		t.Errorf("w480.avif missing or wrong type: %+v", o.ct)
	}
}

func TestProcessPhotoLocationOff(t *testing.T) {
	e := newEnv(t, nil)
	e.prefs("off", "")
	body := testJPEG(t, true)
	id := e.addPhoto("processing", body)
	jid := e.enqueue("process_photo", map[string]string{"photoId": id})
	e.runOne()

	if s := e.jobState(jid); s != "done" {
		t.Fatalf("job state %s", s)
	}
	p, _ := e.photo(id)
	want := media.DerivedHash(sum(body), "salt0")
	if p.status != "ready" || p.err.Valid || p.hash.String != want || p.width.Int64 != 64 || p.height.Int64 != 48 || p.format != "jpeg" {
		t.Fatalf("photo = %+v, want hash %s", p, want)
	}
	if p.lat.Valid || p.lon.Valid {
		t.Fatalf("location written with location_mode=off: %v %v", p.lat, p.lon)
	}
	var mk sql.NullString
	var iso sql.NullInt64
	if err := e.d.QueryRow(`SELECT camera_make,iso FROM photo_exif WHERE photo_id=?`, id).Scan(&mk, &iso); err != nil {
		t.Fatal(err)
	}
	if mk.String != "Sony" || iso.Int64 != 400 {
		t.Fatalf("exif = %v %v", mk, iso)
	}
	var bins []byte
	if err := e.d.QueryRow(`SELECT bins FROM photo_histograms WHERE photo_id=?`, id).Scan(&bins); err != nil || len(bins) != media.HistogramBytes {
		t.Fatalf("histogram %d bytes, %v", len(bins), err)
	}
	assertDerived(t, e, id, want)
	if js := e.jobs("replicate_original"); len(js) != 0 {
		t.Fatalf("replicate enqueued without a replica: %v", js)
	}

	// Re-running a finished photo is a no-op.
	e.enqueue("process_photo", map[string]string{"photoId": id})
	gets := e.st.gets
	e.runOne()
	if e.st.gets != gets {
		t.Fatal("ready photo was reprocessed")
	}
}

func TestProcessPhotoArchiveAndReplica(t *testing.T) {
	e := newEnv(t, withReplica)
	e.prefs("archive", "")
	id := e.addPhoto("processing", testJPEG(t, true))
	e.enqueue("process_photo", map[string]string{"photoId": id})
	e.runOne()
	p, _ := e.photo(id)
	if p.status != "ready" || !p.lat.Valid || !p.lon.Valid || p.lat.Float64 < 34.9 || p.lon.Float64 < 138.9 {
		t.Fatalf("archive location = %+v", p)
	}
	js := e.jobs("replicate_original")
	if len(js) != 1 || js[0].state != "queued" {
		t.Fatalf("replicate jobs = %+v", js)
	}
	e.runOne()
	key := "o/" + owner + "/" + id
	src, _ := e.st.get(origB, key)
	dst, ok := e.repl.get(replB, key)
	if !ok || !bytes.Equal(src.body, dst.body) {
		t.Fatal("original not replicated")
	}
	if s := e.jobs("replicate_original")[0].state; s != "done" {
		t.Fatalf("replicate state %s", s)
	}
}

func TestReplicateNoopWithoutReplica(t *testing.T) {
	e := newEnv(t, nil)
	id := e.addPhoto("ready", testJPEG(t, false))
	jid := e.enqueue("replicate_original", map[string]string{"photoId": id})
	e.runOne()
	if s := e.jobState(jid); s != "done" {
		t.Fatalf("state %s", s)
	}
}

const wmJSON = `{"text":"© Jane","position":"br","opacity":0.5,"scale":0.05}`

func wmHash() string {
	return media.WatermarkHash(media.Watermark{Text: "© Jane", Position: "br", Opacity: 0.5, Scale: 0.05})
}

func TestProcessPhotoWatermark(t *testing.T) {
	e := newEnv(t, nil)
	e.prefs("off", wmJSON)
	body := testJPEG(t, false)
	id := e.addPhoto("processing", body)
	e.enqueue("process_photo", map[string]string{"photoId": id})
	e.runOne()
	hash := media.DerivedHash(sum(body), "salt0")
	o, ok := e.st.get(derB, "d/"+id+"/"+hash+"-wm"+wmHash()+"/w2400.jpg")
	if !ok || o.ct != "image/jpeg" || o.cc != immutable {
		t.Fatalf("watermark variant missing: %+v %v", o.ct, ok)
	}
}

func TestProcessPhotoErrWatermarkFallsBack(t *testing.T) {
	e := newEnv(t, nil)
	e.prefs("off", wmJSON)
	var calls atomic.Int32
	e.setProcess(func(b []byte, o media.Options) (*media.Result, error) {
		calls.Add(1)
		if o.Watermark != nil {
			return nil, media.ErrWatermark
		}
		return media.Process(b, o)
	})
	body := testJPEG(t, false)
	id := e.addPhoto("processing", body)
	jid := e.enqueue("process_photo", map[string]string{"photoId": id})
	e.runOne()
	p, _ := e.photo(id)
	if p.status != "ready" || e.jobState(jid) != "done" || calls.Load() != 2 {
		t.Fatalf("status %s job %s calls %d", p.status, e.jobState(jid), calls.Load())
	}
	for _, k := range e.st.keys(derB, "d/"+id+"/") {
		if strings.Contains(k, "-wm") {
			t.Fatalf("watermark variant written: %s", k)
		}
	}
	assertDerived(t, e, id, p.hash.String)
}

func TestProcessPhotoPermanentFailures(t *testing.T) {
	cases := []struct {
		name string
		body []byte
		fake error
		msg  string
	}{
		{"unsupported", []byte("not an image at all"), nil, "不支持的图片格式。"},
		{"decode", nil, media.ErrDecode, "图片无法解码。"},
		{"animated", nil, media.ErrAnimated, "不支持动图。"},
		{"pixels", nil, media.ErrTooManyPixels, "图片像素超过上限。"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := newEnv(t, nil)
			body := c.body
			if body == nil {
				body = testJPEG(t, false)
				fake := c.fake
				e.setProcess(func([]byte, media.Options) (*media.Result, error) { return nil, fake })
			}
			id := e.addPhoto("processing", body)
			jid := e.enqueue("process_photo", map[string]string{"photoId": id})
			e.runOne()
			p, _ := e.photo(id)
			if p.status != "failed" || p.err.String != c.msg {
				t.Fatalf("photo = %s %q", p.status, p.err.String)
			}
			if s := e.jobState(jid); s != "dead" {
				t.Fatalf("job %s", s)
			}
			if ks := e.st.keys(derB, "d/"+id+"/"); len(ks) != 0 {
				t.Fatalf("objects written: %v", ks)
			}
		})
	}
}

func TestProcessPhotoSHAMismatch(t *testing.T) {
	e := newEnv(t, nil)
	id := e.addPhoto("processing", testJPEG(t, false))
	e.st.put(origB, "o/"+owner+"/"+id, testJPEG(t, true)) // different bytes
	jid := e.enqueue("process_photo", map[string]string{"photoId": id})
	e.runOne()
	p, _ := e.photo(id)
	if p.status != "failed" || p.err.String != "原图校验失败。" || e.jobState(jid) != "dead" {
		t.Fatalf("photo %s %q job %s", p.status, p.err.String, e.jobState(jid))
	}
}

func TestProcessPhotoOriginalMissingOrTooLarge(t *testing.T) {
	e := newEnv(t, nil)
	missing := e.addPhoto("processing", testJPEG(t, false))
	e.st.Delete(context.Background(), origB, "o/"+owner+"/"+missing)
	big := e.addPhoto("processing", testJPEG(t, true))
	e.st.put(origB, "o/"+owner+"/"+big, make([]byte, 3<<20)) // UploadMaxMB is 2
	for id, msg := range map[string]string{missing: "原图缺失，请重新上传。", big: "原图超过大小上限。"} {
		jid := e.enqueue("process_photo", map[string]string{"photoId": id})
		e.runOne()
		p, _ := e.photo(id)
		if p.status != "failed" || p.err.String != msg || e.jobState(jid) != "dead" {
			t.Errorf("photo %s: %s %q job %s", id, p.status, p.err.String, e.jobState(jid))
		}
	}
}

func TestProcessPhotoMissingOrNotProcessingIsNoop(t *testing.T) {
	e := newEnv(t, nil)
	j1 := e.enqueue("process_photo", map[string]string{"photoId": newID()})
	e.runOne()
	id := e.addPhoto("uploading", testJPEG(t, false))
	j2 := e.enqueue("process_photo", map[string]string{"photoId": id})
	e.runOne()
	if e.jobState(j1) != "done" || e.jobState(j2) != "done" {
		t.Fatal("no-op jobs must be done")
	}
	if p, _ := e.photo(id); p.status != "uploading" {
		t.Fatalf("status changed to %s", p.status)
	}
}

func TestProcessPhotoBadPayloadIsPermanent(t *testing.T) {
	e := newEnv(t, nil)
	jid := e.enqueue("process_photo", map[string]string{"photoId": "../../x"})
	e.runOne()
	if s := e.jobState(jid); s != "dead" {
		t.Fatalf("state %s", s)
	}
}

func TestProcessPhotoDeletedDuringProcessing(t *testing.T) {
	e := newEnv(t, nil)
	body := testJPEG(t, false)
	id := e.addPhoto("processing", body)
	e.setProcess(func(b []byte, o media.Options) (*media.Result, error) {
		r, err := media.Process(b, o)
		if _, derr := e.d.Exec(`DELETE FROM photos WHERE id=?`, id); derr != nil {
			t.Error(derr)
		}
		return r, err
	})
	jid := e.enqueue("process_photo", map[string]string{"photoId": id})
	e.runOne()
	if e.jobState(jid) != "done" {
		t.Fatal("job must be done")
	}
	if ks := e.st.keys(derB, "d/"+id+"/"); len(ks) != 0 {
		t.Fatalf("orphan derived objects: %v", ks)
	}
	if _, ok := e.photo(id); ok {
		t.Fatal("photo resurrected")
	}
}

func TestProcessPhotoStorageErrorRetriesThenDeadHook(t *testing.T) {
	e := newEnv(t, nil)
	e.st.putErr = func(string, string) error { return errors.New("storage: put: transport error") }
	id := e.addPhoto("processing", testJPEG(t, false))
	jid := e.enqueue("process_photo", map[string]string{"photoId": id})
	for i := 1; i <= jobs.MaxAttempts; i++ {
		e.runOne()
		p, _ := e.photo(id)
		if i < jobs.MaxAttempts {
			if p.status != "processing" || e.jobState(jid) != "queued" {
				t.Fatalf("attempt %d: photo %s job %s", i, p.status, e.jobState(jid))
			}
			e.now.Add(jobs.BaseBackoffMillis << (i - 1))
		}
	}
	p, _ := e.photo(id)
	if e.jobState(jid) != "dead" || p.status != "failed" || p.err.String != "处理失败，请重新上传。" {
		t.Fatalf("job %s photo %s %q", e.jobState(jid), p.status, p.err.String)
	}
}

func TestReconcileDeadProcessJobsAtStartup(t *testing.T) {
	e := newEnv(t, nil)
	stale := e.addPhoto("processing", testJPEG(t, false))
	live := e.addPhoto("processing", testJPEG(t, true))
	insertDead := func(photo string) {
		e.exec(`INSERT INTO jobs(id,kind,payload,state,attempts,run_after,created_at,finished_at)
			VALUES(?,?,?,?,?,?,?,?)`, newID(), "process_photo", `{"photoId":"`+photo+`"}`, "dead", 5, t0, t0, t0)
	}
	insertDead(stale)
	insertDead(live)
	// live has a newer attempt queued (photo reused after the old failure).
	e.enqueue("process_photo", map[string]string{"photoId": live})

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // Run does its startup work, then returns at once.
	if err := e.w.Run(ctx); err != nil {
		t.Fatal(err)
	}
	if p, _ := e.photo(stale); p.status != "failed" || p.err.String != "处理失败，请重新上传。" {
		t.Fatalf("stale = %s %q", p.status, p.err.String)
	}
	if p, _ := e.photo(live); p.status != "processing" {
		t.Fatalf("live photo with a queued job was failed: %s", p.status)
	}
}

// --- rotate_derived ---

// readyPhoto processes a photo to ready (with a watermark) and returns its id and hash.
func readyPhoto(t *testing.T, e *env) (string, string) {
	t.Helper()
	e.prefs("off", wmJSON)
	id := e.addPhoto("processing", testJPEG(t, false))
	e.enqueue("process_photo", map[string]string{"photoId": id})
	e.runOne()
	p, _ := e.photo(id)
	if p.status != "ready" {
		t.Fatalf("setup: %s %q", p.status, p.err.String)
	}
	return id, p.hash.String
}

func (e *env) collection(photo, status, vis string) {
	cid, fid := newID(), newID()
	e.exec(`INSERT INTO collections(id,owner_id,status,visibility,wall_rank,created_at,updated_at) VALUES(?,?,?,?,0,?,?)`,
		cid, owner, status, vis, t0, t0)
	e.exec(`INSERT INTO frames(id,collection_id,position,layout) VALUES(?,?,0,'full')`, fid, cid)
	e.exec(`INSERT INTO frame_photos(frame_id,slot,photo_id) VALUES(?,0,?)`, fid, photo)
}

func TestRotateSkipsWhileExposed(t *testing.T) {
	for _, vis := range []string{"public", "unlisted"} {
		t.Run(vis, func(t *testing.T) {
			e := newEnv(t, nil)
			id, hash := readyPhoto(t, e)
			e.collection(id, "published", vis)
			jid := e.enqueue("rotate_derived", map[string]string{"photoId": id})
			e.runOne()
			p, _ := e.photo(id)
			if e.jobState(jid) != "done" || p.hash.String != hash || p.salt != "salt0" {
				t.Fatalf("rotated while exposed: %+v", p)
			}
			if len(e.cdn.Prefixes()) != 0 {
				t.Fatalf("purged: %v", e.cdn.Prefixes())
			}
		})
	}
}

func TestRotateWhenWithdrawn(t *testing.T) {
	e := newEnv(t, nil)
	id, old := readyPhoto(t, e)
	e.collection(id, "draft", "public")      // not exposure
	e.collection(id, "published", "private") // not exposure either
	jid := e.enqueue("rotate_derived", map[string]string{"photoId": id})
	e.runOne()

	p, _ := e.photo(id)
	if e.jobState(jid) != "done" || p.status != "ready" {
		t.Fatalf("job %s status %s", e.jobState(jid), p.status)
	}
	if p.hash.String == old || len(p.salt) != 32 || p.salt == "salt0" {
		t.Fatalf("hash/salt not rotated: %+v", p)
	}
	body, _ := e.st.get(origB, "o/"+owner+"/"+id)
	if p.hash.String != media.DerivedHash(sum(body.body), p.salt) {
		t.Fatal("hash does not match the new salt")
	}
	assertDerived(t, e, id, p.hash.String)
	if _, ok := e.st.get(derB, "d/"+id+"/"+p.hash.String+"-wm"+wmHash()+"/w2400.jpg"); !ok {
		t.Fatal("new watermark variant missing")
	}
	// The old prefixes are deleted and purged by the purge_derived job
	// committed together with the new hash.
	pj := e.jobs("purge_derived")
	if len(pj) != 1 || pj[0].state != "queued" {
		t.Fatalf("purge_derived = %+v", pj)
	}
	e.runOne()
	for _, k := range e.st.keys(derB, "d/"+id+"/") {
		if strings.Contains(k, "/"+old) {
			t.Fatalf("old object left: %s", k)
		}
	}
	got := e.cdn.Prefixes()
	sort.Strings(got)
	want := []string{"d/" + id + "/" + old + "-wm" + wmHash() + "/", "d/" + id + "/" + old + "/"}
	sort.Strings(want)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("purged %v, want %v", got, want)
	}

	// A second rotate (duplicate job) rotates again and cleans the previous hash.
	mid := p.hash.String
	e.enqueue("rotate_derived", map[string]string{"photoId": id})
	e.runOne()
	e.runOne()
	p2, _ := e.photo(id)
	if p2.hash.String == mid {
		t.Fatal("second rotate did not rotate")
	}
	for _, k := range e.st.keys(derB, "d/"+id+"/") {
		if !strings.HasPrefix(k, "d/"+id+"/"+p2.hash.String) {
			t.Fatalf("stale object %s", k)
		}
	}
}

func TestRotatePurgeFailureRetries(t *testing.T) {
	e := newEnv(t, nil)
	id, old := readyPhoto(t, e)
	e.cdn.SetErr(errors.New("cdn down"))
	jid := e.enqueue("rotate_derived", map[string]string{"photoId": id})
	e.runOne()
	if s := e.jobState(jid); s != "done" {
		t.Fatalf("rotate state %s", s)
	}
	e.runOne() // purge_derived fails
	pj := e.jobs("purge_derived")
	if len(pj) != 1 || pj[0].state != "queued" {
		t.Fatalf("purge_derived after failure = %+v", pj)
	}
	e.cdn.SetErr(nil)
	e.now.Add(jobs.BaseBackoffMillis)
	e.runOne()
	if s := e.jobs("purge_derived")[0].state; s != "done" {
		t.Fatalf("retry state %s", s)
	}
	found := false
	for _, pfx := range e.cdn.Prefixes() {
		if pfx == "d/"+id+"/"+old+"/" {
			found = true
		}
	}
	if !found {
		t.Fatalf("old prefix never purged: %v", e.cdn.Prefixes())
	}
	p, _ := e.photo(id)
	for _, k := range e.st.keys(derB, "d/"+id+"/") {
		if !strings.HasPrefix(k, "d/"+id+"/"+p.hash.String) {
			t.Fatalf("stale object %s (current %s)", k, p.hash.String)
		}
	}
}

func TestPurgeDerivedRejectsBadPrefixesAndKeepsCurrent(t *testing.T) {
	e := newEnv(t, nil)
	id, cur := readyPhoto(t, e)
	for _, pfx := range []string{"d/" + newID() + "/0123456789abcdef/", "d/" + id + "/", "d/" + id + "/../x/"} {
		jid := e.enqueue("purge_derived", map[string]any{"photoId": id, "prefixes": []string{pfx}})
		e.runOne()
		if s := e.jobState(jid); s != "dead" {
			t.Fatalf("prefix %q: state %s", pfx, s)
		}
	}
	jid := e.enqueue("purge_derived", map[string]any{"photoId": id, "prefixes": []string{"d/" + id + "/" + cur + "/"}})
	e.runOne()
	if e.jobState(jid) != "done" || len(e.st.keys(derB, "d/"+id+"/"+cur+"/")) == 0 || len(e.cdn.Prefixes()) != 0 {
		t.Fatal("current hash prefix must never be deleted or purged")
	}
}

func TestRotateCrashBeforeCommitCleansOrphans(t *testing.T) {
	e := newEnv(t, nil)
	id, old := readyPhoto(t, e)
	e.w.FailNextCommit()
	jid := e.enqueue("rotate_derived", map[string]string{"photoId": id})
	e.runOne()
	if e.jobState(jid) == "done" {
		t.Fatal("injected commit failure still finished the job")
	}
	p, _ := e.photo(id)
	if p.hash.String != old {
		t.Fatalf("hash committed despite failure: %s", p.hash.String)
	}
	if extras := e.derivedHashes(id); len(extras) < 2 {
		t.Fatalf("expected orphan prefixes after crash, got %v", extras)
	}
	e.now.Add(jobs.BaseBackoffMillis)
	e.runOne() // rotate retry
	for e.runIfDue() {
	}
	p, _ = e.photo(id)
	got := e.derivedHashes(id)
	if len(got) != 1 || got[0] != p.hash.String {
		t.Fatalf("after retry hashes = %v current %s", got, p.hash.String)
	}
}

func TestRotateInterleavedJobsKeepOneHash(t *testing.T) {
	e := newEnv(t, func(_ *env, c *config.Config, d *worker.Deps) {
		c.Workers = 2
		d.PollEvery = 5 * time.Millisecond
		d.HeartbeatEvery = 5 * time.Millisecond
	})
	id, _ := readyPhoto(t, e)
	var started atomic.Int32
	block := make(chan struct{})
	e.setProcess(func(b []byte, o media.Options) (*media.Result, error) {
		if started.Add(1) == 2 {
			close(block)
		}
		select {
		case <-block:
		case <-time.After(10 * time.Second):
			t.Error("second rotate never started")
		}
		return media.Process(b, o)
	})
	e.enqueue("rotate_derived", map[string]string{"photoId": id})
	e.enqueue("rotate_derived", map[string]string{"photoId": id})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- e.w.Run(ctx) }()
	deadline := time.Now().Add(20 * time.Second)
	for {
		js := e.jobs("rotate_derived")
		finished := 0
		for _, j := range js {
			if j.state == "done" || j.state == "dead" {
				finished++
			}
		}
		if finished == 2 {
			break
		}
		if time.Now().After(deadline) {
			cancel()
			t.Fatalf("rotates stuck: %+v hashes %v", js, e.derivedHashes(id))
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	for e.runIfDue() {
	}
	p, _ := e.photo(id)
	got := e.derivedHashes(id)
	if len(got) != 1 || got[0] != p.hash.String {
		t.Fatalf("hashes = %v current %s", got, p.hash.String)
	}
}

func TestHeartbeatCancelsOnLeaseLost(t *testing.T) {
	e := newEnv(t, func(_ *env, _ *config.Config, d *worker.Deps) {
		d.HeartbeatEvery = 5 * time.Millisecond
	})
	entered := make(chan struct{})
	e.setProcess(func(b []byte, o media.Options) (*media.Result, error) {
		close(entered)
		time.Sleep(80 * time.Millisecond)
		return media.Process(b, o)
	})
	id := e.addPhoto("processing", testJPEG(t, false))
	jid := e.enqueue("process_photo", map[string]string{"photoId": id})
	go func() {
		<-entered
		if _, err := e.d.Exec(`UPDATE jobs SET lease_token='stolen' WHERE id=?`, jid); err != nil {
			t.Error(err)
		}
		time.Sleep(30 * time.Millisecond)
	}()
	e.runOne()
	if e.jobState(jid) == "done" {
		t.Fatal("handler finished after the lease was stolen")
	}
	if p, _ := e.photo(id); p.status == "ready" {
		t.Fatal("photo committed after the lease was stolen")
	}
}

func TestDeadRotateLogsAndReconcileEnqueuesPurge(t *testing.T) {
	var logs syncBuffer
	e := newEnv(t, func(_ *env, _ *config.Config, d *worker.Deps) {
		d.Log = slog.New(slog.NewTextHandler(&logs, nil))
	})
	id, cur := readyPhoto(t, e)
	orphan := "0123456789abcdef"
	e.st.put(derB, "d/"+id+"/"+orphan+"/w480.jpg", []byte("x"))
	e.setProcess(func([]byte, media.Options) (*media.Result, error) {
		return nil, errors.New("boom")
	})
	jid := e.enqueue("rotate_derived", map[string]string{"photoId": id})
	for i := 0; i < jobs.MaxAttempts; i++ {
		e.runOne()
		if i+1 < jobs.MaxAttempts {
			e.now.Add(jobs.BaseBackoffMillis << i)
		}
	}
	if e.jobState(jid) != "dead" {
		t.Fatalf("state %s", e.jobState(jid))
	}
	if !strings.Contains(logs.String(), "kind=rotate_derived") || !strings.Contains(strings.ToLower(logs.String()), "level=error") {
		t.Fatalf("dead rotate not logged at error: %s", logs.String())
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := e.w.Run(ctx); err != nil {
		t.Fatal(err)
	}
	pj := e.jobs("purge_derived")
	if len(pj) == 0 {
		t.Fatal("reconcile did not enqueue purge_derived")
	}
	e.runOne()
	got := e.derivedHashes(id)
	if len(got) != 1 || got[0] != cur {
		t.Fatalf("hashes after reconcile purge = %v want %s", got, cur)
	}
}

func TestRotateMissingOrNotReadyIsNoop(t *testing.T) {
	e := newEnv(t, nil)
	j1 := e.enqueue("rotate_derived", map[string]string{"photoId": newID()})
	e.runOne()
	id := e.addPhoto("processing", testJPEG(t, false))
	j2 := e.enqueue("rotate_derived", map[string]string{"photoId": id})
	e.runOne()
	if e.jobState(j1) != "done" || e.jobState(j2) != "done" {
		t.Fatal("expected done")
	}
	if p, _ := e.photo(id); p.salt != "salt0" {
		t.Fatal("salt changed for a non-ready photo")
	}
}

func TestRotateDeletedMidwayCleansUp(t *testing.T) {
	e := newEnv(t, nil)
	id, _ := readyPhoto(t, e)
	e.setProcess(func(b []byte, o media.Options) (*media.Result, error) {
		r, err := media.Process(b, o)
		if _, derr := e.d.Exec(`DELETE FROM photos WHERE id=?`, id); derr != nil {
			t.Error(derr)
		}
		return r, err
	})
	jid := e.enqueue("rotate_derived", map[string]string{"photoId": id})
	e.runOne()
	if e.jobState(jid) != "done" {
		t.Fatal("expected done")
	}
	if ks := e.st.keys(derB, "d/"+id+"/"); len(ks) != 0 {
		t.Fatalf("objects left: %v", ks)
	}
}

// --- delete_photo_objects ---

func TestDeletePhotoObjects(t *testing.T) {
	e := newEnv(t, withReplica)
	id := newID()
	key := "o/" + owner + "/" + id
	e.st.put(origB, key, []byte("orig"))
	e.repl.put(replB, key, []byte("orig"))
	e.st.put(derB, "d/"+id+"/abc/w480.jpg", []byte("x"))
	e.st.put(derB, "d/"+id+"/abc-wm1/w2400.jpg", []byte("x"))
	sibling := "d/" + id + "0/abc/w480.jpg"
	e.st.put(derB, sibling, []byte("keep"))

	jid := e.enqueue("delete_photo_objects", map[string]string{"photoId": id, "originalKey": key, "derivedPrefix": "d/" + id + "/"})
	e.runOne()
	if e.jobState(jid) != "done" {
		t.Fatal("expected done")
	}
	if _, ok := e.st.get(origB, key); ok {
		t.Fatal("original left")
	}
	if _, ok := e.repl.get(replB, key); ok {
		t.Fatal("replica left")
	}
	if ks := e.st.keys(derB, "d/"+id+"/"); len(ks) != 0 {
		t.Fatalf("derived left: %v", ks)
	}
	if _, ok := e.st.get(derB, sibling); !ok {
		t.Fatal("sibling prefix deleted")
	}
	if got := e.cdn.Prefixes(); len(got) != 1 || got[0] != "d/"+id+"/" {
		t.Fatalf("purge = %v", got)
	}

	// A late PUT of the original is swept by the delayed follow-up pass.
	js := e.jobs("delete_photo_objects")
	if len(js) != 2 || js[1].state != "queued" || js[1].runAfter != t0+worker.DeleteSweepDelay.Milliseconds() {
		t.Fatalf("follow-up = %+v", js)
	}
	e.st.put(origB, key, []byte("late"))
	if ran, _ := e.w.RunOnce(context.Background()); ran {
		t.Fatal("follow-up ran early")
	}
	e.now.Add(worker.DeleteSweepDelay.Milliseconds())
	e.runOne()
	if _, ok := e.st.get(origB, key); ok {
		t.Fatal("late original survived the sweep")
	}
	if js := e.jobs("delete_photo_objects"); len(js) != 2 {
		t.Fatalf("sweep re-enqueued itself: %d jobs", len(js))
	}

	// Missing objects are fine.
	j3 := e.enqueue("delete_photo_objects", map[string]any{"photoId": id, "originalKey": key, "derivedPrefix": "d/" + id + "/", "sweep": true})
	e.runOne()
	if e.jobState(j3) != "done" {
		t.Fatal("missing objects must be done")
	}
}

func TestDeletePhotoObjectsRejectsForeignKeys(t *testing.T) {
	e := newEnv(t, nil)
	id := newID()
	for _, p := range []map[string]string{
		{"photoId": id, "originalKey": "o/" + owner + "/" + newID(), "derivedPrefix": "d/" + id + "/"},
		{"photoId": id, "originalKey": "o/" + owner + "/" + id, "derivedPrefix": "d/"},
		{"photoId": id, "originalKey": "x/" + id, "derivedPrefix": "d/" + id + "/"},
	} {
		jid := e.enqueue("delete_photo_objects", p)
		e.runOne()
		if s := e.jobState(jid); s != "dead" {
			t.Fatalf("payload %v: state %s", p, s)
		}
	}
}

// --- cleanup_uploads ---

func TestCleanupUploads(t *testing.T) {
	e := newEnv(t, nil)
	e.now.Store(t0 + 30*hour)
	now := e.now.Load()
	mk := func(status string, updated int64) string {
		id := e.addPhoto(status, []byte(status+itoa(updated)))
		e.exec(`UPDATE photos SET created_at=?, updated_at=? WHERE id=?`, updated, updated, id)
		return id
	}
	staleUp := mk("uploading", now-hour-1)
	freshUp := mk("uploading", now-hour+60_000)
	staleFail := mk("failed", now-24*hour-1)
	freshFail := mk("failed", now-23*hour)
	oldReady := mk("ready", t0)
	e.exec(`INSERT INTO jobs(id,kind,payload,state,attempts,run_after,created_at,finished_at) VALUES
		('old-done','x','{}','done',1,0,0,?),('new-done','x','{}','done',1,0,0,?)`, now-8*24*hour, now-hour)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := e.w.Run(ctx); err != nil { // startup enqueues cleanup_uploads
		t.Fatal(err)
	}
	if err := e.w.Run(ctx); err != nil { // deduped
		t.Fatal(err)
	}
	if js := e.jobs("cleanup_uploads"); len(js) != 1 {
		t.Fatalf("cleanup jobs = %d", len(js))
	}
	e.runOne()

	for _, id := range []string{staleUp, staleFail} {
		if _, ok := e.photo(id); ok {
			t.Errorf("%s not deleted", id)
		}
	}
	for _, id := range []string{freshUp, freshFail, oldReady} {
		if _, ok := e.photo(id); !ok {
			t.Errorf("%s deleted", id)
		}
	}
	dels := e.jobs("delete_photo_objects")
	if len(dels) != 2 {
		t.Fatalf("delete jobs = %+v", dels)
	}
	for e.runIfDue() {
	}
	for _, id := range []string{staleUp, staleFail} {
		if _, ok := e.st.get(origB, "o/"+owner+"/"+id); ok {
			t.Errorf("original of %s left", id)
		}
	}
	var n int
	e.d.QueryRow(`SELECT count(*) FROM jobs WHERE id IN ('old-done','new-done')`).Scan(&n)
	if n != 1 {
		t.Fatalf("PurgeDone: %d of 2 left", n)
	}
	cl := e.jobs("cleanup_uploads")
	if len(cl) != 2 || cl[0].state != "done" || cl[1].state != "queued" || cl[1].runAfter != now+hour {
		t.Fatalf("cleanup chain = %+v", cl)
	}
}

func TestCleanupSkipsReusedFailedUpload(t *testing.T) {
	e := newEnv(t, nil)
	e.now.Store(t0 + 30*hour)
	now := e.now.Load()
	body := testJPEG(t, false)
	id := e.addPhoto("failed", body)
	e.exec(`UPDATE photos SET created_at=?, updated_at=?, status='failed' WHERE id=?`, now-24*hour-1, now-24*hour-1, id)
	// T11 reuse: status uploading, created_at kept, updated_at bumped.
	e.exec(`UPDATE photos SET status='uploading', error=NULL, updated_at=? WHERE id=?`, now, id)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := e.w.Run(ctx); err != nil {
		t.Fatal(err)
	}
	e.runOne()
	if _, ok := e.photo(id); !ok {
		t.Fatal("reused uploading row was deleted by cleanup")
	}
	if _, ok := e.st.get(origB, "o/"+owner+"/"+id); !ok {
		t.Fatal("original of a reused upload was deleted")
	}
}

func (e *env) runIfDue() bool {
	ran, err := e.w.RunOnce(context.Background())
	if err != nil {
		e.t.Fatal(err)
	}
	return ran
}

// --- loop, heartbeat, shutdown ---

func TestRunFinishesInFlightJobOnShutdown(t *testing.T) {
	e := newEnv(t, func(_ *env, _ *config.Config, d *worker.Deps) {
		d.PollEvery = 5 * time.Millisecond
		d.HeartbeatEvery = 5 * time.Millisecond
	})
	entered, release := make(chan struct{}), make(chan struct{})
	e.setProcess(func(b []byte, o media.Options) (*media.Result, error) {
		close(entered)
		<-release
		return media.Process(b, o)
	})
	id := e.addPhoto("processing", testJPEG(t, false))
	jid := e.enqueue("process_photo", map[string]string{"photoId": id})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- e.w.Run(ctx) }()
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("job never started")
	}
	// The lease is renewed while the handler runs.
	var before int64
	e.d.QueryRow(`SELECT lease_until FROM jobs WHERE id=?`, jid).Scan(&before)
	e.now.Add(60_000)
	deadline := time.Now().Add(5 * time.Second)
	for {
		var lu int64
		e.d.QueryRow(`SELECT lease_until FROM jobs WHERE id=?`, jid).Scan(&lu)
		if lu > before {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("heartbeat never extended the lease")
		}
		time.Sleep(5 * time.Millisecond)
	}

	cancel()
	select {
	case <-done:
		t.Fatal("Run returned with a job in flight")
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Run did not return")
	}
	if p, _ := e.photo(id); p.status != "ready" || e.jobState(jid) != "done" {
		t.Fatalf("in-flight job not finished: %s %s", p.status, e.jobState(jid))
	}
}

func TestRunLoopProcessesQueuedJobs(t *testing.T) {
	e := newEnv(t, func(_ *env, c *config.Config, d *worker.Deps) {
		c.Workers = 2
		d.PollEvery = 5 * time.Millisecond
	})
	var ids []string
	for _, gps := range []bool{false, true} {
		id := e.addPhoto("processing", testJPEG(t, gps))
		ids = append(ids, id)
		e.enqueue("process_photo", map[string]string{"photoId": id})
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- e.w.Run(ctx) }()
	deadline := time.Now().Add(20 * time.Second)
	for _, id := range ids {
		for {
			if p, _ := e.photo(id); p.status == "ready" {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("%s not processed", id)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}
