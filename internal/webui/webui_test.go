package webui

import (
	"encoding/json"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func built() fstest.MapFS {
	return fstest.MapFS{
		".gitkeep":           {Data: []byte{}},
		"index.html":         {Data: []byte("<!doctype html><title>Markr</title>")},
		"favicon.svg":        {Data: []byte("<svg/>")},
		"assets/app-abc.js":  {Data: []byte("console.log(1)")},
		"assets/app-abc.css": {Data: []byte("body{}")},
	}
}

func do(t *testing.T, h http.Handler, method, path string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(method, path, nil))
	return rec
}

func checkSecurityHeaders(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	h := rec.Header()
	if h.Get("X-Content-Type-Options") != "nosniff" || h.Get("Referrer-Policy") != "no-referrer" || h.Get("X-Frame-Options") != "DENY" {
		t.Errorf("missing security headers: %v", h)
	}
}

func TestSPAFallback(t *testing.T) {
	h := HandlerFS(built(), Options{})
	for _, p := range []string{"/", "/c/abc", "/c/abc/", "/deep/nested/route"} {
		rec := do(t, h, http.MethodGet, p)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: code %d", p, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "<title>Markr</title>") {
			t.Errorf("%s: body %q", p, rec.Body.String())
		}
		if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
			t.Errorf("%s: Cache-Control %q", p, got)
		}
		if !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/html") {
			t.Errorf("%s: Content-Type %q", p, rec.Header().Get("Content-Type"))
		}
		if rec.Header().Get("Content-Security-Policy") == "" {
			t.Errorf("%s: no CSP", p)
		}
		checkSecurityHeaders(t, rec)
	}
}

func TestIndexHTMLDirect(t *testing.T) {
	h := HandlerFS(built(), Options{})
	rec := do(t, h, http.MethodGet, "/index.html")
	// http.FileServer would redirect /index.html to /; either way no loop and no immutable cache.
	if rec.Code != http.StatusOK {
		t.Fatalf("code %d", rec.Code)
	}
	if rec.Header().Get("Cache-Control") != "no-cache" {
		t.Errorf("Cache-Control %q", rec.Header().Get("Cache-Control"))
	}
}

func TestAssetCaching(t *testing.T) {
	h := HandlerFS(built(), Options{})
	rec := do(t, h, http.MethodGet, "/assets/app-abc.js")
	if rec.Code != http.StatusOK || rec.Body.String() != "console.log(1)" {
		t.Fatalf("code %d body %q", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
		t.Errorf("Cache-Control %q", got)
	}
	if rec.Header().Get("Content-Security-Policy") != "" {
		t.Error("CSP on non-HTML response")
	}
	checkSecurityHeaders(t, rec)

	rec = do(t, h, http.MethodGet, "/favicon.svg")
	if rec.Code != http.StatusOK {
		t.Fatalf("favicon code %d", rec.Code)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
		t.Errorf("favicon Cache-Control %q", got)
	}
}

func TestMissingFileWithExtension(t *testing.T) {
	h := HandlerFS(built(), Options{})
	for _, p := range []string{"/assets/gone-123.js", "/robots.txt", "/c/abc/x.png"} {
		rec := do(t, h, http.MethodGet, p)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s: code %d", p, rec.Code)
		}
		if !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/plain") {
			t.Errorf("%s: Content-Type %q", p, rec.Header().Get("Content-Type"))
		}
		if strings.Contains(rec.Body.String(), "<title>") {
			t.Errorf("%s: fell back to index.html", p)
		}
	}
}

func TestDirectoryIsNotListed(t *testing.T) {
	h := HandlerFS(built(), Options{})
	rec := do(t, h, http.MethodGet, "/assets/")
	if strings.Contains(rec.Body.String(), "app-abc.js") {
		t.Fatalf("directory listing exposed: %q", rec.Body.String())
	}
}

func TestHead(t *testing.T) {
	h := HandlerFS(built(), Options{})
	rec := do(t, h, http.MethodHead, "/c/abc")
	if rec.Code != http.StatusOK || rec.Body.Len() != 0 {
		t.Fatalf("code %d body len %d", rec.Code, rec.Body.Len())
	}
	if rec.Header().Get("Cache-Control") != "no-cache" {
		t.Errorf("Cache-Control %q", rec.Header().Get("Cache-Control"))
	}
	rec = do(t, h, http.MethodHead, "/assets/app-abc.js")
	if rec.Code != http.StatusOK || rec.Body.Len() != 0 {
		t.Fatalf("asset HEAD code %d body len %d", rec.Code, rec.Body.Len())
	}
}

