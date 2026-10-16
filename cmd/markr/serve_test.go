package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"testing"
	"testing/fstest"
	"time"

	"github.com/timeStarry/frameMark/internal/config"
	"github.com/timeStarry/frameMark/internal/db"
	"github.com/timeStarry/frameMark/internal/webui"
)

func testEnv(dir string, extra ...string) []string {
	return append([]string{
		"MARKR_ORIGIN=http://localhost:18150",
		"MARKR_DEV=1",
		"MARKR_DATA_DIR=" + dir,
		"MARKR_S3_ENDPOINT=http://127.0.0.1:1",
		"MARKR_S3_REGION=us-east-1",
		"MARKR_S3_ACCESS_KEY=test-access",
		"MARKR_S3_SECRET_KEY=test-secret-sentinel",
		"MARKR_BUCKET_ORIGINALS=originals",
		"MARKR_BUCKET_DERIVED=derived",
	}, extra...)
}

func freeAddr(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	l.Close()
	return addr
}

func TestMigrateCommand(t *testing.T) {
	dir := t.TempDir()
	var out bytes.Buffer
	if err := run(context.Background(), []string{"migrate"}, testEnv(dir), &out); err != nil {
		t.Fatal(err)
	}
	d, err := db.Open(filepath.Join(dir, dbFile))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	var v int
	if err := d.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil || v < 1 {
		t.Fatalf("user_version = %d, %v", v, err)
	}
	if fi, err := os.Stat(dir); err != nil || fi.Mode().Perm() != 0o700 {
		t.Fatalf("data dir mode = %v, %v", fi.Mode().Perm(), err)
	}
	d.Close()

	// A second migrate is a no-op.
	if err := run(context.Background(), []string{"migrate"}, testEnv(dir), &out); err != nil {
		t.Fatalf("second migrate: %v", err)
	}
	d2, err := db.Open(filepath.Join(dir, dbFile))
	if err != nil {
		t.Fatal(err)
	}
	defer d2.Close()
	var v2 int
	if err := d2.QueryRow(`PRAGMA user_version`).Scan(&v2); err != nil || v2 != v {
		t.Fatalf("user_version after second migrate = %d, %v; want %d", v2, err, v)
	}
}

func TestUsageErrors(t *testing.T) {
	dir := t.TempDir()
	for _, args := range [][]string{nil, {"bogus"}, {"serve", "--role=nope"}} {
		if err := run(context.Background(), args, testEnv(dir), io.Discard); err == nil {
			t.Errorf("args %v: expected error", args)
		}
	}
}

func get(t *testing.T, url string) int {
	t.Helper()
	c := &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{Proxy: nil}}
	resp, err := c.Get(url)
	if err != nil {
		return 0
	}
	resp.Body.Close()
	return resp.StatusCode
}

func serveAndCheck(t *testing.T, role string, extra ...string) {
	t.Helper()
	dir := t.TempDir()
	addr := freeAddr(t)
	var logs syncBuffer
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- run(ctx, []string{"serve", "--role=" + role}, testEnv(dir, append(extra, "MARKR_LISTEN="+addr)...), &logs)
	}()

	base := "http://" + addr
	deadline := time.Now().Add(10 * time.Second)
	for get(t, base+"/api/square") != http.StatusOK {
		if time.Now().After(deadline) {
			cancel()
			t.Fatalf("server never came up: %s", logs.String())
		}
		time.Sleep(20 * time.Millisecond)
	}
	want := http.StatusNotFound
	for _, e := range extra {
		if e == "MARKR_IDENTITY_ENABLED=true" {
			want = http.StatusOK
		}
	}
	if code := get(t, base+"/api/auth/session"); code != want {
		t.Errorf("/api/auth/session = %d, want %d", code, want)
	}
	checkComposed(t, base)

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(40 * time.Second):
		t.Fatal("serve did not shut down")
	}
	if strings.Contains(logs.String(), "test-secret-sentinel") {
		t.Fatal("secret in logs")
	}
	if !strings.Contains(logs.String(), "markr starting") {
		t.Fatalf("no startup log: %s", logs.String())
	}
}

