package api

import (
	"context"
	"database/sql"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/timeStarry/frameMark/internal/httperr"
)

const (
	archiveDefaultLimit = 60
	archiveMaxLimit     = 100
	maxFilterRunes      = 200

	msgArchiveFilter = "筛选参数无效。"
)

// archiveKey is the archive sort key: when the photo was taken, else when
// it was uploaded (Unix ms).
const archiveKey = `coalesce(e.taken_at, p.created_at)`

// cameraExpr is the SQL form of cameraName (make + model, model alone when
// it already starts with the make) so the camera filter and facet agree.
const cameraExpr = `CASE
	WHEN trim(coalesce(e.camera_make,''))='' THEN nullif(trim(coalesce(e.camera_model,'')),'')
	WHEN trim(coalesce(e.camera_model,''))='' THEN trim(e.camera_make)
	WHEN lower(substr(trim(e.camera_model),1,length(trim(e.camera_make))))=lower(trim(e.camera_make)) THEN trim(e.camera_model)
	ELSE trim(e.camera_make)||' '||trim(e.camera_model) END`

type yearFacet struct {
	Year  int `json:"year"`
	Count int `json:"count"`
}

type nameFacet struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

type archiveFacets struct {
	Years   []yearFacet `json:"years"`
	Cameras []nameFacet `json:"cameras"`
	Lenses  []nameFacet `json:"lenses"`
}

type archiveView struct {
	Items      []*photoView  `json:"items"`
	NextCursor *string       `json:"nextCursor"`
	Facets     archiveFacets `json:"facets"`
}

// --- GET /api/archive ---

