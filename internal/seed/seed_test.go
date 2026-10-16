package seed_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/timeStarry/frameMark/internal/api"
	"github.com/timeStarry/frameMark/internal/cdn"
	"github.com/timeStarry/frameMark/internal/config"
	"github.com/timeStarry/frameMark/internal/db"
	"github.com/timeStarry/frameMark/internal/identity"
	"github.com/timeStarry/frameMark/internal/jobs"
	"github.com/timeStarry/frameMark/internal/seed"
	"github.com/timeStarry/frameMark/internal/seed/seedtest"
	"github.com/timeStarry/frameMark/internal/storage"
	"github.com/timeStarry/frameMark/internal/worker"
)

const (
	t0     = int64(1_700_000_000_000)
	origB  = "originals"
	derB   = "derived"
	origin = "http://localhost:8080"
)

// --- fake storage: satisfies seed.Storage, worker.Storage and api.Storage ---

type object struct {
	body []byte
	ct   string
}

type fakeStore struct {
	mu      sync.Mutex
	objects map[string]object // bucket + "/" + key
	puts    int
	deleted []string
	putErr  func(bucket, key string) error
}

func newStore() *fakeStore { return &fakeStore{objects: map[string]object{}} }

func (f *fakeStore) Put(_ context.Context, bucket, key string, body []byte, ct, _ string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.putErr != nil {
		if err := f.putErr(bucket, key); err != nil {
			return err
		}
	}
	f.puts++
	f.objects[bucket+"/"+key] = object{body: append([]byte(nil), body...), ct: ct}
	return nil
}

func (f *fakeStore) Delete(_ context.Context, bucket, key string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.objects, bucket+"/"+key)
	f.deleted = append(f.deleted, bucket+"/"+key)
	return nil
}

func (f *fakeStore) Get(_ context.Context, bucket, key string, maxBytes int64) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	o, ok := f.objects[bucket+"/"+key]
	if !ok {
		return nil, storage.ErrNotFound
	}
	if int64(len(o.body)) > maxBytes {
		return nil, storage.ErrTooLarge
	}
	return append([]byte(nil), o.body...), nil
}

func (f *fakeStore) DeletePrefix(_ context.Context, bucket, prefix string) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for k := range f.objects {
		if strings.HasPrefix(k, bucket+"/"+prefix) {
			delete(f.objects, k)
			n++
		}
	}
	return n, nil
}

func (f *fakeStore) List(_ context.Context, bucket, prefix string) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for k := range f.objects {
		if strings.HasPrefix(k, bucket+"/"+prefix) {
			out = append(out, strings.TrimPrefix(k, bucket+"/"))
		}
	}
	sort.Strings(out)
	return out, nil
}

func (f *fakeStore) PresignPut(context.Context, string, string, string, string, time.Duration) (storage.PresignedRequest, error) {
	return storage.PresignedRequest{}, errors.New("fake: presign put not used")
}

func (f *fakeStore) Head(_ context.Context, bucket, key string) (storage.Object, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	o, ok := f.objects[bucket+"/"+key]
	if !ok {
		return storage.Object{}, storage.ErrNotFound
	}
	return storage.Object{Size: int64(len(o.body)), ContentType: o.ct}, nil
}

func (f *fakeStore) PresignGet(_ context.Context, bucket, key string, _ time.Duration, _ string) (string, error) {
	return "https://storage.test/" + bucket + "/" + key, nil
}

