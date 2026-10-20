package api_test

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"testing"
)

// --- helpers ---

// readyPhoto inserts a ready photo owned by owner and returns its id.
func (e *env) readyPhoto(owner string) string {
	e.t.Helper()
	id := newID()
	sum := sha256.Sum256([]byte(id))
	e.insertPhoto(owner, id, "ready", hex.EncodeToString(sum[:]))
	e.exec(`UPDATE photos SET latitude=1.5,longitude=2.5,public_fields='["iso","camera"]' WHERE id=?`, id)
	return id
}

func jsonBody(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(b)
}

// newCollection creates a collection through the API and returns its id.
func (c *client) newCollection(title string) string {
	c.e.t.Helper()
	r := c.post("/api/collections", jsonBody(map[string]any{"title": title}))
	if r.code != 201 {
		c.e.t.Fatalf("create collection: %d %s", r.code, r.raw)
	}
	return r.body["id"].(string)
}

type frameIn map[string]any

func full(id string) frameIn     { return frameIn{"layout": "full", "photoIds": []string{id}} }
func pair(ids ...string) frameIn { return frameIn{"layout": "pair", "photoIds": ids} }
func textFrame(s string) frameIn { return frameIn{"layout": "text", "text": s} }

func (c *client) setFrames(cid string, frames ...frameIn) resp {
	c.e.t.Helper()
	if frames == nil {
		frames = []frameIn{}
	}
	return c.put("/api/collections/"+cid+"/frames", jsonBody(map[string]any{"frames": frames}))
}

func (c *client) mustFrames(cid string, frames ...frameIn) {
	c.e.t.Helper()
	if r := c.setFrames(cid, frames...); r.code != 200 {
		c.e.t.Fatalf("frames: %d %s", r.code, r.raw)
	}
}

func collectionBody(over map[string]any) string {
	b := map[string]any{"title": "T", "intro": "", "visibility": "private", "distribute": true,
		"originalDownload": false, "license": nil, "aiDeclaration": nil, "coverPhotoId": nil}
	for k, v := range over {
		if v == "<omit>" {
			delete(b, k)
		} else {
			b[k] = v
		}
	}
	return jsonBody(b)
}

func (c *client) updateCollection(cid string, over map[string]any) resp {
	return c.put("/api/collections/"+cid, collectionBody(over))
}

// publishPublic makes cid a published public collection.
func (c *client) publishPublic(cid string) {
	c.e.t.Helper()
	if r := c.updateCollection(cid, map[string]any{"visibility": "public"}); r.code != 200 {
		c.e.t.Fatalf("visibility: %d %s", r.code, r.raw)
	}
	if r := c.post("/api/collections/"+cid+"/publish", ""); r.code != 200 {
		c.e.t.Fatalf("publish: %d %s", r.code, r.raw)
	}
}

// rotated returns the sorted photoIds of queued rotate_derived jobs.
func (e *env) rotated() []string {
	e.t.Helper()
	var out []string
	for _, j := range e.jobs() {
		if j.Kind != "rotate_derived" {
			continue
		}
		var p map[string]string
		if err := json.Unmarshal([]byte(j.Payload), &p); err != nil {
			e.t.Fatal(err)
		}
		if len(p) != 1 || p["photoId"] == "" {
			e.t.Fatalf("payload %s", j.Payload)
		}
		out = append(out, p["photoId"])
	}
	sort.Strings(out)
	return out
}

func sorted(ids ...string) []string {
	out := append([]string(nil), ids...)
	sort.Strings(out)
	return out
}

func sameIDs(a, b []string) bool {
	return strings.Join(a, ",") == strings.Join(b, ",")
}

// --- auth ---

