// Package api is the JSON HTTP API (spec §6.1, §7). New builds the whole
// handler: security headers, the identity middleware (sessions, CSRF,
// no-store, body limit), identity's /api/auth routes and the app routes.
package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/timeStarry/frameMark/internal/clock"
	"github.com/timeStarry/frameMark/internal/config"
	"github.com/timeStarry/frameMark/internal/httperr"
	"github.com/timeStarry/frameMark/internal/identity"
	"github.com/timeStarry/frameMark/internal/jobs"
	"github.com/timeStarry/frameMark/internal/storage"
)

// Storage is the subset of *storage.Client the API uses. Tests supply a fake.
type Storage interface {
	PresignPut(ctx context.Context, bucket, key, contentType, sha256Hex string, ttl time.Duration) (storage.PresignedRequest, error)
	Head(ctx context.Context, bucket, key string) (storage.Object, error)
	Delete(ctx context.Context, bucket, key string) error
	PresignGet(ctx context.Context, bucket, key string, ttl time.Duration, downloadName string) (string, error)
}

var _ Storage = (*storage.Client)(nil)

// Deps wires the API. Now returns Unix milliseconds; nil means clock.Now.
type Deps struct {
	DB       *sql.DB
	Identity *identity.Service
	Storage  Storage
	Jobs     *jobs.Queue
	Now      func() int64
	Cfg      config.Config
}

const (
	msgNeedLogin   = "请先登录。"
	msgBadJSON     = "请求格式无效。"
	msgBodyTooBig  = "请求体过大。"
	msgNotFound    = "接口不存在。"
	msgBadMethod   = "不支持的请求方法。"
	msgPhotoAbsent = "照片不存在。"
)

type server struct {
	db    *sql.DB
	store Storage
	q     *jobs.Queue
	cfg   config.Config
	now   func() int64
}

// New returns the API handler. Every response carries the security headers;
// every /api/ request passes identity.Middleware before routing.
func New(d Deps) http.Handler {
	if d.Now == nil {
		d.Now = clock.Now
	}
	s := &server{db: d.DB, store: d.Storage, q: d.Jobs, cfg: d.Cfg, now: d.Now}
	r := chi.NewRouter()
	r.NotFound(func(w http.ResponseWriter, r *http.Request) {
		httperr.Write(w, httperr.Fail(http.StatusNotFound, msgNotFound))
	})
	r.MethodNotAllowed(func(w http.ResponseWriter, r *http.Request) {
		httperr.Write(w, httperr.Fail(http.StatusMethodNotAllowed, msgBadMethod))
	})
	d.Identity.Routes(r)
	s.routes(r)
	return securityHeaders(d.Identity.Middleware(r))
}

func (s *server) routes(r chi.Router) {
	r.Post("/api/uploads", s.handle(s.createUpload))
	r.Post("/api/uploads/{id}/complete", s.handle(s.completeUpload))
	r.Get("/api/photos/{id}", s.handle(s.getPhoto))
	r.Delete("/api/photos/{id}", s.handle(s.deletePhoto))
	r.Get("/api/photos/{id}/original", s.handle(s.originalDownload))
	r.Get("/m/{photoId}/{hash}/{file}", s.mediaRedirect)

	r.Post("/api/collections", s.handle(s.createCollection))
	r.Put("/api/collections/{id}", s.handle(s.updateCollection))
	r.Delete("/api/collections/{id}", s.handle(s.deleteCollection))
	r.Put("/api/collections/{id}/frames", s.handle(s.putFrames))
	r.Post("/api/collections/{id}/publish", s.handle(s.publishCollection))
	r.Post("/api/collections/{id}/unpublish", s.handle(s.unpublishCollection))
	r.Put("/api/collections/{id}/overrides/{photoId}", s.handle(s.putOverride))

	r.Post("/api/albums", s.handle(s.createAlbum))
	r.Put("/api/albums/{id}", s.handle(s.updateAlbum))
	r.Delete("/api/albums/{id}", s.handle(s.deleteAlbum))
	r.Put("/api/albums/{id}/items", s.handle(s.putAlbumItems))

	r.Get("/api/square", s.handle(s.readSquare))
	r.Get("/api/u/{userId}", s.handle(s.readUser))
	r.Get("/api/collections/{id}", s.handle(s.readCollection))
	r.Get("/api/collections/{id}/neighbors", s.handle(s.readNeighbors))
	r.Get("/api/albums/{id}", s.handle(s.readAlbum))
	r.Get("/api/archive", s.handle(s.readArchive))

	r.Put("/api/profile", s.handle(s.putProfile))
	r.Get("/api/upload-prefs", s.handle(s.getPrefs))
	r.Put("/api/upload-prefs", s.handle(s.putPrefs))
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			h.Set("Cache-Control", "private, no-store")
		}
		next.ServeHTTP(w, r)
	})
}