// checkComposed asserts the API keeps its JSON 404s and that the frontend
// answers everything else, whether or not a web build is embedded.
func checkComposed(t *testing.T, base string) {
	t.Helper()
	c := &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{Proxy: nil}}
	for _, p := range []string{"/api/nope", "/m/nope"} {
		resp, err := c.Get(base + p)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound || !strings.HasPrefix(resp.Header.Get("Content-Type"), "application/json") {
			t.Errorf("%s = %d %q %q", p, resp.StatusCode, resp.Header.Get("Content-Type"), body)
		}
	}
	resp, err := c.Get(base + "/c/x")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/html") {
		t.Errorf("/c/x Content-Type %q", resp.Header.Get("Content-Type"))
	}
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusServiceUnavailable:
		if !strings.Contains(string(body), "前端尚未构建") {
			t.Errorf("/c/x 503 body %q", body)
		}
	default:
		t.Errorf("/c/x = %d", resp.StatusCode)
	}
	csp := resp.Header.Get("Content-Security-Policy")
	if !strings.Contains(csp, "img-src 'self' data: http://127.0.0.1:1;") {
		t.Errorf("/c/x CSP %q lacks S3 host", csp)
	}
}

func TestRootHandlerRouting(t *testing.T) {
	apiH := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		io.WriteString(w, `{"error":"接口不存在。"}`)
	})
	web := webui.HandlerFS(fstest.MapFS{"index.html": {Data: []byte("<!doctype html><title>Markr</title>")}}, webui.Options{})
	h := rootHandler(apiH, web)
	for path, wantType := range map[string]string{
		"/api/nope":  "application/json",
		"/m/a/b/c":   "application/json",
		"/c/x":       "text/html",
		"/":          "text/html",
		"/apix":      "text/html",
		"/media/abc": "text/html",
	} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if !strings.HasPrefix(rec.Header().Get("Content-Type"), wantType) {
			t.Errorf("%s: Content-Type %q, want %s", path, rec.Header().Get("Content-Type"), wantType)
		}
	}
}

func TestImgHosts(t *testing.T) {
	cases := []struct {
		cfg  config.Config
		want []string
	}{
		{config.Config{}, nil},
		{config.Config{S3Endpoint: "http://127.0.0.1:9000", S3PathStyle: true, BucketOriginals: "o", BucketDerived: "d"}, []string{"http://127.0.0.1:9000"}},
		{config.Config{S3Endpoint: "https://tos-cn-beijing.volces.com/", BucketOriginals: "orig", BucketDerived: "der"},
			[]string{"https://tos-cn-beijing.volces.com", "https://orig.tos-cn-beijing.volces.com", "https://der.tos-cn-beijing.volces.com"}},
		{config.Config{S3Endpoint: "http://127.0.0.1:1", BucketOriginals: "o", BucketDerived: "d"}, []string{"http://127.0.0.1:1"}},
		{config.Config{S3Endpoint: "not a url"}, nil},
	}
	for _, c := range cases {
		if got := imgHosts(c.cfg); !slices.Equal(got, c.want) {
			t.Errorf("imgHosts(%q) = %v, want %v", c.cfg.S3Endpoint, got, c.want)
		}
	}
}

func TestServeAPIRole(t *testing.T) {
	serveAndCheck(t, "api")
	serveAndCheck(t, "api", "MARKR_IDENTITY_ENABLED=true")
}

func TestServeAllRoleShutsDown(t *testing.T) {
	serveAndCheck(t, "all", "MARKR_WORKERS=1")
}

