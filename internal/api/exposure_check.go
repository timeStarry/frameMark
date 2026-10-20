package api

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"strings"

	"github.com/timeStarry/frameMark/internal/domain"
	"github.com/timeStarry/frameMark/internal/httperr"
)

// --- POST /api/collections/{id}/exposure-check (spec SP4b §3.3) ---
//
// A dry run: it tells the desk whether a proposed edit to a published
// collection widens what anonymous visitors can see. It writes nothing.
// Both the current and the proposed state go through the read path's own
// rules: readable / inSquare (read.go, built on domain.CanReadCollection and
// domain.CollectionInSquare), domain.EffectivePublicFields and
// domain.CanDownloadOriginal.

const (
	kindPhotos     = "photos"
	kindFields     = "fields"
	kindHistogram  = "histogram"
	kindOriginal   = "original"
	kindVisibility = "visibility"
	kindSquare     = "square"
)

// fieldLabels are the author-facing names of domain.PublicFieldKeys.
var fieldLabels = map[string]string{
	"camera": "机身", "lens": "镜头", "focal_length": "焦段", "aperture": "光圈",
	"shutter": "快门", "iso": "ISO", "exposure_bias": "曝光补偿", "taken_date": "拍摄日期",
}

type exposureChange struct {
	Kind   string `json:"kind"`
	Detail string `json:"detail"`
}

type exposureCheckView struct {
	Widens  bool             `json:"widens"`
	Changes []exposureChange `json:"changes"`
}

type overrideInput struct {
	PhotoID         *string   `json:"photoId"`
	PublicFields    *[]string `json:"publicFields"`
	HistogramPublic *bool     `json:"histogramPublic"`
}

// exposureState is one version of a collection, as the read path sees it.
type exposureState struct {
	coll      domain.Collection
	photos    []string // distinct photo ids in the frames
	frames    int
	overrides map[string]*domain.PhotoOverride
}

// photoSnap is the permission-relevant part of a photos row.
type photoSnap struct {
	photo domain.Photo
	ready bool
}

// photoExposure is what an anonymous visitor gets of one photo.
type photoExposure struct {
	fields       map[string]bool // domain.EffectivePublicFields
	downloadable bool
}

