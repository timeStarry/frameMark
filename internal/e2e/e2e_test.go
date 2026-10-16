// Package e2e_test runs the SP1 journey (spec §1, §7, §9) end to end against
// real MinIO, real libvips and the real HTTP API. The tests skip unless
// MARKR_TEST_S3_ENDPOINT, MARKR_TEST_S3_ACCESS_KEY and
// MARKR_TEST_S3_SECRET_KEY are set.
package e2e_test

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"net/http"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func sha(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

// idle reports whether no job is running or queued, ignoring the late-PUT
// sweep that delete_photo_objects schedules 20 minutes out.
func (s *stack) idle() bool {
	s.t.Helper()
	var n int
	err := s.d.QueryRow(`SELECT count(*) FROM jobs WHERE state IN ('queued','running')
		AND coalesce(json_extract(payload,'$.sweep'),0)=0`).Scan(&n)
	if err != nil {
		s.t.Fatal(err)
	}
	return n == 0
}

func (s *stack) photoRow(id string) (status string, hash, lat, lon sql.NullString) {
	s.t.Helper()
	err := s.d.QueryRow(`SELECT status,derived_hash,latitude,longitude FROM photos WHERE id=?`, id).Scan(&status, &hash, &lat, &lon)
	if err != nil {
		s.t.Fatal(err)
	}
	return
}

func (s *stack) deadJobs() []string {
	s.t.Helper()
	rows, err := s.d.Query(`SELECT kind||': '||coalesce(last_error,'') FROM jobs WHERE state='dead'`)
	if err != nil {
		s.t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			s.t.Fatal(err)
		}
		out = append(out, k)
	}
	if err := rows.Err(); err != nil {
		s.t.Fatal(err)
	}
	return out
}

// mediaOf returns photo.media.tiers[tier][format] from a decoded photo view.
func mediaOf(t *testing.T, photo map[string]any, tier, format string) string {
	t.Helper()
	m, _ := photo["media"].(map[string]any)
	tiers, _ := m["tiers"].(map[string]any)
	f, _ := tiers[tier].(map[string]any)
	u, _ := f[format].(string)
	if u == "" {
		t.Fatalf("no media %s.%s in %v", tier, format, photo["media"])
	}
	return u
}

// firstPhoto returns frames[0].photos[0] of a collection read view.
func firstPhoto(t *testing.T, r resp) map[string]any {
	t.Helper()
	frames, _ := r.body["frames"].([]any)
	if len(frames) != 1 {
		t.Fatalf("frames = %v", r.body["frames"])
	}
	photos, _ := frames[0].(map[string]any)["photos"].([]any)
	if len(photos) != 1 {
		t.Fatalf("photos = %v", photos)
	}
	return photos[0].(map[string]any)
}

func keys(m map[string]any) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}