func TestServeWorkerRoleShutsDown(t *testing.T) {
	dir := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	var logs syncBuffer
	// The worker role never builds identity, so an unusable SMTP file is
	// not loaded (role=api would fail on it).
	smtp := testEnv(dir, "MARKR_SMTP_CONFIG_FILE="+filepath.Join(dir, "missing.env"))
	if err := run(context.Background(), []string{"serve", "--role=api"}, smtp, io.Discard); err == nil {
		t.Fatal("api role must fail on a missing SMTP file")
	}
	go func() { done <- run(ctx, []string{"serve", "--role=worker"}, smtp, &logs) }()
	time.Sleep(200 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("worker did not shut down")
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

// TestMain lets TestSecondSignalForcesExit re-run this binary as a serve child.
func TestMain(m *testing.M) {
	if os.Getenv("MARKR_SERVE_CHILD") == "1" {
		err := run(context.Background(), []string{"serve", "--role=api"}, os.Environ(), os.Stderr)
		if err != nil {
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestSecondSignalForcesExit(t *testing.T) {
	dir := t.TempDir()
	addr := freeAddr(t)
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	cmd.Env = append(testEnv(dir, "MARKR_LISTEN="+addr), "MARKR_SERVE_CHILD=1")
	var logs syncBuffer
	cmd.Stderr = &logs
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	defer cmd.Process.Kill()

	deadline := time.Now().Add(10 * time.Second)
	for get(t, "http://"+addr+"/api/square") != http.StatusOK {
		if time.Now().After(deadline) {
			t.Fatalf("child never came up: %s", logs.String())
		}
		time.Sleep(20 * time.Millisecond)
	}
	// A half-sent request keeps the connection active, so the graceful
	// shutdown waits on it (up to ReadHeaderTimeout).
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("GET /api/square HTTP/1.1\r\nHost: x\r\n")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)

	if err := cmd.Process.Signal(syscall.SIGINT); err != nil {
		t.Fatal(err)
	}
	for !strings.Contains(logs.String(), "shutting down") {
		select {
		case err := <-exited:
			t.Fatalf("child exited before the second signal: %v", err)
		case <-time.After(20 * time.Millisecond):
		}
		if time.Now().After(deadline.Add(5 * time.Second)) {
			t.Fatalf("no shutdown log: %s", logs.String())
		}
	}
	if err := cmd.Process.Signal(syscall.SIGINT); err != nil {
		t.Fatal(err)
	}
	select {
	case <-exited:
	case <-time.After(3 * time.Second):
		t.Fatal("second SIGINT did not terminate the child")
	}
}

// Final review I2: a listener that cannot bind makes serve return an error
// (non-zero exit), not nil.
func TestServeFailsWhenPortTaken(t *testing.T) {
	for _, role := range []string{"api", "all"} {
		t.Run(role, func(t *testing.T) {
			l, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer l.Close()
			done := make(chan error, 1)
			go func() {
				done <- run(context.Background(), []string{"serve", "--role=" + role},
					testEnv(t.TempDir(), "MARKR_LISTEN="+l.Addr().String(), "MARKR_IDENTITY_ENABLED=true"), io.Discard)
			}()
			select {
			case err := <-done:
				if err == nil || !strings.Contains(err.Error(), "address already in use") {
					t.Fatalf("serve = %v, want bind error", err)
				}
			case <-time.After(40 * time.Second):
				t.Fatal("serve did not return")
			}
		})
	}
}

// Final review I3: worker and all refuse to start when the libvips
// self-check fails; api does not run it.
func TestServeRefusesWithoutMediaFormats(t *testing.T) {
	orig := mediaSelfCheck
	t.Cleanup(func() { mediaSelfCheck = orig })
	calls := 0
	mediaSelfCheck = func() error { calls++; return errors.New("media self-check: libvips cannot encode AVIF") }
	for _, role := range []string{"worker", "all"} {
		// Bounded: without the check these roles would serve until cancelled.
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		err := run(ctx, []string{"serve", "--role=" + role}, testEnv(t.TempDir(), "MARKR_LISTEN="+freeAddr(t)), io.Discard)
		cancel()
		if err == nil || !strings.Contains(err.Error(), "AVIF") {
			t.Fatalf("%s: serve = %v", role, err)
		}
	}
	if calls != 2 {
		t.Fatalf("self-check calls = %d", calls)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	addr := freeAddr(t)
	go func() {
		done <- run(ctx, []string{"serve", "--role=api"}, testEnv(t.TempDir(), "MARKR_LISTEN="+addr), io.Discard)
	}()
	deadline := time.Now().Add(10 * time.Second)
	for get(t, "http://"+addr+"/api/square") != http.StatusOK {
		if time.Now().After(deadline) {
			cancel()
			t.Fatal("api role never came up")
		}
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	if err := <-done; err != nil || calls != 2 {
		t.Fatalf("api: %v, calls %d", err, calls)
	}
}
