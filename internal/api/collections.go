package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/timeStarry/frameMark/internal/domain"
	"github.com/timeStarry/frameMark/internal/exposure"
	"github.com/timeStarry/frameMark/internal/httperr"
)

const (
	maxIntroRunes     = 2000
	maxFrames         = 200
	maxFrameTextRunes = 2000
	minMatteRatio     = 0.5
	maxMatteRatio     = 0.95

	layoutFull   = "full"
	layoutMatted = "matted"
	layoutPair   = "pair"
	layoutText   = "text"

	jobRotateDerived = "rotate_derived"

	msgCollectionAbsent = "合集不存在。"
	msgTitle            = "标题需为 1–120 个字符。"
	msgIntro            = "简介不能超过 2000 个字符。"
	msgVisibility       = "可见性无效。"
	msgLicense          = "许可协议无效。"
	msgAIDeclaration    = "AI 声明无效。"
	msgCover            = "封面必须是合集中已处理完成的照片。"
	msgTooManyFrames    = "帧序列最多 200 帧。"
	msgLayout           = "帧版式无效。"
	msgFramePhotos      = "帧中的照片数量与版式不符。"
	msgFrameText        = "文字帧需要 1–2000 个字符的文字，且只有文字帧可以带文字。"
	msgMatte            = "留白帧的画面占比需在 0.5–0.95 之间，其他版式不能设置。"
	msgFramePhotoRef    = "帧引用的照片不存在或尚未处理完成。"
	msgEmptyPublish     = "合集至少需要一帧才能发布。"
	msgEmptyPublished   = "已发布的合集至少需要一帧。"
	msgDryRun           = "dry_run 参数无效。"
	msgPublicFields     = "公开字段无效。"
	msgOverridePhoto    = "照片不在该合集中。"
	msgStale            = "这个合集在别处被修改过。"
)

// --- response shapes ---

type frameView struct {
	ID         string   `json:"id"`
	Position   int      `json:"position"`
	Layout     string   `json:"layout"`
	MatteRatio *float64 `json:"matteRatio"`
	Text       *string  `json:"text"`
	PhotoIDs   []string `json:"photoIds"`
}

// collectionView is the owner view of a collection with its frame sequence.
type collectionView struct {
	ID               string      `json:"id"`
	Title            string      `json:"title"`
	Intro            string      `json:"intro"`
	Status           string      `json:"status"`
	Visibility       string      `json:"visibility"`
	Distribute       bool        `json:"distribute"`
	OriginalDownload bool        `json:"originalDownload"`
	License          *string     `json:"license"`
	AIDeclaration    *string     `json:"aiDeclaration"`
	CoverPhotoID     *string     `json:"coverPhotoId"`
	WallRank         int64       `json:"wallRank"`
	PublishedAt      *int64      `json:"publishedAt"`
	CreatedAt        int64       `json:"createdAt"`
	UpdatedAt        int64       `json:"updatedAt"`
	Frames           []frameView `json:"frames"`
}

type manifestView struct {
	Photos           int      `json:"photos"`
	PublicFields     []string `json:"publicFields"`
	Histogram        bool     `json:"histogram"`
	OriginalDownload bool     `json:"originalDownload"`
	Visibility       string   `json:"visibility"`
	InSquare         bool     `json:"inSquare"`
}

type overrideView struct {
	CollectionID    string   `json:"collectionId"`
	PhotoID         string   `json:"photoId"`
	PublicFields    []string `json:"publicFields"`
	HistogramPublic *bool    `json:"histogramPublic"`
	// UpdatedAt is the collection's updated_at after the write.
	UpdatedAt int64 `json:"updatedAt"`
}

// --- POST /api/collections ---