func (f *fakeStore) snapshot() (int, int, []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	keys := make([]string, 0, len(f.objects))
	for k := range f.objects {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return f.puts, len(f.deleted), keys
}

// --- env ---

type env struct {
	t   *testing.T
	d   *sql.DB
	st  *fakeStore
	cfg config.Config
}

func newEnv(t *testing.T) *env {
	t.Helper()
	d, err := db.Open(filepath.Join(t.TempDir(), "markr.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	if err := db.Migrate(d); err != nil {
		t.Fatal(err)
	}
	return &env{t: t, d: d, st: newStore(), cfg: config.Config{
		Origin: origin, Dev: true, IdentityOn: true,
		BucketOriginals: origB, BucketDerived: derB, UploadMaxMB: 60, QuotaPhotos: 2000, Workers: 1,
	}}
}

func (e *env) run(manifest map[string]any, images string, apply bool) (*seed.Report, error) {
	e.t.Helper()
	return e.runPath(seedtest.WriteManifest(e.t, manifest), images, apply)
}

func (e *env) runPath(path, images string, apply bool) (*seed.Report, error) {
	e.t.Helper()
	return seed.Run(context.Background(), seed.Deps{DB: e.d, Storage: e.st, Cfg: e.cfg, Now: func() int64 { return t0 }},
		path, images, apply)
}

func (e *env) exec(q string, args ...any) {
	e.t.Helper()
	if _, err := e.d.Exec(q, args...); err != nil {
		e.t.Fatal(err)
	}
}

var tables = []string{"users", "sessions", "profiles", "upload_prefs", "photos", "photo_exif", "photo_histograms",
	"collections", "frames", "frame_photos", "photo_overrides", "albums", "album_items", "attributions", "jobs"}

// dump renders every row of every table, so two dumps are equal exactly when
// nothing was written in between.
func (e *env) dump() string {
	e.t.Helper()
	var b strings.Builder
	for _, tbl := range tables {
		rows, err := e.d.Query(`SELECT * FROM ` + tbl + ` ORDER BY rowid`)
		if err != nil {
			e.t.Fatal(err)
		}
		cols, _ := rows.Columns()
		for rows.Next() {
			vals := make([]any, len(cols))
			ptrs := make([]any, len(cols))
			for i := range vals {
				ptrs[i] = &vals[i]
			}
			if err := rows.Scan(ptrs...); err != nil {
				e.t.Fatal(err)
			}
			fmt.Fprintf(&b, "%s %v\n", tbl, vals)
		}
		rows.Close()
	}
	return b.String()
}

func (e *env) count(q string, args ...any) int {
	e.t.Helper()
	var n int
	if err := e.d.QueryRow(q, args...).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

// assertNoWrites checks the DB is still empty and storage untouched.
func (e *env) assertEmpty() {
	e.t.Helper()
	for _, tbl := range tables {
		if n := e.count(`SELECT count(*) FROM ` + tbl); n != 0 {
			e.t.Errorf("%s has %d rows", tbl, n)
		}
	}
	if _, _, keys := e.st.snapshot(); len(keys) != 0 {
		e.t.Errorf("storage objects = %v", keys)
	}
}

func sorted(s []string) []string { s = append([]string(nil), s...); sort.Strings(s); return s }

func expectCreated(m map[string]any) []string {
	out := []string{"user:markr-demo"}
	for i := range m["photos"].([]any) {
		out = append(out, "photo:"+seedtest.Photo(m, i)["id"].(string))
	}
	for j := range m["collections"].([]any) {
		out = append(out, "collection:"+seedtest.Collection(m, j)["id"].(string))
	}
	return sorted(out)
}

// --- tests ---

func TestIDsAreDeterministic(t *testing.T) {
	if seed.OwnerID("markr-demo-v1") != seed.OwnerID("markr-demo-v1") ||
		seed.PhotoID("markr-demo-v1", "a") != seed.PhotoID("markr-demo-v1", "a") ||
		seed.PhotoID("markr-demo-v1", "a") == seed.PhotoID("markr-demo-v1", "b") ||
		seed.PhotoID("markr-demo-v1", "a") == seed.CollectionID("markr-demo-v1", "a") ||
		seed.OwnerID("markr-demo-v1") == seed.OwnerID("markr-demo-v2") {
		t.Fatal("ids are not deterministic and distinct")
	}
	if !regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).MatchString(seed.OwnerID("markr-demo-v1")) {
		t.Fatalf("owner id %q is not a canonical uuid v5", seed.OwnerID("markr-demo-v1"))
	}
}

func TestDryRunWritesNothing(t *testing.T) {
	e := newEnv(t)
	m, dir := seedtest.Fixture(t, 8, 2)
	r, err := e.run(m, dir, false)
	if err != nil {
		t.Fatal(err)
	}
	if r.Mode != "dry-run" || r.Photos != 8 || r.Collections != 2 {
		t.Fatalf("report = %+v", r)
	}
	if got, want := sorted(r.Created), expectCreated(m); fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("created = %v, want %v", got, want)
	}
	if len(r.Unchanged) != 0 || len(r.Conflicts) != 0 {
		t.Fatalf("report = %+v", r)
	}
	e.assertEmpty()
	if puts, dels, _ := e.st.snapshot(); puts != 0 || dels != 0 {
		t.Fatalf("storage calls: puts=%d deletes=%d", puts, dels)
	}
}

func TestApplyCreatesRowsAndJobs(t *testing.T) {
	e := newEnv(t)
	m, dir := seedtest.Fixture(t, 8, 2)
	path := seedtest.WriteManifest(t, m)
	r, err := e.runPath(path, dir, true)
	if err != nil {
		t.Fatal(err)
	}
	if r.Mode != "apply" || fmt.Sprint(sorted(r.Created)) != fmt.Sprint(expectCreated(m)) {
		t.Fatalf("report = %+v", r)
	}
	owner := seed.OwnerID("markr-demo-v1")

	// user + profile
	var email, pw string
	if err := e.d.QueryRow(`SELECT email,password FROM users WHERE id=?`, owner).Scan(&email, &pw); err != nil {
		t.Fatal(err)
	}
	if email != "markr-demo@invalid" || !strings.HasPrefix(pw, "!") || len(pw) != 44 {
		t.Fatalf("user = %q %q", email, pw)
	}
	var name, bio, layout string
	if err := e.d.QueryRow(`SELECT name,bio,wall_layout FROM profiles WHERE user_id=?`, owner).Scan(&name, &bio, &layout); err != nil {
		t.Fatal(err)
	}
	prof := m["profile"].(map[string]any)
	if name != prof["name"] || bio != prof["bio"] || layout != "grid" {
		t.Fatalf("profile = %q %q %q", name, bio, layout)
	}
	if n := e.count(`SELECT count(*) FROM upload_prefs`); n != 0 {
		t.Fatalf("upload_prefs rows = %d (worker must see defaults: location off)", n)
	}

	// raw source JSON exactly as written in the manifest file
	var raw struct {
		Photos []struct {
			Source json.RawMessage `json:"source"`
		} `json:"photos"`
	}
	fileBytes, _ := os.ReadFile(path)
	if err := json.Unmarshal(fileBytes, &raw); err != nil {
		t.Fatal(err)
	}

	salts := map[string]bool{}
	for i := 0; i < 8; i++ {
		p := seedtest.Photo(m, i)
		id := seed.PhotoID("markr-demo-v1", p["id"].(string))
		var (
			pOwner, status, key, sha, format, title, caption, fields, salt string
			bytesN                                                         int64
			hist, orig                                                     int
			hash                                                           sql.NullString
		)
		err := e.d.QueryRow(`SELECT owner_id,status,original_key,original_sha256,original_bytes,format,title,caption,
			public_fields,histogram_public,original_download,derived_salt,derived_hash FROM photos WHERE id=?`, id).
			Scan(&pOwner, &status, &key, &sha, &bytesN, &format, &title, &caption, &fields, &hist, &orig, &salt, &hash)
		if err != nil {
			t.Fatalf("photo %d: %v", i, err)
		}
		body, _ := os.ReadFile(filepath.Join(dir, p["file"].(string)))
		if pOwner != owner || status != "processing" || key != "o/"+owner+"/"+id || sha != p["sha256"] ||
			bytesN != int64(len(body)) || format != "jpeg" || title != p["title"] || caption != p["text"] ||
			fields != `["aperture","shutter","iso","focal_length"]` || hist != 1 || orig != 0 || hash.Valid {
			t.Fatalf("photo %d row: %s %s %s %s %d %s %q %q %s %d %d %v", i, pOwner, status, key, sha, bytesN, format, title, caption, fields, hist, orig, hash)
		}
		if !regexp.MustCompile(`^[0-9a-f]{32}$`).MatchString(salt) || salts[salt] {
			t.Fatalf("photo %d salt %q", i, salt)
		}
		salts[salt] = true

		o, ok := e.st.objects[origB+"/"+key]
		if !ok || !bytes.Equal(o.body, body) || o.ct != "image/jpeg" {
			t.Fatalf("photo %d object missing or wrong: ok=%v ct=%q", i, ok, o.ct)
		}

		var src string
		if err := e.d.QueryRow(`SELECT source FROM attributions WHERE photo_id=?`, id).Scan(&src); err != nil {
			t.Fatal(err)
		}
		if src != string(raw.Photos[i].Source) {
			t.Fatalf("photo %d attribution rewritten:\n got %s\nwant %s", i, src, raw.Photos[i].Source)
		}
		if n := e.count(`SELECT count(*) FROM jobs WHERE kind='process_photo' AND state='queued' AND json_extract(payload,'$.photoId')=?`, id); n != 1 {
			t.Fatalf("photo %d process jobs = %d", i, n)
		}
	}
	if n := e.count(`SELECT count(*) FROM jobs`); n != 8 {
		t.Fatalf("jobs = %d", n)
	}

	// collections: coll-1 holds photo-1,3,5,7 (photo-1 featured), coll-2 holds 2,4,6,8 (photo-2 is the profile cover)
	for j, want := range []struct {
		members  []string
		featured sql.NullInt64
		cover    string
	}{
		{[]string{"photo-1", "photo-3", "photo-5", "photo-7"}, sql.NullInt64{Int64: 1, Valid: true}, "photo-1"},
		{[]string{"photo-2", "photo-4", "photo-6", "photo-8"}, sql.NullInt64{}, "photo-2"},
	} {
		c := seedtest.Collection(m, j)
		cid := seed.CollectionID("markr-demo-v1", c["id"].(string))
		var (
			cOwner, title, intro, status, vis string
			dist, orig, wall                  int
			lic, ai                           sql.NullString
			cover                             sql.NullString
			featured                          sql.NullInt64
			pub                               sql.NullInt64
		)
		err := e.d.QueryRow(`SELECT owner_id,title,intro,status,visibility,distribute,original_download,license,ai_declaration,
			cover_photo_id,featured_rank,wall_rank,published_at FROM collections WHERE id=?`, cid).
			Scan(&cOwner, &title, &intro, &status, &vis, &dist, &orig, &lic, &ai, &cover, &featured, &wall, &pub)
		if err != nil {
			t.Fatalf("collection %d: %v", j, err)
		}
		if cOwner != owner || title != c["title"] || intro != c["text"] || status != "published" || vis != "public" ||
			dist != 1 || orig != 0 || lic.Valid || ai.Valid || featured != want.featured || wall != j+1 || !pub.Valid ||
			cover.String != seed.PhotoID("markr-demo-v1", want.cover) {
			t.Fatalf("collection %d row: %s %q %q %s %s %d %d %v %v %v %v %d %v", j, cOwner, title, intro, status, vis, dist, orig, lic, ai, cover, featured, wall, pub)
		}
		rows, err := e.d.Query(`SELECT f.position,f.layout,f.matte_ratio,f.text,fp.slot,fp.photo_id FROM frames f
			JOIN frame_photos fp ON fp.frame_id=f.id WHERE f.collection_id=? ORDER BY f.position`, cid)
		if err != nil {
			t.Fatal(err)
		}
		var got []string
		for rows.Next() {
			var pos, slot int
			var layout, pid string
			var ratio sql.NullFloat64
			var text sql.NullString
			if err := rows.Scan(&pos, &layout, &ratio, &text, &slot, &pid); err != nil {
				t.Fatal(err)
			}
			if pos != len(got) || layout != "full" || ratio.Valid || text.Valid || slot != 0 {
				t.Fatalf("frame %d: %d %s %v %v %d", len(got), pos, layout, ratio, text, slot)
			}
			got = append(got, pid)
		}
		rows.Close()
		var wantIDs []string
		for _, p := range want.members {
			wantIDs = append(wantIDs, seed.PhotoID("markr-demo-v1", p))
		}
		if fmt.Sprint(got) != fmt.Sprint(wantIDs) {
			t.Fatalf("collection %d frames = %v, want %v", j, got, wantIDs)
		}
		if n := e.count(`SELECT count(*) FROM frames WHERE collection_id=?`, cid); n != len(want.members) {
			t.Fatalf("frames = %d", n)
		}
	}
	// The first manifest collection is newest, so the square lists manifest order.
	var p1, p2 int64
	e.d.QueryRow(`SELECT published_at FROM collections WHERE id=?`, seed.CollectionID("markr-demo-v1", "coll-1")).Scan(&p1)
	e.d.QueryRow(`SELECT published_at FROM collections WHERE id=?`, seed.CollectionID("markr-demo-v1", "coll-2")).Scan(&p2)
	if p1 <= p2 {
		t.Fatalf("published_at order %d <= %d", p1, p2)
	}
}

func TestReapplyIsUnchanged(t *testing.T) {
	e := newEnv(t)
	m, dir := seedtest.Fixture(t, 8, 2)
	if _, err := e.run(m, dir, true); err != nil {
		t.Fatal(err)
	}
	before := e.dump()
	puts, dels, keys := e.st.snapshot()

	for _, apply := range []bool{false, true} {
		r, err := e.run(m, dir, apply)
		if err != nil {
			t.Fatal(err)
		}
		if len(r.Created) != 0 || len(r.Conflicts) != 0 || fmt.Sprint(sorted(r.Unchanged)) != fmt.Sprint(expectCreated(m)) {
			t.Fatalf("apply=%v report = %+v", apply, r)
		}
	}
	if after := e.dump(); after != before {
		t.Fatalf("re-apply wrote rows:\n%s\n---\n%s", before, after)
	}
	if p, d, k := e.st.snapshot(); p != puts || d != dels || fmt.Sprint(k) != fmt.Sprint(keys) {
		t.Fatalf("re-apply touched storage: puts %d->%d deletes %d->%d", puts, p, dels, d)
	}
}

func TestSHAMismatchRejected(t *testing.T) {
	e := newEnv(t)
	m, dir := seedtest.Fixture(t, 8, 2)
	seedtest.Photo(m, 3)["sha256"] = seedtest.SHA([]byte("other"))
	_, err := e.run(m, dir, true)
	if !errors.Is(err, seed.ErrInvalid) {
		t.Fatalf("err = %v", err)
	}
	e.assertEmpty()
}

func TestConflictingPhotoRejected(t *testing.T) {
	e := newEnv(t)
	m, dir := seedtest.Fixture(t, 8, 2)
	if _, err := e.run(m, dir, true); err != nil {
		t.Fatal(err)
	}
	before := e.dump()
	puts, _, _ := e.st.snapshot()

	// Same manifest id, different bytes: a conflict, and no writes at all.
	body := seedtest.JPEG(t, 99)
	if err := os.WriteFile(filepath.Join(dir, "photo-3.jpg"), body, 0o600); err != nil {
		t.Fatal(err)
	}
	seedtest.Photo(m, 2)["sha256"] = seedtest.SHA(body)
	// A new photo in the same run must not be written either.
	m2, dir2 := seedtest.Fixture(t, 9, 2)
	_ = dir2
	extra := seedtest.Photo(m2, 8)
	b9, _ := os.ReadFile(filepath.Join(dir2, "photo-9.jpg"))
	os.WriteFile(filepath.Join(dir, "photo-9.jpg"), b9, 0o600)
	m["photos"] = append(m["photos"].([]any), extra)
	c := seedtest.Collection(m, 0)
	c["photos"] = append(c["photos"].([]any), "photo-9")

	for _, apply := range []bool{false, true} {
		r, err := e.run(m, dir, apply)
		if !errors.Is(err, seed.ErrConflict) {
			t.Fatalf("apply=%v err = %v", apply, err)
		}
		if r == nil || fmt.Sprint(r.Conflicts) != "[photo:photo-3]" {
			t.Fatalf("report = %+v", r)
		}
	}
	if e.dump() != before {
		t.Fatal("conflicting run wrote rows")
	}
	if p, _, _ := e.st.snapshot(); p != puts {
		t.Fatal("conflicting run wrote objects")
	}
}

func TestConflictingCollectionAndUserRejected(t *testing.T) {
	m, dir := seedtest.Fixture(t, 8, 2)
	t.Run("collection owned by someone else", func(t *testing.T) {
		e := newEnv(t)
		e.exec(`INSERT INTO users(id,email,password,created_at) VALUES('u-other','other@example.test','x',1)`)
		e.exec(`INSERT INTO collections(id,owner_id,status,visibility,wall_rank,created_at,updated_at)
			VALUES(?,'u-other','draft','private',1,1,1)`, seed.CollectionID("markr-demo-v1", "coll-2"))
		before := e.dump()
		r, err := e.run(m, dir, true)
		if !errors.Is(err, seed.ErrConflict) || r == nil || fmt.Sprint(r.Conflicts) != "[collection:coll-2]" {
			t.Fatalf("err = %v report = %+v", err, r)
		}
		if e.dump() != before {
			t.Fatal("wrote rows")
		}
		if p, _, _ := e.st.snapshot(); p != 0 {
			t.Fatal("wrote objects")
		}
	})
	t.Run("owner id with another email", func(t *testing.T) {
		e := newEnv(t)
		e.exec(`INSERT INTO users(id,email,password,created_at) VALUES(?,'someone@example.test','x',1)`, seed.OwnerID("markr-demo-v1"))
		r, err := e.run(m, dir, true)
		if !errors.Is(err, seed.ErrConflict) || r == nil || fmt.Sprint(r.Conflicts) != "[user:markr-demo]" {
			t.Fatalf("err = %v report = %+v", err, r)
		}
	})
	t.Run("demo email taken by another id", func(t *testing.T) {
		e := newEnv(t)
		e.exec(`INSERT INTO users(id,email,password,created_at) VALUES('u-x','markr-demo@invalid','x',1)`)
		r, err := e.run(m, dir, true)
		if !errors.Is(err, seed.ErrConflict) || r == nil || fmt.Sprint(r.Conflicts) != "[user:markr-demo]" {
			t.Fatalf("err = %v report = %+v", err, r)
		}
	})
}

func TestValidationRules(t *testing.T) {
	type mut func(t *testing.T, m map[string]any, dir string)
	src := func(i int, k string, v any) mut {
		return func(_ *testing.T, m map[string]any, _ string) { seedtest.Source(m, i)[k] = v }
	}
	photo := func(i int, k string, v any) mut {
		return func(_ *testing.T, m map[string]any, _ string) { seedtest.Photo(m, i)[k] = v }
	}
	writeFile := func(name string, body []byte) func(t *testing.T, dir string) {
		return func(t *testing.T, dir string) {
			if err := os.WriteFile(filepath.Join(dir, name), body, 0o600); err != nil {
				t.Fatal(err)
			}
		}
	}
	long := strings.Repeat("长", 2001)
	cases := []struct {
		name string
		n, c int
		mut  mut
	}{
		{"7 photos", 7, 2, nil},
		{"13 photos", 13, 3, nil},
		{"1 collection", 8, 1, nil},
		{"4 collections", 8, 4, nil},
		{"version", 8, 2, func(_ *testing.T, m map[string]any, _ string) { m["version"] = 2 }},
		{"seed", 8, 2, func(_ *testing.T, m map[string]any, _ string) { m["seed"] = "other" }},
		{"owner", 8, 2, func(_ *testing.T, m map[string]any, _ string) { m["owner"] = "admin" }},
		{"profile name", 8, 2, func(_ *testing.T, m map[string]any, _ string) { m["profile"].(map[string]any)["name"] = "Someone" }},
		{"profile layout", 8, 2, func(_ *testing.T, m map[string]any, _ string) { m["profile"].(map[string]any)["layout"] = "x" }},
		{"profile cover", 8, 2, func(_ *testing.T, m map[string]any, _ string) { m["profile"].(map[string]any)["cover"] = "nope" }},
		{"sha mismatch", 8, 2, photo(0, "sha256", strings.Repeat("0", 64))},
		{"sha not hex", 8, 2, photo(0, "sha256", "XYZ")},
		{"file with slash", 8, 2, photo(0, "file", "sub/photo-1.jpg")},
		{"file traversal", 8, 2, photo(0, "file", "../photo-1.jpg")},
		{"file dotdot", 8, 2, photo(0, "file", "..")},
		{"file absolute", 8, 2, photo(0, "file", "/etc/passwd")},
		{"file missing", 8, 2, photo(0, "file", "absent.jpg")},
		{"file wrong extension", 8, 2, photo(0, "file", "photo-1.gif")},
		{"duplicate file", 8, 2, photo(1, "file", "photo-1.jpg")},
		{"duplicate photo id", 8, 2, photo(1, "id", "photo-1")},
		{"symlink escaping dir", 8, 2, func(t *testing.T, m map[string]any, dir string) {
			outside := filepath.Join(t.TempDir(), "secret.jpg")
			body := seedtest.JPEG(t, 50)
			os.WriteFile(outside, body, 0o600)
			if err := os.Symlink(outside, filepath.Join(dir, "link.jpg")); err != nil {
				t.Fatal(err)
			}
			seedtest.Photo(m, 0)["file"] = "link.jpg"
			seedtest.Photo(m, 0)["sha256"] = seedtest.SHA(body)
		}},
		{"not an image", 8, 2, func(t *testing.T, m map[string]any, dir string) {
			body := []byte("GIF89a not supported")
			writeFile("photo-1.jpg", body)(t, dir)
			seedtest.Photo(m, 0)["sha256"] = seedtest.SHA(body)
		}},
		{"file over 5 MiB", 8, 2, func(t *testing.T, m map[string]any, dir string) {
			body := append(seedtest.JPEG(t, 1), make([]byte, 5<<20)...)
			writeFile("photo-1.jpg", body)(t, dir)
			seedtest.Photo(m, 0)["sha256"] = seedtest.SHA(body)
		}},
		{"total over 35 MiB", 8, 2, func(t *testing.T, m map[string]any, dir string) {
			for i := 0; i < 8; i++ {
				body := append(seedtest.JPEG(t, i+1), make([]byte, 4<<20+600<<10)...)
				writeFile(fmt.Sprintf("photo-%d.jpg", i+1), body)(t, dir)
				seedtest.Photo(m, i)["sha256"] = seedtest.SHA(body)
			}
		}},
		{"source page host", 8, 2, src(0, "sourcePage", "https://example.com/wiki/File:X.jpg")},
		{"source page path", 8, 2, src(0, "sourcePage", "https://commons.wikimedia.org/wiki/Category:X")},
		{"source page http", 8, 2, src(0, "sourcePage", "http://commons.wikimedia.org/wiki/File:X.jpg")},
		{"source page userinfo", 8, 2, src(0, "sourcePage", "https://a:b@commons.wikimedia.org/wiki/File:X.jpg")},
		{"source page port", 8, 2, src(0, "sourcePage", "https://commons.wikimedia.org:8443/wiki/File:X.jpg")},
		{"source page duplicate", 8, 2, src(1, "sourcePage", "https://commons.wikimedia.org/wiki/File:Photo_1.jpg")},
		{"download host", 8, 2, src(0, "downloadURL", "https://evil.example/x.jpg")},
		{"license url host", 8, 2, src(0, "licenseURL", "https://example.com/publicdomain/zero/1.0/")},
		{"license name", 8, 2, src(0, "licenseName", "CC BY-NC 4.0")},
		{"license name/url mismatch", 8, 2, src(0, "licenseURL", "https://creativecommons.org/licenses/by/4.0/")},
		{"source author empty", 8, 2, src(0, "author", "")},
		{"source changes too long", 8, 2, src(0, "changes", long)},
		{"photo text too long", 8, 2, photo(0, "text", long)},
		{"photo title too long", 8, 2, photo(0, "title", strings.Repeat("t", 121))},
		{"collection text too long", 8, 2, func(_ *testing.T, m map[string]any, _ string) { seedtest.Collection(m, 0)["text"] = long }},
		{"photo collection unknown", 8, 2, photo(0, "collection", "nowhere")},
		{"collection member mismatch", 8, 2, photo(0, "collection", "coll-2")},
		{"photo in no collection", 8, 2, func(_ *testing.T, m map[string]any, _ string) {
			c := seedtest.Collection(m, 0)
			c["photos"] = c["photos"].([]any)[1:]
		}},
		{"two featured", 8, 2, photo(1, "featuredRank", 1)},
		{"featured rank 2", 8, 2, photo(0, "featuredRank", 2)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := newEnv(t)
			m, dir := seedtest.Fixture(t, tc.n, tc.c)
			if tc.mut != nil {
				tc.mut(t, m, dir)
			}
			_, err := e.run(m, dir, true)
			if !errors.Is(err, seed.ErrInvalid) {
				t.Fatalf("err = %v, want ErrInvalid", err)
			}
			e.assertEmpty()
		})
	}
}

