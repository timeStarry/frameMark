package api_test

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

const msgSourceInvalid = "来源照片无效。"

// toolBody is an upload body with the SP5 tool fields merged in.
func toolBody(filename, sha string, extra map[string]any) string {
	m := map[string]any{"filename": filename, "bytes": 10, "sha256": sha, "contentType": "image/jpeg"}
	for k, v := range extra {
		m[k] = v
	}
	b, _ := json.Marshal(m)
	return string(b)
}

func (e *env) toolOutput(id string) int {
	e.t.Helper()
	var v int
	if err := e.d.QueryRow(`SELECT tool_output FROM photos WHERE id=?`, id).Scan(&v); err != nil {
		e.t.Fatal(err)
	}
	return v
}

func (e *env) sources(id string) []string {
	e.t.Helper()
	rows, err := e.d.Query(`SELECT source_id FROM photo_sources WHERE photo_id=? ORDER BY position`, id)
	if err != nil {
		e.t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			e.t.Fatal(err)
		}
		out = append(out, s)
	}
	return out
}

func (e *env) title(id string) string {
	e.t.Helper()
	var s string
	if err := e.d.QueryRow(`SELECT title FROM photos WHERE id=?`, id).Scan(&s); err != nil {
		e.t.Fatal(err)
	}
	return s
}

func TestUploadTitle(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	for i, tc := range []struct {
		title any
		want  string
	}{
		{"  拼图 · 6 张‮ ", "拼图 · 6 张"},
		{"a\r\nb", "ab"},
		{"", "IMG_7"},
		{"   ", "IMG_7"},
		{strings.Repeat("题", 120), strings.Repeat("题", 120)},
		{"<omit>", "IMG_7"},
	} {
		extra := map[string]any{"title": tc.title}
		if tc.title == "<omit>" {
			extra = nil
		}
		r := u.post("/api/uploads", toolBody("IMG_7.jpg", shaN(200+i), extra))
		if r.code != 201 {
			t.Fatalf("%q: %d %s", tc.title, r.code, r.raw)
		}
		if got := e.title(r.body["photoId"].(string)); got != tc.want {
			t.Errorf("%q: title %q, want %q", tc.title, got, tc.want)
		}
		e.exec(`DELETE FROM photos`)
	}
	for _, v := range []any{strings.Repeat("题", 121), 5, nil} {
		r := u.post("/api/uploads", toolBody("a.jpg", shaA, map[string]any{"title": v}))
		if r.code != 400 {
			t.Errorf("title %v: %d %s", v, r.code, r.raw)
		}
	}
	if r := u.post("/api/uploads", toolBody("a.jpg", shaA, map[string]any{"title": strings.Repeat("a", 121)})); r.errMsg() != "标题需为 0–120 个字符。" {
		t.Errorf("message %q", r.errMsg())
	}
}

func TestUploadDerivedFromValidation(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	e.user("u2")
	mine := newID()
	e.insertPhoto("u1", mine, "ready", shaN(1))
	theirs := newID()
	e.insertPhoto("u2", theirs, "ready", shaN(2))
	busy := newID()
	e.insertPhoto("u1", busy, "processing", shaN(3))

	many := make([]string, 13)
	for i := range many {
		many[i] = newID()
	}
	for name, v := range map[string]any{
		"another user's photo": []string{theirs},
		"not ready":            []string{busy},
		"unknown":              []string{newID()},
		"not a uuid":           []string{"x"},
		"empty id":             []string{""},
		"duplicates":           []string{mine, mine},
		"more than 12":         many,
		"mixed":                []string{mine, theirs},
	} {
		r := u.post("/api/uploads", toolBody("a.jpg", shaA, map[string]any{"derivedFrom": v}))
		if r.code != 400 || r.errMsg() != msgSourceInvalid {
			t.Errorf("%s: %d %s", name, r.code, r.raw)
		}
	}
	for name, v := range map[string]any{"null": nil, "string": mine, "numbers": []int{1}} {
		if r := u.post("/api/uploads", toolBody("a.jpg", shaA, map[string]any{"derivedFrom": v})); r.code != 400 {
			t.Errorf("%s: %d %s", name, r.code, r.raw)
		}
	}
	for name, v := range map[string]any{"toolOutput string": "true", "toolOutput null": nil} {
		if r := u.post("/api/uploads", toolBody("a.jpg", shaA, map[string]any{"toolOutput": v})); r.code != 400 {
			t.Errorf("%s: %d %s", name, r.code, r.raw)
		}
	}
	var n int
	_ = e.d.QueryRow(`SELECT count(*) FROM photos WHERE original_sha256=?`, shaA).Scan(&n)
	if n != 0 || len(e.st.presignCalls()) != 0 {
		t.Fatalf("invalid uploads created %d photos, %d presigns", n, len(e.st.presignCalls()))
	}
}

