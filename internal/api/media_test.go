package api_test

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
	"testing"
	"time"
)

const hashA = "0123456789abcdef"

// mediaPhoto inserts a ready photo with dimensions and a derived hash, plus
// an EXIF row and a histogram, and returns its id. Location is set so the
// privacy scan proves it never leaks.
func (e *env) mediaPhoto(owner, title string) string {
	e.t.Helper()
	id := newID()
	sum := sha256.Sum256([]byte(id))
	e.insertPhoto(owner, id, "ready", hex.EncodeToString(sum[:]))
	e.exec(`UPDATE photos SET latitude=1.5,longitude=2.5,width=3000,height=2000,derived_hash=?,title=?,
		public_fields='["iso","camera"]',histogram_public=1 WHERE id=?`, hashA, title, id)
	e.exec(`INSERT INTO photo_exif(photo_id,camera_make,camera_model,lens_model,focal_length_mm,aperture,
		exposure_time,exposure_seconds,iso,taken_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
		id, "FUJIFILM", "X-T5", "XF23", 23.0, 1.4, "1/250", 0.004, 400, t0)
	bins := make([]byte, 512)
	bins[0], bins[1] = 0xff, 0xff // luma[0] = 65535
	e.exec(`INSERT INTO photo_histograms(photo_id,bins) VALUES(?,?)`, id, bins)
	return id
}

// coll creates a collection of full frames for photos, sets its visibility
// and publishes it when status is "published".
func (c *client) coll(status, vis string, over map[string]any, photos ...string) string {
	c.e.t.Helper()
	id := c.newCollection("C " + status + " " + vis)
	frames := make([]frameIn, 0, len(photos))
	for _, p := range photos {
		frames = append(frames, full(p))
	}
	if len(frames) > 0 {
		c.mustFrames(id, frames...)
	}
	body := map[string]any{"visibility": vis}
	for k, v := range over {
		body[k] = v
	}
	if r := c.updateCollection(id, body); r.code != 200 {
		c.e.t.Fatalf("update: %d %s", r.code, r.raw)
	}
	if status == "published" {
		if r := c.post("/api/collections/"+id+"/publish", ""); r.code != 200 {
			c.e.t.Fatalf("publish: %d %s", r.code, r.raw)
		}
	}
	return id
}

func is404JSON(t *testing.T, w interface {
	Result() *http.Response
}, what string) {
	t.Helper()
	res := w.Result()
	if res.StatusCode != 404 || res.Header.Get("Location") != "" ||
		!strings.HasPrefix(res.Header.Get("Content-Type"), "application/json") {
		t.Errorf("%s: %d location=%q ct=%q", what, res.StatusCode, res.Header.Get("Location"), res.Header.Get("Content-Type"))
	}
}

func TestMediaRedirectAuthorization(t *testing.T) {
	e := newEnv(t)
	u1 := e.user("u1")
	u2 := e.user("u2")
	anon := e.anon()
	p := e.mediaPhoto("u1", "P")
	other := e.mediaPhoto("u1", "Other")
	listed := u1.coll("published", "unlisted", nil, p)
	without := u1.coll("published", "unlisted", nil, other)
	draft := u1.coll("draft", "public", nil, p)
	private := u1.coll("published", "private", nil, p)

	path := func(file, c string) string { return "/m/" + p + "/" + hashA + "/" + file + "?c=" + c }
	ok := func(cl *client, url, wantKey, what string) {
		t.Helper()
		w := cl.raw(url)
		if w.Code != 302 {
			t.Fatalf("%s: %d %s", what, w.Code, w.Body.String())
		}
		g := e.st.lastGet()
		if g.Bucket != derivedBucket || g.Key != wantKey || g.TTL != 5*time.Minute || g.Name != "" {
			t.Fatalf("%s: presign %+v", what, g)
		}
		if loc := w.Header().Get("Location"); loc != "https://storage.test/"+derivedBucket+"/"+wantKey+"?get" {
			t.Fatalf("%s: location %q", what, loc)
		}
		if cc := w.Header().Get("Cache-Control"); cc != "private, no-store" {
			t.Fatalf("%s: cache-control %q", what, cc)
		}
	}

	for _, cl := range []*client{anon, u2, u1} {
		ok(cl, path("w480.avif", listed), "d/"+p+"/"+hashA+"/w480.avif", "readable collection")
	}
	ok(anon, path("w3840.jpg", listed), "d/"+p+"/"+hashA+"/w3840.jpg", "jpg tier")
	ok(anon, path("w1280.webp", listed), "d/"+p+"/"+hashA+"/w1280.webp", "webp tier")
	ok(u1, path("w2400.jpg", ""), "d/"+p+"/"+hashA+"/w2400.jpg", "owner without c")
	ok(u1, "/m/"+p+"/"+hashA+"/w2400.jpg", "d/"+p+"/"+hashA+"/w2400.jpg", "owner with no query")
	ok(u1, path("w480.avif", draft), "d/"+p+"/"+hashA+"/w480.avif", "owner in draft")

	for _, cl := range []*client{anon, u2} {
		for what, url := range map[string]string{
			"no c":                    path("w480.avif", ""),
			"no query":                "/m/" + p + "/" + hashA + "/w480.avif",
			"c without the photo":     path("w480.avif", without),
			"draft c":                 path("w480.avif", draft),
			"private c":               path("w480.avif", private),
			"unknown c":               path("w480.avif", newID()),
			"non-uuid c":              path("w480.avif", "x"),
			"wrong hash":              "/m/" + p + "/fedcba9876543210/w480.avif?c=" + listed,
			"uppercase hash":          "/m/" + p + "/0123456789ABCDEF/w480.avif?c=" + listed,
			"short hash":              "/m/" + p + "/0123/w480.avif?c=" + listed,
			"bad tier":                path("w999.avif", listed),
			"bad ext":                 path("w480.png", listed),
			"jpeg ext":                path("w480.jpeg", listed),
			"non-uuid photo":          "/m/nope/" + hashA + "/w480.avif?c=" + listed,
			"photo not in collection": "/m/" + other + "/" + hashA + "/w480.avif?c=" + listed,
		} {
			is404JSON(t, cl.raw(url), what)
		}
	}
	// A collection containing a different photo never authorizes this one,
	// even for the owner's own unknown ids.
	is404JSON(t, u1.raw("/m/"+newID()+"/"+hashA+"/w480.avif"), "owner unknown photo")

	// Rotation: the old hash stops resolving for everyone, the new one works.
	e.exec(`UPDATE photos SET derived_hash='aaaaaaaaaaaaaaaa' WHERE id=?`, p)
	for _, cl := range []*client{anon, u1} {
		is404JSON(t, cl.raw(path("w480.avif", listed)), "stale hash")
	}
	ok(anon, "/m/"+p+"/aaaaaaaaaaaaaaaa/w480.avif?c="+listed, "d/"+p+"/aaaaaaaaaaaaaaaa/w480.avif", "rotated hash")

	// Not ready (or hash cleared): 404 even for the owner.
	e.exec(`UPDATE photos SET status='processing' WHERE id=?`, p)
	is404JSON(t, u1.raw("/m/"+p+"/aaaaaaaaaaaaaaaa/w480.avif"), "processing photo")
}

func TestOriginalDownload(t *testing.T) {
	e := newEnv(t)
	u1 := e.user("u1")
	u2 := e.user("u2")
	anon := e.anon()
	p := e.mediaPhoto("u1", `Sun/set "1"`)
	stranger := e.mediaPhoto("u1", "S")
	noDL := u1.coll("published", "public", nil, p)
	dl := u1.coll("published", "unlisted", map[string]any{"originalDownload": true}, p)
	dlDraft := u1.coll("draft", "public", map[string]any{"originalDownload": true}, p)
	dlOther := u1.coll("published", "public", map[string]any{"originalDownload": true}, stranger)

	ok := func(cl *client, url, what string) {
		t.Helper()
		w := cl.raw(url)
		if w.Code != 302 {
			t.Fatalf("%s: %d %s", what, w.Code, w.Body.String())
		}
		g := e.st.lastGet()
		if g.Bucket != bucket || g.Key != "o/u1/"+p || g.TTL != 5*time.Minute || g.Name != "Sunset 1.jpg" {
			t.Fatalf("%s: presign %+v", what, g)
		}
		if w.Header().Get("Location") == "" {
			t.Fatalf("%s: no location", what)
		}
	}
	base := "/api/photos/" + p + "/original"
	ok(u1, base, "owner without collection")
	ok(u1, base+"?collection="+noDL, "owner in no-download collection")
	ok(u1, base+"?collection="+dlOther, "owner with unrelated collection")
	for _, cl := range []*client{anon, u2} {
		ok(cl, base+"?collection="+dl, "download allowed")
		for what, url := range map[string]string{
			"no collection":              base,
			"download off":               base + "?collection=" + noDL,
			"draft collection":           base + "?collection=" + dlDraft,
			"collection without photo":   base + "?collection=" + dlOther,
			"unknown collection":         base + "?collection=" + newID(),
			"non-uuid collection":        base + "?collection=x",
			"unknown photo":              "/api/photos/" + newID() + "/original?collection=" + dl,
			"photo not in the dl collec": "/api/photos/" + stranger + "/original?collection=" + dl,
		} {
			is404JSON(t, cl.raw(url), what)
		}
	}
	e.exec(`UPDATE photos SET title='' WHERE id=?`, p)
	u1.raw(base)
	if g := e.st.lastGet(); g.Name != p+".jpg" {
		t.Fatalf("empty title name %q", g.Name)
	}
	e.exec(`UPDATE photos SET status='failed' WHERE id=?`, p)
	is404JSON(t, u1.raw(base), "failed photo")
}

func TestOwnerPhotoMedia(t *testing.T) {
	e := newEnvCfg(t, nil)
	u1 := e.user("u1")
	p := e.mediaPhoto("u1", "P")
	g := u1.get("/api/photos/" + p)
	m, _ := g.body["media"].(map[string]any)
	if m == nil || m["width"] != 3000.0 || m["height"] != 2000.0 {
		t.Fatalf("%s", g.raw)
	}
	tiers, _ := m["tiers"].(map[string]any)
	if len(tiers) != 4 {
		t.Fatalf("tiers %v", tiers)
	}
	for _, tier := range []string{"w480", "w1280", "w2400", "w3840"} {
		f, _ := tiers[tier].(map[string]any)
		want := map[string]string{"avif": ".avif", "webp": ".webp", "jpeg": ".jpg"}
		if len(f) != 3 {
			t.Fatalf("%s: %v", tier, f)
		}
		for k, ext := range want {
			if f[k] != "/m/"+p+"/"+hashA+"/"+tier+ext+"?c=" {
				t.Errorf("%s.%s = %v", tier, k, f[k])
			}
		}
	}
	e.exec(`UPDATE photos SET derived_hash=NULL WHERE id=?`, p)
	if g := u1.get("/api/photos/" + p); g.body["media"] != nil {
		t.Fatalf("media without hash: %s", g.raw)
	}
	e.exec(`UPDATE photos SET derived_hash=?,status='processing' WHERE id=?`, hashA, p)
	if g := u1.get("/api/photos/" + p); g.body["media"] != nil {
		t.Fatalf("media while processing: %s", g.raw)
	}
}
