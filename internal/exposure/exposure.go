// Package exposure holds the SQL rules for how far a photo's derived media
// is exposed (spec §7 撤回, T13 ruling I1, final review ruling I1). There
// are two sets:
//
//   - CDN-exposed: the photo sits in at least one of its owner's published
//     public collections, so the API hands out cacheable CDN URLs for it.
//   - hash-exposed: the photo sits in at least one published public or
//     unlisted collection, so anyone holding the link has seen the hash.
//
// CDN-exposed is a subset of hash-exposed. The API enqueues rotate_derived
// when a photo leaves either set; the worker skips the rotate only while the
// photo is still CDN-exposed. Both use this package, so they cannot disagree.
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

const (
	joinPublished = `FROM frame_photos fp
	JOIN frames f ON f.id=fp.frame_id
	JOIN collections c ON c.id=f.collection_id
	WHERE c.status='published'`
	cdnJoin  = joinPublished + ` AND c.visibility='public'`
	hashJoin = joinPublished + ` AND c.visibility IN ('public','unlisted')`
)

// OwnerCDN returns the ids of owner's photos that are CDN-exposed.
func OwnerCDN(ctx context.Context, q Querier, owner string) (map[string]struct{}, error) {
	return ownerSet(ctx, q, cdnJoin, owner)
}

// OwnerHash returns the ids of owner's photos that are hash-exposed.
func OwnerHash(ctx context.Context, q Querier, owner string) (map[string]struct{}, error) {
	return ownerSet(ctx, q, hashJoin, owner)
}

func ownerSet(ctx context.Context, q Querier, join, owner string) (map[string]struct{}, error) {
	rows, err := q.QueryContext(ctx, `SELECT DISTINCT fp.photo_id `+join+` AND c.owner_id=?`, owner)
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

// PhotoCDN reports whether one photo is CDN-exposed. It is the
// rotate_derived skip check.
func PhotoCDN(ctx context.Context, q Querier, photoID string) (bool, error) {
	var one int
	err := q.QueryRowContext(ctx, `SELECT 1 `+cdnJoin+` AND fp.photo_id=? LIMIT 1`, photoID).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}