// readArchive lists the owner's own photos (owner photo view, media via
// /m/…?c=) newest first by archiveKey, with optional filters, and facets
// over all the owner's ready photos. The WHERE clause is assembled only
// from constant fragments; every user value is a placeholder argument.
func (s *server) readArchive(w http.ResponseWriter, r *http.Request) (int, any, error) {
	owner, err := requireUser(r)
	if err != nil {
		return 0, nil, err
	}
	q := r.URL.Query()
	limit, err := parseLimit(q, archiveDefaultLimit, archiveMaxLimit)
	if err != nil {
		return 0, nil, err
	}
	where := []string{`p.owner_id=?`}
	args := []any{owner}
	add := func(clause string, a ...any) { where, args = append(where, clause), append(args, a...) }

	if v, ok, err := single(q, "year"); err != nil {
		return 0, nil, err
	} else if ok {
		y, err := strconv.Atoi(v)
		if err != nil || y < 1900 || y > 2100 || strconv.Itoa(y) != v {
			return 0, nil, httperr.Fail(http.StatusBadRequest, msgArchiveFilter)
		}
		from := time.Date(y, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
		to := time.Date(y+1, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
		add(archiveKey+`>=? AND `+archiveKey+`<?`, from, to)
	}
	for _, f := range []struct{ name, clause string }{
		{"camera", cameraExpr + `=?`},
		{"lens", `e.lens_model=?`},
	} {
		v, ok, err := single(q, f.name)
		if err != nil {
			return 0, nil, err
		}
		if ok {
			if v == "" || !utf8.ValidString(v) || utf8.RuneCountInString(v) > maxFilterRunes {
				return 0, nil, httperr.Fail(http.StatusBadRequest, msgArchiveFilter)
			}
			add(f.clause, v)
		}
	}
	var fmin, fmax float64
	for _, f := range []struct {
		name, clause string
		dst          *float64
	}{
		{"focal_min", `e.focal_length_mm>=?`, &fmin},
		{"focal_max", `e.focal_length_mm<=?`, &fmax},
	} {
		v, ok, err := single(q, f.name)
		if err != nil {
			return 0, nil, err
		}
		if !ok {
			continue
		}
		n, err := strconv.ParseFloat(v, 64)
		if err != nil || math.IsNaN(n) || math.IsInf(n, 0) || !(n > 0) {
			return 0, nil, httperr.Fail(http.StatusBadRequest, msgArchiveFilter)
		}
		*f.dst = n
		add(f.clause, n)
	}
	if fmin > 0 && fmax > 0 && fmin > fmax {
		return 0, nil, httperr.Fail(http.StatusBadRequest, msgArchiveFilter)
	}
	if v, ok, err := single(q, "in_collection"); err != nil {
		return 0, nil, err
	} else if ok {
		const in = `EXISTS (SELECT 1 FROM frame_photos fp WHERE fp.photo_id=p.id)`
		switch v {
		case "true":
			add(in)
		case "false":
			add(`NOT ` + in)
		default:
			return 0, nil, httperr.Fail(http.StatusBadRequest, msgArchiveFilter)
		}
	}
	if v, ok, err := single(q, "status"); err != nil {
		return 0, nil, err
	} else if ok {
		switch v {
		case statusUploading, statusProcessing, statusReady, statusFailed:
			add(`p.status=?`, v)
		default:
			return 0, nil, httperr.Fail(http.StatusBadRequest, msgArchiveFilter)
		}
	}
	if raw, ok := q["cursor"]; ok {
		if len(raw) != 1 {
			return 0, nil, httperr.Fail(http.StatusBadRequest, msgCursor)
		}
		key, id, err := decodeCursor(raw[0])
		if err != nil {
			return 0, nil, err
		}
		add(`(`+archiveKey+`<? OR (`+archiveKey+`=? AND p.id<?))`, key, key, id)
	}

	ctx := r.Context()
	rows, err := s.db.QueryContext(ctx, `SELECT p.id,`+archiveKey+` FROM photos p LEFT JOIN photo_exif e ON e.photo_id=p.id
		WHERE `+strings.Join(where, ` AND `)+` ORDER BY `+archiveKey+` DESC, p.id DESC LIMIT ?`, append(args, limit+1)...)
	if err != nil {
		return 0, nil, err
	}
	type pos struct {
		id  string
		key int64
	}
	var page []pos
	for rows.Next() {
		var p pos
		if err := rows.Scan(&p.id, &p.key); err != nil {
			rows.Close()
			return 0, nil, err
		}
		page = append(page, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, nil, err
	}

	v := archiveView{Items: []*photoView{}}
	if len(page) > limit {
		page = page[:limit]
		last := page[len(page)-1]
		c := encodeCursor(last.key, last.id)
		v.NextCursor = &c
	}
	for _, p := range page {
		pv, err := s.loadPhoto(ctx, owner, p.id)
		if err != nil {
			return 0, nil, err
		}
		v.Items = append(v.Items, pv)
	}
	if v.Facets, err = archiveFacetsFor(ctx, s.db, owner); err != nil {
		return 0, nil, err
	}
	return http.StatusOK, v, nil
}

// single returns a query parameter that may appear at most once.
func single(q url.Values, name string) (string, bool, error) {
	vs, ok := q[name]
	if !ok {
		return "", false, nil
	}
	if len(vs) != 1 {
		return "", false, httperr.Fail(http.StatusBadRequest, msgArchiveFilter)
	}
	return vs[0], true, nil
}

// archiveFacetsFor counts the owner's ready photos by year (of archiveKey,
// UTC), camera and lens. Names are ordered by count then name.
func archiveFacetsFor(ctx context.Context, db *sql.DB, owner string) (archiveFacets, error) {
	f := archiveFacets{Years: []yearFacet{}, Cameras: []nameFacet{}, Lenses: []nameFacet{}}
	const from = ` FROM photos p LEFT JOIN photo_exif e ON e.photo_id=p.id WHERE p.owner_id=? AND p.status='ready'`
	rows, err := db.QueryContext(ctx, `SELECT CAST(strftime('%Y', `+archiveKey+`/1000, 'unixepoch') AS INTEGER) AS y, count(*)`+
		from+` GROUP BY y ORDER BY y DESC`, owner)
	if err != nil {
		return f, err
	}
	for rows.Next() {
		var y yearFacet
		if err := rows.Scan(&y.Year, &y.Count); err != nil {
			rows.Close()
			return f, err
		}
		f.Years = append(f.Years, y)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return f, err
	}
	for _, nf := range []struct {
		expr string
		dst  *[]nameFacet
	}{
		{cameraExpr, &f.Cameras},
		{`nullif(e.lens_model,'')`, &f.Lenses},
	} {
		rows, err := db.QueryContext(ctx, `SELECT `+nf.expr+` AS n, count(*) AS k`+from+
			` AND n IS NOT NULL GROUP BY n ORDER BY k DESC, n`, owner)
		if err != nil {
			return f, err
		}
		for rows.Next() {
			var n nameFacet
			if err := rows.Scan(&n.Name, &n.Count); err != nil {
				rows.Close()
				return f, err
			}
			*nf.dst = append(*nf.dst, n)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return f, err
		}
	}
	return f, nil
}