// Response convention (binding for all routes in this package): a single
// resource is returned as the bare object (e.g. GET /api/photos/{id}, and the
// 200/202 photo bodies of the upload endpoints), never wrapped as
// {"photo": …}; the status code tells the client which shape it has. Lists are
// {"items": […], "nextCursor": string|null}. Field names are camelCase and
// times are Unix milliseconds. Errors are {"error": message} via httperr.
//
// handlerFunc returns the status and body to send as JSON, or an error that
// is written through httperr (non-StatusError values become a generic 500).
// A 204 status sends no body. errRedirected means fn already wrote the
// response (a 302).
type handlerFunc func(w http.ResponseWriter, r *http.Request) (int, any, error)

func (s *server) handle(fn handlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		code, body, err := fn(w, r)
		if err == errRedirected {
			return
		}
		if err != nil {
			httperr.Write(w, err)
			return
		}
		if code == http.StatusNoContent {
			w.WriteHeader(code)
			return
		}
		writeJSON(w, code, body)
	}
}

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}

// errEmptyBody is returned by decodeJSON when the body has no JSON value.
var errEmptyBody = httperr.Fail(http.StatusBadRequest, msgBadJSON)

// decodeJSON strictly decodes exactly one JSON value into dst: unknown
// fields, wrong types and trailing data are 400, an oversized body 413.
// An empty body returns errEmptyBody so callers may choose to accept it.
func decodeJSON(r *http.Request, dst any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	err := dec.Decode(dst)
	if errors.Is(err, io.EOF) {
		return errEmptyBody
	}
	if err == nil {
		if extra := dec.Decode(&struct{}{}); !errors.Is(extra, io.EOF) {
			err = errors.New("trailing data")
			if extra != nil {
				err = extra
			}
		}
	}
	var tooBig *http.MaxBytesError
	switch {
	case err == nil:
		return nil
	case errors.As(err, &tooBig):
		return httperr.Fail(http.StatusRequestEntityTooLarge, msgBodyTooBig)
	default:
		return httperr.Fail(http.StatusBadRequest, msgBadJSON)
	}
}

// requireUser returns the logged-in user id, or a 401.
func requireUser(r *http.Request) (string, error) {
	if u := identity.User(r.Context()); u != "" {
		return u, nil
	}
	return "", httperr.Fail(http.StatusUnauthorized, msgNeedLogin)
}

// pathID returns the {id} URL parameter when it is a canonical (lowercase,
// hyphenated) UUID; anything else is a 404 so ids are never probed by shape.
func pathID(r *http.Request) (string, error) { return idParam(r, "id", msgPhotoAbsent) }

// idParam is pathID for any URL parameter, with the 404 message to use.
func idParam(r *http.Request, name, absent string) (string, error) {
	raw := chi.URLParam(r, name)
	u, err := uuid.Parse(raw)
	if err != nil || u.String() != raw {
		return "", httperr.Fail(http.StatusNotFound, absent)
	}
	return raw, nil
}
