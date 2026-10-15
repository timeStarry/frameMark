package api

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/timeStarry/frameMark/internal/domain"
	"github.com/timeStarry/frameMark/internal/httperr"
	"github.com/timeStarry/frameMark/internal/identity"
)

const (
	mediaTTL = 5 * time.Minute

	msgMediaAbsent = "图片不存在。"
)

// mediaTiers are the derived widths (spec §6.2) and mediaExts the derived
// object extensions. The JSON key for JPEG is "jpeg"; the object is .jpg.
var (
	mediaTiers = []string{"w480", "w1280", "w2400", "w3840"}
	mediaFiles = func() map[string]bool {
		m := map[string]bool{}
		for _, t := range mediaTiers {
			for _, ext := range []string{"avif", "webp", "jpg"} {
				m[t+"."+ext] = true
			}
		}
		return m
	}()
)

// --- response shapes ---

type mediaFormats struct {
	AVIF string `json:"avif"`
	WebP string `json:"webp"`
	JPEG string `json:"jpeg"`
}

// mediaView is the media block of every photo the API returns.
type mediaView struct {
	Width  int64                   `json:"width"`
	Height int64                   `json:"height"`
	Tiers  map[string]mediaFormats `json:"tiers"`
}

// mediaSource is the photo state the media URL builder needs.
type mediaSource struct {
	ID, Status    string
	Width, Height sql.NullInt64
	Hash          sql.NullString
}

// mediaFor builds a photo's media URLs in the context of coll (nil = the
// owner's archive, no collection). A photo that is not ready or has no
// derived hash has no media. Fixed CDN URLs are used only when
// domain.UsesCDN allows them for coll; everything else, unlisted included,
// goes through the re-authorizing /m/ redirect.
func (s *server) mediaFor(p mediaSource, coll *domain.Collection) *mediaView {
	if p.Status != statusReady || !p.Hash.Valid || p.Hash.String == "" || !p.Width.Valid || !p.Height.Valid {
		return nil
	}
	prefix := p.ID + "/" + p.Hash.String + "/"
	url := func(file string) string { return "/m/" + prefix + file + "?c=" }
	if coll != nil {
		if domain.UsesCDN(*coll, s.cfg.CDNBase) {
			url = func(file string) string { return s.cfg.CDNBase + "/d/" + prefix + file }
		} else {
			cid := coll.ID
			url = func(file string) string { return "/m/" + prefix + file + "?c=" + cid }
		}
	}
	m := &mediaView{Width: p.Width.Int64, Height: p.Height.Int64, Tiers: make(map[string]mediaFormats, len(mediaTiers))}
	for _, t := range mediaTiers {
		m.Tiers[t] = mediaFormats{AVIF: url(t + ".avif"), WebP: url(t + ".webp"), JPEG: url(t + ".jpg")}
	}
	return m
}

// --- GET /m/{photoId}/{hash}/{file} ---

// mediaRedirect re-authorizes every request: the viewer must own the photo,
// or ?c= must name a collection that contains the photo and is readable by
// the viewer. The hash must be the photo's current derived_hash, so URLs
// minted before a rotation (withdrawal) stop resolving. Success is a 302 to
// a 5-minute presigned GET; every failure is the same JSON 404.
func (s *server) mediaRedirect(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	notFound := func() { httperr.Write(w, httperr.Fail(http.StatusNotFound, msgMediaAbsent)) }
	pid, hash, file := chi.URLParam(r, "photoId"), chi.URLParam(r, "hash"), chi.URLParam(r, "file")
	if !canonicalUUID(pid) || !isLowerHex16(hash) || !mediaFiles[file] {
		notFound()
		return
	}
	ctx := r.Context()
	viewer := identity.User(ctx)
	var owner, status string
	var current sql.NullString
	err := s.db.QueryRowContext(ctx, `SELECT owner_id,status,derived_hash FROM photos WHERE id=?`, pid).Scan(&owner, &status, &current)
	if errors.Is(err, sql.ErrNoRows) {
		notFound()
		return
	}
	if err != nil {
		httperr.Write(w, err)
		return
	}
	if status != statusReady || !current.Valid || current.String != hash {
		notFound()
		return
	}
	coll, err := s.photoContext(ctx, pid, r.URL.Query().Get("c"))
	if err != nil {
		httperr.Write(w, err)
		return
	}
	if !domain.CanReadPhotoIn(domain.Photo{ID: pid, OwnerID: owner}, coll, viewer) {
		notFound()
		return
	}
	loc, err := s.store.PresignGet(ctx, s.cfg.BucketDerived, derivedPrefix(pid)+hash+"/"+file, mediaTTL, "")
	if err != nil {
		httperr.Write(w, err)
		return
	}
	redirect(w, loc)
}

