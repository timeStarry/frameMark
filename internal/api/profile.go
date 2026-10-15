package api

import (
	"net/http"
	"unicode/utf8"

	"github.com/timeStarry/frameMark/internal/httperr"
)

const (
	maxNameRunes = 60
	maxBioRunes  = 500

	msgName       = "名字需为 1–60 个字符。"
	msgBio        = "简介不能超过 500 个字符。"
	msgWallLayout = "主页布局无效。"
)

type profileView struct {
	UserID     string `json:"userId"`
	Name       string `json:"name"`
	Bio        string `json:"bio"`
	WallLayout string `json:"wallLayout"`
	UpdatedAt  int64  `json:"updatedAt"`
}

// --- PUT /api/profile ---

func (s *server) putProfile(w http.ResponseWriter, r *http.Request) (int, any, error) {
	owner, err := requireUser(r)
	if err != nil {
		return 0, nil, err
	}
	var in struct {
		Name       *string `json:"name"`
		Bio        *string `json:"bio"`
		WallLayout *string `json:"wallLayout"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return 0, nil, err
	}
	if in.Name == nil {
		return 0, nil, httperr.Fail(http.StatusBadRequest, msgName)
	}
	name := cleanText(*in.Name, false)
	if n := utf8.RuneCountInString(name); n < 1 || n > maxNameRunes {
		return 0, nil, httperr.Fail(http.StatusBadRequest, msgName)
	}
	bio := ""
	if in.Bio != nil {
		bio = cleanText(*in.Bio, true)
	}
	if utf8.RuneCountInString(bio) > maxBioRunes {
		return 0, nil, httperr.Fail(http.StatusBadRequest, msgBio)
	}
	if in.WallLayout == nil || (*in.WallLayout != "salon" && *in.WallLayout != "grid") {
		return 0, nil, httperr.Fail(http.StatusBadRequest, msgWallLayout)
	}
	p := profileView{UserID: owner, Name: name, Bio: bio, WallLayout: *in.WallLayout, UpdatedAt: s.now()}
	if _, err := s.db.ExecContext(r.Context(), `INSERT INTO profiles(user_id,name,bio,wall_layout,updated_at) VALUES(?,?,?,?,?)
		ON CONFLICT(user_id) DO UPDATE SET name=excluded.name,bio=excluded.bio,wall_layout=excluded.wall_layout,updated_at=excluded.updated_at`,
		p.UserID, p.Name, p.Bio, p.WallLayout, p.UpdatedAt); err != nil {
		return 0, nil, err
	}
	return http.StatusOK, p, nil
}