func TestWriteRoutesRequireLoginAndCSRF(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	cid := u.newCollection("A")
	pid := e.readyPhoto("u1")
	aid := newID()
	routes := []struct{ method, path, body string }{
		{http.MethodPost, "/api/collections", `{"title":"x"}`},
		{http.MethodPut, "/api/collections/" + cid, collectionBody(nil)},
		{http.MethodDelete, "/api/collections/" + cid, ""},
		{http.MethodPut, "/api/collections/" + cid + "/frames", `{"frames":[]}`},
		{http.MethodPost, "/api/collections/" + cid + "/publish?dry_run=1", ""},
		{http.MethodPost, "/api/collections/" + cid + "/publish", ""},
		{http.MethodPost, "/api/collections/" + cid + "/unpublish", ""},
		{http.MethodPut, "/api/collections/" + cid + "/overrides/" + pid, `{}`},
		{http.MethodDelete, "/api/photos/" + pid, ""},
		{http.MethodPost, "/api/albums", `{"title":"x","visibility":"private"}`},
		{http.MethodPut, "/api/albums/" + aid, `{"title":"x","visibility":"private"}`},
		{http.MethodDelete, "/api/albums/" + aid, ""},
		{http.MethodPut, "/api/albums/" + aid + "/items", `{"collectionIds":[]}`},
		{http.MethodPut, "/api/profile", `{"name":"n","bio":"","wallLayout":"grid"}`},
		{http.MethodPut, "/api/upload-prefs", `{}`},
	}
	anon := e.anon()
	for _, rt := range routes {
		if r := anon.do(rt.method, rt.path, rt.body, nil); r.code != 401 {
			t.Errorf("anon %s %s: %d %s", rt.method, rt.path, r.code, r.raw)
		}
		for name, hdr := range map[string]map[string]string{
			"no csrf":      {"X-CSRF-Token": "<delete>"},
			"wrong origin": {"Origin": "https://evil.example"},
		} {
			if r := u.do(rt.method, rt.path, rt.body, hdr); r.code != 403 {
				t.Errorf("%s %s %s: %d %s", name, rt.method, rt.path, r.code, r.raw)
			}
		}
	}
	if r := anon.get("/api/upload-prefs"); r.code != 401 {
		t.Errorf("anon prefs: %d", r.code)
	}
	var n int
	_ = e.d.QueryRow(`SELECT (SELECT count(*) FROM collections)+(SELECT count(*) FROM albums)+
		(SELECT count(*) FROM profiles)+(SELECT count(*) FROM upload_prefs)`).Scan(&n)
	if n != 1 || len(e.jobs()) != 0 {
		t.Fatalf("writes leaked through: %d collections, %d jobs", n, len(e.jobs()))
	}
	if st, _ := e.status(pid); st != "ready" {
		t.Fatal("photo deleted without auth")
	}
}

// --- create / update / delete ---

func TestCreateCollection(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	r := u.post("/api/collections", `{"title":"  First\u0007 "}`)
	if r.code != 201 {
		t.Fatalf("%d %s", r.code, r.raw)
	}
	want := map[string]any{"title": "First", "intro": "", "status": "draft", "visibility": "private",
		"distribute": true, "originalDownload": false, "license": nil, "aiDeclaration": nil,
		"coverPhotoId": nil, "publishedAt": nil, "wallRank": 1.0, "createdAt": float64(t0), "updatedAt": float64(t0)}
	for k, v := range want {
		if r.body[k] != v {
			t.Errorf("%s = %v, want %v", k, r.body[k], v)
		}
	}
	if f, ok := r.body["frames"].([]any); !ok || len(f) != 0 {
		t.Errorf("frames: %s", r.raw)
	}
	if r2 := u.post("/api/collections", `{"title":"Second"}`); r2.body["wallRank"] != 2.0 {
		t.Errorf("wallRank: %s", r2.raw)
	}
	// Another owner's ranks are independent.
	if r3 := e.user("u2").post("/api/collections", `{"title":"Other"}`); r3.body["wallRank"] != 1.0 {
		t.Errorf("u2 wallRank: %s", r3.raw)
	}
	for _, body := range []string{`{"title":""}`, `{"title":"  "}`, `{}`, `{"title":"x","extra":1}`,
		jsonBody(map[string]any{"title": strings.Repeat("字", 121)})} {
		if r := u.post("/api/collections", body); r.code != 400 {
			t.Errorf("%s: %d %s", body, r.code, r.raw)
		}
	}
	if r := u.post("/api/collections", jsonBody(map[string]any{"title": strings.Repeat("字", 120)})); r.code != 201 {
		t.Errorf("120 runes: %d", r.code)
	}
}

func TestUpdateCollectionValidation(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	cid := u.newCollection("A")
	e.user("u2")
	inFrames := e.readyPhoto("u1")
	notInFrames := e.readyPhoto("u1")
	others := e.readyPhoto("u2")
	u.mustFrames(cid, full(inFrames))
	for name, over := range map[string]map[string]any{
		"empty title":      {"title": ""},
		"long title":       {"title": strings.Repeat("a", 121)},
		"long intro":       {"intro": strings.Repeat("a", 2001)},
		"bad visibility":   {"visibility": "secret"},
		"bad license":      {"license": "cc0"},
		"bad ai":           {"aiDeclaration": "yes"},
		"cover not frames": {"coverPhotoId": notInFrames},
		"cover others":     {"coverPhotoId": others},
		"cover unknown":    {"coverPhotoId": newID()},
		"missing title":    {"title": "<omit>"},
		"missing vis":      {"visibility": "<omit>"},
		"missing dist":     {"distribute": "<omit>"},
		"missing orig":     {"originalDownload": "<omit>"},
		"wrong type":       {"distribute": "yes"},
		"unknown field":    {"status": "published"},
	} {
		if r := u.updateCollection(cid, over); r.code != 400 {
			t.Errorf("%s: %d %s", name, r.code, r.raw)
		}
	}
	var title string
	_ = e.d.QueryRow(`SELECT title FROM collections WHERE id=?`, cid).Scan(&title)
	if title != "A" {
		t.Fatalf("invalid update wrote: %q", title)
	}
}

