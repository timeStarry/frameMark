// Package webui serves the embedded web frontend built by web/ (Vite outputs
// into dist/). Unknown extensionless paths fall back to index.html so the
// client router can handle them; /api/ and /m/ are never answered with HTML.
package webui

import (
	"bytes"
	"embed"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"path"
	"strings"
	"time"
)

// FS holds the Vite build. In a fresh checkout it contains only dist/.gitkeep.
//
//go:embed all:dist
var FS embed.FS

// Options configures the Content-Security-Policy for HTML responses.
type Options struct {
	// CDNBase is the origin derived images are served from (may be empty).
	CDNBase string
	// ImgHosts are further image origins, such as S3 presigned URL hosts.
	ImgHosts []string
	// ConnectHosts are further fetch/XHR origins, such as the S3 hosts the
	// browser PUTs presigned uploads to.
	ConnectHosts []string
}

const (
	cacheImmutable = "public, max-age=31536000, immutable"
	cacheNoCache   = "no-cache"
	notBuiltMsg    = "前端尚未构建：在 web/ 下运行 npm run build。"
)

var notBuiltPage = []byte(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Markr</title></head>
<body><p>` + notBuiltMsg + `</p></body></html>
`)

// Handler serves the embedded build.
func Handler(opts Options) http.Handler {
	sub, err := fs.Sub(FS, "dist")
	if err != nil {
		// fs.Sub only fails on an invalid path literal.
		panic(err)
	}
	return HandlerFS(sub, opts)
}

// HandlerFS serves fsys as the frontend root; tests pass an fstest.MapFS.
func HandlerFS(fsys fs.FS, opts Options) http.Handler {
	h := &handler{fsys: fsys, csp: buildCSP(opts)}
	if b, err := fs.ReadFile(fsys, "index.html"); err == nil {
		h.index = b
		h.built = true
	}
	return h
}

func buildCSP(opts Options) string {
	img := []string{"'self'", "data:"}
	for _, s := range append([]string{opts.CDNBase}, opts.ImgHosts...) {
		if s = strings.TrimSpace(s); s != "" {
			img = append(img, s)
		}
	}
	connect := []string{"'self'"}
	for _, s := range opts.ConnectHosts {
		if s = strings.TrimSpace(s); s != "" {
			connect = append(connect, s)
		}
	}
	return strings.Join([]string{
		"default-src 'self'",
		"img-src " + strings.Join(img, " "),
		"style-src 'self'",
		"script-src 'self'",
		"connect-src " + strings.Join(connect, " "),
		"base-uri 'none'",
		"form-action 'self'",
		"frame-ancestors 'none'",
	}, "; ")
}

type handler struct {
	fsys  fs.FS
	csp   string
	index []byte
	built bool
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	hd := w.Header()
	hd.Set("X-Content-Type-Options", "nosniff")
	hd.Set("Referrer-Policy", "no-referrer")
	hd.Set("X-Frame-Options", "DENY")

	p := r.URL.Path
	if strings.HasPrefix(p, "/api/") || strings.HasPrefix(p, "/m/") {
		// Defensive: the composing layer routes these to the API.
		hd.Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"error":"未找到。"}`+"\n")
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		hd.Set("Allow", "GET, HEAD")
		http.Error(w, "方法不允许。", http.StatusMethodNotAllowed)
		return
	}
	if !h.built {
		h.writeHTML(w, r, http.StatusServiceUnavailable, notBuiltPage)
		return
	}

	name := strings.TrimPrefix(path.Clean("/"+p), "/")
	if name == "" || name == "index.html" {
		h.writeHTML(w, r, http.StatusOK, h.index)
		return
	}
	if b, err := fs.ReadFile(h.fsys, name); err == nil {
		h.serveFile(w, r, name, b)
		return
	} else if !errors.Is(err, fs.ErrNotExist) && !isDirErr(h.fsys, name) {
		http.Error(w, "读取失败。", http.StatusInternalServerError)
		return
	}
	if path.Ext(name) != "" {
		http.Error(w, "未找到。", http.StatusNotFound)
		return
	}
	h.writeHTML(w, r, http.StatusOK, h.index)
}

// isDirErr reports whether name is a directory; directories are never listed
// and are treated like a missing extensionless path.
func isDirErr(fsys fs.FS, name string) bool {
	st, err := fs.Stat(fsys, name)
	return err == nil && st.IsDir()
}

func (h *handler) serveFile(w http.ResponseWriter, r *http.Request, name string, b []byte) {
	if strings.HasPrefix(name, "assets/") {
		w.Header().Set("Cache-Control", cacheImmutable)
	} else {
		w.Header().Set("Cache-Control", cacheNoCache)
	}
	if strings.HasSuffix(name, ".html") {
		w.Header().Set("Content-Security-Policy", h.csp)
	}
	// ServeContent sets Content-Type from the extension and handles HEAD
	// and Range. Embedded files carry no mod time, so pass the zero time.
	http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(b))
}

func (h *handler) writeHTML(w http.ResponseWriter, r *http.Request, status int, body []byte) {
	hd := w.Header()
	hd.Set("Content-Type", "text/html; charset=utf-8")
	hd.Set("Cache-Control", cacheNoCache)
	hd.Set("Content-Security-Policy", h.csp)
	w.WriteHeader(status)
	if r.Method != http.MethodHead {
		_, _ = w.Write(body)
	}
}