func (s *server) createCollection(w http.ResponseWriter, r *http.Request) (int, any, error) {
	owner, err := requireUser(r)
	if err != nil {
		return 0, nil, err
	}
	var in struct {
		Title *string `json:"title"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return 0, nil, err
	}
	title, err := validTitle(in.Title)
	if err != nil {
		return 0, nil, err
	}
	u, err := uuid.NewV7()
	if err != nil {
		return 0, nil, err
	}
	id := u.String()
	ctx := r.Context()
	now := s.now()
	err = s.inTx(ctx, func(tx *sql.Tx) error {
		// license and ai_declaration are prefilled from the owner's upload
		// prefs (NULL without a prefs row or default).
		_, err := tx.ExecContext(ctx, `INSERT INTO collections(id,owner_id,title,status,visibility,distribute,wall_rank,
			license,ai_declaration,created_at,updated_at)
			VALUES(?,?,?,'draft','private',1,(SELECT coalesce(max(wall_rank),0)+1 FROM collections WHERE owner_id=?),
			(SELECT default_license FROM upload_prefs WHERE user_id=?),(SELECT default_ai_declaration FROM upload_prefs WHERE user_id=?),?,?)`,
			id, owner, title, owner, owner, owner, now, now)
		return err
	})
	if err != nil {
		return 0, nil, err
	}
	return s.collectionResponse(ctx, http.StatusCreated, owner, id)
}

// --- PUT /api/collections/{id} ---

type collectionInput struct {
	Title            *string `json:"title"`
	Intro            *string `json:"intro"`
	Visibility       *string `json:"visibility"`
	Distribute       *bool   `json:"distribute"`
	OriginalDownload *bool   `json:"originalDownload"`
	License          *string `json:"license"`
	AIDeclaration    *string `json:"aiDeclaration"`
	CoverPhotoID     *string `json:"coverPhotoId"`
	// IfUpdatedAt, when set, must equal the current updated_at or the write
	// is refused with 409 (optimistic concurrency).
	IfUpdatedAt *int64 `json:"ifUpdatedAt"`
}

func (s *server) updateCollection(w http.ResponseWriter, r *http.Request) (int, any, error) {
	owner, err := requireUser(r)
	if err != nil {
		return 0, nil, err
	}
	id, err := collectionID(r)
	if err != nil {
		return 0, nil, err
	}
	var in collectionInput
	if err := decodeJSON(r, &in); err != nil {
		return 0, nil, err
	}
	title, intro, err := validCollection(in)
	if err != nil {
		return 0, nil, err
	}
	ctx := r.Context()
	err = s.inTx(ctx, func(tx *sql.Tx) error {
		if _, _, err := ownedCollection(ctx, tx, owner, id); err != nil {
			return err
		}
		if err := checkFresh(ctx, tx, id, in.IfUpdatedAt); err != nil {
			return err
		}
		if in.CoverPhotoID != nil {
			if err := checkCover(ctx, tx, owner, id, *in.CoverPhotoID); err != nil {
				return err
			}
		}
		before, err := exposedPhotos(ctx, tx, owner)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `UPDATE collections SET title=?,intro=?,visibility=?,distribute=?,original_download=?,
			license=?,ai_declaration=?,cover_photo_id=?,updated_at=? WHERE id=? AND owner_id=?`,
			title, intro, *in.Visibility, boolInt(*in.Distribute), boolInt(*in.OriginalDownload),
			in.License, in.AIDeclaration, in.CoverPhotoID, s.now(), id, owner)
		if err != nil {
			return err
		}
		return s.withdraw(ctx, tx, owner, before)
	})
	if err != nil {
		return 0, nil, err
	}
	return s.collectionResponse(ctx, http.StatusOK, owner, id)
}

// validCollection checks a collectionInput's own fields (not the cover,
// which needs the frames) and returns the cleaned title and intro.
func validCollection(in collectionInput) (title, intro string, err error) {
	if title, err = validTitle(in.Title); err != nil {
		return "", "", err
	}
	if intro, err = validIntro(in.Intro); err != nil {
		return "", "", err
	}
	if in.Visibility == nil || !validVisibility(*in.Visibility) {
		return "", "", httperr.Fail(http.StatusBadRequest, msgVisibility)
	}
	if in.Distribute == nil || in.OriginalDownload == nil {
		return "", "", httperr.Fail(http.StatusBadRequest, msgBadJSON)
	}
	if in.License != nil && !domain.ValidLicense(*in.License) {
		return "", "", httperr.Fail(http.StatusBadRequest, msgLicense)
	}
	if in.AIDeclaration != nil && !domain.ValidAIDeclaration(*in.AIDeclaration) {
		return "", "", httperr.Fail(http.StatusBadRequest, msgAIDeclaration)
	}
	return title, intro, nil
}

// checkCover requires photo to be one of owner's ready photos placed in the
// collection's frames.
func checkCover(ctx context.Context, tx *sql.Tx, owner, collection, photo string) error {
	var one int
	err := tx.QueryRowContext(ctx, `SELECT 1 FROM frame_photos fp JOIN frames f ON f.id=fp.frame_id
		JOIN photos p ON p.id=fp.photo_id
		WHERE f.collection_id=? AND fp.photo_id=? AND p.owner_id=? AND p.status='ready' LIMIT 1`,
		collection, photo, owner).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return httperr.Fail(http.StatusBadRequest, msgCover)
	}
	return err
}

// --- DELETE /api/collections/{id} ---

func (s *server) deleteCollection(w http.ResponseWriter, r *http.Request) (int, any, error) {
	owner, err := requireUser(r)
	if err != nil {
		return 0, nil, err
	}
	id, err := collectionID(r)
	if err != nil {
		return 0, nil, err
	}
	ctx := r.Context()
	err = s.inTx(ctx, func(tx *sql.Tx) error {
		if _, _, err := ownedCollection(ctx, tx, owner, id); err != nil {
			return err
		}
		before, err := exposedPhotos(ctx, tx, owner)
		if err != nil {
			return err
		}
		albums, err := stringsOf(ctx, tx, `SELECT DISTINCT album_id FROM album_items WHERE collection_id=?`, id)
		if err != nil {
			return err
		}
		// frames, frame_photos, photo_overrides and album_items cascade.
		if _, err := tx.ExecContext(ctx, `DELETE FROM collections WHERE id=? AND owner_id=?`, id, owner); err != nil {
			return err
		}
		for _, aid := range albums {
			if err := renumberAlbum(ctx, tx, aid); err != nil {
				return err
			}
		}
		return s.withdraw(ctx, tx, owner, before)
	})
	if err != nil {
		return 0, nil, err
	}
	return http.StatusNoContent, nil, nil
}

// --- PUT /api/collections/{id}/frames ---

type frameInput struct {
	Layout     string   `json:"layout"`
	MatteRatio *float64 `json:"matteRatio"`
	Text       *string  `json:"text"`
	PhotoIDs   []string `json:"photoIds"`
}

func (s *server) putFrames(w http.ResponseWriter, r *http.Request) (int, any, error) {
	owner, err := requireUser(r)
	if err != nil {
		return 0, nil, err
	}
	id, err := collectionID(r)
	if err != nil {
		return 0, nil, err
	}
	frames, ifUpdatedAt, err := decodeFrames(r)
	if err != nil {
		return 0, nil, err
	}
	texts, refs, err := validFrames(frames)
	if err != nil {
		return 0, nil, err
	}

	ctx := r.Context()
	now := s.now()
	err = s.inTx(ctx, func(tx *sql.Tx) error {
		status, _, err := ownedCollection(ctx, tx, owner, id)
		if err != nil {
			return err
		}
		if err := checkFresh(ctx, tx, id, ifUpdatedAt); err != nil {
			return err
		}
		if status == domain.StatusPublished && len(frames) == 0 {
			return httperr.Fail(http.StatusBadRequest, msgEmptyPublished)
		}
		if err := checkReadyPhotos(ctx, tx, owner, refs); err != nil {
			return err
		}
		before, err := exposedPhotos(ctx, tx, owner)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM frames WHERE collection_id=?`, id); err != nil {
			return err
		}
		for i, f := range frames {
			u, err := uuid.NewV7()
			if err != nil {
				return err
			}
			fid := u.String()
			if _, err := tx.ExecContext(ctx, `INSERT INTO frames(id,collection_id,position,layout,matte_ratio,text) VALUES(?,?,?,?,?,?)`,
				fid, id, i, f.Layout, f.MatteRatio, texts[i]); err != nil {
				return err
			}
			for slot, pid := range f.PhotoIDs {
				if _, err := tx.ExecContext(ctx, `INSERT INTO frame_photos(frame_id,slot,photo_id) VALUES(?,?,?)`, fid, slot, pid); err != nil {
					return err
				}
			}
		}
		if err := dropDetached(ctx, tx, id); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE collections SET updated_at=? WHERE id=?`, now, id); err != nil {
			return err
		}
		return s.withdraw(ctx, tx, owner, before)
	})
	if err != nil {
		return 0, nil, err
	}
	return s.collectionResponse(ctx, http.StatusOK, owner, id)
}

// decodeFrames reads the frames body: {"frames": [...], "ifUpdatedAt"?: n},
// or, for compatibility, a bare array of frames.
func decodeFrames(r *http.Request) ([]frameInput, *int64, error) {
	var raw json.RawMessage
	if err := decodeJSON(r, &raw); err != nil {
		return nil, nil, err
	}
	trimmed := bytes.TrimLeft(raw, " \t\r\n")
	if len(trimmed) > 0 && trimmed[0] == '[' {
		var frames []frameInput
		if err := decodeStrict(trimmed, &frames); err != nil {
			return nil, nil, err
		}
		return frames, nil, nil
	}
	var in struct {
		Frames      *[]frameInput `json:"frames"`
		IfUpdatedAt *int64        `json:"ifUpdatedAt"`
	}
	if err := decodeStrict(trimmed, &in); err != nil {
		return nil, nil, err
	}
	if in.Frames == nil {
		return nil, nil, httperr.Fail(http.StatusBadRequest, msgBadJSON)
	}
	return *in.Frames, in.IfUpdatedAt, nil
}

// decodeStrict decodes one JSON value from data with unknown fields
// rejected; any failure is a 400.
func decodeStrict(data []byte, dst any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return httperr.Fail(http.StatusBadRequest, msgBadJSON)
	}
	return nil
}

// checkFresh refuses a write with 409 and the current updated_at when want
// is set and differs from it. The caller has already checked ownership.
func checkFresh(ctx context.Context, tx *sql.Tx, id string, want *int64) error {
	if want == nil {
		return nil
	}
	var cur int64
	if err := tx.QueryRowContext(ctx, `SELECT updated_at FROM collections WHERE id=?`, id).Scan(&cur); err != nil {
		return err
	}
	if cur != *want {
		return httperr.FailWith(http.StatusConflict, msgStale, map[string]any{"updatedAt": cur})
	}
	return nil
}

// validFrames checks a frame sequence's length and every frame's shape. It
// returns the cleaned texts by position and every referenced photo id. The
// referenced photos still need checkReadyPhotos.
func validFrames(frames []frameInput) (texts []*string, refs []string, err error) {
	if len(frames) > maxFrames {
		return nil, nil, httperr.Fail(http.StatusBadRequest, msgTooManyFrames)
	}
	texts = make([]*string, len(frames))
	for i, f := range frames {
		t, err := validFrame(f)
		if err != nil {
			return nil, nil, err
		}
		texts[i] = t
		refs = append(refs, f.PhotoIDs...)
	}
	return texts, refs, nil
}

// validFrame checks one frame's shape and returns its cleaned text (nil for
// non-text frames).
func validFrame(f frameInput) (*string, error) {
	n := len(f.PhotoIDs)
	switch f.Layout {
	case layoutFull, layoutMatted:
		if n != 1 {
			return nil, httperr.Fail(http.StatusBadRequest, msgFramePhotos)
		}
	case layoutPair:
		if n < 2 || n > 3 {
			return nil, httperr.Fail(http.StatusBadRequest, msgFramePhotos)
		}
		seen := map[string]bool{}
		for _, p := range f.PhotoIDs {
			if seen[p] {
				return nil, httperr.Fail(http.StatusBadRequest, msgFramePhotos)
			}
			seen[p] = true
		}
	case layoutText:
		if n != 0 {
			return nil, httperr.Fail(http.StatusBadRequest, msgFramePhotos)
		}
	default:
		return nil, httperr.Fail(http.StatusBadRequest, msgLayout)
	}
	if f.Layout == layoutMatted {
		// The negated comparison also rejects NaN.
		if f.MatteRatio == nil || !(*f.MatteRatio >= minMatteRatio && *f.MatteRatio <= maxMatteRatio) {
			return nil, httperr.Fail(http.StatusBadRequest, msgMatte)
		}
	} else if f.MatteRatio != nil {
		return nil, httperr.Fail(http.StatusBadRequest, msgMatte)
	}
	if f.Layout != layoutText {
		if f.Text != nil {
			return nil, httperr.Fail(http.StatusBadRequest, msgFrameText)
		}
		return nil, nil
	}
	if f.Text == nil {
		return nil, httperr.Fail(http.StatusBadRequest, msgFrameText)
	}
	t := cleanText(*f.Text, true)
	if c := utf8.RuneCountInString(t); c < 1 || c > maxFrameTextRunes {
		return nil, httperr.Fail(http.StatusBadRequest, msgFrameText)
	}
	return &t, nil
}

// checkReadyPhotos requires every id to be one of owner's ready photos.
func checkReadyPhotos(ctx context.Context, tx *sql.Tx, owner string, ids []string) error {
	set := map[string]struct{}{}
	for _, id := range ids {
		set[id] = struct{}{}
	}
	if len(set) == 0 {
		return nil
	}
	args := []any{owner}
	for id := range set {
		args = append(args, id)
	}
	var n int
	q := `SELECT count(*) FROM photos WHERE owner_id=? AND status='ready' AND id IN (?` + strings.Repeat(",?", len(set)-1) + `)`
	if err := tx.QueryRowContext(ctx, q, args...).Scan(&n); err != nil {
		return err
	}
	if n != len(set) {
		return httperr.Fail(http.StatusBadRequest, msgFramePhotoRef)
	}
	return nil
}

// dropDetached clears the cover and deletes overrides of photos no longer in
// the collection's frames, so a stale override cannot silently reapply if
// the photo is added again later.
func dropDetached(ctx context.Context, tx *sql.Tx, collection string) error {
	const present = `SELECT fp.photo_id FROM frame_photos fp JOIN frames f ON f.id=fp.frame_id WHERE f.collection_id=?`
	if _, err := tx.ExecContext(ctx, `UPDATE collections SET cover_photo_id=NULL
		WHERE id=? AND cover_photo_id IS NOT NULL AND cover_photo_id NOT IN (`+present+`)`, collection, collection); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `DELETE FROM photo_overrides WHERE collection_id=? AND photo_id NOT IN (`+present+`)`,
		collection, collection)
	return err
}

// --- POST /api/collections/{id}/publish, /unpublish ---

func (s *server) publishCollection(w http.ResponseWriter, r *http.Request) (int, any, error) {
	owner, err := requireUser(r)
	if err != nil {
		return 0, nil, err
	}
	id, err := collectionID(r)
	if err != nil {
		return 0, nil, err
	}
	q := r.URL.Query()
	dry := false
	if vs, ok := q["dry_run"]; ok {
		if len(vs) != 1 || vs[0] != "1" {
			return 0, nil, httperr.Fail(http.StatusBadRequest, msgDryRun)
		}
		dry = true
	}
	if err := decodeJSON(r, &struct{}{}); err != nil && err != errEmptyBody {
		return 0, nil, err
	}
	ctx := r.Context()
	var manifest *manifestView
	err = s.inTx(ctx, func(tx *sql.Tx) error {
		if _, _, err := ownedCollection(ctx, tx, owner, id); err != nil {
			return err
		}
		var frames int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM frames WHERE collection_id=?`, id).Scan(&frames); err != nil {
			return err
		}
		if frames == 0 {
			return httperr.Fail(http.StatusBadRequest, msgEmptyPublish)
		}
		if dry {
			m, err := buildManifest(ctx, tx, owner, id)
			manifest = m
			return err
		}
		// Publishing only adds exposure, so no withdrawal check is needed.
		now := s.now()
		_, err := tx.ExecContext(ctx, `UPDATE collections SET status='published',published_at=coalesce(published_at,?),updated_at=?
			WHERE id=? AND owner_id=?`, now, now, id, owner)
		return err
	})
	if err != nil {
		return 0, nil, err
	}
	if dry {
		return http.StatusOK, manifest, nil
	}
	return s.collectionResponse(ctx, http.StatusOK, owner, id)
}