func TestFullJourney(t *testing.T) {
	s := newStack(t)
	owner := s.client(s.srv.URL)

	// 1–2. Session bootstrap, register, verify, log in.
	r := owner.get("/api/auth/session").want(t, 200)
	if r.body["user"] != nil || owner.csrf == "" || r.body["registrationOpen"] != true {
		t.Fatalf("session: %s", r.raw)
	}
	email := "e2e-" + randHex(t, 4) + "@example.test"
	uid := owner.signUp(email)
	if r := owner.get("/api/auth/session").want(t, 200); r.str("user") != uid {
		t.Fatalf("session after login: %s", r.raw)
	}

	// 3. Upload prefs: location off, four public fields.
	pub := []string{"aperture", "shutter", "iso", "focal_length"}
	r = owner.put("/api/upload-prefs", map[string]any{
		"publicFields": pub, "histogramPublic": true, "originalDownload": false,
		"watermark": nil, "locationMode": "off",
	}).want(t, 200)
	if r.str("locationMode") != "off" {
		t.Fatalf("prefs: %s", r.raw)
	}

	// 4–5. EXIF+GPS JPEG, presigned PUT, complete.
	img := fixtureJPEG(t, 1)
	if !bytes.Contains(img, []byte("Exif\x00\x00")) {
		t.Fatal("fixture has no EXIF")
	}
	r = owner.post("/api/uploads", map[string]any{
		"filename": "e2e-photo.jpg", "bytes": len(img), "sha256": sha(img), "contentType": "image/jpeg",
	}).want(t, 201)
	pid := r.str("photoId")
	upload, _ := r.body["upload"].(map[string]any)
	if pid == "" || upload == nil {
		t.Fatalf("initiate: %s", r.raw)
	}
	if code := s.putPresigned(upload, img); code != 200 {
		t.Fatalf("presigned PUT: %d", code)
	}
	if got := s.list(s.cfg.BucketOriginals, "o/"+uid+"/"); len(got) != 1 || got[0] != "o/"+uid+"/"+pid {
		t.Fatalf("original objects = %v", got)
	}
	r = owner.post("/api/uploads/"+pid+"/complete", nil).want(t, 202)
	if r.str("status") != "processing" {
		t.Fatalf("complete: %s", r.raw)
	}

	// 6. Worker until ready.
	s.drain("photo ready", func() bool { st, _, _, _ := s.photoRow(pid); return st == "ready" })
	_, hash0, lat, lon := s.photoRow(pid)
	if !hash0.Valid || lat.Valid || lon.Valid {
		t.Fatalf("photo row: hash %v lat %v lon %v (location off must store no position)", hash0, lat, lon)
	}
	oldHash := hash0.String
	derived := s.list(s.cfg.BucketDerived, "d/"+pid+"/"+oldHash+"/")
	if len(derived) != 12 {
		t.Fatalf("derived objects = %v", derived)
	}

	// 7. Owner view: ready, exif present, no position.
	r = owner.get("/api/photos/"+pid).want(t, 200)
	exif, _ := r.body["exif"].(map[string]any)
	if r.str("status") != "ready" || exif == nil {
		t.Fatalf("photo: %s", r.raw)
	}
	if exif["camera"] != fixtureModel || exif["lens"] != fixtureLens || exif["iso"] != float64(400) ||
		exif["aperture"] != 2.8 || exif["focalLength"] != float64(50) || exif["shutter"] == nil || exif["takenAt"] == nil {
		t.Fatalf("owner exif = %v", exif)
	}
	ownerMedia := mediaOf(t, r.body, "w480", "jpeg")
	if want := "/m/" + pid + "/" + oldHash + "/w480.jpg?c="; ownerMedia != want {
		t.Fatalf("owner media %q, want %q", ownerMedia, want)
	}

	// 8. Collection, one full frame, public, dry run, publish.
	r = owner.post("/api/collections", map[string]any{"title": "E2E 合集"}).want(t, 201)
	cid := r.str("id")
	owner.put("/api/collections/"+cid+"/frames", map[string]any{
		"frames": []any{map[string]any{"layout": "full", "photoIds": []string{pid}}},
	}).want(t, 200)
	collBody := func(vis string) map[string]any {
		return map[string]any{"title": "E2E 合集", "visibility": vis, "distribute": true, "originalDownload": false}
	}
	owner.put("/api/collections/"+cid, collBody("public")).want(t, 200)
	r = owner.post("/api/collections/"+cid+"/publish?dry_run=1", nil).want(t, 200)
	wantFields := []any{"aperture", "focal_length", "iso", "shutter"}
	if r.body["photos"] != float64(1) || !reflect.DeepEqual(r.body["publicFields"], wantFields) ||
		r.body["histogram"] != true || r.body["originalDownload"] != false ||
		r.str("visibility") != "public" || r.body["inSquare"] != true {
		t.Fatalf("manifest: %s", r.raw)
	}
	r = owner.post("/api/collections/"+cid+"/publish", nil).want(t, 200)
	if r.str("status") != "published" {
		t.Fatalf("publish: %s", r.raw)
	}

	// 9. Anonymous read: public fields only, /m redirect to MinIO, clean bytes.
	anon := s.client(s.srv.URL)
	r = anon.get("/api/collections/"+cid).want(t, 200)
	if _, ok := r.body["status"]; ok {
		t.Fatalf("anonymous view carries owner fields: %s", r.raw)
	}
	photo := firstPhoto(t, r)
	pexif, _ := photo["exif"].(map[string]any)
	if got, want := keys(pexif), []string{"aperture", "exposureSeconds", "focalLength", "iso", "shutter"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("public exif keys %v, want %v (%v)", got, want, pexif)
	}
	if photo["histogram"] == nil {
		t.Fatal("public histogram missing")
	}
	for _, format := range []string{"jpeg", "webp", "avif"} {
		m := mediaOf(t, photo, "w480", format)
		if !strings.HasPrefix(m, "/m/"+pid+"/"+oldHash+"/") || !strings.HasSuffix(m, "?c="+cid) {
			t.Fatalf("anonymous media %q", m)
		}
		red := anon.get(m).want(t, 302)
		loc := red.header.Get("Location")
		if !strings.Contains(loc, s.cfg.BucketDerived) || strings.Contains(loc, s.cfg.BucketOriginals) ||
			red.header.Get("Cache-Control") != "private, no-store" {
			t.Fatalf("redirect %q cache %q", loc, red.header.Get("Cache-Control"))
		}
		code, obj := fetch(t, loc)
		if code != 200 || len(obj) == 0 {
			t.Fatalf("fetch %s: %d (%d bytes)", format, code, len(obj))
		}
		if bytes.Contains(obj, []byte("Exif")) || bytes.Contains(obj, []byte("GPS")) {
			t.Fatalf("derived %s carries EXIF/GPS markers", format)
		}
	}
	// CDN-configured server: the public collection gets fixed CDN URLs.
	anonCDN := s.client(s.cdnSrv.URL)
	cdnURL := mediaOf(t, firstPhoto(t, anonCDN.get("/api/collections/"+cid).want(t, 200)), "w1280", "webp")
	if want := cdnBase + "/d/" + pid + "/" + oldHash + "/w1280.webp"; cdnURL != want {
		t.Fatalf("cdn media %q, want %q", cdnURL, want)
	}
	staleM := "/m/" + pid + "/" + oldHash + "/w480.jpg?c=" + cid

	// 10. Withdraw: public → private.
	owner.put("/api/collections/"+cid, collBody("private")).want(t, 200)

	// 11. rotate_derived then purge_derived.
	s.drain("rotate and purge", func() bool {
		_, h, _, _ := s.photoRow(pid)
		return h.Valid && h.String != oldHash && s.idle()
	})
	_, hash1, _, _ := s.photoRow(pid)
	newHash := hash1.String
	if dead := s.deadJobs(); len(dead) != 0 {
		t.Fatalf("dead jobs: %v", dead)
	}
	if !slices.Contains(s.cdn.Prefixes(), "d/"+pid+"/"+oldHash+"/") {
		t.Fatalf("cdn purges %v lack old prefix", s.cdn.Prefixes())
	}
	if got := s.list(s.cfg.BucketDerived, "d/"+pid+"/"+oldHash+"/"); len(got) != 0 {
		t.Fatalf("old derived objects remain: %v", got)
	}
	if got := s.list(s.cfg.BucketDerived, "d/"+pid+"/"+newHash+"/"); len(got) != 12 {
		t.Fatalf("new derived objects = %v", got)
	}
	r = owner.get("/api/photos/"+pid).want(t, 200)
	if m := mediaOf(t, r.body, "w480", "jpeg"); !strings.HasPrefix(m, "/m/"+pid+"/"+newHash+"/") {
		t.Fatalf("owner media after rotate %q", m)
	}
	owner.get(staleM).wantf(t, 404, "owner stale hash")

	// 12. Anonymous: collection and old /m URL are gone.
	anon2 := s.client(s.srv.URL)
	anon2.get("/api/collections/"+cid).wantf(t, 404, "anonymous collection after withdraw")
	anon2.get(staleM).wantf(t, 404, "anonymous stale /m")
	anonCDN.get("/api/collections/"+cid).wantf(t, 404, "anonymous cdn collection after withdraw")

	// 13. Delete the photo; original and derived objects go.
	owner.del("/api/photos/"+pid).want(t, 204)
	s.drain("photo objects deleted", s.idle)
	if dead := s.deadJobs(); len(dead) != 0 {
		t.Fatalf("dead jobs: %v", dead)
	}
	if got := s.list(s.cfg.BucketOriginals, "o/"); len(got) != 0 {
		t.Fatalf("originals remain: %v", got)
	}
	if got := s.list(s.cfg.BucketDerived, "d/"+pid+"/"); len(got) != 0 {
		t.Fatalf("derived remain: %v", got)
	}
	if !slices.Contains(s.cdn.Prefixes(), "d/"+pid+"/") {
		t.Fatalf("cdn purges %v lack photo prefix", s.cdn.Prefixes())
	}
	owner.get("/api/photos/"+pid).wantf(t, 404, "deleted photo")
}

