package api

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/timeStarry/frameMark/internal/domain"
	"github.com/timeStarry/frameMark/internal/httperr"
	"github.com/timeStarry/frameMark/internal/identity"
	"github.com/timeStarry/frameMark/internal/media"
)

const (
	squareDefaultLimit = 24
	squareMaxLimit     = 48
	maxFeatured        = 6
	stripSize          = 12

	wallSquare = "square"
	wallUser   = "user"
	wallAlbum  = "album"

	msgUserAbsent = "用户不存在。"
	msgCursor     = "游标无效。"
	msgLimit      = "limit 参数无效。"
)

// userIDRe bounds /api/u/{userId}: user ids are UUIDs for registered users
// but seeded ids such as "markr-demo" are plain slugs.
var userIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// --- response shapes ---

type ownerRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// cardView is a collection on a wall: square, user wall, album, neighbor strip.
type cardView struct {
	ID       string       `json:"id"`
	Title    string       `json:"title"`
	Owner    ownerRef     `json:"owner"`
	Count    int          `json:"count"`
	Cover    *mediaView   `json:"cover"`
	Previews []*mediaView `json:"previews"`
	// Status and Visibility are set only when the viewer owns the card.
	Status     *string `json:"status,omitempty"`
	Visibility *string `json:"visibility,omitempty"`
}

// maxPreviews bounds cardView.Previews: the first distinct photos in frame
// order that have ready media.
const maxPreviews = 5

// publicPhotoView is a photo as read inside one collection. EXIF and the
// histogram are filtered by domain.EffectivePublicFields for that
// collection. It never carries public_fields, status, location or the
// original key.
type publicPhotoView struct {
	ID           string           `json:"id"`
	Title        string           `json:"title"`
	Caption      string           `json:"caption"`
	Width        *int64           `json:"width"`
	Height       *int64           `json:"height"`
	Media        *mediaView       `json:"media"`
	EXIF         *exifView        `json:"exif"`
	Histogram    *[4][64]uint16   `json:"histogram"`
	Attribution  *json.RawMessage `json:"attribution"`
	Downloadable bool             `json:"downloadable"`
	// ownerPhotoFields is set only when the viewer owns the collection. As a
	// nil embedded pointer its keys are absent from the visitor JSON.
	*ownerPhotoFields
}

// ownerPhotoFields are the owner-only keys of a photo in the owner's read of
// their collection: the effective exposure in this collection's context and
// the raw override (null when there is none).
type ownerPhotoFields struct {
	PublicFields    []string           `json:"publicFields"`
	HistogramPublic bool               `json:"histogramPublic"`
	Override        *ownerOverrideView `json:"override"`
}

// ownerOverrideView is a photo_overrides row; a null field is not overridden.
type ownerOverrideView struct {
	PublicFields    []string `json:"publicFields"`
	HistogramPublic *bool    `json:"histogramPublic"`
}

type readFrameView struct {
	Layout     string             `json:"layout"`
	MatteRatio *float64           `json:"matteRatio"`
	Text       *string            `json:"text"`
	Photos     []*publicPhotoView `json:"photos"`
}

// collectionReadView is GET /api/collections/{id}. Status, visibility and
// distribute are present for the owner only.
type collectionReadView struct {
	ID               string           `json:"id"`
	Title            string           `json:"title"`
	Intro            string           `json:"intro"`
	Owner            ownerRef         `json:"owner"`
	Status           *string          `json:"status,omitempty"`
	Visibility       *string          `json:"visibility,omitempty"`
	Distribute       *bool            `json:"distribute,omitempty"`
	License          *string          `json:"license"`
	AIDeclaration    *string          `json:"aiDeclaration"`
	OriginalDownload bool             `json:"originalDownload"`
	Cover            *publicPhotoView `json:"cover"`
	PublishedAt      *int64           `json:"publishedAt"`
	// UpdatedAt is present for the owner only (optimistic concurrency).
	UpdatedAt *int64 `json:"updatedAt,omitempty"`
	// CoverPhotoID is the owner's explicit cover choice, owner only; Cover may
	// be the first-photo fallback, so the desk cannot infer the choice from it.
	CoverPhotoID *string         `json:"coverPhotoId,omitempty"`
	Frames       []readFrameView `json:"frames"`
}