// buildManifest describes what publishing the collection would expose, using
// domain.EffectivePublicFields per photo in this collection's context.
func buildManifest(ctx context.Context, tx *sql.Tx, owner, id string) (*manifestView, error) {
	var vis string
	var dist, orig int
	if err := tx.QueryRowContext(ctx, `SELECT visibility,distribute,original_download FROM collections WHERE id=? AND owner_id=?`,
		id, owner).Scan(&vis, &dist, &orig); err != nil {
		return nil, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT p.id,p.public_fields,p.histogram_public,o.public_fields,o.histogram_public
		FROM photos p LEFT JOIN photo_overrides o ON o.collection_id=? AND o.photo_id=p.id
		WHERE p.id IN (SELECT fp.photo_id FROM frame_photos fp JOIN frames f ON f.id=fp.frame_id WHERE f.collection_id=?)`, id, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	m := &manifestView{PublicFields: []string{}, OriginalDownload: orig == 1, Visibility: vis}
	union := map[string]bool{}
	for rows.Next() {
		var (
			pid, fields string
			hist        int
			oFields     sql.NullString
			oHist       sql.NullInt64
		)
		if err := rows.Scan(&pid, &fields, &hist, &oFields, &oHist); err != nil {
			return nil, err
		}
		m.Photos++
		p := domain.Photo{ID: pid, OwnerID: owner, PublicFields: parsePublicFields(fields), HistogramPublic: hist == 1}
		var o *domain.PhotoOverride
		if oFields.Valid || oHist.Valid {
			o = &domain.PhotoOverride{}
			if oFields.Valid {
				o.PublicFields = parsePublicFields(oFields.String) // non-nil, possibly empty
			}
			if oHist.Valid {
				h := oHist.Int64 == 1
				o.HistogramPublic = &h
			}
		}
		for k, on := range domain.EffectivePublicFields(p, o) {
			switch {
			case k == domain.HistogramKey:
				m.Histogram = m.Histogram || on
			case on:
				union[k] = true
			}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for k := range union {
		m.PublicFields = append(m.PublicFields, k)
	}
	sort.Strings(m.PublicFields)
	m.InSquare = domain.CollectionInSquare(domain.Collection{ID: id, OwnerID: owner, Status: domain.StatusPublished,
		Visibility: vis, Distribute: dist == 1, AllowOriginal: orig == 1})
	return m, nil
}

func (s *server) unpublishCollection(w http.ResponseWriter, r *http.Request) (int, any, error) {
	owner, err := requireUser(r)
	if err != nil {
		return 0, nil, err
	}
	id, err := collectionID(r)
	if err != nil {
		return 0, nil, err
	}
	if err := decodeJSON(r, &struct{}{}); err != nil && err != errEmptyBody {
		return 0, nil, err
	}
	ctx := r.Context()
	err = s.inTx(ctx, func(tx *sql.Tx) error {
		status, _, err := ownedCollection(ctx, tx, owner, id)
		if err != nil || status == domain.StatusDraft {
			return err
		}
		before, err := exposedPhotos(ctx, tx, owner)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE collections SET status='draft',updated_at=? WHERE id=? AND owner_id=?`,
			s.now(), id, owner); err != nil {
			return err
		}
		return s.withdraw(ctx, tx, owner, before)
	})
	if err != nil {
		return 0, nil, err
	}
	return s.collectionResponse(ctx, http.StatusOK, owner, id)
}

