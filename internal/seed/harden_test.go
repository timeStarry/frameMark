package seed_test

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/timeStarry/frameMark/internal/seed"
	"github.com/timeStarry/frameMark/internal/seed/seedtest"
)

// A symlinked images dir is refused even with a trailing slash, which would
// otherwise make Lstat follow the link.
func TestImagesDirSymlinkWithTrailingSlashRejected(t *testing.T) {
	e := newEnv(t)
	m, dir := seedtest.Fixture(t, 8, 2)
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(dir, link); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{link, link + "/", link + "//", link + "/."} {
		if _, err := e.run(m, p, true); !errors.Is(err, seed.ErrInvalid) {
			t.Fatalf("images %q: err = %v, want ErrInvalid", p, err)
		}
	}
	e.assertEmpty()
}

func TestImagesDirTrailingSlashAccepted(t *testing.T) {
	e := newEnv(t)
	m, dir := seedtest.Fixture(t, 8, 2)
	if _, err := e.run(m, dir+"/", false); err != nil {
		t.Fatal(err)
	}
}

func TestMissingImagesDirIsInvalid(t *testing.T) {
	e := newEnv(t)
	m, dir := seedtest.Fixture(t, 8, 2)
	if _, err := e.run(m, filepath.Join(dir, "nope"), true); !errors.Is(err, seed.ErrInvalid) {
		t.Fatalf("err = %v, want ErrInvalid", err)
	}
	f := filepath.Join(dir, "photo-1.jpg")
	if _, err := e.run(m, f, true); !errors.Is(err, seed.ErrInvalid) {
		t.Fatalf("file as images dir: err = %v, want ErrInvalid", err)
	}
	e.assertEmpty()
}

// Drift in an already-seeded row is a conflict, never "unchanged" and never
// a silent repair.
func TestDriftedSeedIsConflict(t *testing.T) {
	m, dir := seedtest.Fixture(t, 8, 2)
	c2 := seed.CollectionID("markr-demo-v1", "coll-2")
	cases := []struct {
		name, tag, sql string
		args           []any
	}{
		{"collection title", "collection:coll-2", `UPDATE collections SET title='edited' WHERE id=?`, []any{c2}},
		{"collection intro", "collection:coll-2", `UPDATE collections SET intro='edited' WHERE id=?`, []any{c2}},
		{"collection frame removed", "collection:coll-2", `DELETE FROM frames WHERE collection_id=? AND position=3`, []any{c2}},
		{"collection frames reordered", "collection:coll-2",
			`UPDATE frame_photos SET photo_id=CASE photo_id WHEN ? THEN ? ELSE ? END
			 WHERE frame_id IN (SELECT id FROM frames WHERE collection_id=? AND position IN (0,1))`,
			[]any{seed.PhotoID("markr-demo-v1", "photo-2"), seed.PhotoID("markr-demo-v1", "photo-4"),
				seed.PhotoID("markr-demo-v1", "photo-2"), c2}},
		{"profile missing", "user:markr-demo", `DELETE FROM profiles WHERE user_id=?`, []any{seed.OwnerID("markr-demo-v1")}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := newEnv(t)
			if _, err := e.run(m, dir, true); err != nil {
				t.Fatal(err)
			}
			e.exec(tc.sql, tc.args...)
			before := e.dump()
			puts, dels, _ := e.st.snapshot()
			for _, apply := range []bool{false, true} {
				r, err := e.run(m, dir, apply)
				if !errors.Is(err, seed.ErrConflict) {
					t.Fatalf("apply=%v err = %v, want ErrConflict", apply, err)
				}
				if r == nil || fmt.Sprint(r.Conflicts) != "["+tc.tag+"]" {
					t.Fatalf("apply=%v report = %+v", apply, r)
				}
			}
			if e.dump() != before {
				t.Fatal("drifted run wrote rows")
			}
			if p, d, _ := e.st.snapshot(); p != puts || d != dels {
				t.Fatal("drifted run touched storage")
			}
		})
	}
}
