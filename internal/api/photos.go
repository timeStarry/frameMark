package api

import (
	"context"
	"database/sql"
	"errors"
	"net/http"

	"github.com/timeStarry/frameMark/internal/httperr"
)

const jobDeletePhotoObjects = "delete_photo_objects"

// --- DELETE /api/photos/{id} ---

// deletePhoto removes an owner's photo in one tx: the row (cascading
// frame_photos, overrides, exif and histogram), frames left below their slot
// minimum, a dense renumbering of the touched collections' positions, a
// delete_photo_objects job for the stored objects, and the withdrawal rule.
func (s *server) deletePhoto(w http.ResponseWriter, r *http.Request) (int, any, error) {
	owner, err := requireUser(r)
	if err != nil {
		return 0, nil, err
	}
	id, err := pathID(r)
	if err != nil {
		return 0, nil, err
	}
	ctx := r.Context()
	err = s.inTx(ctx, func(tx *sql.Tx) error {
		var key string
		err := tx.QueryRowContext(ctx, `SELECT original_key FROM photos WHERE id=? AND owner_id=?`, id, owner).Scan(&key)
		if errors.Is(err, sql.ErrNoRows) {
			return httperr.Fail(http.StatusNotFound, msgPhotoAbsent)
		}
		if err != nil {
			return err
		}
		touched, err := stringsOf(ctx, tx, `SELECT DISTINCT f.collection_id FROM frame_photos fp JOIN frames f ON f.id=fp.frame_id
			WHERE fp.photo_id=?`, id)
		if err != nil {
			return err
		}
		before, err := exposedPhotos(ctx, tx, owner)
		if err != nil {
			return err
		}
		// The photo itself is not rotated: its objects are deleted outright.
		delete(before, id)

		if _, err := tx.ExecContext(ctx, `DELETE FROM photos WHERE id=? AND owner_id=?`, id, owner); err != nil {
			return err
		}
		now := s.now()
		for _, cid := range touched {
			if err := pruneFrames(ctx, tx, cid); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `UPDATE collections SET updated_at=? WHERE id=?`, now, cid); err != nil {
				return err
			}
		}
		if _, err := s.q.EnqueueTx(ctx, tx, jobDeletePhotoObjects, map[string]string{
			"photoId": id, "originalKey": key, "derivedPrefix": derivedPrefix(id),
		}); err != nil {
			return err
		}
		return s.withdraw(ctx, tx, owner, before)
	})
	if err != nil {
		return 0, nil, err
	}
	return http.StatusNoContent, nil, nil
}

// pruneFrames deletes frames of a collection left below their slot minimum
// (full/matted with no photo, pair with fewer than 2), compacts the remaining
// slots, renumbers positions densely, and drops a cover or overrides whose
// photo left the collection.
func pruneFrames(ctx context.Context, tx *sql.Tx, cid string) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM frames WHERE collection_id=? AND (
		(layout IN ('full','matted') AND NOT EXISTS (SELECT 1 FROM frame_photos WHERE frame_id=frames.id)) OR
		(layout='pair' AND (SELECT count(*) FROM frame_photos WHERE frame_id=frames.id) < 2))`, cid); err != nil {
		return err
	}
	// A 3-photo pair that lost a photo keeps two of slots 0–2; shift slots
	// down into gaps so they stay dense. slot is CHECKed to 0–2, so no
	// negative staging; a shift never collides because it only targets a
	// free slot, and two passes close every gap left in a 3-slot frame.
	for range 2 {
		if _, err := tx.ExecContext(ctx, `UPDATE frame_photos SET slot=slot-1
			WHERE slot>0 AND frame_id IN (SELECT id FROM frames WHERE collection_id=?)
			AND NOT EXISTS (SELECT 1 FROM frame_photos o WHERE o.frame_id=frame_photos.frame_id AND o.slot=frame_photos.slot-1)`, cid); err != nil {
			return err
		}
	}
	if err := renumberFrames(ctx, tx, cid); err != nil {
		return err
	}
	if err := demoteIfEmpty(ctx, tx, cid); err != nil {
		return err
	}
	return dropDetached(ctx, tx, cid)
}

// renumberFrames makes a collection's positions dense (0..n-1) keeping their
// order. Ranks come from a row_number() snapshot taken before the UPDATE
// writes, so the result does not depend on rowid order; staging through
// negatives avoids UNIQUE(collection_id, position) collisions.
func renumberFrames(ctx context.Context, tx *sql.Tx, cid string) error {
	if _, err := tx.ExecContext(ctx, `UPDATE frames SET position = -1 - n.rn
		FROM (SELECT id, row_number() OVER (ORDER BY position) - 1 AS rn FROM frames WHERE collection_id=?) AS n
		WHERE frames.id = n.id`, cid); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `UPDATE frames SET position = -1 - position WHERE collection_id=? AND position < 0`, cid)
	return err
}

// demoteIfEmpty returns a published collection left with no frames to draft:
// publishing requires at least one frame. The caller's withdrawal pass then
// sees its photos (none remain) as unexposed.
func demoteIfEmpty(ctx context.Context, tx *sql.Tx, cid string) error {
	_, err := tx.ExecContext(ctx, `UPDATE collections SET status='draft'
		WHERE id=? AND status='published' AND NOT EXISTS (SELECT 1 FROM frames WHERE collection_id=?)`, cid, cid)
	return err
}

// derivedPrefix is the derived-bucket prefix holding every rendition of a
// photo, across derived hashes and watermark variants.
func derivedPrefix(id string) string { return "d/" + id + "/" }

func stringsOf(ctx context.Context, q querier, query string, args ...any) ([]string, error) {
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