// --- PUT /api/collections/{id}/overrides/{photoId} ---

func (s *server) putOverride(w http.ResponseWriter, r *http.Request) (int, any, error) {
	owner, err := requireUser(r)
	if err != nil {
		return 0, nil, err
	}
	id, err := collectionID(r)
	if err != nil {
		return 0, nil, err
	}
	pid, err := idParam(r, "photoId", msgOverridePhoto)
	if err != nil {
		return 0, nil, err
	}
	var in struct {
		PublicFields    *[]string `json:"publicFields"`
		HistogramPublic *bool     `json:"histogramPublic"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return 0, nil, err
	}
	var fieldsJSON *string
	view := overrideView{CollectionID: id, PhotoID: pid, HistogramPublic: in.HistogramPublic}
	if in.PublicFields != nil {
		fields, err := validPublicFields(*in.PublicFields)
		if err != nil {
			return 0, nil, err
		}
		b, _ := json.Marshal(fields)
		j := string(b)
		fieldsJSON, view.PublicFields = &j, fields
	}
	var hist *int
	if in.HistogramPublic != nil {
		h := boolInt(*in.HistogramPublic)
		hist = &h
	}
	ctx := r.Context()
	err = s.inTx(ctx, func(tx *sql.Tx) error {
		if _, _, err := ownedCollection(ctx, tx, owner, id); err != nil {
			return err
		}
		var one int
		err := tx.QueryRowContext(ctx, `SELECT 1 FROM frame_photos fp JOIN frames f ON f.id=fp.frame_id
			WHERE f.collection_id=? AND fp.photo_id=? LIMIT 1`, id, pid).Scan(&one)
		if errors.Is(err, sql.ErrNoRows) {
			return httperr.Fail(http.StatusNotFound, msgOverridePhoto)
		}
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO photo_overrides(collection_id,photo_id,public_fields,histogram_public) VALUES(?,?,?,?)
			ON CONFLICT(collection_id,photo_id) DO UPDATE SET public_fields=excluded.public_fields,histogram_public=excluded.histogram_public`,
			id, pid, fieldsJSON, hist)
		if err != nil {
			return err
		}
		view.UpdatedAt = s.now()
		_, err = tx.ExecContext(ctx, `UPDATE collections SET updated_at=? WHERE id=?`, view.UpdatedAt, id)
		return err
	})
	if err != nil {
		return 0, nil, err
	}
	return http.StatusOK, view, nil
}

