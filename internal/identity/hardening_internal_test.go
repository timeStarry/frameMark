package identity

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/timeStarry/frameMark/internal/db"
	"github.com/timeStarry/frameMark/internal/httperr"
)

func newClockSvc(t *testing.T) (*Service, *sql.DB, *atomic.Int64) {
	t.Helper()
	d, err := db.Open(filepath.Join(t.TempDir(), "h.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	if err := db.Migrate(d); err != nil {
		t.Fatal(err)
	}
	now := &atomic.Int64{}
	now.Store(1_700_000_000_000)
	s := newTestService(t, d, Deps{Origin: qOrigin, Enabled: true, Now: now.Load})
	t.Cleanup(func() { s.Close(context.Background()) })
	return s, d, now
}

func rows(t *testing.T, d *sql.DB, table string) int {
	t.Helper()
	var n int
	if err := d.QueryRow(`SELECT count(*) FROM ` + table).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestPruneRunsAtMostOncePerMinute(t *testing.T) {
	s, d, now := newClockSvc(t)
	h := s.Handler()
	get := func() {
		r := httptest.NewRequest("GET", "/api/anything", nil)
		h.ServeHTTP(httptest.NewRecorder(), r)
	}
	get() // first request prunes and records the time
	expired := func() {
		if _, err := d.Exec(`INSERT OR REPLACE INTO rate_limits(key,count,expires_at) VALUES('k',1,?)`, now.Load()-1); err != nil {
			t.Fatal(err)
		}
	}
	expired()
	now.Add(pruneEveryMs - 1)
	get()
	if rows(t, d, "rate_limits") != 1 {
		t.Fatal("pruned again before the throttle interval")
	}
	now.Add(1)
	get()
	if rows(t, d, "rate_limits") != 0 {
		t.Fatal("prune did not run after the throttle interval")
	}
}

func TestRateWindowResetsWithoutPrune(t *testing.T) {
	s, d, now := newClockSvc(t)
	if err := s.rate("k", 1); err != nil {
		t.Fatal(err)
	}
	var se *httperr.StatusError
	if err := s.rate("k", 1); !errors.As(err, &se) || se.Status != 429 {
		t.Fatalf("second hit: %v", err)
	}
	now.Add(rateMs) // stored expires_at == now: window over
	if err := s.rate("k", 1); err != nil {
		t.Fatalf("window must reset without prune: %v", err)
	}
	var count int
	var exp int64
	if err := d.QueryRow(`SELECT count,expires_at FROM rate_limits`).Scan(&count, &exp); err != nil {
		t.Fatal(err)
	}
	if count != 1 || exp != now.Load()+rateMs {
		t.Fatalf("reset row: count=%d expires=%d", count, exp)
	}
	if err := s.rate("k", 1); !errors.As(err, &se) || se.Status != 429 {
		t.Fatalf("new window must count again: %v", err)
	}
}

func TestRateKeyIP(t *testing.T) {
	same := [][2]string{
		{"[2001:db8:1:2::1]:1", "[2001:db8:1:2:ffff:ffff:ffff:ffff]:9"},
		{"[2001:db8:1:2::1%en0]:1", "[2001:db8:1:2::2]:1"},
		{"[::ffff:192.0.2.1]:1", "192.0.2.1:2"},
	}
	for _, p := range same {
		if a, b := rateIP(p[0]), rateIP(p[1]); a != b {
			t.Errorf("%s and %s must share a bucket: %q vs %q", p[0], p[1], a, b)
		}
	}
	diff := [][2]string{
		{"[2001:db8:1:2::1]:1", "[2001:db8:1:3::1]:1"},
		{"192.0.2.1:1", "192.0.2.2:1"},
	}
	for _, p := range diff {
		if a, b := rateIP(p[0]), rateIP(p[1]); a == b {
			t.Errorf("%s and %s must not share a bucket: %q", p[0], p[1], a)
		}
	}
}

func TestDecodeIsStrict(t *testing.T) {
	for _, body := range []string{`{"email":"a@b.co"}{"x":1}`, `{"email":"a@b.co"} garbage`, `{"email":"a@b.co","extra":1}`, `[]`} {
		r := httptest.NewRequest("POST", "/", strings.NewReader(body))
		var se *httperr.StatusError
		if _, err := decode(r); !errors.As(err, &se) || se.Status != http.StatusBadRequest {
			t.Errorf("%s: want 400, got %v", body, err)
		}
	}
	for _, body := range []string{``, `{}`, `{"email":"a@b.co"}`, "{\"email\":\"a@b.co\"}\n"} {
		if _, err := decode(httptest.NewRequest("POST", "/", strings.NewReader(body))); err != nil {
			t.Errorf("%q: %v", body, err)
		}
	}
}

// The session touch is throttled: touched_at is rewritten only once it is
// at least touchEveryMs old, so bursts (e.g. many /m/ images) do not write.
func TestSessionTouchThrottled(t *testing.T) {
	s, d, now := newClockSvc(t)
	h := s.Handler()
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/api/auth/session", nil))
	var val string
	for _, c := range w.Result().Cookies() {
		if c.Name == s.cookie {
			val = c.Value
		}
	}
	if val == "" {
		t.Fatal("no session cookie")
	}
	touched := func() int64 {
		var v int64
		if err := d.QueryRow(`SELECT touched_at FROM sessions`).Scan(&v); err != nil {
			t.Fatal(err)
		}
		return v
	}
	get := func(path string) {
		r := httptest.NewRequest("GET", path, nil)
		r.Header.Set("Cookie", s.cookie+"="+val)
		h.ServeHTTP(httptest.NewRecorder(), r)
	}
	start := touched()
	now.Add(touchEveryMs - 1)
	get("/m/x")
	if touched() != start {
		t.Fatal("touched before the throttle interval")
	}
	now.Add(1)
	get("/m/x")
	if got := touched(); got != now.Load() {
		t.Fatalf("touched_at %d, want %d", got, now.Load())
	}
}
