package db_test

import (
	"database/sql"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/timeStarry/frameMark/internal/db"
)

func openMigrated(t *testing.T) *sql.DB {
	t.Helper()
	d, err := db.Open(filepath.Join(t.TempDir(), "test.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	if err := db.Migrate(d); err != nil {
		t.Fatal(err)
	}
	return d
}

func userVersion(t *testing.T, d *sql.DB) int {
	t.Helper()
	var uv int
	if err := d.QueryRow(`PRAGMA user_version`).Scan(&uv); err != nil {
		t.Fatal(err)
	}
	return uv
}

func TestMigrateCreatesTables(t *testing.T) {
	d := openMigrated(t)
	var n int
	if err := d.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('users','photos','collections','frames','jobs')`).Scan(&n); err != nil || n != 5 {
		t.Fatalf("expected 5 tables, got %d err=%v", n, err)
	}
	if uv := userVersion(t, d); uv != 1 {
		t.Fatalf("expected user_version 1, got %d", uv)
	}
}

func TestMigrateCreatesEverySpecTable(t *testing.T) {
	d := openMigrated(t)
	tables := []string{
		"users", "sessions", "pending_verifications", "rate_limits",
		"profiles", "upload_prefs",
		"photos", "photo_exif", "photo_histograms",
		"collections", "frames", "frame_photos", "photo_overrides",
		"albums", "album_items", "attributions",
		"jobs",
	}
	for _, name := range tables {
		var got string
		err := d.QueryRow(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, name).Scan(&got)
		if err != nil {
			t.Errorf("table %q missing: %v", name, err)
		}
	}
}

func TestMigrateCreatesSpecIndexes(t *testing.T) {
	d := openMigrated(t)
	// table -> expected indexed column lists (non-PK indexes from spec §4)
	want := map[string][]string{
		"photos":     {"owner_id,created_at", "owner_id,original_sha256"},
		"photo_exif": {"camera_model", "lens_model", "focal_length_mm", "taken_at"},
		"frames":     {"collection_id,position"},
		"jobs":       {"state,run_after"},
		"sessions":   {"user_id", "expires_at", "touched_at"},
		// expiry indexes keep identity pruning off full scans
		"rate_limits":           {"expires_at"},
		"pending_verifications": {"expires_at"},
	}
	for table, idxs := range want {
		have := map[string]bool{}
		rows, err := d.Query(`SELECT name FROM pragma_index_list(?)`, table)
		if err != nil {
			t.Fatal(err)
		}
		var names []string
		for rows.Next() {
			var n string
			if err := rows.Scan(&n); err != nil {
				t.Fatal(err)
			}
			names = append(names, n)
		}
		rows.Close()
		for _, n := range names {
			var cols string
			if err := d.QueryRow(`SELECT group_concat(name, ',') FROM (SELECT name FROM pragma_index_info(?) ORDER BY seqno)`, n).Scan(&cols); err != nil {
				t.Fatal(err)
			}
			have[cols] = true
		}
		for _, cols := range idxs {
			if !have[cols] {
				t.Errorf("%s: missing index on (%s); have %v", table, cols, have)
			}
		}
	}
}

func TestMigrateIsIdempotent(t *testing.T) {
	d := openMigrated(t)
	if err := db.Migrate(d); err != nil {
		t.Fatalf("second Migrate: %v", err)
	}
	if uv := userVersion(t, d); uv != 1 {
		t.Fatalf("expected user_version 1, got %d", uv)
	}
}

func TestOpenPragmas(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "p.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	var fk int
	if err := d.QueryRow(`PRAGMA foreign_keys`).Scan(&fk); err != nil || fk != 1 {
		t.Fatalf("foreign_keys = %d err=%v, want 1", fk, err)
	}
	var mode string
	if err := d.QueryRow(`PRAGMA journal_mode`).Scan(&mode); err != nil || mode != "wal" {
		t.Fatalf("journal_mode = %q err=%v, want wal", mode, err)
	}
	var bt int
	if err := d.QueryRow(`PRAGMA busy_timeout`).Scan(&bt); err != nil || bt != 5000 {
		t.Fatalf("busy_timeout = %d err=%v, want 5000", bt, err)
	}
}

func mustExec(t *testing.T, d *sql.DB, q string, args ...any) {
	t.Helper()
	if _, err := d.Exec(q, args...); err != nil {
		t.Fatalf("%s: %v", q, err)
	}
}

func seedUserAndCollection(t *testing.T, d *sql.DB) {
	t.Helper()
	mustExec(t, d, `INSERT INTO users(id, email, password, created_at) VALUES ('u1','a@example.com','scrypt-v1$x$y',1)`)
	mustExec(t, d, `INSERT INTO collections(id, owner_id, title, intro, status, visibility, wall_rank, created_at, updated_at)
		VALUES ('c1','u1','t','','draft','private',0,1,1)`)
}

func TestCheckRejectsBadValue(t *testing.T) {
	d := openMigrated(t)
	mustExec(t, d, `INSERT INTO users(id, email, password, created_at) VALUES ('u1','a@example.com','p',1)`)
	_, err := d.Exec(`INSERT INTO collections(id, owner_id, title, intro, status, visibility, wall_rank, created_at, updated_at)
		VALUES ('c1','u1','t','','draft','secret',0,1,1)`)
	if err == nil {
		t.Fatal("visibility='secret' accepted, want CHECK failure")
	}
}

func TestSchemaChecks(t *testing.T) {
	d := openMigrated(t)
	seedUserAndCollection(t, d)
	bad := []string{
		`INSERT INTO frames(id, collection_id, position, layout, matte_ratio) VALUES ('f9','c1',9,'matted',0.99)`,
		`INSERT INTO frames(id, collection_id, position, layout) VALUES ('f8','c1',8,'poster')`,
		`INSERT INTO collections(id, owner_id, title, intro, status, visibility, wall_rank, created_at, updated_at, license)
			VALUES ('c2','u1','t','','draft','private',0,1,1,'cc0')`,
		`INSERT INTO collections(id, owner_id, title, intro, status, visibility, wall_rank, created_at, updated_at, distribute)
			VALUES ('c3','u1','t','','draft','private',0,1,1,2)`,
		`INSERT INTO jobs(id, kind, payload, state, run_after, created_at) VALUES ('j1','k','not json','queued',0,0)`,
		`INSERT INTO profiles(user_id, name, bio, wall_layout, updated_at) VALUES ('u1','n','b','masonry',1)`,
	}
	for _, q := range bad {
		if _, err := d.Exec(q); err == nil {
			t.Errorf("accepted, want CHECK failure: %s", q)
		}
	}
	mustExec(t, d, `INSERT INTO frames(id, collection_id, position, layout) VALUES ('f1','c1',0,'text')`)
	mustExec(t, d, `INSERT INTO photos(id, owner_id, status, original_key, original_sha256, original_bytes, format,
		public_fields, histogram_public, original_download, created_at, updated_at)
		VALUES ('p1','u1','uploading','o/u1/p1','abc',1,'jpeg','[]',0,0,1,1)`)
	mustExec(t, d, `INSERT INTO frame_photos(frame_id, slot, photo_id) VALUES ('f1',2,'p1')`)
	if _, err := d.Exec(`INSERT INTO frame_photos(frame_id, slot, photo_id) VALUES ('f1',3,'p1')`); err == nil {
		t.Error("frame_photos slot=3 accepted")
	}
}

func TestForeignKeyEnforced(t *testing.T) {
	d := openMigrated(t)
	_, err := d.Exec(`INSERT INTO frames(id, collection_id, position, layout) VALUES ('f1','nope',0,'full')`)
	if err == nil {
		t.Fatal("frame with nonexistent collection accepted, want FK failure")
	}
}

func TestDeleteCollectionCascadesFrames(t *testing.T) {
	d := openMigrated(t)
	seedUserAndCollection(t, d)
	mustExec(t, d, `INSERT INTO frames(id, collection_id, position, layout) VALUES ('f1','c1',0,'text')`)
	mustExec(t, d, `INSERT INTO frames(id, collection_id, position, layout) VALUES ('f2','c1',1,'text')`)
	mustExec(t, d, `DELETE FROM collections WHERE id='c1'`)
	var n int
	if err := d.QueryRow(`SELECT COUNT(*) FROM frames`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("frames after cascade = %d err=%v, want 0", n, err)
	}
}

// seedGraph creates one of each row so every cascade case can delete a parent.
func seedGraph(t *testing.T, d *sql.DB) {
	t.Helper()
	mustExec(t, d, `INSERT INTO users(id, email, password, created_at) VALUES ('u1','a@example.com','p',1)`)
	mustExec(t, d, `INSERT INTO users(id, email, password, created_at) VALUES ('u2','b@example.com','p',1)`)
	// Photo owned by u2 so deleting u1 is not blocked by photos.owner_id.
	mustExec(t, d, `INSERT INTO photos(id, owner_id, status, original_key, original_sha256, original_bytes, format,
		public_fields, histogram_public, original_download, created_at, updated_at)
		VALUES ('p1','u2','ready','o/u2/p1','abc',1,'jpeg','[]',0,0,1,1)`)
	mustExec(t, d, `INSERT INTO photo_histograms(photo_id, bins) VALUES ('p1', x'00')`)
	mustExec(t, d, `INSERT INTO attributions(photo_id, source) VALUES ('p1', '{}')`)
	mustExec(t, d, `INSERT INTO collections(id, owner_id, title, intro, status, visibility, wall_rank, created_at, updated_at)
		VALUES ('c1','u1','t','','draft','private',0,1,1)`)
	mustExec(t, d, `INSERT INTO frames(id, collection_id, position, layout) VALUES ('f1','c1',0,'full')`)
	mustExec(t, d, `INSERT INTO frame_photos(frame_id, slot, photo_id) VALUES ('f1',0,'p1')`)
	mustExec(t, d, `INSERT INTO photo_overrides(collection_id, photo_id) VALUES ('c1','p1')`)
	mustExec(t, d, `INSERT INTO albums(id, owner_id, title, intro, visibility, created_at, updated_at)
		VALUES ('a1','u1','t','','private',1,1)`)
	mustExec(t, d, `INSERT INTO album_items(album_id, position, collection_id) VALUES ('a1',0,'c1')`)
}

func TestForeignKeysCascade(t *testing.T) {
	cases := []struct {
		name, deleteSQL, child string
	}{
		{"photo_histograms.photo_id", `DELETE FROM photos WHERE id='p1'`, "photo_histograms"},
		{"attributions.photo_id", `DELETE FROM photos WHERE id='p1'`, "attributions"},
		{"frame_photos.photo_id", `DELETE FROM photos WHERE id='p1'`, "frame_photos"},
		{"photo_overrides.photo_id", `DELETE FROM photos WHERE id='p1'`, "photo_overrides"},
		{"photo_overrides.collection_id", `DELETE FROM collections WHERE id='c1'`, "photo_overrides"},
		{"album_items.album_id", `DELETE FROM albums WHERE id='a1'`, "album_items"},
		{"album_items.collection_id", `DELETE FROM collections WHERE id='c1'`, "album_items"},
		{"collections.owner_id", `DELETE FROM users WHERE id='u1'`, "collections"},
		{"albums.owner_id", `DELETE FROM users WHERE id='u1'`, "albums"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := openMigrated(t)
			seedGraph(t, d)
			var before int
			if err := d.QueryRow(`SELECT COUNT(*) FROM ` + tc.child).Scan(&before); err != nil || before != 1 {
				t.Fatalf("%s before delete = %d err=%v, want 1", tc.child, before, err)
			}
			mustExec(t, d, tc.deleteSQL)
			var after int
			if err := d.QueryRow(`SELECT COUNT(*) FROM ` + tc.child).Scan(&after); err != nil || after != 0 {
				t.Fatalf("%s after delete = %d err=%v, want 0", tc.child, after, err)
			}
		})
	}
}

func TestDeleteCoverPhotoClearsCover(t *testing.T) {
	d := openMigrated(t)
	seedGraph(t, d)
	mustExec(t, d, `UPDATE collections SET cover_photo_id='p1' WHERE id='c1'`)
	mustExec(t, d, `DELETE FROM photos WHERE id='p1'`)
	var cover sql.NullString
	if err := d.QueryRow(`SELECT cover_photo_id FROM collections WHERE id='c1'`).Scan(&cover); err != nil {
		t.Fatal(err)
	}
	if cover.Valid {
		t.Fatalf("cover_photo_id = %q, want NULL", cover.String)
	}
}

// With _txlock=immediate a transaction holds the write lock from BEGIN, so
// another connection's write waits (here: until busy_timeout) even while the
// transaction has only read.
func TestTransactionsBeginImmediate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.sqlite")
	d1, err := db.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer d1.Close()
	if err := db.Migrate(d1); err != nil {
		t.Fatal(err)
	}
	// Second connection with a short busy_timeout so the expected lock
	// failure surfaces in ~50ms instead of the production 5s.
	d2, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(50)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_txlock=immediate")
	if err != nil {
		t.Fatal(err)
	}
	d2.SetMaxOpenConns(1)
	defer d2.Close()

	tx, err := d1.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	var n int
	if err := tx.QueryRow(`SELECT count(*) FROM users`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if _, err := d2.Exec(`INSERT INTO users(id,email,password,created_at) VALUES('u','a@example.test','x',0)`); err == nil {
		t.Fatal("write succeeded while another transaction held BEGIN IMMEDIATE")
	}
}