func TestBadManifestFileRejected(t *testing.T) {
	e := newEnv(t)
	_, dir := seedtest.Fixture(t, 8, 2)
	p := filepath.Join(t.TempDir(), "m.json")
	os.WriteFile(p, []byte(`{"version":1,`), 0o600)
	if _, err := e.runPath(p, dir, true); !errors.Is(err, seed.ErrInvalid) {
		t.Fatalf("err = %v", err)
	}
	if _, err := e.runPath(filepath.Join(dir, "absent.json"), dir, true); err == nil {
		t.Fatal("missing manifest accepted")
	}
	m, _ := seedtest.Fixture(t, 8, 2)
	if _, err := e.run(m, filepath.Join(dir, "nope"), true); err == nil {
		t.Fatal("missing images dir accepted")
	}
	e.assertEmpty()
}

// The vetted repository manifest passes schema validation (its images are
// not on this machine, so only the manifest itself is checked).
func TestRepositoryManifestIsValid(t *testing.T) {
	b, err := os.ReadFile("../../ops/demo/manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := seed.ValidateManifest(b); err != nil {
		t.Fatal(err)
	}
}

func TestTxFailureRemovesPutObjects(t *testing.T) {
	e := newEnv(t)
	m, dir := seedtest.Fixture(t, 8, 2)
	e.exec(`CREATE TRIGGER boom BEFORE INSERT ON collections WHEN NEW.title LIKE '合集 2%' BEGIN SELECT RAISE(ABORT,'boom'); END`)
	if _, err := e.run(m, dir, true); err == nil {
		t.Fatal("expected tx failure")
	}
	e.exec(`DROP TRIGGER boom`)
	e.assertEmpty()
	if _, dels, _ := e.st.snapshot(); dels != 8 {
		t.Fatalf("deleted %d objects, want 8", dels)
	}
}

