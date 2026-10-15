package api_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/timeStarry/frameMark/internal/api"
	"github.com/timeStarry/frameMark/internal/config"
	"github.com/timeStarry/frameMark/internal/db"
	"github.com/timeStarry/frameMark/internal/identity"
	"github.com/timeStarry/frameMark/internal/jobs"
	"github.com/timeStarry/frameMark/internal/storage"
)

const (
	origin  = "http://localhost:8080"
	cookie  = "markr_dev_session"
	t0      = int64(1_700_000_000_000)
	bucket  = "originals"
	maxMB   = 2
	quota   = 3
	sessDay = int64(24 * 3_600_000)
)

// privacyKeyRe matches JSON keys a response must never carry. privacyWordRe
// is a raw-text check for location words anywhere (values included).
var (
	privacyKeyRe  = regexp.MustCompile(`(?i)latitude|longitude|gps|original_?key|^lat$|^lng$|^lon$`)
	privacyWordRe = regexp.MustCompile(`(?i)latitude|longitude`)
)

// --- fake storage ---

type presignCall struct {
	Bucket, Key, ContentType, SHA256 string
	TTL                              time.Duration
}

type fakeStorage struct {
	mu         sync.Mutex
	objects    map[string]storage.Object // by bucket+"/"+key
	deleted    []string
	presigns   []presignCall
	presignErr error
	deleteErr  error
	onHead     func() // runs before Head answers, outside the lock
	tt         *testing.T
}

var lowerHex64 = regexp.MustCompile(`^[0-9a-f]{64}$`)

func newFakeStorage(t *testing.T) *fakeStorage {
	return &fakeStorage{objects: map[string]storage.Object{}, tt: t}
}

func (f *fakeStorage) t() *testing.T { return f.tt }

// PresignPut mirrors the real client's argument checks so a caller bug
// cannot pass here and fail against S3.
func (f *fakeStorage) PresignPut(_ context.Context, b, key, ct, sha string, ttl time.Duration) (storage.PresignedRequest, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !lowerHex64.MatchString(sha) || ct == "" || ttl <= 0 || ttl > 7*24*time.Hour || b == "" || key == "" {
		f.t().Errorf("PresignPut called with invalid args: %q %q %q %q %v", b, key, ct, sha, ttl)
		return storage.PresignedRequest{}, errors.New("fake: invalid presign args")
	}
	if f.presignErr != nil {
		return storage.PresignedRequest{}, f.presignErr
	}
	f.presigns = append(f.presigns, presignCall{b, key, ct, sha, ttl})
	return storage.PresignedRequest{
		URL:     "https://storage.test/" + b + "/" + key + "?X-Amz-Signature=fake",
		Method:  http.MethodPut,
		Headers: map[string]string{"Content-Type": ct, "X-Amz-Checksum-Sha256": sha},
	}, nil
}

func (f *fakeStorage) Head(_ context.Context, b, key string) (storage.Object, error) {
	if f.onHead != nil {
		f.onHead()
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	o, ok := f.objects[b+"/"+key]
	if !ok {
		return storage.Object{}, storage.ErrNotFound
	}
	return o, nil
}

func (f *fakeStorage) Delete(_ context.Context, b, key string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.deleteErr != nil {
		return f.deleteErr
	}
	delete(f.objects, b+"/"+key)
	f.deleted = append(f.deleted, b+"/"+key)
	return nil
}

func (f *fakeStorage) PresignGet(_ context.Context, b, key string, ttl time.Duration, _ string) (string, error) {
	if ttl <= 0 || ttl > 7*24*time.Hour || b == "" || key == "" {
		f.t().Errorf("PresignGet called with invalid args: %q %q %v", b, key, ttl)
		return "", errors.New("fake: invalid presign args")
	}
	return "https://storage.test/" + b + "/" + key + "?get", nil
}

func (f *fakeStorage) put(key string, o storage.Object) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.objects[bucket+"/"+key] = o
}

func (f *fakeStorage) has(key string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, ok := f.objects[bucket+"/"+key]
	return ok
}

func (f *fakeStorage) wasDeleted(key string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, k := range f.deleted {
		if k == bucket+"/"+key {
			return true
		}
	}
	return false
}

func (f *fakeStorage) presignCalls() []presignCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]presignCall(nil), f.presigns...)
}

// --- env ---

type env struct {
	t   *testing.T
	d   *sql.DB
	h   http.Handler
	st  *fakeStorage
	q   *jobs.Queue
	now atomic.Int64
}