func TestUpdateCollectionSuccess(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	cid := u.newCollection("A")
	p := e.readyPhoto("u1")
	u.mustFrames(cid, full(p))
	e.now.Add(1000)
	r := u.updateCollection(cid, map[string]any{"title": "B", "intro": "line1\r\nline2‮", "visibility": "unlisted",
		"distribute": false, "originalDownload": true, "license": "by-nc", "aiDeclaration": "no-generative-ai", "coverPhotoId": p})
	if r.code != 200 {
		t.Fatalf("%d %s", r.code, r.raw)
	}
	want := map[string]any{"title": "B", "intro": "line1\nline2", "visibility": "unlisted", "distribute": false,
		"originalDownload": true, "license": "by-nc", "aiDeclaration": "no-generative-ai", "coverPhotoId": p,
		"status": "draft", "updatedAt": float64(t0 + 1000), "createdAt": float64(t0)}
	for k, v := range want {
		if r.body[k] != v {
			t.Errorf("%s = %v, want %v", k, r.body[k], v)
		}
	}
	if f, _ := r.body["frames"].([]any); len(f) != 1 {
		t.Errorf("frames: %s", r.raw)
	}
	// Nullable fields can be cleared; intro may be omitted.
	r = u.updateCollection(cid, map[string]any{"intro": "<omit>", "license": "<omit>", "coverPhotoId": nil})
	if r.code != 200 || r.body["license"] != nil || r.body["coverPhotoId"] != nil || r.body["intro"] != "" {
		t.Fatalf("clear: %d %s", r.code, r.raw)
	}
}

func TestDeleteCollection(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	cid := u.newCollection("A")
	u.mustFrames(cid, full(e.readyPhoto("u1")))
	if r := u.del("/api/collections/" + cid); r.code != 204 {
		t.Fatalf("%d %s", r.code, r.raw)
	}
	var n int
	_ = e.d.QueryRow(`SELECT (SELECT count(*) FROM collections)+(SELECT count(*) FROM frames)`).Scan(&n)
	if n != 0 {
		t.Fatalf("%d rows left", n)
	}
	if r := u.del("/api/collections/" + cid); r.code != 404 {
		t.Fatalf("second delete: %d", r.code)
	}
}

func TestCollectionNonOwnerGets404(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	mallory := e.user("u2")
	cid := u.newCollection("A")
	p := e.readyPhoto("u1")
	u.mustFrames(cid, full(p))
	mp := e.readyPhoto("u2")
	for _, rt := range []struct{ method, path, body string }{
		{http.MethodPut, "/api/collections/" + cid, collectionBody(map[string]any{"title": "pwned"})},
		{http.MethodDelete, "/api/collections/" + cid, ""},
		{http.MethodPut, "/api/collections/" + cid + "/frames", jsonBody(map[string]any{"frames": []frameIn{full(mp)}})},
		{http.MethodPost, "/api/collections/" + cid + "/publish?dry_run=1", ""},
		{http.MethodPost, "/api/collections/" + cid + "/publish", ""},
		{http.MethodPost, "/api/collections/" + cid + "/unpublish", ""},
		{http.MethodPut, "/api/collections/" + cid + "/overrides/" + p, `{"publicFields":[]}`},
		{http.MethodDelete, "/api/photos/" + p, ""},
		{http.MethodPut, "/api/collections/not-a-uuid", collectionBody(nil)},
		{http.MethodPut, "/api/collections/" + newID(), collectionBody(nil)},
	} {
		if r := mallory.do(rt.method, rt.path, rt.body, nil); r.code != 404 {
			t.Errorf("%s %s: %d %s", rt.method, rt.path, r.code, r.raw)
		}
	}
	var title, status string
	var frames, overrides int
	_ = e.d.QueryRow(`SELECT title,status,(SELECT count(*) FROM frames),(SELECT count(*) FROM photo_overrides) FROM collections WHERE id=?`, cid).
		Scan(&title, &status, &frames, &overrides)
	if title != "A" || status != "draft" || frames != 1 || overrides != 0 {
		t.Fatalf("mutated: %s %s %d %d", title, status, frames, overrides)
	}
	if st, _ := e.status(p); st != "ready" {
		t.Fatal("photo deleted by non-owner")
	}
}

// --- frames ---

