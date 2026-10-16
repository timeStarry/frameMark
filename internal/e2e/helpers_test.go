package e2e_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"

	"github.com/timeStarry/frameMark/internal/api"
	"github.com/timeStarry/frameMark/internal/cdn"
	"github.com/timeStarry/frameMark/internal/clock"
	"github.com/timeStarry/frameMark/internal/config"
	"github.com/timeStarry/frameMark/internal/db"
	"github.com/timeStarry/frameMark/internal/identity"
	"github.com/timeStarry/frameMark/internal/jobs"
	"github.com/timeStarry/frameMark/internal/storage"
	"github.com/timeStarry/frameMark/internal/worker"
)

const (
	cdnBase  = "https://cdn.e2e.test"
	password = "correct-horse-battery-staple"
	pollMax  = 30 * time.Second
)

// directHTTP never uses HTTP(S)_PROXY, so requests reach local MinIO and
// the httptest servers directly. It does not follow redirects.
func directHTTP(jar http.CookieJar) *http.Client {
	return &http.Client{
		Transport:     &http.Transport{Proxy: nil},
		Jar:           jar,
		Timeout:       30 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// --- mailer ---

type captureMailer struct {
	mu   sync.Mutex
	msgs []identity.Mail
}

func (m *captureMailer) Send(msg identity.Mail) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.msgs = append(m.msgs, msg)
	return nil
}

// waitURL returns the verify URL sent to email; identity sends mail async.
func (m *captureMailer) waitURL(t *testing.T, email string) string {
	t.Helper()
	deadline := time.Now().Add(pollMax)
	for time.Now().Before(deadline) {
		m.mu.Lock()
		for _, msg := range m.msgs {
			if msg.To == email {
				m.mu.Unlock()
				return msg.URL
			}
		}
		m.mu.Unlock()
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("no verification mail for %s", email)
	return ""
}

// --- stack ---

// stack is the full SP1 wiring: real MinIO, real libvips (worker default
// media.Process), real jobs queue, identity in dev mode with a capturing
// mailer, cdn.Fake, and api.New behind two httptest servers (one without and
// one with CDNBase) sharing one database.
type stack struct {
	t       *testing.T
	d       *sql.DB
	store   *storage.Client
	w       *worker.Worker
	cdn     *cdn.Fake
	mail    *captureMailer
	cfg     config.Config
	srv     *httptest.Server // no CDN base
	cdnSrv  *httptest.Server // CDNBase set
	privacy *privacyRecorder
}

func newStack(t *testing.T) *stack {
	t.Helper()
	endpoint := os.Getenv("MARKR_TEST_S3_ENDPOINT")
	ak, sk := os.Getenv("MARKR_TEST_S3_ACCESS_KEY"), os.Getenv("MARKR_TEST_S3_SECRET_KEY")
	if endpoint == "" || ak == "" || sk == "" {
		t.Skip("MARKR_TEST_S3_ENDPOINT, MARKR_TEST_S3_ACCESS_KEY and MARKR_TEST_S3_SECRET_KEY must be set")
	}
	ctx := context.Background()

	raw := s3.New(s3.Options{
		Region:       "us-east-1",
		Credentials:  credentials.NewStaticCredentialsProvider(ak, sk, ""),
		BaseEndpoint: aws.String(endpoint),
		UsePathStyle: true,
		HTTPClient:   directHTTP(nil),
	})
	suffix := randHex(t, 6)
	origB, derB := "markr-e2e-o-"+suffix, "markr-e2e-d-"+suffix
	for _, b := range []string{origB, derB} {
		makeBucket(t, raw, b)
	}

	store, err := storage.New(ctx, storage.Options{
		Endpoint: endpoint, Region: "us-east-1", AccessKey: ak, SecretKey: sk, PathStyle: true,
	})
	if err != nil {
		t.Fatal(err)
	}

	d, err := db.Open(filepath.Join(t.TempDir(), "markr.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	if err := db.Migrate(d); err != nil {
		t.Fatal(err)
	}

	// The identity origin must be known before the handler exists, so the
	// listener is bound first and the server started afterwards.
	srv := httptest.NewUnstartedServer(nil)
	origin := "http://" + srv.Listener.Addr().(*net.TCPAddr).String()

	s := &stack{t: t, d: d, store: store, cdn: &cdn.Fake{}, mail: &captureMailer{}, privacy: newPrivacyRecorder(origB, derB)}
	id, err := identity.New(d, identity.Deps{Origin: origin, Dev: true, Enabled: true, RegistrationOpen: true, Mailer: s.mail})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { id.Close(context.Background()) })

	q := jobs.New(d, clock.Now)
	s.cfg = config.Config{
		Origin: origin, Dev: true, IdentityOn: true, RegOpen: true,
		BucketOriginals: origB, BucketDerived: derB,
		UploadMaxMB: 10, MaxPixels: 60_000_000, QuotaPhotos: 100, Workers: 1,
	}
	s.w = worker.New(worker.Deps{
		DB: d, Jobs: q, Storage: store, CDN: s.cdn, Cfg: s.cfg,
		Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})

	srv.Config.Handler = api.New(api.Deps{DB: d, Identity: id, Storage: store, Jobs: q, Cfg: s.cfg})
	srv.Start()
	t.Cleanup(srv.Close)
	s.srv = srv

	cdnCfg := s.cfg
	cdnCfg.CDNBase = cdnBase
	s.cdnSrv = httptest.NewServer(api.New(api.Deps{DB: d, Identity: id, Storage: store, Jobs: q, Cfg: cdnCfg}))
	t.Cleanup(s.cdnSrv.Close)

	t.Cleanup(func() { s.privacy.check(t) })
	return s
}

func randHex(t *testing.T, n int) string {
	t.Helper()
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(b)
}

// makeBucket creates bucket and registers its removal (objects first).
func makeBucket(t *testing.T, c *s3.Client, bucket string) {
	t.Helper()
	ctx := context.Background()
	if _, err := c.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: aws.String(bucket)}); err != nil {
		t.Fatalf("create bucket %s: %v", bucket, err)
	}
	t.Cleanup(func() {
		p := s3.NewListObjectsV2Paginator(c, &s3.ListObjectsV2Input{Bucket: aws.String(bucket)})
		for p.HasMorePages() {
			page, err := p.NextPage(ctx)
			if err != nil {
				t.Errorf("cleanup list %s: %v", bucket, err)
				return
			}
			var ids []types.ObjectIdentifier
			for _, o := range page.Contents {
				ids = append(ids, types.ObjectIdentifier{Key: o.Key})
			}
			if len(ids) > 0 {
				if _, err := c.DeleteObjects(ctx, &s3.DeleteObjectsInput{Bucket: aws.String(bucket), Delete: &types.Delete{Objects: ids}}); err != nil {
					t.Errorf("cleanup delete %s: %v", bucket, err)
				}
			}
		}
		if _, err := c.DeleteBucket(ctx, &s3.DeleteBucketInput{Bucket: aws.String(bucket)}); err != nil {
			t.Errorf("cleanup bucket %s: %v", bucket, err)
		}
	})
}