func TestPutFailureRemovesEarlierObjects(t *testing.T) {
	e := newEnv(t)
	m, dir := seedtest.Fixture(t, 8, 2)
	n := 0
	e.st.putErr = func(string, string) error {
		n++
		if n == 4 {
			return errors.New("put failed")
		}
		return nil
	}
	if _, err := e.run(m, dir, true); err == nil {
		t.Fatal("expected put failure")
	}
	e.assertEmpty()
}

func TestDemoUserCannotLogIn(t *testing.T) {
	e := newEnv(t)
	m, dir := seedtest.Fixture(t, 8, 2)
	if _, err := e.run(m, dir, true); err != nil {
		t.Fatal(err)
	}
	var email, stored string
	if err := e.d.QueryRow(`SELECT email,password FROM users WHERE id=?`, seed.OwnerID("markr-demo-v1")).Scan(&email, &stored); err != nil {
		t.Fatal(err)
	}
	if strings.HasPrefix(stored, "scrypt-v1$") || strings.Count(stored, "$") == 2 {
		t.Fatalf("stored password %q looks like a hash", stored)
	}
	for _, pw := range []string{stored, stored[1:], "", "!", "password", strings.Repeat("a", 20)} {
		if identity.VerifyPassword(pw, stored) {
			t.Fatalf("VerifyPassword(%q) matched", pw)
		}
	}

	// And through the real login endpoint: never 200, never a session.
	h := newAPI(t, e)
	c := &httpClient{t: t, h: h}
	c.bootstrap()
	r := c.post("/api/auth/login", fmt.Sprintf(`{"email":%q,"password":%q}`, email, stored))
	if r.code == 200 {
		t.Fatalf("demo login succeeded: %s", r.raw)
	}
	if n := e.count(`SELECT count(*) FROM sessions WHERE user_id IS NOT NULL`); n != 0 {
		t.Fatalf("bound sessions = %d", n)
	}
}