// --- withdrawal (spec §7 撤回) ---

// exposed is a snapshot of owner's CDN-exposed and hash-exposed photo sets
// (package exposure, shared with the worker's rotate_derived re-check).
type exposed struct {
	cdn, hash map[string]struct{}
}

// drop removes id from both sets, for a photo that is deleted outright
// rather than rotated.
func (x exposed) drop(id string) {
	delete(x.cdn, id)
	delete(x.hash, id)
}

func exposedPhotos(ctx context.Context, tx *sql.Tx, owner string) (exposed, error) {
	cdn, err := exposure.OwnerCDN(ctx, tx, owner)
	if err != nil {
		return exposed{}, err
	}
	hash, err := exposure.OwnerHash(ctx, tx, owner)
	if err != nil {
		return exposed{}, err
	}
	return exposed{cdn: cdn, hash: hash}, nil
}

// withdraw enqueues one rotate_derived for every photo in before (the
// exposedPhotos snapshot taken earlier in the same tx) that has left the
// CDN-exposed set, the hash-exposed set, or both (final review I1), so its
// old derived URLs stop resolving and the CDN prefix is purged.
func (s *server) withdraw(ctx context.Context, tx *sql.Tx, owner string, before exposed) error {
	if len(before.hash) == 0 {
		return nil // CDN-exposed is a subset of hash-exposed
	}
	after, err := exposedPhotos(ctx, tx, owner)
	if err != nil {
		return err
	}
	left := map[string]struct{}{}
	for _, sets := range [][2]map[string]struct{}{{before.cdn, after.cdn}, {before.hash, after.hash}} {
		for id := range sets[0] {
			if _, ok := sets[1][id]; !ok {
				left[id] = struct{}{}
			}
		}
	}
	gone := make([]string, 0, len(left))
	for id := range left {
		gone = append(gone, id)
	}
	sort.Strings(gone)
	for _, id := range gone {
		if _, err := s.q.EnqueueTx(ctx, tx, jobRotateDerived, map[string]string{"photoId": id}); err != nil {
			return err
		}
	}
	return nil
}