func newEnv(t *testing.T) *env {
	t.Helper()
	d, err := db.Open(filepath.Join(t.TempDir(), "markr.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	if err := db.Migrate(d); err != nil {
		t.Fatal(err)
	}
	e := &env{t: t, d: d, st: newFakeStorage(t)}
	e.now.Store(t0)
	id, err := identity.New(d, identity.Deps{Origin: origin, Dev: true, Enabled: true, Now: e.now.Load})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { id.Close(context.Background()) })
	e.q = jobs.New(d, e.now.Load)
	e.h = api.New(api.Deps{
		DB:       d,
		Identity: id,
		Storage:  e.st,
		Jobs:     e.q,
		Now:      e.now.Load,
		Cfg: config.Config{Origin: origin, Dev: true, IdentityOn: true, BucketOriginals: bucket,
			UploadMaxMB: maxMB, QuotaPhotos: quota},
	})
	return e
}

func (e *env) exec(q string, args ...any) {
	e.t.Helper()
	if _, err := e.d.Exec(q, args...); err != nil {
		e.t.Fatal(err)
	}
}

// insertPhoto adds a photo row directly; it returns the id.
func (e *env) insertPhoto(owner, id, status, sha string) {
	e.t.Helper()
	e.exec(`INSERT INTO photos(id,owner_id,status,original_key,original_sha256,original_bytes,format,
		public_fields,histogram_public,original_download,created_at,updated_at)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
		id, owner, status, "o/"+owner+"/"+id, sha, 100, "jpeg", `["iso"]`, 0, 0, t0, t0)
}

func (e *env) status(id string) (string, sql.NullString) {
	e.t.Helper()
	var st string
	var msg sql.NullString
	if err := e.d.QueryRow(`SELECT status,error FROM photos WHERE id=?`, id).Scan(&st, &msg); err != nil {
		e.t.Fatal(err)
	}
	return st, msg
}

type jobRow struct{ Kind, Payload string }

func (e *env) jobs() []jobRow {
	e.t.Helper()
	rows, err := e.d.Query(`SELECT kind,payload FROM jobs ORDER BY id`)
	if err != nil {
		e.t.Fatal(err)
	}
	defer rows.Close()
	var out []jobRow
	for rows.Next() {
		var j jobRow
		if err := rows.Scan(&j.Kind, &j.Payload); err != nil {
			e.t.Fatal(err)
		}
		out = append(out, j)
	}
	return out
}

// --- client ---

type client struct {
	e      *env
	cookie string
	csrf   string
}

type resp struct {
	code   int
	raw    string
	body   map[string]any
	header http.Header
}

func (r resp) errMsg() string { s, _ := r.body["error"].(string); return s }

// anon bootstraps an anonymous session (cookie + CSRF token) through identity.
func (e *env) anon() *client {
	c := &client{e: e}
	r := c.do(http.MethodGet, "/api/auth/session", "", nil)
	if r.code != 200 || c.cookie == "" || c.csrf == "" {
		e.t.Fatalf("bootstrap: %d %s", r.code, r.raw)
	}
	return c
}

// user creates a user and a client whose session is bound to it. The
// session comes from identity's own bootstrap; binding it directly skips
// scrypt so tests stay fast.
func (e *env) user(id string) *client {
	e.t.Helper()
	e.exec(`INSERT INTO users(id,email,password,created_at) VALUES(?,?,?,?)`, id, id+"@example.test", "x", t0)
	c := e.anon()
	e.exec(`UPDATE sessions SET user_id=?, expires_at=? WHERE csrf=?`, id, e.now.Load()+7*sessDay, c.csrf)
	return c
}

// do sends a request and asserts privacy, security headers and a JSON body.
func (c *client) do(method, path, body string, hdr map[string]string) resp {
	t := c.e.t
	t.Helper()
	out, err := c.send(method, path, body, hdr)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	return out
}

// send is do without t.Fatal, safe from goroutines; it returns the first
// failed assertion as an error.
func (c *client) send(method, path, body string, hdr map[string]string) (resp, error) {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	if method != http.MethodGet {
		r.Header.Set("Origin", origin)
		r.Header.Set("X-CSRF-Token", c.csrf)
	}
	if c.cookie != "" {
		r.Header.Set("Cookie", cookie+"="+c.cookie)
	}
	for k, v := range hdr {
		if v == "<delete>" {
			r.Header.Del(k)
		} else {
			r.Header.Set(k, v)
		}
	}
	w := httptest.NewRecorder()
	c.e.h.ServeHTTP(w, r)
	out := resp{code: w.Code, raw: w.Body.String(), header: w.Header()}
	if out.code == http.StatusNoContent {
		// 204 carries no body; only the headers are checked.
		if out.raw != "" {
			return out, fmt.Errorf("204 with body %q", out.raw)
		}
		return out, checkSecurityHeaders(out.header)
	}
	if leak := privacyLeak(out.raw); leak != "" {
		return out, fmt.Errorf("response leaks %s: %s", leak, out.raw)
	}
	if err := checkSecurityHeaders(out.header); err != nil {
		return out, err
	}
	if ct := out.header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		return out, fmt.Errorf("content-type %q", ct)
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out.body); err != nil {
		return out, fmt.Errorf("body is not a JSON object: %q", out.raw)
	}
	for _, ck := range w.Result().Cookies() {
		if ck.Name == cookie {
			c.cookie = ck.Value
		}
	}
	if tok, ok := out.body["csrfToken"].(string); ok {
		c.csrf = tok
	}
	return out, nil
}

func (c *client) post(path, body string) resp { return c.do(http.MethodPost, path, body, nil) }
func (c *client) get(path string) resp        { return c.do(http.MethodGet, path, "", nil) }
func (c *client) put(path, body string) resp  { return c.do(http.MethodPut, path, body, nil) }
func (c *client) del(path string) resp        { return c.do(http.MethodDelete, path, "", nil) }

// privacyLeak describes the first leak in body, or returns "". Keys and
// string values are checked structurally so random tokens cannot trip it.
func privacyLeak(body string) string {
	if m := privacyWordRe.FindString(body); m != "" {
		return fmt.Sprintf("word %q", m)
	}
	var v any
	if err := json.Unmarshal([]byte(body), &v); err != nil {
		return "non-JSON body"
	}
	// upload.url is the presigned PUT target the browser must use, so it
	// necessarily names the object; it is the only exempt string.
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
			if path != ".upload.url" && (strings.HasPrefix(x, "o/") || strings.Contains(x, "/o/")) {
				return fmt.Sprintf("original key %q", x)
			}
		}
		return ""
	}
	return walk("", v)
}

func TestPrivacyScanCatchesLeaks(t *testing.T) {
	for _, body := range []string{
		`{"latitude":1}`, `{"a":{"gpsLat":1}}`, `{"originalKey":"x"}`, `{"k":"o/u1/p1"}`,
		`{"url":"https://s.test/originals/o/u1/p1"}`, `[{"lng":2}]`, `{"m":"Longitude 3"}`,
	} {
		if privacyLeak(body) == "" {
			t.Errorf("scan missed %s", body)
		}
	}
	if l := privacyLeak(`{"csrfToken":"XGpSz1FPC6","title":"photo/2","upload":{"url":"https://s.test/b/o/u/p"}}`); l != "" {
		t.Errorf("false positive: %s", l)
	}
}

func checkSecurityHeaders(h http.Header) error {
	want := map[string]string{
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy":        "no-referrer",
		"X-Frame-Options":        "DENY",
		"Cache-Control":          "private, no-store",
	}
	for k, v := range want {
		if got := h.Get(k); got != v {
			return fmt.Errorf("header %s = %q, want %q", k, got, v)
		}
	}
	return nil
}

// --- skeleton tests ---

func TestUnknownAPIRouteIsJSON404(t *testing.T) {
	e := newEnv(t)
	c := e.user("u1")
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/nope"},
		{http.MethodGet, "/api/photos"},
		{http.MethodGet, "/api/photos/not-a-uuid"},
		{http.MethodGet, "/api/photos/0192F0C4-0000-7000-8000-000000000000"},
		{http.MethodPost, "/api/uploads/not-a-uuid/complete"},
		{http.MethodPost, "/api/nope"},
	} {
		r := c.do(tc.method, tc.path, "", nil)
		if r.code != 404 || r.errMsg() == "" {
			t.Errorf("%s %s: %d %s", tc.method, tc.path, r.code, r.raw)
		}
	}
	r := c.get("/api/uploads")
	if r.code != 405 || r.errMsg() == "" {
		t.Errorf("GET /api/uploads: %d %s", r.code, r.raw)
	}
}

func TestIdentityRoutesAreMounted(t *testing.T) {
	e := newEnv(t)
	c := e.user("u1")
	r := c.get("/api/auth/session")
	if r.code != 200 || r.body["user"] != "u1" {
		t.Fatalf("session: %d %s", r.code, r.raw)
	}
}
