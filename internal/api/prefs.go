package api

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/timeStarry/frameMark/internal/domain"
	"github.com/timeStarry/frameMark/internal/httperr"
	"github.com/timeStarry/frameMark/internal/media"
)

const (
	msgWatermark    = "水印设置无效。"
	msgLocationMode = "位置模式无效。"
)

// prefsView is upload_prefs. updatedAt is null until the first PUT.
type prefsView struct {
	PublicFields         []string         `json:"publicFields"`
	HistogramPublic      bool             `json:"histogramPublic"`
	OriginalDownload     bool             `json:"originalDownload"`
	Watermark            *media.Watermark `json:"watermark"`
	DefaultLicense       *string          `json:"defaultLicense"`
	DefaultAIDeclaration *string          `json:"defaultAiDeclaration"`
	LocationMode         string           `json:"locationMode"`
	UpdatedAt            *int64           `json:"updatedAt"`
}

// --- GET /api/upload-prefs ---

func (s *server) getPrefs(w http.ResponseWriter, r *http.Request) (int, any, error) {
	owner, err := requireUser(r)
	if err != nil {
		return 0, nil, err
	}
	var (
		p          prefsView
		fields     string
		hist, orig int
		wm         sql.NullString
		lic, ai    sql.NullString
		updated    int64
	)
	err = s.db.QueryRowContext(r.Context(), `SELECT public_fields,histogram_public,original_download,watermark,default_license,
		default_ai_declaration,location_mode,updated_at FROM upload_prefs WHERE user_id=?`, owner).
		Scan(&fields, &hist, &orig, &wm, &lic, &ai, &p.LocationMode, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		// Same defaults prefsSnapshot applies to uploads.
		return http.StatusOK, prefsView{PublicFields: append([]string(nil), defaultPublicFields...), HistogramPublic: true,
			LocationMode: "off"}, nil
	}
	if err != nil {
		return 0, nil, err
	}
	p.PublicFields = parsePublicFields(fields)
	p.HistogramPublic, p.OriginalDownload = hist == 1, orig == 1
	p.DefaultLicense, p.DefaultAIDeclaration, p.UpdatedAt = nullStr(lic), nullStr(ai), &updated
	if wm.Valid {
		var w media.Watermark
		if err := json.Unmarshal([]byte(wm.String), &w); err != nil {
			return 0, nil, err
		}
		p.Watermark = &w
	}
	return http.StatusOK, p, nil
}

// --- PUT /api/upload-prefs ---

// putPrefs replaces the owner's upload prefs. Prefs are only snapshotted
// onto photos at upload time, so existing photos are never touched here.
func (s *server) putPrefs(w http.ResponseWriter, r *http.Request) (int, any, error) {
	owner, err := requireUser(r)
	if err != nil {
		return 0, nil, err
	}
	var in struct {
		PublicFields         *[]string       `json:"publicFields"`
		HistogramPublic      *bool           `json:"histogramPublic"`
		OriginalDownload     *bool           `json:"originalDownload"`
		Watermark            json.RawMessage `json:"watermark"`
		DefaultLicense       *string         `json:"defaultLicense"`
		DefaultAIDeclaration *string         `json:"defaultAiDeclaration"`
		LocationMode         *string         `json:"locationMode"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return 0, nil, err
	}
	// watermark is required but may be null: a missing key leaves the
	// RawMessage empty, an explicit null stores the literal "null".
	if in.PublicFields == nil || in.HistogramPublic == nil || in.OriginalDownload == nil || len(in.Watermark) == 0 {
		return 0, nil, httperr.Fail(http.StatusBadRequest, msgBadJSON)
	}
	fields, err := validPublicFields(*in.PublicFields)
	if err != nil {
		return 0, nil, err
	}
	var wm *media.Watermark
	var wmJSON *string
	if string(in.Watermark) != "null" {
		var v media.Watermark
		dec := json.NewDecoder(bytes.NewReader(in.Watermark))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&v); err != nil || v.Validate() != nil {
			return 0, nil, httperr.Fail(http.StatusBadRequest, msgWatermark)
		}
		b, _ := json.Marshal(v)
		j := string(b)
		wm, wmJSON = &v, &j
	}
	if in.DefaultLicense != nil && !domain.ValidLicense(*in.DefaultLicense) {
		return 0, nil, httperr.Fail(http.StatusBadRequest, msgLicense)
	}
	if in.DefaultAIDeclaration != nil && !domain.ValidAIDeclaration(*in.DefaultAIDeclaration) {
		return 0, nil, httperr.Fail(http.StatusBadRequest, msgAIDeclaration)
	}
	if in.LocationMode == nil || (*in.LocationMode != "off" && *in.LocationMode != "archive") {
		return 0, nil, httperr.Fail(http.StatusBadRequest, msgLocationMode)
	}
	now := s.now()
	fb, _ := json.Marshal(fields)
	if _, err := s.db.ExecContext(r.Context(), `INSERT INTO upload_prefs(user_id,public_fields,histogram_public,original_download,
		watermark,default_license,default_ai_declaration,location_mode,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
		ON CONFLICT(user_id) DO UPDATE SET public_fields=excluded.public_fields,histogram_public=excluded.histogram_public,
		original_download=excluded.original_download,watermark=excluded.watermark,default_license=excluded.default_license,
		default_ai_declaration=excluded.default_ai_declaration,location_mode=excluded.location_mode,updated_at=excluded.updated_at`,
		owner, string(fb), boolInt(*in.HistogramPublic), boolInt(*in.OriginalDownload), wmJSON,
		in.DefaultLicense, in.DefaultAIDeclaration, *in.LocationMode, now); err != nil {
		return 0, nil, err
	}
	return http.StatusOK, prefsView{PublicFields: fields, HistogramPublic: *in.HistogramPublic, OriginalDownload: *in.OriginalDownload,
		Watermark: wm, DefaultLicense: in.DefaultLicense, DefaultAIDeclaration: in.DefaultAIDeclaration,
		LocationMode: *in.LocationMode, UpdatedAt: &now}, nil
}