// --- end to end through the worker and the read API ---

func newAPI(t *testing.T, e *env) http.Handler {
	t.Helper()
	now := func() int64 { return t0 }
	id, err := identity.New(e.d, identity.Deps{Origin: origin, Dev: true, Enabled: true, Now: now})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { id.Close(context.Background()) })
	return api.New(api.Deps{DB: e.d, Identity: id, Storage: e.st, Jobs: jobs.New(e.d, now), Now: now, Cfg: e.cfg})
}

type httpClient struct {
	t            *testing.T
	h            http.Handler
	cookie, csrf string
}

type resp struct {
	code int
	raw  string
	body map[string]any
}

func (c *httpClient) do(method, path, body string) resp {
	c.t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	if method != http.MethodGet {
		r.Header.Set("Origin", origin)
		r.Header.Set("X-CSRF-Token", c.csrf)
	}
	if c.cookie != "" {
		r.Header.Set("Cookie", "markr_dev_session="+c.cookie)
	}
	w := httptest.NewRecorder()
	c.h.ServeHTTP(w, r)
	out := resp{code: w.Code, raw: w.Body.String()}
	if leak := privacyLeak(out.raw); leak != "" {
		c.t.Fatalf("%s %s leaks %s: %s", method, path, leak, out.raw)
	}
	_ = json.Unmarshal(w.Body.Bytes(), &out.body)
	for _, ck := range w.Result().Cookies() {
		if ck.Name == "markr_dev_session" {
			c.cookie = ck.Value
		}
	}
	if tok, ok := out.body["csrfToken"].(string); ok {
		c.csrf = tok
	}
	return out
}