func TestFramesValidation(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	cid := u.newCollection("A")
	e.user("u2")
	a, b, c, d := e.readyPhoto("u1"), e.readyPhoto("u1"), e.readyPhoto("u1"), e.readyPhoto("u1")
	others := e.readyPhoto("u2")
	processing := newID()
	e.insertPhoto("u1", processing, "processing", shaB)
	many := make([]frameIn, 201)
	for i := range many {
		many[i] = textFrame("x")
	}
	cases := map[string][]frameIn{
		"201 frames":           many,
		"unknown layout":       {{"layout": "grid", "photoIds": []string{a}}},
		"full 0 photos":        {{"layout": "full"}},
		"full 2 photos":        {{"layout": "full", "photoIds": []string{a, b}}},
		"pair 1 photo":         {pair(a)},
		"pair 4 photos":        {pair(a, b, c, d)},
		"pair duplicate":       {pair(a, a)},
		"text with photo":      {{"layout": "text", "text": "x", "photoIds": []string{a}}},
		"text empty":           {textFrame("")},
		"text blank":           {textFrame(" \u0007 ")},
		"text too long":        {textFrame(strings.Repeat("字", 2001))},
		"text missing":         {{"layout": "text"}},
		"text on full":         {{"layout": "full", "text": "x", "photoIds": []string{a}}},
		"matted no ratio":      {{"layout": "matted", "photoIds": []string{a}}},
		"matted 0.49":          {{"layout": "matted", "matteRatio": 0.49, "photoIds": []string{a}}},
		"matted 0.96":          {{"layout": "matted", "matteRatio": 0.96, "photoIds": []string{a}}},
		"matted 2 photos":      {{"layout": "matted", "matteRatio": 0.8, "photoIds": []string{a, b}}},
		"ratio on full":        {{"layout": "full", "matteRatio": 0.8, "photoIds": []string{a}}},
		"ratio on text":        {{"layout": "text", "matteRatio": 0.8, "text": "x"}},
		"others photo":         {full(others)},
		"others photo in pair": {pair(a, others)},
		"unknown photo":        {full(newID())},
		"processing photo":     {full(processing)},
		"unknown field":        {{"layout": "full", "photoIds": []string{a}, "slot": 1}},
	}
	for name, frames := range cases {
		if r := u.setFrames(cid, frames...); r.code != 400 {
			t.Errorf("%s: %d %s", name, r.code, r.raw)
		}
	}
	for _, body := range []string{`{}`, `{"frames":null}`, `null`} {
		if r := u.put("/api/collections/"+cid+"/frames", body); r.code != 400 {
			t.Errorf("%s: %d %s", body, r.code, r.raw)
		}
	}
	var n int
	_ = e.d.QueryRow(`SELECT count(*) FROM frames`).Scan(&n)
	if n != 0 {
		t.Fatalf("invalid sequence wrote %d frames", n)
	}

	// The boundaries are accepted.
	ok := make([]frameIn, 200)
	for i := range ok {
		ok[i] = textFrame("x")
	}
	ok[0] = frameIn{"layout": "matted", "matteRatio": 0.5, "photoIds": []string{a}}
	ok[1] = frameIn{"layout": "matted", "matteRatio": 0.95, "photoIds": []string{a}}
	ok[2] = pair(a, b, c)
	ok[3] = textFrame(strings.Repeat("字", 2000))
	if r := u.setFrames(cid, ok...); r.code != 200 {
		t.Fatalf("200 frames: %d %s", r.code, r.raw)
	}
}