// drain runs due jobs until done() holds and the queue has no due job, or
// fails after pollMax. Deferred jobs (errPhotoBusy) are waited for.
func (s *stack) drain(what string, done func() bool) {
	s.t.Helper()
	ctx := context.Background()
	deadline := time.Now().Add(pollMax)
	for time.Now().Before(deadline) {
		ran, err := s.w.RunOnce(ctx)
		if err != nil {
			s.t.Fatalf("RunOnce: %v", err)
		}
		if !ran {
			if done() {
				return
			}
			time.Sleep(100 * time.Millisecond)
		}
	}
	s.t.Fatalf("timed out waiting for %s", what)
}

func (s *stack) list(bucket, prefix string) []string {
	s.t.Helper()
	keys, err := s.store.List(context.Background(), bucket, prefix)
	if err != nil {
		s.t.Fatalf("list %s/%s: %v", bucket, prefix, err)
	}
	return keys
}

// --- HTTP client ---

type client struct {
	s    *stack
	base string
	hc   *http.Client
	csrf string
}

// client returns a fresh browser-like client (own cookie jar) for base.
func (s *stack) client(base string) *client {
	jar, err := cookiejar.New(nil)
	if err != nil {
		s.t.Fatal(err)
	}
	return &client{s: s, base: base, hc: directHTTP(jar)}
}

