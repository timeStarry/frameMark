// Package exposure holds the one SQL rule for "is this photo's derived hash
// exposed?" (spec §7 撤回, T13 ruling I1). A photo is exposed while it sits
// in at least one of its owner's published collections whose visibility is
// public or unlisted: anyone holding an unlisted link has seen the hash.
// The API's withdrawal path and the worker's rotate_derived re-check both
// use it, so they can never disagree.
package exposure

import (
	"context"
	"database/sql"
	"errors"
)

// Querier is satisfied by *sql.DB and *sql.Tx.
type Querier interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

const exposedJoin = `FROM frame_photos fp
	JOIN frames f ON f.id=fp.frame_id
	JOIN collections c ON c.id=f.collection_id
	WHERE c.status='published' AND c.visibility IN ('public','unlisted')`

// OwnerPhotos returns the ids of owner's photos that are exposed.
func OwnerPhotos(ctx context.Context, q Querier, owner string) (map[string]struct{}, error) {
	rows, err := q.QueryContext(ctx, `SELECT DISTINCT fp.photo_id `+exposedJoin+` AND c.owner_id=?`, owner)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]struct{}{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = struct{}{}
	}
	return out, rows.Err()
}

// Photo reports whether one photo is exposed.
func Photo(ctx context.Context, q Querier, photoID string) (bool, error) {
	var one int
	err := q.QueryRowContext(ctx, `SELECT 1 `+exposedJoin+` AND fp.photo_id=? LIMIT 1`, photoID).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}