func TestFramesReplace(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	cid := u.newCollection("A")
	a, b, c := e.readyPhoto("u1"), e.readyPhoto("u1"), e.readyPhoto("u1")
	u.mustFrames(cid, full(a), pair(b, c))
	if r := u.updateCollection(cid, map[string]any{"coverPhotoId": a}); r.code != 200 {
		t.Fatalf("cover: %d %s", r.code, r.raw)
	}
	r := u.setFrames(cid, textFrame("hello\nworld"), frameIn{"layout": "matted", "matteRatio": 0.8, "photoIds": []string{c}}, pair(c, b))
	if r.code != 200 {
		t.Fatalf("%d %s", r.code, r.raw)
	}
	if r.body["coverPhotoId"] != nil {
		t.Errorf("cover kept after its photo left: %s", r.raw)
	}
	frames, _ := r.body["frames"].([]any)
	if len(frames) != 3 {
		t.Fatalf("frames: %s", r.raw)
	}
	type fv struct {
		ID         string   `json:"id"`
		Position   int      `json:"position"`
		Layout     string   `json:"layout"`
		MatteRatio *float64 `json:"matteRatio"`
		Text       *string  `json:"text"`
		PhotoIDs   []string `json:"photoIds"`
	}
	var got []fv
	b2, _ := json.Marshal(frames)
	if err := json.Unmarshal(b2, &got); err != nil {
		t.Fatal(err)
	}
	if got[0].Layout != "text" || got[0].Text == nil || *got[0].Text != "hello\nworld" || len(got[0].PhotoIDs) != 0 || got[0].MatteRatio != nil ||
		got[1].Layout != "matted" || *got[1].MatteRatio != 0.8 || !sameIDs(got[1].PhotoIDs, []string{c}) || got[1].Text != nil ||
		got[2].Layout != "pair" || !sameIDs(got[2].PhotoIDs, []string{c, b}) {
		t.Fatalf("frames: %s", r.raw)
	}
	for i, f := range got {
		if f.Position != i || f.ID == "" {
			t.Errorf("frame %d: %+v", i, f)
		}
	}
	var n int
	_ = e.d.QueryRow(`SELECT count(*) FROM frames`).Scan(&n)
	if n != 3 {
		t.Fatalf("%d frames in db", n)
	}
	// A cover still present survives a replacement.
	if r := u.updateCollection(cid, map[string]any{"coverPhotoId": b}); r.code != 200 {
		t.Fatal(r.raw)
	}
	if r := u.setFrames(cid, full(b)); r.body["coverPhotoId"] != b {
		t.Errorf("cover dropped: %s", r.raw)
	}
	// An empty sequence is allowed.
	if r := u.setFrames(cid); r.code != 200 {
		t.Errorf("empty: %d %s", r.code, r.raw)
	}
}

// --- publish ---

func TestPublishDryRunManifest(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	cid := u.newCollection("A")
	a, b := e.readyPhoto("u1"), e.readyPhoto("u1") // snapshot ["iso","camera"], histogram 0
	e.exec(`UPDATE photos SET public_fields='["lens"]' WHERE id=?`, b)
	u.mustFrames(cid, full(a), pair(a, b), textFrame("x"))
	if r := u.updateCollection(cid, map[string]any{"visibility": "public", "originalDownload": true}); r.code != 200 {
		t.Fatal(r.raw)
	}
	// Override a: hide camera, show histogram.
	if r := u.put("/api/collections/"+cid+"/overrides/"+a, `{"publicFields":["iso","taken_date"],"histogramPublic":true}`); r.code != 200 {
		t.Fatalf("override: %d %s", r.code, r.raw)
	}
	r := u.post("/api/collections/"+cid+"/publish?dry_run=1", "")
	if r.code != 200 {
		t.Fatalf("%d %s", r.code, r.raw)
	}
	pf, _ := r.body["publicFields"].([]any)
	var fields []string
	for _, f := range pf {
		fields = append(fields, f.(string))
	}
	if r.body["photos"] != 2.0 || !sameIDs(fields, []string{"iso", "lens", "taken_date"}) || r.body["histogram"] != true ||
		r.body["originalDownload"] != true || r.body["visibility"] != "public" || r.body["inSquare"] != true || r.body["updatedAt"] == nil || len(r.body) != 7 {
		t.Fatalf("manifest: %s", r.raw)
	}
	var status string
	_ = e.d.QueryRow(`SELECT status FROM collections WHERE id=?`, cid).Scan(&status)
	if status != "draft" {
		t.Fatal("dry run published")
	}
	// Without the override the histogram is not exposed; distribute=0 leaves the square.
	if r := u.put("/api/collections/"+cid+"/overrides/"+a, `{"publicFields":null,"histogramPublic":null}`); r.code != 200 {
		t.Fatal(r.raw)
	}
	_ = u.updateCollection(cid, map[string]any{"visibility": "public", "distribute": false})
	r = u.post("/api/collections/"+cid+"/publish?dry_run=1", "")
	pf, _ = r.body["publicFields"].([]any)
	if r.body["histogram"] != false || r.body["inSquare"] != false || r.body["originalDownload"] != false || len(pf) != 3 {
		t.Fatalf("manifest 2: %s", r.raw)
	}
}