type resp struct {
	code   int
	raw    []byte
	body   map[string]any
	header http.Header
}

// do sends a JSON request like the browser front end would: same-origin
// Origin header and the CSRF token on writes. Every JSON body is recorded
// for the privacy scan.
func (c *client) do(method, path string, body any) resp {
	t := c.s.t
	t.Helper()
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.base+path, rd)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if method != http.MethodGet {
		req.Header.Set("Origin", c.s.cfg.Origin)
		req.Header.Set("X-CSRF-Token", c.csrf)
	}
	res, err := c.hc.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	out := resp{code: res.StatusCode, raw: raw, header: res.Header}
	if strings.HasPrefix(path, "/api/") && res.Header.Get("Cache-Control") != "private, no-store" {
		t.Errorf("%s %s: Cache-Control %q", method, path, res.Header.Get("Cache-Control"))
	}
	if strings.HasPrefix(res.Header.Get("Content-Type"), "application/json") {
		c.s.privacy.record(method+" "+path, raw)
		if err := json.Unmarshal(raw, &out.body); err != nil {
			t.Fatalf("%s %s: body is not a JSON object: %s", method, path, raw)
		}
		if tok, ok := out.body["csrfToken"].(string); ok {
			c.csrf = tok
		}
	} else if len(raw) != 0 {
		t.Fatalf("%s %s: non-JSON body %q (%s)", method, path, raw, res.Header.Get("Content-Type"))
	}
	return out
}

func (c *client) get(path string) resp          { return c.do(http.MethodGet, path, nil) }
func (c *client) post(path string, b any) resp  { return c.do(http.MethodPost, path, b) }
func (c *client) put(path string, b any) resp   { return c.do(http.MethodPut, path, b) }
func (c *client) del(path string) resp          { return c.do(http.MethodDelete, path, nil) }
func (r resp) str(key string) string            { s, _ := r.body[key].(string); return s }
func (r resp) want(t *testing.T, code int) resp { t.Helper(); return r.wantf(t, code, "") }
func (r resp) wantf(t *testing.T, code int, what string) resp {
	t.Helper()
	if r.code != code {
		t.Fatalf("%s: status %d, want %d: %s", what, r.code, code, r.raw)
	}
	return r
}

// signUp registers email through the real flow (register, captured mail,
// verify), then logs out and logs in again. It returns the user id.
func (c *client) signUp(email string) string {
	t := c.s.t
	t.Helper()
	c.get("/api/auth/session").wantf(t, 200, "bootstrap session")
	c.post("/api/auth/register", map[string]any{"email": email}).wantf(t, 202, "register")
	link := c.s.mail.waitURL(t, email)
	u, err := url.Parse(link)
	if err != nil || !strings.HasPrefix(u.Fragment, "verify=") {
		t.Fatalf("verify link %q", link)
	}
	token := strings.TrimPrefix(u.Fragment, "verify=")
	r := c.post("/api/auth/verify", map[string]any{"token": token, "password": password}).wantf(t, 201, "verify")
	uid := r.str("user")
	if uid == "" {
		t.Fatalf("verify returned no user: %s", r.raw)
	}
	c.post("/api/auth/logout", nil).wantf(t, 200, "logout")
	c.get("/api/auth/session").wantf(t, 200, "anonymous session")
	r = c.post("/api/auth/login", map[string]any{"email": email, "password": password}).wantf(t, 200, "login")
	if r.str("user") != uid {
		t.Fatalf("login user %q, want %q", r.str("user"), uid)
	}
	return uid
}

// putPresigned replays a presigned upload with exactly the returned
// method, URL and headers, and returns the S3 status code.
func (s *stack) putPresigned(upload map[string]any, body []byte) int {
	s.t.Helper()
	method, _ := upload["method"].(string)
	u, _ := upload["url"].(string)
	req, err := http.NewRequest(method, u, bytes.NewReader(body))
	if err != nil {
		s.t.Fatal(err)
	}
	hdrs, _ := upload["headers"].(map[string]any)
	for k, v := range hdrs {
		req.Header.Set(k, v.(string))
	}
	res, err := directHTTP(nil).Do(req)
	if err != nil {
		s.t.Fatalf("presigned PUT: %v", err)
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, res.Body)
	return res.StatusCode
}