func (c *httpClient) get(path string) resp        { return c.do(http.MethodGet, path, "") }
func (c *httpClient) post(path, body string) resp { return c.do(http.MethodPost, path, body) }
func (c *httpClient) bootstrap() {
	if r := c.get("/api/auth/session"); r.code != 200 || c.csrf == "" {
		c.t.Fatalf("bootstrap: %d %s", r.code, r.raw)
	}
}

var (
	privacyKeyRe  = regexp.MustCompile(`(?i)latitude|longitude|gps|original_?key|^lat$|^lng$|^lon$`)
	privacyWordRe = regexp.MustCompile(`(?i)latitude|longitude`)
)

// privacyLeak mirrors the api package's scan: no location keys or words and
// no original object key anywhere in a response.
func privacyLeak(body string) string {
	if m := privacyWordRe.FindString(body); m != "" {
		return fmt.Sprintf("word %q", m)
	}
	var v any
	if err := json.Unmarshal([]byte(body), &v); err != nil {
		return "non-JSON body"
	}
	var walk func(v any) string
	walk = func(v any) string {
		switch x := v.(type) {
		case map[string]any:
			for k, vv := range x {
				if privacyKeyRe.MatchString(k) {
					return fmt.Sprintf("key %q", k)
				}
				if l := walk(vv); l != "" {
					return l
				}
			}
		case []any:
			for _, vv := range x {
				if l := walk(vv); l != "" {
					return l
				}
			}
		case string:
			if strings.HasPrefix(x, "o/") || strings.Contains(x, "/o/") {
				return fmt.Sprintf("original key %q", x)
			}
		}
		return ""
	}
	return walk(v)
}