// --- loading ---

type querier interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

// ownedCollection returns the status and visibility of owner's collection,
// or 404 when it does not exist or belongs to someone else.
func ownedCollection(ctx context.Context, q querier, owner, id string) (status, visibility string, err error) {
	err = q.QueryRowContext(ctx, `SELECT status,visibility FROM collections WHERE id=? AND owner_id=?`, id, owner).Scan(&status, &visibility)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", httperr.Fail(http.StatusNotFound, msgCollectionAbsent)
	}
	return status, visibility, err
}

func (s *server) collectionResponse(ctx context.Context, code int, owner, id string) (int, any, error) {
	c, err := loadCollection(ctx, s.db, owner, id)
	if err != nil {
		return 0, nil, err
	}
	return code, c, nil
}

// loadCollection returns the owner view of a collection with its frames.
func loadCollection(ctx context.Context, q querier, owner, id string) (*collectionView, error) {
	var (
		c              collectionView
		dist, orig     int
		lic, ai, cover sql.NullString
		published      sql.NullInt64
	)
	err := q.QueryRowContext(ctx, `SELECT id,title,intro,status,visibility,distribute,original_download,license,ai_declaration,
		cover_photo_id,wall_rank,published_at,created_at,updated_at FROM collections WHERE id=? AND owner_id=?`, id, owner).Scan(
		&c.ID, &c.Title, &c.Intro, &c.Status, &c.Visibility, &dist, &orig, &lic, &ai, &cover, &c.WallRank, &published,
		&c.CreatedAt, &c.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, httperr.Fail(http.StatusNotFound, msgCollectionAbsent)
	}
	if err != nil {
		return nil, err
	}
	c.Distribute, c.OriginalDownload = dist == 1, orig == 1
	c.License, c.AIDeclaration, c.CoverPhotoID = nullStr(lic), nullStr(ai), nullStr(cover)
	if published.Valid {
		c.PublishedAt = &published.Int64
	}

	rows, err := q.QueryContext(ctx, `SELECT id,position,layout,matte_ratio,text FROM frames WHERE collection_id=? ORDER BY position`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	c.Frames = []frameView{}
	index := map[string]int{}
	for rows.Next() {
		var f frameView
		var ratio sql.NullFloat64
		var text sql.NullString
		if err := rows.Scan(&f.ID, &f.Position, &f.Layout, &ratio, &text); err != nil {
			return nil, err
		}
		f.MatteRatio, f.Text, f.PhotoIDs = floatPtr(ratio), nullStr(text), []string{}
		index[f.ID] = len(c.Frames)
		c.Frames = append(c.Frames, f)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()

	slots, err := q.QueryContext(ctx, `SELECT fp.frame_id,fp.photo_id FROM frame_photos fp JOIN frames f ON f.id=fp.frame_id
		WHERE f.collection_id=? ORDER BY f.position,fp.slot`, id)
	if err != nil {
		return nil, err
	}
	defer slots.Close()
	for slots.Next() {
		var fid, pid string
		if err := slots.Scan(&fid, &pid); err != nil {
			return nil, err
		}
		if i, ok := index[fid]; ok {
			c.Frames[i].PhotoIDs = append(c.Frames[i].PhotoIDs, pid)
		}
	}
	return &c, slots.Err()
}

// --- shared helpers for the write API ---

// inTx runs fn in a transaction, committing when it returns nil.
func (s *server) inTx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

func collectionID(r *http.Request) (string, error) { return idParam(r, "id", msgCollectionAbsent) }

// cleanText normalises user text: CRLF/CR become LF (kept only when
// multiline), other control characters and bidi embedding/override/isolate
// controls are removed, and the result is trimmed.
func cleanText(s string, multiline bool) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	s = strings.Map(func(r rune) rune {
		switch {
		case r == '\n' && multiline:
			return r
		case unicode.IsControl(r), (r >= 0x202A && r <= 0x202E) || (r >= 0x2066 && r <= 0x2069):
			return -1
		}
		return r
	}, s)
	return strings.TrimSpace(s)
}

// validTitle cleans a required title and enforces 1–120 runes.
func validTitle(in *string) (string, error) {
	if in == nil {
		return "", httperr.Fail(http.StatusBadRequest, msgTitle)
	}
	t := cleanText(*in, false)
	if n := utf8.RuneCountInString(t); n < 1 || n > maxTitleRunes {
		return "", httperr.Fail(http.StatusBadRequest, msgTitle)
	}
	return t, nil
}

// validIntro cleans an optional intro (absent means empty), ≤ 2000 runes.
func validIntro(in *string) (string, error) {
	if in == nil {
		return "", nil
	}
	t := cleanText(*in, true)
	if utf8.RuneCountInString(t) > maxIntroRunes {
		return "", httperr.Fail(http.StatusBadRequest, msgIntro)
	}
	return t, nil
}

func validVisibility(v string) bool {
	return v == domain.VisibilityPrivate || v == domain.VisibilityUnlisted || v == domain.VisibilityPublic
}

// validPublicFields requires known, unique keys and returns them as a
// non-nil slice.
func validPublicFields(in []string) ([]string, error) {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, f := range in {
		if !domain.ValidPublicField(f) || seen[f] {
			return nil, httperr.Fail(http.StatusBadRequest, msgPublicFields)
		}
		seen[f] = true
		out = append(out, f)
	}
	return out, nil
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func nullStr(v sql.NullString) *string {
	if !v.Valid {
		return nil
	}
	return &v.String
}
