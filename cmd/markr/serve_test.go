package main

import (
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/timeStarry/frameMark/internal/db"
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