func (s *server) exposureCheck(w http.ResponseWriter, r *http.Request) (int, any, error) {
	owner, err := requireUser(r)
	if err != nil {
		return 0, nil, err
	}
	id, err := collectionID(r)
	if err != nil {
		return 0, nil, err
	}
	var in struct {
		Collection *collectionInput `json:"collection"`
		Frames     *[]frameInput    `json:"frames"`
		Override   *overrideInput   `json:"override"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return 0, nil, err
	}
	// Shape checks first, exactly as the write endpoints run them.
	var refs []string
	if in.Collection != nil {
		if _, _, err := validCollection(*in.Collection); err != nil {
			return 0, nil, err
		}
	}
	if in.Frames != nil {
		if _, refs, err = validFrames(*in.Frames); err != nil {
			return 0, nil, err
		}
	}
	var ov *domain.PhotoOverride
	if in.Override != nil {
		if in.Override.PhotoID == nil || !canonicalUUID(*in.Override.PhotoID) {
			return 0, nil, httperr.Fail(http.StatusNotFound, msgOverridePhoto)
		}
		// putOverride stores an absent or null key as NULL ("not overridden").
		ov = &domain.PhotoOverride{HistogramPublic: in.Override.HistogramPublic}
		if in.Override.PublicFields != nil {
			if ov.PublicFields, err = validPublicFields(*in.Override.PublicFields); err != nil {
				return 0, nil, err
			}
		}
	}

	ctx := r.Context()
	view := exposureCheckView{Changes: []exposureChange{}}
	err = s.inTx(ctx, func(tx *sql.Tx) error {
		status, _, err := ownedCollection(ctx, tx, owner, id)
		if err != nil {
			return err
		}
		before, err := loadExposureState(ctx, tx, owner, id)
		if err != nil {
			return err
		}
		after := before.clone()
		if in.Frames != nil {
			if status == domain.StatusPublished && len(*in.Frames) == 0 {
				return httperr.Fail(http.StatusBadRequest, msgEmptyPublished)
			}
			if err := checkReadyPhotos(ctx, tx, owner, refs); err != nil {
				return err
			}
			after.setFrames(*in.Frames)
		}
		if in.Override != nil {
			pid := *in.Override.PhotoID
			if !contains(after.photos, pid) {
				return httperr.Fail(http.StatusNotFound, msgOverridePhoto)
			}
			after.overrides[pid] = ov
		}
		if c := in.Collection; c != nil {
			if c.CoverPhotoID != nil {
				if in.Frames != nil {
					// Proposed refs are already checked as owner's ready photos.
					if !contains(after.photos, *c.CoverPhotoID) {
						return httperr.Fail(http.StatusBadRequest, msgCover)
					}
				} else if err := checkCover(ctx, tx, owner, id, *c.CoverPhotoID); err != nil {
					return err
				}
			}
			after.coll.Visibility = *c.Visibility
			after.coll.Distribute = *c.Distribute
			after.coll.AllowOriginal = *c.OriginalDownload
		}
		if status != domain.StatusPublished {
			return nil
		}
		snaps, err := loadPhotoSnaps(ctx, tx, owner, append(append([]string{}, before.photos...), after.photos...))
		if err != nil {
			return err
		}
		view.Changes = exposureChanges(before, after, snaps)
		return nil
	})
	if err != nil {
		return 0, nil, err
	}
	view.Widens = len(view.Changes) > 0
	return http.StatusOK, view, nil
}

// exposureChanges lists the widenings from before to after, in the order
// photos, fields, histogram, original, visibility, square.
func exposureChanges(before, after exposureState, snaps map[string]photoSnap) []exposureChange {
	was, will := before.visible(snaps), after.visible(snaps)
	newPhotos := 0
	newFields := map[string]bool{}
	for pid, a := range will {
		b, seen := was[pid]
		if !seen {
			newPhotos++
		}
		for k, on := range a.fields {
			if on && !(seen && b.fields[k]) {
				newFields[k] = true
			}
		}
	}
	histogram := newFields[domain.HistogramKey]
	delete(newFields, domain.HistogramKey)
	// Original download is a collection-level switch: it widens when no
	// visible photo could be downloaded before and one can be after.
	original := anyDownloadable(will) && !anyDownloadable(was)

	out := []exposureChange{}
	if newPhotos > 0 {
		out = append(out, exposureChange{kindPhotos, fmt.Sprintf("新增 %d 张公开照片", newPhotos)})
	}
	var labels []string
	for _, k := range domain.PublicFieldKeys {
		if newFields[k] {
			labels = append(labels, fieldLabels[k])
		}
	}
	if len(labels) > 0 {
		out = append(out, exposureChange{kindFields, "公开" + joinLabels(labels)})
	}
	if histogram {
		out = append(out, exposureChange{kindHistogram, "公开直方图"})
	}
	if original {
		out = append(out, exposureChange{kindOriginal, "开放原图下载"})
	}
	bv, av := before.coll.Visibility, after.coll.Visibility
	switch {
	case av == domain.VisibilityPublic && bv != domain.VisibilityPublic:
		out = append(out, exposureChange{kindVisibility, "改为公开"})
	case av == domain.VisibilityUnlisted && bv == domain.VisibilityPrivate:
		out = append(out, exposureChange{kindVisibility, "改为仅链接"})
	}
	if after.inSquare() && !before.inSquare() {
		out = append(out, exposureChange{kindSquare, "进入广场"})
	}
	return out
}

func anyDownloadable(m map[string]photoExposure) bool {
	for _, p := range m {
		if p.downloadable {
			return true
		}
	}
	return false
}

// joinLabels joins with 「与」 for two items; with three or more, 「、」 and
// 「与」 before the last.
func joinLabels(l []string) string {
	if len(l) <= 1 {
		return strings.Join(l, "")
	}
	return strings.Join(l[:len(l)-1], "、") + "与" + l[len(l)-1]
}

// row is the state as a read.go collRow, for readable and inSquare.
func (st exposureState) row() collRow { return collRow{Collection: st.coll, Frames: st.frames} }

func (st exposureState) inSquare() bool { return inSquare(st.row()) }

// visible returns what an anonymous visitor gets of each photo: nothing when
// the collection is not readable (readable in read.go), else every photo in
// its frames, filtered as collectionPhotos does.
func (st exposureState) visible(snaps map[string]photoSnap) map[string]photoExposure {
	out := map[string]photoExposure{}
	if !readable(st.row(), "") {
		return out
	}
	for _, pid := range st.photos {
		sn, ok := snaps[pid]
		if !ok {
			continue
		}
		out[pid] = photoExposure{
			fields:       domain.EffectivePublicFields(sn.photo, st.overrides[pid]),
			downloadable: sn.ready && domain.CanDownloadOriginal(sn.photo, st.coll, ""),
		}
	}
	return out
}

func (st exposureState) clone() exposureState {
	c := st
	c.photos = append([]string(nil), st.photos...)
	c.overrides = make(map[string]*domain.PhotoOverride, len(st.overrides))
	for k, v := range st.overrides {
		c.overrides[k] = v
	}
	return c
}

// setFrames applies a frame sequence the way putFrames does, including
// dropDetached: overrides of photos that leave the frames are deleted.
func (st *exposureState) setFrames(frames []frameInput) {
	st.frames = len(frames)
	st.photos = nil
	seen := map[string]bool{}
	for _, f := range frames {
		for _, pid := range f.PhotoIDs {
			if !seen[pid] {
				seen[pid] = true
				st.photos = append(st.photos, pid)
			}
		}
	}
	for pid := range st.overrides {
		if !seen[pid] {
			delete(st.overrides, pid)
		}
	}
}

func loadExposureState(ctx context.Context, q querier, owner, id string) (exposureState, error) {
	var st exposureState
	var dist, orig int
	err := q.QueryRowContext(ctx, `SELECT status,visibility,distribute,original_download,
		(SELECT count(*) FROM frames WHERE collection_id=c.id) FROM collections c WHERE id=? AND owner_id=?`,
		id, owner).Scan(&st.coll.Status, &st.coll.Visibility, &dist, &orig, &st.frames)
	if err != nil {
		return st, err
	}
	st.coll.ID, st.coll.OwnerID = id, owner
	st.coll.Distribute, st.coll.AllowOriginal = dist == 1, orig == 1
	ids, err := stringsOf(ctx, q, `SELECT DISTINCT fp.photo_id FROM frame_photos fp JOIN frames f ON f.id=fp.frame_id
		WHERE f.collection_id=?`, id)
	if err != nil {
		return st, err
	}
	st.photos = ids
	st.overrides = map[string]*domain.PhotoOverride{}
	rows, err := q.QueryContext(ctx, `SELECT photo_id,public_fields,histogram_public FROM photo_overrides WHERE collection_id=?`, id)
	if err != nil {
		return st, err
	}
	defer rows.Close()
	for rows.Next() {
		var pid string
		var fields sql.NullString
		var hist sql.NullInt64
		if err := rows.Scan(&pid, &fields, &hist); err != nil {
			return st, err
		}
		if o := overrideOf(fields, hist); o != nil {
			st.overrides[pid] = o
		}
	}
	return st, rows.Err()
}

// overrideOf maps photo_overrides columns to a domain.PhotoOverride. It is
// the single mapping shared by the visitor read path and exposure-check
// (nil when nothing is overridden).
func overrideOf(fields sql.NullString, hist sql.NullInt64) *domain.PhotoOverride {
	if !fields.Valid && !hist.Valid {
		return nil
	}
	o := &domain.PhotoOverride{}
	if fields.Valid {
		o.PublicFields = parsePublicFields(fields.String) // non-nil, possibly empty
	}
	if hist.Valid {
		h := hist.Int64 == 1
		o.HistogramPublic = &h
	}
	return o
}

func loadPhotoSnaps(ctx context.Context, q querier, owner string, ids []string) (map[string]photoSnap, error) {
	out := map[string]photoSnap{}
	if len(ids) == 0 {
		return out, nil
	}
	args := []any{owner}
	for _, id := range ids {
		args = append(args, id)
	}
	rows, err := q.QueryContext(ctx, `SELECT id,owner_id,status,public_fields,histogram_public FROM photos
		WHERE owner_id=? AND id IN (?`+strings.Repeat(",?", len(ids)-1)+`)`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, own, status, fields string
		var hist int
		if err := rows.Scan(&id, &own, &status, &fields, &hist); err != nil {
			return nil, err
		}
		out[id] = photoSnap{
			photo: domain.Photo{ID: id, OwnerID: own, PublicFields: parsePublicFields(fields), HistogramPublic: hist == 1},
			ready: status == statusReady,
		}
	}
	return out, rows.Err()
}

func contains(ids []string, id string) bool {
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}