func TestPublishAndUnpublish(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	cid := u.newCollection("A")
	if r := u.post("/api/collections/"+cid+"/publish", ""); r.code != 400 {
		t.Fatalf("empty publish: %d %s", r.code, r.raw)
	}
	if r := u.post("/api/collections/"+cid+"/publish?dry_run=1", ""); r.code != 400 {
		t.Fatalf("empty dry run: %d %s", r.code, r.raw)
	}
	u.mustFrames(cid, textFrame("words only"))
	e.now.Add(5000)
	r := u.post("/api/collections/"+cid+"/publish", "")
	if r.code != 200 || r.body["status"] != "published" || r.body["publishedAt"] != float64(t0+5000) {
		t.Fatalf("publish: %d %s", r.code, r.raw)
	}
	e.now.Add(5000)
	if r := u.post("/api/collections/"+cid+"/unpublish", ""); r.code != 200 || r.body["status"] != "draft" || r.body["publishedAt"] != float64(t0+5000) {
		t.Fatalf("unpublish: %d %s", r.code, r.raw)
	}
	// published_at is only set the first time.
	if r := u.post("/api/collections/"+cid+"/publish", ""); r.body["publishedAt"] != float64(t0+5000) {
		t.Fatalf("republish: %s", r.raw)
	}
	if r := u.post("/api/collections/"+cid+"/publish?dry_run=yes", ""); r.code != 400 {
		t.Errorf("bad dry_run: %d", r.code)
	}
}

// --- overrides ---

func TestOverrides(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	cid := u.newCollection("A")
	a, notIn := e.readyPhoto("u1"), e.readyPhoto("u1")
	u.mustFrames(cid, full(a))
	path := "/api/collections/" + cid + "/overrides/"
	for name, body := range map[string]string{
		"bad field":     `{"publicFields":["gps"]}`,
		"location":      `{"publicFields":["location"]}`,
		"duplicate":     `{"publicFields":["iso","iso"]}`,
		"wrong type":    `{"histogramPublic":"yes"}`,
		"unknown field": `{"originalDownload":true}`,
	} {
		if r := u.put(path+a, body); r.code != 400 {
			t.Errorf("%s: %d %s", name, r.code, r.raw)
		}
	}
	if r := u.put(path+notIn, `{"publicFields":[]}`); r.code != 404 {
		t.Errorf("not in collection: %d %s", r.code, r.raw)
	}
	r := u.put(path+a, `{"publicFields":[],"histogramPublic":false}`)
	if r.code != 200 || r.body["photoId"] != a || r.body["collectionId"] != cid || r.body["histogramPublic"] != false {
		t.Fatalf("%d %s", r.code, r.raw)
	}
	if pf, ok := r.body["publicFields"].([]any); !ok || len(pf) != 0 {
		t.Fatalf("empty override lost: %s", r.raw)
	}
	var fields string
	_ = e.d.QueryRow(`SELECT public_fields FROM photo_overrides WHERE collection_id=? AND photo_id=?`, cid, a).Scan(&fields)
	if fields != "[]" {
		t.Fatalf("stored %q", fields)
	}
	// Upsert: absent fields reset to "not overridden".
	r = u.put(path+a, `{"publicFields":["lens"]}`)
	if r.code != 200 || r.body["histogramPublic"] != nil {
		t.Fatalf("%s", r.raw)
	}
	var n int
	_ = e.d.QueryRow(`SELECT count(*) FROM photo_overrides`).Scan(&n)
	if n != 1 {
		t.Fatalf("%d rows", n)
	}
}

// --- withdrawal ---

func TestWithdrawalOnVisibilityChange(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	a, b, shared := e.readyPhoto("u1"), e.readyPhoto("u1"), e.readyPhoto("u1")
	c1 := u.newCollection("one")
	c2 := u.newCollection("two")
	u.mustFrames(c1, full(a), pair(b, shared))
	u.mustFrames(c2, full(shared))
	u.publishPublic(c1)
	u.publishPublic(c2)
	if got := e.rotated(); len(got) != 0 {
		t.Fatalf("publishing enqueued %v", got)
	}
	// distribute and other edits that keep c1 public do nothing.
	if r := u.updateCollection(c1, map[string]any{"visibility": "public", "distribute": false, "title": "x"}); r.code != 200 {
		t.Fatal(r.raw)
	}
	if got := e.rotated(); len(got) != 0 {
		t.Fatalf("distribute change enqueued %v", got)
	}
	// public -> private: a and b leave every public collection, shared stays in c2.
	if r := u.updateCollection(c1, map[string]any{"visibility": "private"}); r.code != 200 {
		t.Fatal(r.raw)
	}
	if got := e.rotated(); !sameIDs(got, sorted(a, b)) {
		t.Fatalf("rotated %v, want %v", got, sorted(a, b))
	}
	// c2 public -> unlisted: shared leaves CDN exposure (final review I1).
	if r := u.updateCollection(c2, map[string]any{"visibility": "unlisted"}); r.code != 200 {
		t.Fatal(r.raw)
	}
	if got := e.rotated(); !sameIDs(got, sorted(a, b, shared)) {
		t.Fatalf("rotated %v", got)
	}
	// c2 unlisted -> private: shared leaves hash exposure too, so it rotates again.
	if r := u.updateCollection(c2, map[string]any{"visibility": "private"}); r.code != 200 {
		t.Fatal(r.raw)
	}
	if got := e.rotated(); !sameIDs(got, sorted(a, b, shared, shared)) {
		t.Fatalf("rotated %v", got)
	}
}

