package api_test

import (
	"encoding/json"
	"github.com/timeStarry/frameMark/internal/config"
	"sort"
	"strings"
	"testing"
)

// keyPaths returns every object key path in a JSON document; array elements
// collapse to "[]", so the set describes the shape, not the values.
func keyPaths(t *testing.T, raw string) []string {
	t.Helper()
	var v any
	if err := json.Unmarshal([]byte(raw), &v); err != nil {
		t.Fatal(err)
	}
	set := map[string]bool{}
	var walk func(prefix string, v any)
	walk = func(prefix string, v any) {
		switch x := v.(type) {
		case map[string]any:
			for k, c := range x {
				p := prefix + "." + k
				set[p] = true
				walk(p, c)
			}
		case []any:
			for _, c := range x {
				walk(prefix+"[]", c)
			}
		}
	}
	walk("", v)
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// deskFixture is a published unlisted collection by u1 with a text frame, a
// pair (one photo overridden) and a matted frame, a cover and an attribution.
func deskFixture(e *env, u1 *client) (cid, a, b, c string) {
	e.t.Helper()
	a, b, c = e.mediaPhoto("u1", "A"), e.mediaPhoto("u1", "B"), e.mediaPhoto("u1", "C")
	e.exec(`INSERT INTO attributions(photo_id,source) VALUES(?,?)`, b, `{"author":"X","license":"CC0"}`)
	cid = u1.newCollection("Desk")
	u1.mustFrames(cid, textFrame("hello"), pair(b, c), frameIn{"layout": "matted", "matteRatio": 0.8, "photoIds": []string{a}})
	if r := u1.updateCollection(cid, map[string]any{"visibility": "unlisted", "coverPhotoId": a, "license": "by"}); r.code != 200 {
		e.t.Fatalf("update: %d %s", r.code, r.raw)
	}
	if r := u1.put("/api/collections/"+cid+"/overrides/"+b, `{"publicFields":["lens"],"histogramPublic":false}`); r.code != 200 {
		e.t.Fatalf("override: %d %s", r.code, r.raw)
	}
	if r := u1.post("/api/collections/"+cid+"/publish", ""); r.code != 200 {
		e.t.Fatalf("publish: %d %s", r.code, r.raw)
	}
	return cid, a, b, c
}

// visitorKeys is the key-path set of the visitor read of deskFixture,
// captured from the code before SP4b added owner fields. It must not change.
var visitorKeys = []string{
	".aiDeclaration",
	".cover",
	".cover.attribution",
	".cover.caption",
	".cover.downloadable",
	".cover.exif",
	".cover.exif.camera",
	".cover.exif.iso",
	".cover.height",
	".cover.histogram",
	".cover.id",
	".cover.media",
	".cover.media.height",
	".cover.media.tiers",
	".cover.media.tiers.w1280",
	".cover.media.tiers.w1280.avif",
	".cover.media.tiers.w1280.jpeg",
	".cover.media.tiers.w1280.webp",
	".cover.media.tiers.w2400",
	".cover.media.tiers.w2400.avif",
	".cover.media.tiers.w2400.jpeg",
	".cover.media.tiers.w2400.webp",
	".cover.media.tiers.w3840",
	".cover.media.tiers.w3840.avif",
	".cover.media.tiers.w3840.jpeg",
	".cover.media.tiers.w3840.webp",
	".cover.media.tiers.w480",
	".cover.media.tiers.w480.avif",
	".cover.media.tiers.w480.jpeg",
	".cover.media.tiers.w480.webp",
	".cover.media.width",
	".cover.title",
	".cover.width",
	".frames",
	".frames[].layout",
	".frames[].matteRatio",
	".frames[].photos",
	".frames[].photos[].attribution",
	".frames[].photos[].attribution.author",
	".frames[].photos[].attribution.license",
	".frames[].photos[].caption",
	".frames[].photos[].downloadable",
	".frames[].photos[].exif",
	".frames[].photos[].exif.camera",
	".frames[].photos[].exif.iso",
	".frames[].photos[].exif.lens",
	".frames[].photos[].height",
	".frames[].photos[].histogram",
	".frames[].photos[].id",
	".frames[].photos[].media",
	".frames[].photos[].media.height",
	".frames[].photos[].media.tiers",
	".frames[].photos[].media.tiers.w1280",
	".frames[].photos[].media.tiers.w1280.avif",
	".frames[].photos[].media.tiers.w1280.jpeg",
	".frames[].photos[].media.tiers.w1280.webp",
	".frames[].photos[].media.tiers.w2400",
	".frames[].photos[].media.tiers.w2400.avif",
	".frames[].photos[].media.tiers.w2400.jpeg",
	".frames[].photos[].media.tiers.w2400.webp",
	".frames[].photos[].media.tiers.w3840",
	".frames[].photos[].media.tiers.w3840.avif",
	".frames[].photos[].media.tiers.w3840.jpeg",
	".frames[].photos[].media.tiers.w3840.webp",
	".frames[].photos[].media.tiers.w480",
	".frames[].photos[].media.tiers.w480.avif",
	".frames[].photos[].media.tiers.w480.jpeg",
	".frames[].photos[].media.tiers.w480.webp",
	".frames[].photos[].media.width",
	".frames[].photos[].title",
	".frames[].photos[].width",
	".frames[].text",
	".id",
	".intro",
	".license",
	".originalDownload",
	".owner",
	".owner.id",
	".owner.name",
	".publishedAt",
	".title",
}

func TestVisitorReadUnchanged(t *testing.T) {
	e := newEnv(t)
	u1, u2, anon := viewers(e)
	cid, _, _, _ := deskFixture(e, u1)
	for name, c := range map[string]*client{"anon": anon, "u2": u2} {
		r := c.get("/api/collections/" + cid)
		if r.code != 200 {
			t.Fatalf("%s: %d", name, r.code)
		}
		if got := keyPaths(t, r.raw); strings.Join(got, "\n") != strings.Join(visitorKeys, "\n") {
			t.Errorf("%s keys changed:\n%s", name, strings.Join(got, "\n"))
		}
		for _, k := range []string{"updatedAt", "publicFields", "histogramPublic", "override"} {
			if strings.Contains(r.raw, `"`+k+`"`) {
				t.Errorf("%s sees %s", name, k)
			}
		}
	}
}

func TestOwnerReadFields(t *testing.T) {
	e := newEnvCfg(t, func(c *config.Config) { c.CDNBase = cdnBase })
	u1 := e.user("u1")
	cid, a, b, c := deskFixture(e, u1)
	// Public + published would use the CDN for visitors; the owner keeps /m/?c=.
	if r := u1.updateCollection(cid, map[string]any{"visibility": "public", "coverPhotoId": a, "license": "by"}); r.code != 200 {
		t.Fatal(r.raw)
	}
	var updated int64
	_ = e.d.QueryRow(`SELECT updated_at FROM collections WHERE id=?`, cid).Scan(&updated)
	r := u1.get("/api/collections/" + cid)
	if r.code != 200 || r.body["updatedAt"] != float64(updated) {
		t.Fatalf("updatedAt: %d %s", r.code, r.raw)
	}
	frames := r.body["frames"].([]any)
	photos := map[string]map[string]any{}
	for _, f := range frames {
		for _, p := range f.(map[string]any)["photos"].([]any) {
			m := p.(map[string]any)
			photos[m["id"].(string)] = m
		}
	}
	pb := photos[b]
	if pf := pb["publicFields"].([]any); len(pf) != 1 || pf[0] != "lens" || pb["histogramPublic"] != false {
		t.Errorf("b effective: %v %v", pb["publicFields"], pb["histogramPublic"])
	}
	ov, ok := pb["override"].(map[string]any)
	if !ok || ov["histogramPublic"] != false || len(ov["publicFields"].([]any)) != 1 || len(ov) != 2 {
		t.Errorf("b override %v", pb["override"])
	}
	pc := photos[c]
	if pf := pc["publicFields"].([]any); !sameIDs(sortedAny(pf), []string{"camera", "iso"}) || pc["histogramPublic"] != true {
		t.Errorf("c effective: %v %v", pc["publicFields"], pc["histogramPublic"])
	}
	if v, ok := pc["override"]; !ok || v != nil {
		t.Errorf("c override %v (present %v)", v, ok)
	}
	m := pc["media"].(map[string]any)["tiers"].(map[string]any)["w480"].(map[string]any)
	if m["avif"] != "/m/"+c+"/"+hashA+"/w480.avif?c="+cid {
		t.Errorf("owner media %v", m)
	}
	// The visitor gets the CDN for the same photo.
	vr := e.anon().get("/api/collections/" + cid)
	vm := vr.body["frames"].([]any)[1].(map[string]any)["photos"].([]any)[1].(map[string]any)["media"].(map[string]any)
	if w := vm["tiers"].(map[string]any)["w480"].(map[string]any)["avif"].(string); !strings.HasPrefix(w, cdnBase) {
		t.Errorf("visitor media %v", w)
	}
	// A draft reads with media for the owner too.
	if r := u1.post("/api/collections/"+cid+"/unpublish", ""); r.code != 200 {
		t.Fatal(r.raw)
	}
	r = u1.get("/api/collections/" + cid)
	dm := r.body["frames"].([]any)[2].(map[string]any)["photos"].([]any)[0].(map[string]any)
	if dm["media"] == nil || dm["publicFields"] == nil {
		t.Errorf("draft owner photo %v", dm)
	}
}

func sortedAny(v []any) []string {
	out := make([]string, 0, len(v))
	for _, x := range v {
		out = append(out, x.(string))
	}
	sort.Strings(out)
	return out
}

func TestOverrideAdvancesUpdatedAt(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	cid := u.newCollection("A")
	a := e.readyPhoto("u1")
	u.mustFrames(cid, full(a))
	e.now.Add(1000)
	r := u.put("/api/collections/"+cid+"/overrides/"+a, `{"publicFields":["iso"]}`)
	if r.code != 200 || r.body["updatedAt"] != float64(t0+1000) {
		t.Fatalf("%d %s", r.code, r.raw)
	}
	var n int64
	_ = e.d.QueryRow(`SELECT updated_at FROM collections WHERE id=?`, cid).Scan(&n)
	if n != t0+1000 {
		t.Fatalf("updated_at %d", n)
	}
}

// --- PUT /api/photos/{id} ---

func TestPutPhotoMetadata(t *testing.T) {
	e := newEnv(t)
	u1, u2, anon := viewers(e)
	p := e.mediaPhoto("u1", "Old")
	cid := u1.coll("published", "public", nil, p)
	path := "/api/photos/" + p
	for name, body := range map[string]string{
		"no title":      `{"caption":""}`,
		"no caption":    `{"title":""}`,
		"null title":    `{"title":null,"caption":""}`,
		"unknown field": `{"title":"","caption":"","x":1}`,
		"wrong type":    `{"title":1,"caption":""}`,
	} {
		if r := u1.put(path, body); r.code != 400 || r.errMsg() != "请求格式无效。" {
			t.Errorf("%s: %d %s", name, r.code, r.raw)
		}
	}
	long := jsonBody(map[string]any{"title": strings.Repeat("字", 121), "caption": ""})
	if r := u1.put(path, long); r.code != 400 || r.errMsg() != "标题不能超过 120 个字符。" {
		t.Errorf("long title: %d %s", r.code, r.raw)
	}
	longCap := jsonBody(map[string]any{"title": "", "caption": strings.Repeat("字", 2001)})
	if r := u1.put(path, longCap); r.code != 400 || r.errMsg() != "图注不能超过 2000 个字符。" {
		t.Errorf("long caption: %d %s", r.code, r.raw)
	}
	if r := u2.put(path, `{"title":"x","caption":""}`); r.code != 404 || r.errMsg() != "照片不存在。" {
		t.Errorf("other user: %d %s", r.code, r.raw)
	}
	if r := u1.put("/api/photos/"+newID(), `{"title":"x","caption":""}`); r.code != 404 {
		t.Errorf("absent: %d %s", r.code, r.raw)
	}
	if r := anon.put(path, `{"title":"x","caption":""}`); r.code != 401 {
		t.Errorf("anon: %d %s", r.code, r.raw)
	}
	var title string
	_ = e.d.QueryRow(`SELECT title FROM photos WHERE id=?`, p).Scan(&title)
	if title != "Old" {
		t.Fatalf("rejected write stored %q", title)
	}

	e.now.Add(1000)
	body := jsonBody(map[string]any{"title": "  New\u0007 " + strings.Repeat("字", 116), "caption": "line one\r\nline two‮ "})
	r := u1.put(path, body)
	wantTitle := "New " + strings.Repeat("字", 116)
	if r.code != 200 || r.body["id"] != p || r.body["title"] != wantTitle || r.body["caption"] != "line one\nline two" ||
		r.body["status"] != "ready" || r.body["media"] == nil {
		t.Fatalf("%d %s", r.code, r.raw)
	}
	// Empty strings are allowed (no title / no caption).
	if r := u1.put(path, `{"title":"","caption":""}`); r.code != 200 || r.body["title"] != "" {
		t.Fatalf("empty: %d %s", r.code, r.raw)
	}
	e.now.Add(1000)
	u1.put(path, `{"title":"Shown","caption":"Cap"}`)
	vr := anon.get("/api/collections/" + cid)
	vp := vr.body["frames"].([]any)[0].(map[string]any)["photos"].([]any)[0].(map[string]any)
	if vp["title"] != "Shown" || vp["caption"] != "Cap" {
		t.Errorf("public read %v", vp)
	}
	var cu, pu int64
	_ = e.d.QueryRow(`SELECT updated_at FROM collections WHERE id=?`, cid).Scan(&cu)
	_ = e.d.QueryRow(`SELECT updated_at FROM photos WHERE id=?`, p).Scan(&pu)
	if cu != t0+2000 || pu != t0+2000 {
		t.Errorf("updated_at collection %d photo %d", cu, pu)
	}
}

// --- ifUpdatedAt ---

func TestCollectionIfUpdatedAt(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	cid := u.newCollection("A")
	e.now.Add(1000)
	// omitted: writes
	if r := u.updateCollection(cid, map[string]any{"title": "B"}); r.code != 200 || r.body["updatedAt"] != float64(t0+1000) {
		t.Fatalf("omitted: %d %s", r.code, r.raw)
	}
	e.now.Add(1000)
	// matching: writes
	if r := u.updateCollection(cid, map[string]any{"title": "C", "ifUpdatedAt": t0 + 1000}); r.code != 200 || r.body["updatedAt"] != float64(t0+2000) {
		t.Fatalf("matching: %d %s", r.code, r.raw)
	}
	e.now.Add(1000)
	// stale: 409 with the current value, no write
	r := u.updateCollection(cid, map[string]any{"title": "D", "ifUpdatedAt": t0 + 1000})
	if r.code != 409 || r.errMsg() != "这个合集在别处被修改过。" || r.body["updatedAt"] != float64(t0+2000) || len(r.body) != 2 {
		t.Fatalf("stale: %d %s", r.code, r.raw)
	}
	var title string
	_ = e.d.QueryRow(`SELECT title FROM collections WHERE id=?`, cid).Scan(&title)
	if title != "C" {
		t.Fatalf("stale wrote %q", title)
	}
	if r := u.updateCollection(cid, map[string]any{"ifUpdatedAt": "x"}); r.code != 400 {
		t.Errorf("bad type: %d", r.code)
	}
	// Another user's collection stays 404, not 409.
	if r := e.user("u2").updateCollection(cid, map[string]any{"ifUpdatedAt": 1}); r.code != 404 {
		t.Errorf("other user: %d %s", r.code, r.raw)
	}
}

func TestFramesIfUpdatedAt(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	cid := u.newCollection("A")
	a := e.readyPhoto("u1")
	path := "/api/collections/" + cid + "/frames"
	e.now.Add(1000)
	// omitted, object body
	r := u.put(path, jsonBody(map[string]any{"frames": []frameIn{full(a)}}))
	if r.code != 200 || r.body["updatedAt"] != float64(t0+1000) {
		t.Fatalf("omitted: %d %s", r.code, r.raw)
	}
	if f := r.body["frames"].([]any); len(f) != 1 || f[0].(map[string]any)["layout"] != "full" {
		t.Fatalf("frames: %s", r.raw)
	}
	e.now.Add(1000)
	// matching
	r = u.put(path, jsonBody(map[string]any{"frames": []frameIn{full(a), textFrame("x")}, "ifUpdatedAt": t0 + 1000}))
	if r.code != 200 || r.body["updatedAt"] != float64(t0+2000) || len(r.body["frames"].([]any)) != 2 {
		t.Fatalf("matching: %d %s", r.code, r.raw)
	}
	e.now.Add(1000)
	// stale
	r = u.put(path, jsonBody(map[string]any{"frames": []frameIn{}, "ifUpdatedAt": t0 + 1000}))
	if r.code != 409 || r.errMsg() != "这个合集在别处被修改过。" || r.body["updatedAt"] != float64(t0+2000) || len(r.body) != 2 {
		t.Fatalf("stale: %d %s", r.code, r.raw)
	}
	if n := len(e.framesOf(cid)); n != 2 {
		t.Fatalf("stale wrote: %d frames", n)
	}
	// bare array still works
	e.now.Add(1000)
	r = u.put(path, "  \n"+jsonBody([]frameIn{textFrame("only")}))
	if r.code != 200 || r.body["updatedAt"] != float64(t0+4000) || len(r.body["frames"].([]any)) != 1 {
		t.Fatalf("bare array: %d %s", r.code, r.raw)
	}
	for _, body := range []string{`[] []`, `[{"layout":"text","text":"x","slot":1}]`, `"x"`, `{"frames":[],"ifUpdatedAt":"x"}`, `{"frames":[],"x":1}`} {
		if r := u.put(path, body); r.code != 400 {
			t.Errorf("%s: %d %s", body, r.code, r.raw)
		}
	}
}

// --- create prefill ---

func TestCreatePrefill(t *testing.T) {
	e := newEnv(t)
	u1, u2 := e.user("u1"), e.user("u2")
	if r := u1.put("/api/upload-prefs", prefsBody(map[string]any{"defaultLicense": "by-nc", "defaultAiDeclaration": "no-generative-ai"})); r.code != 200 {
		t.Fatalf("prefs: %d %s", r.code, r.raw)
	}
	r := u1.post("/api/collections", `{"title":"P"}`)
	if r.code != 201 || r.body["license"] != "by-nc" || r.body["aiDeclaration"] != "no-generative-ai" {
		t.Fatalf("with prefs: %d %s", r.code, r.raw)
	}
	r = u2.post("/api/collections", `{"title":"Q"}`)
	if r.code != 201 || r.body["license"] != nil || r.body["aiDeclaration"] != nil {
		t.Fatalf("without prefs: %d %s", r.code, r.raw)
	}
	// A prefs row with null defaults prefills null.
	if r := u2.put("/api/upload-prefs", prefsBody(nil)); r.code != 200 {
		t.Fatal(r.raw)
	}
	if r := u2.post("/api/collections", `{"title":"R"}`); r.body["license"] != nil || r.body["aiDeclaration"] != nil {
		t.Fatalf("null prefs: %s", r.raw)
	}
}

// --- every collection write reports updatedAt ---

func TestCollectionWritesReportUpdatedAt(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	cid := u.newCollection("A")
	a, b := e.readyPhoto("u1"), e.readyPhoto("u1")
	u.mustFrames(cid, full(a), full(b))
	step := func(name string, r resp) {
		t.Helper()
		var n int64
		_ = e.d.QueryRow(`SELECT updated_at FROM collections WHERE id=?`, cid).Scan(&n)
		if r.code != 200 || r.body["updatedAt"] != float64(n) || n != e.now.Load() {
			t.Errorf("%s: %d updated_at=%d now=%d %s", name, r.code, n, e.now.Load(), r.raw)
		}
	}
	e.now.Add(1000)
	step("publish", u.post("/api/collections/"+cid+"/publish", ""))
	e.now.Add(1000)
	step("unpublish", u.post("/api/collections/"+cid+"/unpublish", ""))
	e.now.Add(1000)
	step("override", u.put("/api/collections/"+cid+"/overrides/"+a, `{}`))
	e.now.Add(1000)
	if r := u.del("/api/photos/" + b); r.code != 204 {
		t.Fatal(r.raw)
	}
	var n int64
	_ = e.d.QueryRow(`SELECT updated_at FROM collections WHERE id=?`, cid).Scan(&n)
	if n != e.now.Load() {
		t.Errorf("photo delete pruning: updated_at %d", n)
	}
}

func TestPutPhotoReturnsBumpedCollections(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	p, lone := e.readyPhoto("u1"), e.readyPhoto("u1")
	c1, c2 := u.newCollection("one"), u.newCollection("two")
	u.mustFrames(c1, full(p))
	u.mustFrames(c2, full(p), textFrame("x"))
	e.now.Add(1000)
	r := u.put("/api/photos/"+p, `{"title":"T","caption":""}`)
	if r.code != 200 || r.body["id"] != p || r.body["title"] != "T" || r.body["status"] != "ready" {
		t.Fatalf("%d %s", r.code, r.raw)
	}
	want := []string{c1, c2}
	sort.Strings(want)
	cs, _ := r.body["collections"].([]any)
	if len(cs) != 2 {
		t.Fatalf("collections %s", r.raw)
	}
	for i, x := range cs {
		m := x.(map[string]any)
		if m["id"] != want[i] || m["updatedAt"] != float64(t0+1000) || len(m) != 2 {
			t.Errorf("collections[%d] %v", i, m)
		}
	}
	// The returned value is a fresh ifUpdatedAt: no self-conflict.
	e.now.Add(1000)
	if r := u.updateCollection(c1, map[string]any{"ifUpdatedAt": t0 + 1000}); r.code != 200 {
		t.Fatalf("follow-up update: %d %s", r.code, r.raw)
	}
	if r := u.put("/api/collections/"+c2+"/frames", jsonBody(map[string]any{"frames": []frameIn{full(p)}, "ifUpdatedAt": t0 + 1000})); r.code != 200 {
		t.Fatalf("follow-up frames: %d %s", r.code, r.raw)
	}
	// A photo in no collection lists none.
	r = u.put("/api/photos/"+lone, `{"title":"","caption":""}`)
	if cs, ok := r.body["collections"].([]any); r.code != 200 || !ok || len(cs) != 0 {
		t.Fatalf("lone: %d %s", r.code, r.raw)
	}
}