type neighborsView struct {
	Wall  string     `json:"wall"`
	Prev  *cardView  `json:"prev"`
	Next  *cardView  `json:"next"`
	Strip []cardView `json:"strip"`
}

type squareView struct {
	Featured   []cardView `json:"featured"`
	Items      []cardView `json:"items"`
	NextCursor *string    `json:"nextCursor"`
}

type profileReadView struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Bio        string `json:"bio"`
	WallLayout string `json:"wallLayout"`
}

type albumCardView struct {
	ID    string     `json:"id"`
	Title string     `json:"title"`
	Intro string     `json:"intro"`
	Count int        `json:"count"`
	Cover *mediaView `json:"cover"`
}

type userWallView struct {
	Profile     profileReadView `json:"profile"`
	Collections []cardView      `json:"collections"`
	Albums      []albumCardView `json:"albums"`
}

// albumReadView is GET /api/albums/{id}. Visibility is owner-only.
type albumReadView struct {
	ID         string     `json:"id"`
	Title      string     `json:"title"`
	Intro      string     `json:"intro"`
	Owner      ownerRef   `json:"owner"`
	Visibility *string    `json:"visibility,omitempty"`
	Members    []cardView `json:"members"`
}

// --- collection rows ---

// collRow is a collections row with what the read paths need.
type collRow struct {
	domain.Collection
	Title, Intro string
	License, AI  sql.NullString
	Cover        sql.NullString
	PublishedAt  sql.NullInt64
	FeaturedRank sql.NullInt64
	WallRank     int64
	Frames       int
}

const collCols = `c.id,c.owner_id,c.status,c.visibility,c.distribute,c.original_download,c.title,c.intro,
	c.license,c.ai_declaration,c.cover_photo_id,c.published_at,c.featured_rank,c.wall_rank,
	(SELECT count(*) FROM frames WHERE collection_id=c.id)`

// squareWhere is the SQL form of domain.CollectionInSquare plus "has
// frames". It is a constant; every value comes through placeholders.
// Rows are re-checked with domain in Go.
const squareWhere = `c.status='published' AND c.visibility='public' AND c.distribute=1 AND c.published_at IS NOT NULL
	AND EXISTS (SELECT 1 FROM frames WHERE collection_id=c.id)`

type scanner interface{ Scan(dest ...any) error }

func scanColl(sc scanner) (collRow, error) {
	var c collRow
	var dist, orig int
	err := sc.Scan(&c.ID, &c.OwnerID, &c.Status, &c.Visibility, &dist, &orig, &c.Title, &c.Intro,
		&c.License, &c.AI, &c.Cover, &c.PublishedAt, &c.FeaturedRank, &c.WallRank, &c.Frames)
	c.Distribute, c.AllowOriginal = dist == 1, orig == 1
	return c, err
}