func TestWithdrawalOnUnpublishDeleteAndFrames(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	a, b, c, d := e.readyPhoto("u1"), e.readyPhoto("u1"), e.readyPhoto("u1"), e.readyPhoto("u1")
	c1 := u.newCollection("one")
	c2 := u.newCollection("two")
	draft := u.newCollection("draft")
	u.mustFrames(c1, full(a), full(b))
	u.mustFrames(c2, full(c), full(d))
	u.mustFrames(draft, full(a))
	u.publishPublic(c1)
	u.publishPublic(c2)

	// Frame replacement dropping b.
	u.mustFrames(c1, full(a))
	if got := e.rotated(); !sameIDs(got, []string{b}) {
		t.Fatalf("frames: rotated %v", got)
	}
	// A draft public collection never exposed anything: editing it does nothing.
	if r := u.updateCollection(draft, map[string]any{"visibility": "public"}); r.code != 200 {
		t.Fatal(r.raw)
	}
	u.mustFrames(draft)
	if got := e.rotated(); len(got) != 1 {
		t.Fatalf("draft: rotated %v", got)
	}
	// Unpublish c1: a leaves.
	if r := u.post("/api/collections/"+c1+"/unpublish", ""); r.code != 200 {
		t.Fatal(r.raw)
	}
	if got := e.rotated(); !sameIDs(got, sorted(a, b)) {
		t.Fatalf("unpublish: rotated %v", got)
	}
	// Unpublishing again changes nothing.
	_ = u.post("/api/collections/"+c1+"/unpublish", "")
	// Delete c2: c and d leave.
	if r := u.del("/api/collections/" + c2); r.code != 204 {
		t.Fatal(r.raw)
	}
	if got := e.rotated(); !sameIDs(got, sorted(a, b, c, d)) {
		t.Fatalf("delete: rotated %v", got)
	}
	// Another owner's public collection does not keep a photo exposed... and
	// cannot contain it anyway; check the u2 world is untouched.
	for _, j := range e.jobs() {
		if j.Kind != "rotate_derived" {
			t.Errorf("unexpected job %s", j.Kind)
		}
	}
}

func TestEmptyFramesOnPublishedCollection(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	a := e.readyPhoto("u1")
	cid := u.newCollection("A")
	u.mustFrames(cid, full(a))
	u.publishPublic(cid)
	if r := u.setFrames(cid); r.code != 400 || r.errMsg() != "已发布的合集至少需要一帧。" {
		t.Fatalf("%d %s", r.code, r.raw)
	}
	if got := e.framesOf(cid); len(got) != 1 {
		t.Fatalf("frames %+v", got)
	}
	if got := e.rotated(); len(got) != 0 {
		t.Fatalf("rotated %v", got)
	}
	// After unpublishing, emptying is allowed.
	_ = u.post("/api/collections/"+cid+"/unpublish", "")
	if r := u.setFrames(cid); r.code != 200 {
		t.Fatalf("draft: %d %s", r.code, r.raw)
	}
}

func TestWithdrawalFramesKeepOtherPublicExposure(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	shared, other := e.readyPhoto("u1"), e.readyPhoto("u1")
	c1 := u.newCollection("one")
	c2 := u.newCollection("two")
	u.mustFrames(c1, full(shared), full(other))
	u.mustFrames(c2, full(shared))
	u.publishPublic(c1)
	u.publishPublic(c2)
	// Dropping shared from c1 leaves it public through c2: nothing enqueued.
	u.mustFrames(c1, full(other))
	if got := e.rotated(); len(got) != 0 {
		t.Fatalf("rotated %v", got)
	}
}

// publishUnlisted makes cid a published unlisted collection.
func (c *client) publishUnlisted(cid string) {
	c.e.t.Helper()
	if r := c.updateCollection(cid, map[string]any{"visibility": "unlisted"}); r.code != 200 {
		c.e.t.Fatalf("visibility: %d %s", r.code, r.raw)
	}
	if r := c.post("/api/collections/"+cid+"/publish", ""); r.code != 200 {
		c.e.t.Fatalf("publish: %d %s", r.code, r.raw)
	}
}

// Dropping a photo from its only public collection ends CDN exposure even
// while an unlisted collection still holds it (final review I1).
func TestWithdrawalLeavingPublicRotatesDespiteUnlisted(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	a := e.readyPhoto("u1")
	pub := u.newCollection("public")
	unl := u.newCollection("unlisted")
	u.mustFrames(pub, full(a), textFrame("x"))
	u.mustFrames(unl, full(a))
	u.publishPublic(pub)
	u.publishUnlisted(unl)
	u.mustFrames(pub, textFrame("x"))
	if got := e.rotated(); !sameIDs(got, []string{a}) {
		t.Fatalf("rotated %v", got)
	}
}