func TestMethodNotAllowed(t *testing.T) {
	h := HandlerFS(built(), Options{})
	for _, m := range []string{http.MethodPost, http.MethodPut, http.MethodDelete} {
		rec := do(t, h, m, "/c/abc")
		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s: code %d", m, rec.Code)
		}
		if a := rec.Header().Get("Allow"); a != "GET, HEAD" {
			t.Errorf("%s: Allow %q", m, a)
		}
	}
}

func TestDefensiveAPIAndMedia404(t *testing.T) {
	h := HandlerFS(built(), Options{})
	for _, p := range []string{"/api/x", "/api/", "/m/p/h/f.webp"} {
		for _, m := range []string{http.MethodGet, http.MethodPost} {
			rec := do(t, h, m, p)
			if rec.Code != http.StatusNotFound {
				t.Fatalf("%s %s: code %d", m, p, rec.Code)
			}
			if !strings.HasPrefix(rec.Header().Get("Content-Type"), "application/json") {
				t.Errorf("%s %s: Content-Type %q", m, p, rec.Header().Get("Content-Type"))
			}
			var body map[string]string
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body["error"] != "未找到。" {
				t.Errorf("%s %s: body %q", m, p, rec.Body.String())
			}
			checkSecurityHeaders(t, rec)
		}
	}
}

func TestNotBuilt(t *testing.T) {
	h := HandlerFS(fstest.MapFS{".gitkeep": {Data: []byte{}}}, Options{})
	for _, p := range []string{"/", "/c/abc", "/assets/app.js"} {
		rec := do(t, h, http.MethodGet, p)
		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s: code %d", p, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "前端尚未构建：在 web/ 下运行 npm run build。") {
			t.Errorf("%s: body %q", p, rec.Body.String())
		}
		if !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/html") {
			t.Errorf("%s: Content-Type %q", p, rec.Header().Get("Content-Type"))
		}
		if rec.Header().Get("Cache-Control") != "no-cache" {
			t.Errorf("%s: Cache-Control %q", p, rec.Header().Get("Cache-Control"))
		}
		checkSecurityHeaders(t, rec)
	}
	// Defensive JSON 404 still wins over 503.
	if rec := do(t, h, http.MethodGet, "/api/x"); rec.Code != http.StatusNotFound {
		t.Errorf("/api/x without build: %d", rec.Code)
	}
}

func TestCSP(t *testing.T) {
	const base = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
	got := do(t, HandlerFS(built(), Options{}), http.MethodGet, "/c/x").Header().Get("Content-Security-Policy")
	if got != base {
		t.Errorf("no hosts:\n got %q\nwant %q", got, base)
	}

	opts := Options{CDNBase: "https://cdn.example.com", ImgHosts: []string{"https://derived.s3.example.com", "", "https://s3.example.com"}}
	want := "default-src 'self'; img-src 'self' data: https://cdn.example.com https://derived.s3.example.com https://s3.example.com; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
	got = do(t, HandlerFS(built(), opts), http.MethodGet, "/c/x").Header().Get("Content-Security-Policy")
	if got != want {
		t.Errorf("with hosts:\n got %q\nwant %q", got, want)
	}

	// The 503 page is HTML too.
	got = do(t, HandlerFS(fstest.MapFS{}, opts), http.MethodGet, "/").Header().Get("Content-Security-Policy")
	if got != want {
		t.Errorf("503 page CSP %q", got)
	}
}

func TestCSPConnectHosts(t *testing.T) {
	got := do(t, HandlerFS(built(), Options{ConnectHosts: []string{"http://127.0.0.1:9000", " "}}), http.MethodGet, "/").Header().Get("Content-Security-Policy")
	if !strings.Contains(got, "; connect-src 'self' http://127.0.0.1:9000; ") {
		t.Errorf("connect hosts: %q", got)
	}
	got = do(t, HandlerFS(built(), Options{}), http.MethodGet, "/").Header().Get("Content-Security-Policy")
	if !strings.Contains(got, "; connect-src 'self'; ") {
		t.Errorf("no connect hosts: %q", got)
	}
}

func TestEmbeddedFSHasGitkeep(t *testing.T) {
	f, err := FS.Open("dist/.gitkeep")
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
	if _, err := fs.Sub(FS, "dist"); err != nil {
		t.Fatal(err)
	}
	// Handler must build regardless of whether a frontend build exists.
	rec := do(t, Handler(Options{}), http.MethodGet, "/c/x")
	if rec.Code != http.StatusOK && rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("code %d", rec.Code)
	}
	_, _ = io.Copy(io.Discard, rec.Body)
}