func queryColls(ctx context.Context, q querier, query string, args ...any) ([]collRow, error) {
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []collRow
	for rows.Next() {
		c, err := scanColl(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// readable is domain.CanReadCollection plus the frameless rule: a
// collection without frames is not found for anyone but its owner.
func readable(c collRow, viewer string) bool {
	if !domain.CanReadCollection(c.Collection, viewer) {
		return false
	}
	return c.Frames > 0 || domain.IsOwner(c.OwnerID, viewer)
}

func inSquare(c collRow) bool { return domain.CollectionInSquare(c.Collection) && c.Frames > 0 }

func onUserWall(c collRow, viewer string) bool {
	return domain.CollectionOnWall(c.Collection, viewer) && readable(c, viewer)
}

// loadReadable returns collection id when viewer may read it, else 404.
func (s *server) loadReadable(ctx context.Context, id, viewer string) (collRow, error) {
	c, err := scanColl(s.db.QueryRowContext(ctx, `SELECT `+collCols+` FROM collections c WHERE c.id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return collRow{}, httperr.Fail(http.StatusNotFound, msgCollectionAbsent)
	}
	if err != nil {
		return collRow{}, err
	}
	if !readable(c, viewer) {
		return collRow{}, httperr.Fail(http.StatusNotFound, msgCollectionAbsent)
	}
	return c, nil
}

// --- cards ---

// cardBuilder caches owner names across one response. viewer is the
// signed-in user ("" when anonymous); cards they own carry status and
// visibility.
type cardBuilder struct {
	s      *server
	ctx    context.Context
	viewer string
	names  map[string]string
}

func (s *server) cards(ctx context.Context, viewer string) *cardBuilder {
	return &cardBuilder{s: s, ctx: ctx, viewer: viewer, names: map[string]string{}}
}

func (b *cardBuilder) owner(id string) (ownerRef, error) {
	if n, ok := b.names[id]; ok {
		return ownerRef{ID: id, Name: n}, nil
	}
	var name string
	err := b.s.db.QueryRowContext(b.ctx, `SELECT name FROM profiles WHERE user_id=?`, id).Scan(&name)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return ownerRef{}, err
	}
	b.names[id] = name
	return ownerRef{ID: id, Name: name}, nil
}

// coverSource is the collection's cover photo, or else its first photo in
// frame order; ok is false for a collection without photos.
func coverSource(ctx context.Context, q querier, c collRow) (mediaSource, bool, error) {
	var m mediaSource
	err := q.QueryRowContext(ctx, `SELECT p.id,p.status,p.width,p.height,p.derived_hash FROM photos p
		WHERE p.id = coalesce(
			(SELECT fp.photo_id FROM frame_photos fp JOIN frames f ON f.id=fp.frame_id WHERE f.collection_id=? AND fp.photo_id=?),
			(SELECT fp.photo_id FROM frame_photos fp JOIN frames f ON f.id=fp.frame_id WHERE f.collection_id=? ORDER BY f.position,fp.slot LIMIT 1))`,
		c.ID, c.Cover, c.ID).Scan(&m.ID, &m.Status, &m.Width, &m.Height, &m.Hash)
	if errors.Is(err, sql.ErrNoRows) {
		return m, false, nil
	}
	return m, err == nil, err
}

func (b *cardBuilder) card(c collRow) (cardView, error) {
	o, err := b.owner(c.OwnerID)
	if err != nil {
		return cardView{}, err
	}
	v := cardView{ID: c.ID, Title: c.Title, Owner: o}
	if b.viewer != "" && b.viewer == c.OwnerID {
		st, vis := c.Status, c.Visibility
		v.Status, v.Visibility = &st, &vis
	}
	if err := b.s.db.QueryRowContext(b.ctx, `SELECT count(DISTINCT fp.photo_id) FROM frame_photos fp JOIN frames f ON f.id=fp.frame_id
		WHERE f.collection_id=?`, c.ID).Scan(&v.Count); err != nil {
		return cardView{}, err
	}
	src, ok, err := coverSource(b.ctx, b.s.db, c)
	if err != nil {
		return cardView{}, err
	}
	if ok {
		v.Cover = b.s.mediaFor(src, &c.Collection)
	}
	if v.Previews, err = b.previews(c); err != nil {
		return cardView{}, err
	}
	return v, nil
}

// previews returns media for the first maxPreviews distinct photos of c in
// frame order (position, then slot), skipping photos without ready media.
// It never returns nil.
func (b *cardBuilder) previews(c collRow) ([]*mediaView, error) {
	out := []*mediaView{}
	rows, err := b.s.db.QueryContext(b.ctx, `SELECT p.id,p.status,p.width,p.height,p.derived_hash
		FROM frame_photos fp JOIN frames f ON f.id=fp.frame_id JOIN photos p ON p.id=fp.photo_id
		WHERE f.collection_id=? ORDER BY f.position, fp.slot`, c.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	seen := map[string]bool{}
	for len(out) < maxPreviews && rows.Next() {
		var m mediaSource
		if err := rows.Scan(&m.ID, &m.Status, &m.Width, &m.Height, &m.Hash); err != nil {
			return nil, err
		}
		if seen[m.ID] {
			continue
		}
		seen[m.ID] = true
		if mv := b.s.mediaFor(m, &c.Collection); mv != nil {
			out = append(out, mv)
		}
	}
	return out, rows.Err()
}

func (b *cardBuilder) list(cs []collRow) ([]cardView, error) {
	out := make([]cardView, 0, len(cs))
	for _, c := range cs {
		v, err := b.card(c)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}

// --- photos in a collection ---

// collectionPhotos returns the public view of every photo in c's frames,
// filtered for c's context and viewer.
func (s *server) collectionPhotos(ctx context.Context, c collRow, viewer string) (map[string]*publicPhotoView, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT p.id,p.owner_id,p.status,p.title,p.caption,p.width,p.height,p.derived_hash,
			p.public_fields,p.histogram_public,o.public_fields,o.histogram_public,
			e.photo_id,e.camera_make,e.camera_model,e.lens_model,e.focal_length_mm,e.focal_length_35mm,e.aperture,
			e.exposure_time,e.exposure_seconds,e.iso,e.exposure_bias,e.taken_at,e.taken_offset_min,
			h.bins,a.source
		FROM photos p
		LEFT JOIN photo_overrides o ON o.collection_id=? AND o.photo_id=p.id
		LEFT JOIN photo_exif e ON e.photo_id=p.id
		LEFT JOIN photo_histograms h ON h.photo_id=p.id
		LEFT JOIN attributions a ON a.photo_id=p.id
		WHERE p.id IN (SELECT fp.photo_id FROM frame_photos fp JOIN frames f ON f.id=fp.frame_id WHERE f.collection_id=?)`,
		c.ID, c.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]*publicPhotoView{}
	for rows.Next() {
		var (
			v                        publicPhotoView
			owner, status, fields    string
			hist                     int
			width, height            sql.NullInt64
			hash, oFields            sql.NullString
			oHist                    sql.NullInt64
			exifRow                  sql.NullString
			mk, model, lens, shutter sql.NullString
			focal, focal35, ap, secs sql.NullFloat64
			bias                     sql.NullFloat64
			iso, taken, offset       sql.NullInt64
			bins                     []byte
			attr                     sql.NullString
		)
		if err := rows.Scan(&v.ID, &owner, &status, &v.Title, &v.Caption, &width, &height, &hash,
			&fields, &hist, &oFields, &oHist,
			&exifRow, &mk, &model, &lens, &focal, &focal35, &ap, &shutter, &secs, &iso, &bias, &taken, &offset,
			&bins, &attr); err != nil {
			return nil, err
		}
		v.Width, v.Height = intPtr(width), intPtr(height)
		src := mediaSource{ID: v.ID, Status: status, Width: width, Height: height, Hash: hash}
		isOwner := domain.IsOwner(c.OwnerID, viewer)
		if isOwner {
			// The owner always goes through /m/…?c= (draft or not, CDN or not).
			v.Media = s.collectionMedia(src, c.ID)
		} else {
			v.Media = s.mediaFor(src, &c.Collection)
		}
		p := domain.Photo{ID: v.ID, OwnerID: owner, PublicFields: parsePublicFields(fields), HistogramPublic: hist == 1}
		// Same mapping exposure-check uses, so the two can never disagree.
		o := overrideOf(oFields, oHist)
		pub := domain.EffectivePublicFields(p, o)
		if isOwner {
			v.ownerPhotoFields = ownerFields(pub, o)
		}
		if exifRow.Valid && status == statusReady {
			ex := exifView{}
			set := func(key string, apply func()) {
				if pub[key] {
					apply()
				}
			}
			set("camera", func() { ex.Camera = cameraName(mk.String, model.String) })
			set("lens", func() { ex.Lens = nonEmpty(lens) })
			set("focal_length", func() { ex.FocalLength, ex.FocalLength35mm = floatPtr(focal), floatPtr(focal35) })
			set("aperture", func() { ex.Aperture = floatPtr(ap) })
			set("shutter", func() { ex.Shutter, ex.ExposureSeconds = nonEmpty(shutter), floatPtr(secs) })
			set("iso", func() { ex.ISO = intPtr(iso) })
			set("exposure_bias", func() { ex.ExposureBias = floatPtr(bias) })
			set("taken_date", func() { ex.TakenAt, ex.TakenOffsetMinutes = intPtr(taken), intPtr(offset) })
			if ex != (exifView{}) {
				v.EXIF = &ex
			}
		}
		if pub[domain.HistogramKey] && bins != nil {
			if h, err := media.DecodeHistogram(bins); err == nil {
				v.Histogram = &h
			}
		}
		if attr.Valid {
			raw := json.RawMessage(attr.String)
			v.Attribution = &raw
		}
		// /original serves only ready photos, so only those are downloadable.
		v.Downloadable = status == statusReady && domain.CanDownloadOriginal(p, c.Collection, viewer)
		out[v.ID] = &v
	}
	return out, rows.Err()
}

// ownerFields builds the owner-only photo keys from the effective field set
// and the override (nil when the photo has none in this collection).
func ownerFields(pub map[string]bool, o *domain.PhotoOverride) *ownerPhotoFields {
	f := &ownerPhotoFields{PublicFields: []string{}, HistogramPublic: pub[domain.HistogramKey]}
	for k, on := range pub {
		if on && k != domain.HistogramKey {
			f.PublicFields = append(f.PublicFields, k)
		}
	}
	sort.Strings(f.PublicFields)
	if o != nil {
		f.Override = &ownerOverrideView{PublicFields: o.PublicFields, HistogramPublic: o.HistogramPublic}
	}
	return f
}

// --- GET /api/collections/{id} ---

func (s *server) readCollection(w http.ResponseWriter, r *http.Request) (int, any, error) {
	id, err := collectionID(r)
	if err != nil {
		return 0, nil, err
	}
	ctx := r.Context()
	viewer := identity.User(ctx)
	c, err := s.loadReadable(ctx, id, viewer)
	if err != nil {
		return 0, nil, err
	}
	photos, err := s.collectionPhotos(ctx, c, viewer)
	if err != nil {
		return 0, nil, err
	}
	o, err := s.cards(ctx, viewer).owner(c.OwnerID)
	if err != nil {
		return 0, nil, err
	}
	v := collectionReadView{ID: c.ID, Title: c.Title, Intro: c.Intro, Owner: o,
		License: nullStr(c.License), AIDeclaration: nullStr(c.AI), OriginalDownload: c.AllowOriginal,
		PublishedAt: intPtr(c.PublishedAt), Frames: []readFrameView{}}
	if domain.IsOwner(c.OwnerID, viewer) {
		st, vis, dist := c.Status, c.Visibility, c.Distribute
		v.Status, v.Visibility, v.Distribute = &st, &vis, &dist
		var updated int64
		if err := s.db.QueryRowContext(ctx, `SELECT updated_at FROM collections WHERE id=?`, c.ID).Scan(&updated); err != nil {
			return 0, nil, err
		}
		v.UpdatedAt = &updated
		v.CoverPhotoID = nullStr(c.Cover)
	}
	if src, ok, err := coverSource(ctx, s.db, c); err != nil {
		return 0, nil, err
	} else if ok {
		v.Cover = photos[src.ID]
	}

	rows, err := s.db.QueryContext(ctx, `SELECT f.id,f.layout,f.matte_ratio,f.text,fp.photo_id FROM frames f
		LEFT JOIN frame_photos fp ON fp.frame_id=f.id WHERE f.collection_id=? ORDER BY f.position,fp.slot`, id)
	if err != nil {
		return 0, nil, err
	}
	defer rows.Close()
	last := ""
	for rows.Next() {
		var fid, layout string
		var ratio sql.NullFloat64
		var text, pid sql.NullString
		if err := rows.Scan(&fid, &layout, &ratio, &text, &pid); err != nil {
			return 0, nil, err
		}
		if fid != last {
			v.Frames = append(v.Frames, readFrameView{Layout: layout, MatteRatio: floatPtr(ratio), Text: nullStr(text),
				Photos: []*publicPhotoView{}})
			last = fid
		}
		if p, ok := photos[pid.String]; pid.Valid && ok {
			f := &v.Frames[len(v.Frames)-1]
			f.Photos = append(f.Photos, p)
		}
	}
	if err := rows.Err(); err != nil {
		return 0, nil, err
	}
	return http.StatusOK, v, nil
}

// --- GET /api/collections/{id}/neighbors ---

func (s *server) readNeighbors(w http.ResponseWriter, r *http.Request) (int, any, error) {
	id, err := collectionID(r)
	if err != nil {
		return 0, nil, err
	}
	ctx := r.Context()
	viewer := identity.User(ctx)
	cur, err := s.loadReadable(ctx, id, viewer)
	if err != nil {
		return 0, nil, err
	}
	wall := r.URL.Query().Get("wall")
	var list []collRow
	idx := -1
	var used string
	switch {
	case wall == wallSquare && inSquare(cur):
		list, idx, err = s.squareAround(ctx, cur)
		used = wallSquare
	case strings.HasPrefix(wall, wallAlbum+":"):
		list, idx, err = s.albumAround(ctx, strings.TrimPrefix(wall, wallAlbum+":"), cur, viewer)
		if idx >= 0 {
			used = wall
		}
	}
	if err != nil {
		return 0, nil, err
	}
	if idx < 0 {
		// Unknown, invalid, unreadable or user wall: the owner's wall,
		// reported as user:{ownerId}. "user" and any "user:{id}" land here.
		list, idx, err = s.userAround(ctx, cur, viewer)
		if err != nil {
			return 0, nil, err
		}
		used = wallUser + ":" + cur.OwnerID
	}
	b := s.cards(ctx, viewer)
	v := neighborsView{Wall: used, Strip: []cardView{}}
	if len(list) == 0 {
		return http.StatusOK, v, nil
	}
	lo, hi := 0, len(list)
	if idx >= 0 {
		lo = max(0, idx-stripSize/2+1)
	}
	hi = min(len(list), lo+stripSize)
	lo = max(0, hi-stripSize)
	if v.Strip, err = b.list(list[lo:hi]); err != nil {
		return 0, nil, err
	}
	if idx > 0 {
		p := v.Strip[idx-1-lo]
		v.Prev = &p
	}
	if idx >= 0 && idx+1 < len(list) {
		n := v.Strip[idx+1-lo]
		v.Next = &n
	}
	return http.StatusOK, v, nil
}

// squareAround returns up to stripSize-1 square collections on each side of
// cur in square order, and cur's index in that list.
func (s *server) squareAround(ctx context.Context, cur collRow) ([]collRow, int, error) {
	pub, cid := cur.PublishedAt.Int64, cur.ID
	before, err := queryColls(ctx, s.db, `SELECT `+collCols+` FROM collections c WHERE `+squareWhere+`
		AND (c.published_at > ? OR (c.published_at = ? AND c.id > ?)) ORDER BY c.published_at ASC, c.id ASC LIMIT ?`,
		pub, pub, cid, stripSize-1)
	if err != nil {
		return nil, -1, err
	}
	after, err := queryColls(ctx, s.db, `SELECT `+collCols+` FROM collections c WHERE `+squareWhere+`
		AND (c.published_at < ? OR (c.published_at = ? AND c.id < ?)) ORDER BY c.published_at DESC, c.id DESC LIMIT ?`,
		pub, pub, cid, stripSize-1)
	if err != nil {
		return nil, -1, err
	}
	var list []collRow
	for i := len(before) - 1; i >= 0; i-- {
		if inSquare(before[i]) {
			list = append(list, before[i])
		}
	}
	idx := len(list)
	list = append(list, cur)
	for _, c := range after {
		if inSquare(c) {
			list = append(list, c)
		}
	}
	return list, idx, nil
}

// userAround returns the owner's wall for viewer and cur's index in it (-1
// when cur is not listed there, e.g. an unlisted collection).
func (s *server) userAround(ctx context.Context, cur collRow, viewer string) ([]collRow, int, error) {
	all, err := s.userWall(ctx, cur.OwnerID, viewer)
	if err != nil {
		return nil, -1, err
	}
	for i, c := range all {
		if c.ID == cur.ID {
			return all, i, nil
		}
	}
	return all, -1, nil
}

func (s *server) userWall(ctx context.Context, owner, viewer string) ([]collRow, error) {
	all, err := queryColls(ctx, s.db, `SELECT `+collCols+` FROM collections c WHERE c.owner_id=? ORDER BY c.wall_rank, c.id`, owner)
	if err != nil {
		return nil, err
	}
	out := all[:0]
	for _, c := range all {
		if onUserWall(c, viewer) {
			out = append(out, c)
		}
	}
	return out, nil
}

// albumAround returns the album's readable members and cur's index among
// them; -1 when the album id is invalid, unreadable or lacks cur.
func (s *server) albumAround(ctx context.Context, aid string, cur collRow, viewer string) ([]collRow, int, error) {
	if !canonicalUUID(aid) {
		return nil, -1, nil
	}
	a, err := s.loadAlbum(ctx, aid)
	if err != nil || a == nil || !domain.CanReadAlbum(a.Album, viewer) {
		return nil, -1, err
	}
	members, err := s.albumMembers(ctx, a.Album, viewer)
	if err != nil {
		return nil, -1, err
	}
	for i, c := range members {
		if c.ID == cur.ID {
			return members, i, nil
		}
	}
	return nil, -1, nil
}

// --- albums ---

type albumRow struct {
	domain.Album
	Title, Intro string
}

func (s *server) loadAlbum(ctx context.Context, id string) (*albumRow, error) {
	a := albumRow{Album: domain.Album{ID: id}}
	err := s.db.QueryRowContext(ctx, `SELECT owner_id,visibility,title,intro FROM albums WHERE id=?`, id).
		Scan(&a.OwnerID, &a.Visibility, &a.Title, &a.Intro)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &a, nil
}

// albumMembers returns the members viewer may see through a, in order.
// Each member is checked on its own terms (domain.CanReadAlbumMember).
func (s *server) albumMembers(ctx context.Context, a domain.Album, viewer string) ([]collRow, error) {
	all, err := queryColls(ctx, s.db, `SELECT `+collCols+` FROM album_items ai JOIN collections c ON c.id=ai.collection_id
		WHERE ai.album_id=? ORDER BY ai.position`, a.ID)
	if err != nil {
		return nil, err
	}
	out := all[:0]
	for _, c := range all {
		if domain.CanReadAlbumMember(a, c.Collection, viewer) && readable(c, viewer) {
			out = append(out, c)
		}
	}
	return out, nil
}

func (s *server) readAlbum(w http.ResponseWriter, r *http.Request) (int, any, error) {
	id, err := albumID(r)
	if err != nil {
		return 0, nil, err
	}
	ctx := r.Context()
	viewer := identity.User(ctx)
	a, err := s.loadAlbum(ctx, id)
	if err != nil {
		return 0, nil, err
	}
	if a == nil || !domain.CanReadAlbum(a.Album, viewer) {
		return 0, nil, httperr.Fail(http.StatusNotFound, msgAlbumAbsent)
	}
	members, err := s.albumMembers(ctx, a.Album, viewer)
	if err != nil {
		return 0, nil, err
	}
	b := s.cards(ctx, viewer)
	o, err := b.owner(a.OwnerID)
	if err != nil {
		return 0, nil, err
	}
	v := albumReadView{ID: a.ID, Title: a.Title, Intro: a.Intro, Owner: o}
	if domain.IsOwner(a.OwnerID, viewer) {
		vis := a.Visibility
		v.Visibility = &vis
	}
	if v.Members, err = b.list(members); err != nil {
		return 0, nil, err
	}
	return http.StatusOK, v, nil
}

// --- GET /api/u/{userId} ---

func (s *server) readUser(w http.ResponseWriter, r *http.Request) (int, any, error) {
	uid := chi.URLParam(r, "userId")
	if !userIDRe.MatchString(uid) {
		return 0, nil, httperr.Fail(http.StatusNotFound, msgUserAbsent)
	}
	ctx := r.Context()
	viewer := identity.User(ctx)
	var one int
	err := s.db.QueryRowContext(ctx, `SELECT 1 FROM users WHERE id=?`, uid).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil, httperr.Fail(http.StatusNotFound, msgUserAbsent)
	}
	if err != nil {
		return 0, nil, err
	}
	v := userWallView{Profile: profileReadView{ID: uid, WallLayout: "salon"}, Albums: []albumCardView{}}
	err = s.db.QueryRowContext(ctx, `SELECT name,bio,wall_layout FROM profiles WHERE user_id=?`, uid).
		Scan(&v.Profile.Name, &v.Profile.Bio, &v.Profile.WallLayout)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, nil, err
	}
	wall, err := s.userWall(ctx, uid, viewer)
	if err != nil {
		return 0, nil, err
	}
	b := s.cards(ctx, viewer)
	if v.Collections, err = b.list(wall); err != nil {
		return 0, nil, err
	}

	rows, err := s.db.QueryContext(ctx, `SELECT id,visibility,title,intro FROM albums WHERE owner_id=? ORDER BY created_at DESC, id DESC`, uid)
	if err != nil {
		return 0, nil, err
	}
	var albums []albumRow
	for rows.Next() {
		a := albumRow{Album: domain.Album{OwnerID: uid}}
		if err := rows.Scan(&a.ID, &a.Visibility, &a.Title, &a.Intro); err != nil {
			rows.Close()
			return 0, nil, err
		}
		albums = append(albums, a)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, nil, err
	}
	for _, a := range albums {
		if !domain.AlbumOnWall(a.Album, viewer) {
			continue
		}
		members, err := s.albumMembers(ctx, a.Album, viewer)
		if err != nil {
			return 0, nil, err
		}
		card := albumCardView{ID: a.ID, Title: a.Title, Intro: a.Intro, Count: len(members)}
		for _, m := range members {
			src, ok, err := coverSource(ctx, s.db, m)
			if err != nil {
				return 0, nil, err
			}
			if ok {
				card.Cover = s.mediaFor(src, &m.Collection)
				break
			}
		}
		v.Albums = append(v.Albums, card)
	}
	return http.StatusOK, v, nil
}

// --- GET /api/square ---

func (s *server) readSquare(w http.ResponseWriter, r *http.Request) (int, any, error) {
	q := r.URL.Query()
	limit, err := parseLimit(q, squareDefaultLimit, squareMaxLimit)
	if err != nil {
		return 0, nil, err
	}
	ctx := r.Context()
	b := s.cards(ctx, identity.User(ctx))
	v := squareView{Featured: []cardView{}}

	var page []collRow
	if raw, ok := q["cursor"]; ok {
		if len(raw) != 1 {
			return 0, nil, httperr.Fail(http.StatusBadRequest, msgCursor)
		}
		pub, id, err := decodeCursor(raw[0])
		if err != nil {
			return 0, nil, err
		}
		page, err = queryColls(ctx, s.db, `SELECT `+collCols+` FROM collections c WHERE `+squareWhere+`
			AND (c.published_at < ? OR (c.published_at = ? AND c.id < ?)) ORDER BY c.published_at DESC, c.id DESC LIMIT ?`,
			pub, pub, id, limit+1)
		if err != nil {
			return 0, nil, err
		}
	} else {
		featured, err := queryColls(ctx, s.db, `SELECT `+collCols+` FROM collections c WHERE `+squareWhere+`
			AND c.featured_rank IS NOT NULL ORDER BY c.featured_rank, c.id LIMIT ?`, maxFeatured)
		if err != nil {
			return 0, nil, err
		}
		if v.Featured, err = b.list(filterColls(featured, inSquare)); err != nil {
			return 0, nil, err
		}
		page, err = queryColls(ctx, s.db, `SELECT `+collCols+` FROM collections c WHERE `+squareWhere+`
			ORDER BY c.published_at DESC, c.id DESC LIMIT ?`, limit+1)
		if err != nil {
			return 0, nil, err
		}
	}
	if len(page) > limit {
		page = page[:limit]
		last := page[len(page)-1]
		cur := encodeCursor(last.PublishedAt.Int64, last.ID)
		v.NextCursor = &cur
	}
	if v.Items, err = b.list(filterColls(page, inSquare)); err != nil {
		return 0, nil, err
	}
	return http.StatusOK, v, nil
}

func filterColls(cs []collRow, keep func(collRow) bool) []collRow {
	out := make([]collRow, 0, len(cs))
	for _, c := range cs {
		if keep(c) {
			out = append(out, c)
		}
	}
	return out
}

// parseLimit reads ?limit: absent means def, otherwise an integer in 1..max.
func parseLimit(q map[string][]string, def, maxN int) (int, error) {
	raw, ok := q["limit"]
	if !ok {
		return def, nil
	}
	if len(raw) != 1 {
		return 0, httperr.Fail(http.StatusBadRequest, msgLimit)
	}
	n, err := strconv.Atoi(raw[0])
	if err != nil || n < 1 || n > maxN || strconv.Itoa(n) != raw[0] {
		return 0, httperr.Fail(http.StatusBadRequest, msgLimit)
	}
	return n, nil
}

// encodeCursor makes the opaque cursor for a (sort key, id) position:
// base64url (no padding) of "{key}.{id}".
func encodeCursor(key int64, id string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(key, 10) + "." + id))
}

// decodeCursor is the strict inverse of encodeCursor: anything that does
// not re-encode to the same string is 400.
func decodeCursor(s string) (int64, string, error) {
	bad := httperr.Fail(http.StatusBadRequest, msgCursor)
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return 0, "", bad
	}
	k, id, ok := strings.Cut(string(b), ".")
	if !ok || !canonicalUUID(id) {
		return 0, "", bad
	}
	key, err := strconv.ParseInt(k, 10, 64)
	if err != nil || encodeCursor(key, id) != s {
		return 0, "", bad
	}
	return key, id, nil
}