func TestPrivacyScanCatchesLeaks(t *testing.T) {
	for _, b := range []string{`{"latitude":1}`, `{"a":{"gpsLat":1}}`, `{"k":"o/u/p"}`, `[{"lng":2}]`} {
		if privacyLeak(b) == "" {
			t.Errorf("missed %s", b)
		}
	}
}

func TestEndToEndSeedWorkerSquare(t *testing.T) {
	e := newEnv(t)
	m, dir := seedtest.Fixture(t, 8, 2)
	path := seedtest.WriteManifest(t, m)
	if _, err := e.runPath(path, dir, true); err != nil {
		t.Fatal(err)
	}

	now := func() int64 { return t0 }
	w := worker.New(worker.Deps{DB: e.d, Jobs: jobs.New(e.d, now), Storage: e.st, CDN: &cdn.Fake{}, Cfg: e.cfg, Now: now,
		Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	for i := 0; ; i++ {
		ran, err := w.RunOnce(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if !ran {
			break
		}
		if i > 50 {
			t.Fatal("worker never drained")
		}
	}
	if n := e.count(`SELECT count(*) FROM photos WHERE status='ready' AND derived_hash IS NOT NULL AND width=64 AND height=48`); n != 8 {
		var errs []string
		rows, _ := e.d.Query(`SELECT status, coalesce(error,'') FROM photos`)
		for rows.Next() {
			var s, er string
			rows.Scan(&s, &er)
			errs = append(errs, s+":"+er)
		}
		rows.Close()
		t.Fatalf("ready photos = %d: %v", n, errs)
	}
	if n := e.count(`SELECT count(*) FROM photo_histograms`); n != 8 {
		t.Fatalf("histograms = %d", n)
	}
	if n := e.count(`SELECT count(*) FROM photo_exif`); n != 8 {
		t.Fatalf("exif rows = %d", n)
	}
	if n := e.count(`SELECT count(*) FROM photos WHERE latitude IS NOT NULL OR longitude IS NOT NULL`); n != 0 {
		t.Fatalf("location stored for %d photos", n)
	}
	if n := e.count(`SELECT count(*) FROM jobs WHERE state!='done'`); n != 0 {
		t.Fatalf("unfinished jobs = %d", n)
	}

	c := &httpClient{t: t, h: newAPI(t, e)}
	sq := c.get("/api/square")
	if sq.code != 200 {
		t.Fatalf("square: %d %s", sq.code, sq.raw)
	}
	items, _ := sq.body["items"].([]any)
	if len(items) != 2 {
		t.Fatalf("square items = %s", sq.raw)
	}
	owner := seed.OwnerID("markr-demo-v1")
	for i, it := range items {
		card := it.(map[string]any)
		want := seed.CollectionID("markr-demo-v1", fmt.Sprintf("coll-%d", i+1))
		if card["id"] != want || card["cover"] == nil || card["owner"].(map[string]any)["id"] != owner ||
			card["owner"].(map[string]any)["name"] != "Markr Demo · 演示图库" || card["count"] != float64(4) {
			t.Fatalf("square card %d = %v", i, card)
		}
	}
	feat, _ := sq.body["featured"].([]any)
	if len(feat) != 1 || feat[0].(map[string]any)["id"] != seed.CollectionID("markr-demo-v1", "coll-1") {
		t.Fatalf("featured = %v", feat)
	}

	// The collection read carries the attribution exactly as in the manifest.
	var raw struct {
		Photos []struct {
			ID     string          `json:"id"`
			Source json.RawMessage `json:"source"`
		} `json:"photos"`
	}
	fb, _ := os.ReadFile(path)
	json.Unmarshal(fb, &raw)
	wantSrc := map[string]any{}
	for _, p := range raw.Photos {
		var v any
		json.Unmarshal(p.Source, &v)
		wantSrc[seed.PhotoID("markr-demo-v1", p.ID)] = v
	}
	cid := seed.CollectionID("markr-demo-v1", "coll-2")
	cr := c.get("/api/collections/" + cid)
	if cr.code != 200 {
		t.Fatalf("collection: %d %s", cr.code, cr.raw)
	}
	if cr.body["license"] != nil || cr.body["aiDeclaration"] != nil || cr.body["originalDownload"] != false {
		t.Fatalf("license/ai/originalDownload = %v %v %v", cr.body["license"], cr.body["aiDeclaration"], cr.body["originalDownload"])
	}
	if cover := cr.body["cover"].(map[string]any); cover["id"] != seed.PhotoID("markr-demo-v1", "photo-2") {
		t.Fatalf("cover = %v", cover["id"])
	}
	frames := cr.body["frames"].([]any)
	if len(frames) != 4 {
		t.Fatalf("frames = %d", len(frames))
	}
	for _, f := range frames {
		fr := f.(map[string]any)
		ph := fr["photos"].([]any)[0].(map[string]any)
		if fr["layout"] != "full" || ph["media"] == nil || ph["downloadable"] != false || ph["histogram"] == nil {
			t.Fatalf("frame = %v", fr)
		}
		if fmt.Sprint(ph["attribution"]) != fmt.Sprint(wantSrc[ph["id"].(string)]) || ph["attribution"] == nil {
			t.Fatalf("attribution = %v, want %v", ph["attribution"], wantSrc[ph["id"].(string)])
		}
	}

	u := c.get("/api/u/" + owner)
	if u.code != 200 || u.body["profile"].(map[string]any)["wallLayout"] != "grid" || len(u.body["collections"].([]any)) != 2 {
		t.Fatalf("user wall: %d %s", u.code, u.raw)
	}
}
