package api

import (
	"context"
	"database/sql"
	"errors"
	"net/http"

	"github.com/google/uuid"

	"github.com/timeStarry/frameMark/internal/httperr"
)

const (
	maxAlbumItems = 40

	msgAlbumAbsent = "作品集不存在。"
	msgAlbumItems  = "作品集最多 40 个合集，且必须是你自己的、互不重复的合集。"
)

type albumItemView struct {
	Position     int    `json:"position"`
	CollectionID string `json:"collectionId"`
}

// albumView is the owner view of an album with its ordered items.
type albumView struct {
	ID         string          `json:"id"`
	Title      string          `json:"title"`
	Intro      string          `json:"intro"`
	Visibility string          `json:"visibility"`
	CreatedAt  int64           `json:"createdAt"`
	UpdatedAt  int64           `json:"updatedAt"`
	Items      []albumItemView `json:"items"`
}

type albumInput struct {
	Title      *string `json:"title"`
	Intro      *string `json:"intro"`
	Visibility *string `json:"visibility"`
}

func (in albumInput) validate() (title, intro string, err error) {
	if title, err = validTitle(in.Title); err != nil {
		return "", "", err
	}
	if intro, err = validIntro(in.Intro); err != nil {
		return "", "", err
	}
	if in.Visibility == nil || !validVisibility(*in.Visibility) {
		return "", "", httperr.Fail(http.StatusBadRequest, msgVisibility)
	}
	return title, intro, nil
}

func albumID(r *http.Request) (string, error) { return idParam(r, "id", msgAlbumAbsent) }

// --- POST /api/albums ---

func (s *server) createAlbum(w http.ResponseWriter, r *http.Request) (int, any, error) {
	owner, err := requireUser(r)
	if err != nil {
		return 0, nil, err
	}
	var in albumInput
	if err := decodeJSON(r, &in); err != nil {
		return 0, nil, err
	}
	title, intro, err := in.validate()
	if err != nil {
		return 0, nil, err
	}
	u, err := uuid.NewV7()
	if err != nil {
		return 0, nil, err
	}
	id, now, ctx := u.String(), s.now(), r.Context()
	if _, err := s.db.ExecContext(ctx, `INSERT INTO albums(id,owner_id,title,intro,visibility,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`,
		id, owner, title, intro, *in.Visibility, now, now); err != nil {
		return 0, nil, err
	}
	return s.albumResponse(ctx, http.StatusCreated, owner, id)
}

// --- PUT /api/albums/{id} ---

func (s *server) updateAlbum(w http.ResponseWriter, r *http.Request) (int, any, error) {
	owner, err := requireUser(r)
	if err != nil {
		return 0, nil, err
	}
	id, err := albumID(r)
	if err != nil {
		return 0, nil, err
	}
	var in albumInput
	if err := decodeJSON(r, &in); err != nil {
		return 0, nil, err
	}
	title, intro, err := in.validate()
	if err != nil {
		return 0, nil, err
	}
	ctx := r.Context()
	res, err := s.db.ExecContext(ctx, `UPDATE albums SET title=?,intro=?,visibility=?,updated_at=? WHERE id=? AND owner_id=?`,
		title, intro, *in.Visibility, s.now(), id, owner)
	if err != nil {
		return 0, nil, err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return 0, nil, httperr.Fail(http.StatusNotFound, msgAlbumAbsent)
	}
	return s.albumResponse(ctx, http.StatusOK, owner, id)
}

// --- DELETE /api/albums/{id} ---

func (s *server) deleteAlbum(w http.ResponseWriter, r *http.Request) (int, any, error) {
	owner, err := requireUser(r)
	if err != nil {
		return 0, nil, err
	}
	id, err := albumID(r)
	if err != nil {
		return 0, nil, err
	}
	// album_items cascade. Albums never raise member visibility, so
	// deleting one cannot withdraw exposure.
	res, err := s.db.ExecContext(r.Context(), `DELETE FROM albums WHERE id=? AND owner_id=?`, id, owner)
	if err != nil {
		return 0, nil, err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return 0, nil, httperr.Fail(http.StatusNotFound, msgAlbumAbsent)
	}
	return http.StatusNoContent, nil, nil
}

// --- PUT /api/albums/{id}/items ---

func (s *server) putAlbumItems(w http.ResponseWriter, r *http.Request) (int, any, error) {
	owner, err := requireUser(r)
	if err != nil {
		return 0, nil, err
	}
	id, err := albumID(r)
	if err != nil {
		return 0, nil, err
	}
	var in struct {
		CollectionIDs *[]string `json:"collectionIds"`
	}
	if err := decodeJSON(r, &in); err != nil {
		return 0, nil, err
	}
	if in.CollectionIDs == nil || len(*in.CollectionIDs) > maxAlbumItems {
		return 0, nil, httperr.Fail(http.StatusBadRequest, msgAlbumItems)
	}
	ids := *in.CollectionIDs
	seen := map[string]bool{}
	for _, c := range ids {
		if seen[c] {
			return 0, nil, httperr.Fail(http.StatusBadRequest, msgAlbumItems)
		}
		seen[c] = true
	}
	ctx := r.Context()
	err = s.inTx(ctx, func(tx *sql.Tx) error {
		var one int
		err := tx.QueryRowContext(ctx, `SELECT 1 FROM albums WHERE id=? AND owner_id=?`, id, owner).Scan(&one)
		if errors.Is(err, sql.ErrNoRows) {
			return httperr.Fail(http.StatusNotFound, msgAlbumAbsent)
		}
		if err != nil {
			return err
		}
		for _, c := range ids {
			var se *httperr.StatusError
			if _, _, err := ownedCollection(ctx, tx, owner, c); errors.As(err, &se) {
				return httperr.Fail(http.StatusBadRequest, msgAlbumItems)
			} else if err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM album_items WHERE album_id=?`, id); err != nil {
			return err
		}
		for i, c := range ids {
			if _, err := tx.ExecContext(ctx, `INSERT INTO album_items(album_id,position,collection_id) VALUES(?,?,?)`, id, i, c); err != nil {
				return err
			}
		}
		_, err = tx.ExecContext(ctx, `UPDATE albums SET updated_at=? WHERE id=?`, s.now(), id)
		return err
	})
	if err != nil {
		return 0, nil, err
	}
	return s.albumResponse(ctx, http.StatusOK, owner, id)
}

// --- loading ---

func (s *server) albumResponse(ctx context.Context, code int, owner, id string) (int, any, error) {
	var a albumView
	err := s.db.QueryRowContext(ctx, `SELECT id,title,intro,visibility,created_at,updated_at FROM albums WHERE id=? AND owner_id=?`,
		id, owner).Scan(&a.ID, &a.Title, &a.Intro, &a.Visibility, &a.CreatedAt, &a.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil, httperr.Fail(http.StatusNotFound, msgAlbumAbsent)
	}
	if err != nil {
		return 0, nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT position,collection_id FROM album_items WHERE album_id=? ORDER BY position`, id)
	if err != nil {
		return 0, nil, err
	}
	defer rows.Close()
	a.Items = []albumItemView{}
	for rows.Next() {
		var it albumItemView
		if err := rows.Scan(&it.Position, &it.CollectionID); err != nil {
			return 0, nil, err
		}
		a.Items = append(a.Items, it)
	}
	if err := rows.Err(); err != nil {
		return 0, nil, err
	}
	return code, &a, nil
}