// Final review I1: a rotate is enqueued when a photo leaves either the
// CDN-exposed set (published public) or the hash-exposed set (published
// public or unlisted); one write that leaves both enqueues one rotate.
func TestWithdrawalExposureTransitions(t *testing.T) {
	for _, tc := range []struct {
		name     string
		from, to string
		want     int
	}{
		{"public to unlisted", "public", "unlisted", 1},
		{"unlisted to private", "unlisted", "private", 1},
		{"public to private once", "public", "private", 1},
		{"unlisted to public", "unlisted", "public", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newEnv(t)
			u := e.user("u1")
			a := e.readyPhoto("u1")
			cid := u.newCollection("c")
			u.mustFrames(cid, full(a))
			if tc.from == "public" {
				u.publishPublic(cid)
			} else {
				u.publishUnlisted(cid)
			}
			if r := u.updateCollection(cid, map[string]any{"visibility": tc.to}); r.code != 200 {
				t.Fatal(r.raw)
			}
			got := e.rotated()
			if len(got) != tc.want || (tc.want == 1 && got[0] != a) {
				t.Fatalf("rotated %v, want %d of %s", got, tc.want, a)
			}
		})
	}
}

// A photo that stays in another published public collection keeps its CDN
// URLs, so taking one public collection private enqueues nothing for it.
func TestWithdrawalStillInOtherPublicCollection(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	a := e.readyPhoto("u1")
	c1, c2 := u.newCollection("one"), u.newCollection("two")
	u.mustFrames(c1, full(a))
	u.mustFrames(c2, full(a))
	u.publishPublic(c1)
	u.publishPublic(c2)
	for _, vis := range []string{"unlisted", "private"} {
		if r := u.updateCollection(c1, map[string]any{"visibility": vis}); r.code != 200 {
			t.Fatal(r.raw)
		}
		if got := e.rotated(); len(got) != 0 {
			t.Fatalf("%s: rotated %v", vis, got)
		}
	}
}

func TestWithdrawalUnlistedOnly(t *testing.T) {
	for _, tc := range []struct {
		name string
		act  func(u *client, cid string) resp
	}{
		{"to private", func(u *client, cid string) resp {
			return u.updateCollection(cid, map[string]any{"visibility": "private"})
		}},
		{"unpublish", func(u *client, cid string) resp { return u.post("/api/collections/"+cid+"/unpublish", "") }},
		{"delete", func(u *client, cid string) resp { return u.del("/api/collections/" + cid) }},
		{"frames", func(u *client, cid string) resp { return u.setFrames(cid, textFrame("x")) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newEnv(t)
			u := e.user("u1")
			a := e.readyPhoto("u1")
			unl := u.newCollection("unlisted")
			u.mustFrames(unl, full(a))
			u.publishUnlisted(unl)
			if r := tc.act(u, unl); r.code != 200 && r.code != 204 {
				t.Fatalf("%d %s", r.code, r.raw)
			}
			if got := e.rotated(); !sameIDs(got, []string{a}) {
				t.Fatalf("rotated %v", got)
			}
		})
	}
}

func TestWithdrawalUnlistedToPublicNoRotate(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	a := e.readyPhoto("u1")
	unl := u.newCollection("unlisted")
	u.mustFrames(unl, full(a))
	u.publishUnlisted(unl)
	if r := u.updateCollection(unl, map[string]any{"visibility": "public"}); r.code != 200 {
		t.Fatal(r.raw)
	}
	if got := e.rotated(); len(got) != 0 {
		t.Fatalf("rotated %v", got)
	}
}

// Final review M1: the maximum frame sequence (200 text frames of 2000 CJK
// runes, about 1.2 MB of JSON) fits under the request body cap.
func TestSetFramesMaxCJKTextFits(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	cid := u.newCollection("long")
	frames := make([]frameIn, maxFramesTest)
	for i := range frames {
		frames[i] = textFrame(strings.Repeat("字", 2000))
	}
	b, err := json.Marshal(map[string]any{"frames": frames})
	if err != nil {
		t.Fatal(err)
	}
	if len(b) < 1_200_000 {
		t.Fatalf("body is only %d bytes", len(b))
	}
	if r := u.put("/api/collections/"+cid+"/frames", string(b)); r.code != 200 {
		t.Fatalf("%d %.200s", r.code, r.raw)
	}
	if got := e.framesOf(cid); len(got) != maxFramesTest {
		t.Fatalf("%d frames stored", len(got))
	}
}

const maxFramesTest = 200