func TestPresignedPutRejectsWrongChecksum(t *testing.T) {
	s := newStack(t)
	c := s.client(s.srv.URL)
	uid := c.signUp("e2e-sum-" + randHex(t, 4) + "@example.test")

	img := fixtureJPEG(t, 2)
	r := c.post("/api/uploads", map[string]any{
		"filename": "wrong.jpg", "bytes": len(img), "sha256": sha(img), "contentType": "image/jpeg",
	}).want(t, 201)
	pid := r.str("photoId")
	upload, _ := r.body["upload"].(map[string]any)

	// Same length, different bytes: MinIO must refuse the declared checksum.
	other := bytes.Clone(img)
	other[len(other)-3] ^= 0xFF
	if code := s.putPresigned(upload, other); code < 400 || code >= 500 {
		t.Fatalf("PUT with mismatched body: %d, want 4xx", code)
	}
	if got := s.list(s.cfg.BucketOriginals, "o/"+uid+"/"); len(got) != 0 {
		t.Fatalf("rejected PUT stored objects: %v", got)
	}
	r = c.post("/api/uploads/"+pid+"/complete", nil).wantf(t, http.StatusConflict, "complete without object")
	if r.str("error") == "" {
		t.Fatalf("complete: %s", r.raw)
	}
	if st, _, _, _ := s.photoRow(pid); st != "uploading" {
		t.Fatalf("status %q after failed complete, want uploading", st)
	}
}