func TestUploadToolOutputStoresSources(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	a, b := newID(), newID()
	e.insertPhoto("u1", a, "ready", shaN(1))
	e.insertPhoto("u1", b, "ready", shaN(2))

	r := u.post("/api/uploads", toolBody("collage.jpg", shaA, map[string]any{
		"title": "拼图 · 2 张", "derivedFrom": []string{b, a}, "toolOutput": true}))
	if r.code != 201 {
		t.Fatalf("%d %s", r.code, r.raw)
	}
	id := r.body["photoId"].(string)
	if got := e.sources(id); len(got) != 2 || got[0] != b || got[1] != a {
		t.Fatalf("sources %v", got)
	}
	if e.toolOutput(id) != 1 || e.title(id) != "拼图 · 2 张" {
		t.Fatalf("tool_output %d title %q", e.toolOutput(id), e.title(id))
	}

	// A plain upload is unchanged: no sources, tool_output 0, filename title.
	e.exec(`DELETE FROM photos WHERE id=?`, id) // stay under the test quota
	plain := u.initiate(shaB, 10)
	if e.toolOutput(plain) != 0 || len(e.sources(plain)) != 0 || e.title(plain) != "IMG_0001" {
		t.Fatalf("plain: %d %v %q", e.toolOutput(plain), e.sources(plain), e.title(plain))
	}
	// An explicit empty list and false are a plain upload too.
	e.exec(`DELETE FROM photos WHERE id=?`, plain)
	r = u.post("/api/uploads", toolBody("x.jpg", shaB, map[string]any{"derivedFrom": []string{}, "toolOutput": false}))
	if r.code != 201 {
		t.Fatalf("%d %s", r.code, r.raw)
	}
	if p := r.body["photoId"].(string); e.toolOutput(p) != 0 || len(e.sources(p)) != 0 {
		t.Fatal("empty fields stored")
	}
}

func TestUploadToolFieldsOnDuplicate(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	src := newID()
	e.insertPhoto("u1", src, "ready", shaN(1))

	// Same hash as a ready photo: 200, fields ignored, nothing written.
	ready := newID()
	e.insertPhoto("u1", ready, "ready", shaN(2))
	r := u.post("/api/uploads", toolBody("a.jpg", shaN(2), map[string]any{
		"title": "New", "derivedFrom": []string{src}, "toolOutput": true}))
	if r.code != 200 || r.body["id"] != ready {
		t.Fatalf("%d %s", r.code, r.raw)
	}
	if e.toolOutput(ready) != 0 || len(e.sources(ready)) != 0 || e.title(ready) != "" {
		t.Fatalf("duplicate wrote fields: %d %v %q", e.toolOutput(ready), e.sources(ready), e.title(ready))
	}

	// A reused failed row takes the new request's fields, replacing old sources.
	failed := newID()
	e.insertPhoto("u1", failed, "failed", shaN(3))
	e.exec(`UPDATE photos SET tool_output=1 WHERE id=?`, failed)
	e.exec(`INSERT INTO photo_sources(photo_id,source_id,position) VALUES(?,?,0),(?,?,1)`, failed, newID(), failed, newID())
	r = u.post("/api/uploads", toolBody("b.jpg", shaN(3), map[string]any{"derivedFrom": []string{src}}))
	if r.code != 201 || r.body["photoId"] != failed {
		t.Fatalf("%d %s", r.code, r.raw)
	}
	if got := e.sources(failed); e.toolOutput(failed) != 0 || len(got) != 1 || got[0] != src {
		t.Fatalf("reuse: %d %v", e.toolOutput(failed), got)
	}
}

func TestSourceRead(t *testing.T) {
	e := newEnv(t)
	u1, u2, anon := e.user("u1"), e.user("u2"), e.anon()
	p := e.mediaPhoto("u1", "Title")
	path := "/api/photos/" + p + "/source"

	w := u1.raw(path)
	if w.Code != 302 {
		t.Fatalf("owner: %d %s", w.Code, w.Body.String())
	}
	g := e.st.lastGet()
	if g.Bucket != bucket || g.Key != "o/u1/"+p || g.TTL != 5*time.Minute || g.Name != "" {
		t.Fatalf("presign %+v", g)
	}
	if loc := w.Header().Get("Location"); loc != "https://storage.test/"+bucket+"/o/u1/"+p+"?get" {
		t.Fatalf("location %q", loc)
	}
	if cc := w.Header().Get("Cache-Control"); cc != "private, no-store" {
		t.Fatalf("cache-control %q", cc)
	}

	okGet := e.st.lastGet()
	for what, cl := range map[string]*client{"anonymous": anon, "other user": u2} {
		w := cl.raw(path)
		is404JSON(t, w, what)
		var body struct{ Error string }
		_ = json.Unmarshal(w.Body.Bytes(), &body)
		if body.Error != "照片不存在。" {
			t.Errorf("%s: %q", what, body.Error)
		}
	}
	is404JSON(t, u1.raw("/api/photos/"+newID()+"/source"), "unknown photo")
	is404JSON(t, u1.raw("/api/photos/nope/source"), "non-uuid")
	for _, st := range []string{"uploading", "processing", "failed"} {
		e.exec(`UPDATE photos SET status=? WHERE id=?`, st, p)
		is404JSON(t, u1.raw(path), st)
	}
	if e.st.lastGet() != okGet {
		t.Fatal("presigned for a refused request")
	}
}
