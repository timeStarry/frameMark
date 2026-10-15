package api_test

import (
	"strings"
	"testing"
)

func TestProfile(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	r := u.put("/api/profile", `{"name":"Ada","bio":"hello","wallLayout":"grid"}`)
	if r.code != 200 || r.body["name"] != "Ada" || r.body["bio"] != "hello" || r.body["wallLayout"] != "grid" ||
		r.body["userId"] != "u1" || r.body["updatedAt"] != float64(t0) {
		t.Fatalf("%d %s", r.code, r.raw)
	}
	e.now.Add(1)
	r = u.put("/api/profile", `{"name":"  Ada\u0007 ","bio":"line1\r\nline2","wallLayout":"salon"}`)
	if r.code != 200 || r.body["name"] != "Ada" || r.body["bio"] != "line1\nline2" || r.body["wallLayout"] != "salon" ||
		r.body["updatedAt"] != float64(t0+1) {
		t.Fatalf("upsert: %s", r.raw)
	}
	var n int
	_ = e.d.QueryRow(`SELECT count(*) FROM profiles`).Scan(&n)
	if n != 1 {
		t.Fatalf("%d rows", n)
	}
	for name, body := range map[string]string{
		"empty name": `{"name":"","bio":"","wallLayout":"grid"}`,
		"blank name": `{"name":"  ","bio":"","wallLayout":"grid"}`,
		"long name":  jsonBody(map[string]any{"name": strings.Repeat("字", 61), "bio": "", "wallLayout": "grid"}),
		"long bio":   jsonBody(map[string]any{"name": "a", "bio": strings.Repeat("字", 501), "wallLayout": "grid"}),
		"bad layout": `{"name":"a","bio":"","wallLayout":"list"}`,
		"missing":    `{"name":"a","bio":""}`,
		"unknown":    `{"name":"a","bio":"","wallLayout":"grid","extra":1}`,
	} {
		if r := u.put("/api/profile", body); r.code != 400 {
			t.Errorf("%s: %d %s", name, r.code, r.raw)
		}
	}
	ok := jsonBody(map[string]any{"name": strings.Repeat("字", 60), "bio": strings.Repeat("字", 500), "wallLayout": "grid"})
	if r := u.put("/api/profile", ok); r.code != 200 {
		t.Errorf("bounds: %d %s", r.code, r.raw)
	}
	if r := e.user("u2").put("/api/profile", `{"name":"B","bio":"","wallLayout":"grid"}`); r.body["userId"] != "u2" {
		t.Errorf("u2: %s", r.raw)
	}
	var name string
	_ = e.d.QueryRow(`SELECT name FROM profiles WHERE user_id='u1'`).Scan(&name)
	if name != strings.Repeat("字", 60) {
		t.Fatalf("u2 write touched u1: %q", name)
	}
}