// fetch GETs an absolute URL (a presigned MinIO URL) and returns status and body.
func fetch(t *testing.T, u string) (int, []byte) {
	t.Helper()
	res, err := directHTTP(nil).Get(u)
	if err != nil {
		t.Fatalf("GET %s: %v", u, err)
	}
	defer res.Body.Close()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return res.StatusCode, b
}

// --- privacy scan ---

// privacyRecorder keeps every JSON body any client received. check walks
// them structurally: no key may name a location, GPS or the original key,
// and no string value may contain a location word, an "o/" storage key or a
// bucket name. upload.url (the presigned PUT target, which must name the
// object) is the only exempt value. A structural walk is used because a
// raw-text "gps" match false-positives on random CSRF tokens.
type privacyRecorder struct {
	mu      sync.Mutex
	bodies  []recorded
	buckets []string
}

type recorded struct {
	where string
	raw   []byte
}

var (
	privacyKeyRe   = regexp.MustCompile(`(?i)latitude|longitude|gps|original_?key|^lat$|^lng$|^lon$`)
	privacyValueRe = regexp.MustCompile(`(?i)latitude|longitude|gps`)
)

func newPrivacyRecorder(buckets ...string) *privacyRecorder {
	return &privacyRecorder{buckets: buckets}
}

func (p *privacyRecorder) record(where string, raw []byte) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.bodies = append(p.bodies, recorded{where, append([]byte(nil), raw...)})
}

func (p *privacyRecorder) check(t *testing.T) {
	t.Helper()
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, b := range p.bodies {
		if leak := p.leak(b.raw); leak != "" {
			t.Errorf("privacy: %s leaks %s: %s", b.where, leak, b.raw)
		}
	}
	t.Logf("privacy scan: %d JSON bodies clean", len(p.bodies))
}

func (p *privacyRecorder) leak(raw []byte) string {
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return "non-JSON body"
	}
	var walk func(path string, v any) string
	walk = func(path string, v any) string {
		switch x := v.(type) {
		case map[string]any:
			for k, vv := range x {
				if privacyKeyRe.MatchString(k) {
					return fmt.Sprintf("key %q", k)
				}
				if l := walk(path+"."+k, vv); l != "" {
					return l
				}
			}
		case []any:
			for _, vv := range x {
				if l := walk(path+"[]", vv); l != "" {
					return l
				}
			}
		case string:
			if path == ".upload.url" {
				return ""
			}
			if m := privacyValueRe.FindString(x); m != "" && !strings.HasSuffix(path, "csrfToken") {
				return fmt.Sprintf("word %q at %s", m, path)
			}
			if strings.Contains(x, "o/") {
				return fmt.Sprintf("storage key %q at %s", x, path)
			}
			for _, b := range p.buckets {
				if strings.Contains(x, b) {
					return fmt.Sprintf("bucket name at %s", path)
				}
			}
		}
		return ""
	}
	return walk("", v)
}

