package exposure_test

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/timeStarry/frameMark/internal/db"
	"github.com/timeStarry/frameMark/internal/exposure"
)

func TestExposureGrid(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "x.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	if err := db.Migrate(d); err != nil {
		t.Fatal(err)
	}
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := d.Exec(q, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO users(id,email,password,created_at) VALUES('u1','a@x','!',0),('u2','b@x','!',0)`)
	cases := []struct {
		photo, owner, status, vis string
		want                      bool
	}{
		{"p-pub", "u1", "published", "public", true},
		{"p-unl", "u1", "published", "unlisted", true},
		{"p-priv", "u1", "published", "private", false},
		{"p-draft", "u1", "draft", "public", false},
		{"p-other", "u2", "published", "public", true},
	}
	for i, c := range cases {
		exec(`INSERT INTO photos(id,owner_id,status,original_key,original_sha256,original_bytes,format,public_fields,
			histogram_public,original_download,created_at,updated_at) VALUES(?,?,'ready','k',?,1,'jpeg','[]',0,0,0,0)`,
			c.photo, c.owner, c.photo)
		cid, fid := "c"+c.photo, "f"+c.photo
		exec(`INSERT INTO collections(id,owner_id,status,visibility,wall_rank,created_at,updated_at) VALUES(?,?,?,?,?,0,0)`,
			cid, c.owner, c.status, c.vis, i)
		exec(`INSERT INTO frames(id,collection_id,position,layout) VALUES(?,?,0,'full')`, fid, cid)
		exec(`INSERT INTO frame_photos(frame_id,slot,photo_id) VALUES(?,0,?)`, fid, c.photo)
	}
	exec(`INSERT INTO photos(id,owner_id,status,original_key,original_sha256,original_bytes,format,public_fields,
		histogram_public,original_download,created_at,updated_at) VALUES('p-none','u1','ready','k','none',1,'jpeg','[]',0,0,0,0)`)

	ctx := context.Background()
	for _, c := range append(cases, struct {
		photo, owner, status, vis string
		want                      bool
	}{"p-none", "u1", "", "", false}) {
		got, err := exposure.Photo(ctx, d, c.photo)
		if err != nil || got != c.want {
			t.Errorf("Photo(%s) = %v, %v; want %v", c.photo, got, err, c.want)
		}
	}
	set, err := exposure.OwnerPhotos(ctx, d, "u1")
	if err != nil {
		t.Fatal(err)
	}
	if len(set) != 2 {
		t.Fatalf("OwnerPhotos(u1) = %v", set)
	}
	for _, id := range []string{"p-pub", "p-unl"} {
		if _, ok := set[id]; !ok {
			t.Errorf("missing %s", id)
		}
	}
}