// photoContext returns the collection named by cid when it is a canonical
// id of an existing collection whose frames contain photo; otherwise nil
// (no collection context).
func (s *server) photoContext(ctx context.Context, photo, cid string) (*domain.Collection, error) {
	if !canonicalUUID(cid) {
		return nil, nil
	}
	c, err := domainCollection(ctx, s.db, cid)
	if err != nil || c == nil {
		return nil, err
	}
	var one int
	err = s.db.QueryRowContext(ctx, `SELECT 1 FROM frame_photos fp JOIN frames f ON f.id=fp.frame_id
		WHERE f.collection_id=? AND fp.photo_id=? LIMIT 1`, cid, photo).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return c, nil
}

// domainCollection loads the permission-relevant part of a collection, or
// nil when it does not exist.
func domainCollection(ctx context.Context, q querier, id string) (*domain.Collection, error) {
	c := domain.Collection{ID: id}
	var dist, orig int
	err := q.QueryRowContext(ctx, `SELECT owner_id,status,visibility,distribute,original_download FROM collections WHERE id=?`, id).
		Scan(&c.OwnerID, &c.Status, &c.Visibility, &dist, &orig)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	c.Distribute, c.AllowOriginal = dist == 1, orig == 1
	return &c, nil
}

// --- GET /api/photos/{id}/original?collection={cid} ---

func (s *server) originalDownload(w http.ResponseWriter, r *http.Request) (int, any, error) {
	id, err := pathID(r)
	if err != nil {
		return 0, nil, err
	}
	ctx := r.Context()
	viewer := identity.User(ctx)
	var owner, status, key, title, format string
	err = s.db.QueryRowContext(ctx, `SELECT owner_id,status,original_key,title,format FROM photos WHERE id=?`, id).
		Scan(&owner, &status, &key, &title, &format)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil, httperr.Fail(http.StatusNotFound, msgPhotoAbsent)
	}
	if err != nil {
		return 0, nil, err
	}
	if status != statusReady {
		return 0, nil, httperr.Fail(http.StatusNotFound, msgPhotoAbsent)
	}
	coll, err := s.photoContext(ctx, id, r.URL.Query().Get("collection"))
	if err != nil {
		return 0, nil, err
	}
	var c domain.Collection // the zero collection is readable by no one
	if coll != nil {
		c = *coll
	}
	if !domain.CanDownloadOriginal(domain.Photo{ID: id, OwnerID: owner}, c, viewer) {
		return 0, nil, httperr.Fail(http.StatusNotFound, msgPhotoAbsent)
	}
	loc, err := s.store.PresignGet(ctx, s.cfg.BucketOriginals, key, mediaTTL, downloadName(id, title, format))
	if err != nil {
		return 0, nil, err
	}
	redirect(w, loc)
	return 0, nil, errRedirected
}

// redirect sends a bare 302 with no body. http.Redirect would add an HTML
// body echoing the presigned URL; the Location header is all a client needs.
func redirect(w http.ResponseWriter, loc string) {
	w.Header().Set("Location", loc)
	w.WriteHeader(http.StatusFound)
}

// errRedirected tells handle() the response has already been written.
var errRedirected = errors.New("api: response already written")

// downloadName is the sanitized title plus the format's extension: path
// separators, quotes, reserved filename characters, control and format
// characters are removed. An empty result falls back to the photo id.
func downloadName(id, title, format string) string {
	name := strings.TrimSpace(strings.Map(func(r rune) rune {
		switch {
		case strings.ContainsRune(`/\:*?"<>|`, r), unicode.IsControl(r), unicode.Is(unicode.Cf, r):
			return -1
		}
		return r
	}, title))
	name = strings.Trim(name, ". ")
	if name == "" {
		name = id
	}
	ext := map[string]string{"jpeg": ".jpg", "png": ".png", "webp": ".webp"}[format]
	return name + ext
}

func canonicalUUID(s string) bool {
	u, err := uuid.Parse(s)
	return err == nil && u.String() == s
}

func isLowerHex16(s string) bool {
	if len(s) != 16 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}