// --- fixture ---
//
// fixtureJPEG is a 64x48 gradient JPEG with an EXIF APP1 that carries full
// shooting data and a GPS IFD. The TIFF layout follows exifTIFF/testJPEG in
// internal/worker/worker_test.go (itself modelled on buildTIFF in
// internal/media/tiff_builder_test.go); those are unexported test code, so
// the minimum is copied here and extended with the Exif tags SP1 reads.
func fixtureJPEG(t *testing.T, seed int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 64, 48))
	for y := 0; y < 48; y++ {
		for x := 0; x < 64; x++ {
			img.Set(x, y, color.RGBA{uint8(x*4 + seed*31), uint8(y * 5), 128, 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatal(err)
	}
	b := buf.Bytes()
	payload := append([]byte("Exif\x00\x00"), exifTIFF()...)
	seg := []byte{0xFF, 0xE1, 0, 0}
	binary.BigEndian.PutUint16(seg[2:], uint16(len(payload)+2))
	out := append([]byte{0xFF, 0xD8}, seg...)
	out = append(out, payload...)
	return append(out, b[2:]...)
}

const (
	fixtureMake  = "E2ECam"
	fixtureModel = "E2ECam Model X"
	fixtureLens  = "E2E 50mm F2.8"
)

type tiffTag struct {
	id, typ uint16
	count   uint32
	data    []byte
}

// exifTIFF builds a big-endian TIFF: IFD0 {Make, Model, ExifIFD, GPSIFD},
// Exif {ExposureTime 1/125, FNumber 2.8, ISO 400, DateTimeOriginal,
// FocalLength 50, LensModel}, GPS {N 35°30', E 139°45'}.
func exifTIFF() []byte {
	be := binary.BigEndian
	u32 := func(v uint32) []byte { b := make([]byte, 4); be.PutUint32(b, v); return b }
	ascii := func(id uint16, s string) tiffTag {
		b := append([]byte(s), 0)
		return tiffTag{id, 2, uint32(len(b)), b}
	}
	short := func(id, v uint16) tiffTag { b := make([]byte, 2); be.PutUint16(b, v); return tiffTag{id, 3, 1, b} }
	long := func(id uint16, v uint32) tiffTag { return tiffTag{id, 4, 1, u32(v)} }
	rat := func(id uint16, nd ...uint32) tiffTag {
		var b []byte
		for _, v := range nd {
			b = append(b, u32(v)...)
		}
		return tiffTag{id, 5, uint32(len(nd) / 2), b}
	}
	size := func(n int) int { return 2 + 12*n + 4 }

	ifd0 := []tiffTag{ascii(0x010F, fixtureMake), ascii(0x0110, fixtureModel), long(0x8769, 0), long(0x8825, 0)}
	exif := []tiffTag{
		rat(0x829A, 1, 125), rat(0x829D, 28, 10), short(0x8827, 400),
		ascii(0x9003, "2024:05:01 10:00:00"), rat(0x920A, 50, 1), ascii(0xA434, fixtureLens),
	}
	gps := []tiffTag{ascii(1, "N"), rat(2, 35, 1, 30, 1, 0, 1), ascii(3, "E"), rat(4, 139, 1, 45, 1, 0, 1)}

	exifOff := 8 + size(len(ifd0))
	gpsOff := exifOff + size(len(exif))
	dataOff := gpsOff + size(len(gps))
	ifd0[2].data = u32(uint32(exifOff))
	ifd0[3].data = u32(uint32(gpsOff))

	var data []byte
	enc := func(tags []tiffTag) []byte {
		b := make([]byte, 2)
		be.PutUint16(b, uint16(len(tags)))
		for _, tg := range tags {
			e := make([]byte, 12)
			be.PutUint16(e[0:], tg.id)
			be.PutUint16(e[2:], tg.typ)
			be.PutUint32(e[4:], tg.count)
			if len(tg.data) <= 4 {
				copy(e[8:], tg.data)
			} else {
				be.PutUint32(e[8:], uint32(dataOff+len(data)))
				data = append(data, tg.data...)
				if len(data)%2 == 1 {
					data = append(data, 0)
				}
			}
			b = append(b, e...)
		}
		return append(b, 0, 0, 0, 0)
	}
	out := []byte{'M', 'M', 0, 42}
	out = append(out, u32(8)...)
	out = append(out, enc(ifd0)...)
	out = append(out, enc(exif)...)
	out = append(out, enc(gps)...)
	return append(out, data...)
}

// TestPrivacyScanCatchesLeaks runs without MinIO: the scan must flag each
// leak and accept upload.url, CSRF tokens and ordinary text.
func TestPrivacyScanCatchesLeaks(t *testing.T) {
	p := newPrivacyRecorder("markr-e2e-o-x", "markr-e2e-d-x")
	for _, body := range []string{
		`{"latitude":1}`, `{"a":{"gpsLat":1}}`, `{"originalKey":"x"}`, `{"original_key":"x"}`,
		`{"k":"o/u1/p1"}`, `[{"lng":2}]`, `{"m":"Longitude 3"}`, `{"m":"GPS on"}`,
		`{"url":"http://127.0.0.1:19000/markr-e2e-d-x/d/p/h/w480.jpg"}`,
	} {
		if p.leak([]byte(body)) == "" {
			t.Errorf("scan missed %s", body)
		}
	}
	ok := `{"csrfToken":"XGpSz1FPC6","title":"photo","upload":{"url":"http://h/markr-e2e-o-x/o/u/p"}}`
	if l := p.leak([]byte(ok)); l != "" {
		t.Errorf("false positive: %s", l)
	}
}
