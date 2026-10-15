package api_test

import (
	"strings"
	"testing"
)

func manyIDs(n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = newID()
	}
	return out
}

func TestAlbumCRUD(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	mallory := e.user("u2")

	r := u.post("/api/albums", `{"title":"  Wall\u0007 ","intro":"hi","visibility":"unlisted"}`)
	if r.code != 201 {
		t.Fatalf("%d %s", r.code, r.raw)
	}
	if r.body["title"] != "Wall" || r.body["intro"] != "hi" || r.body["visibility"] != "unlisted" ||
		r.body["createdAt"] != float64(t0) || r.body["updatedAt"] != float64(t0) {
		t.Fatalf("%s", r.raw)
	}
	aid := r.body["id"].(string)
	if items, ok := r.body["items"].([]any); !ok || len(items) != 0 {
		t.Errorf("items: %s", r.raw)
	}

	for name, body := range map[string]string{
		"empty title": `{"title":"","visibility":"private"}`,
		"long title":  jsonBody(map[string]any{"title": strings.Repeat("a", 121), "visibility": "private"}),
		"long intro":  jsonBody(map[string]any{"title": "a", "intro": strings.Repeat("a", 2001), "visibility": "private"}),
		"bad vis":     `{"title":"a","visibility":"secret"}`,
		"missing vis": `{"title":"a"}`,
		"unknown":     `{"title":"a","visibility":"private","extra":1}`,
	} {
		if r := u.post("/api/albums", body); r.code != 400 {
			t.Errorf("post %s: %d %s", name, r.code, r.raw)
		}
		if r := u.put("/api/albums/"+aid, body); r.code != 400 {
			t.Errorf("put %s: %d %s", name, r.code, r.raw)
		}
	}

	e.now.Add(1000)
	r = u.put("/api/albums/"+aid, `{"title":"B","intro":"line1\r\nline2","visibility":"public"}`)
	if r.code != 200 || r.body["title"] != "B" || r.body["intro"] != "line1\nline2" || r.body["visibility"] != "public" ||
		r.body["updatedAt"] != float64(t0+1000) {
		t.Fatalf("update: %d %s", r.code, r.raw)
	}

	if r := mallory.put("/api/albums/"+aid, `{"title":"pwned","visibility":"private"}`); r.code != 404 {
		t.Errorf("mallory put: %d", r.code)
	}
	if r := mallory.del("/api/albums/" + aid); r.code != 404 {
		t.Errorf("mallory del: %d", r.code)
	}
	if r := u.put("/api/albums/"+newID(), `{"title":"x","visibility":"private"}`); r.code != 404 {
		t.Errorf("unknown: %d", r.code)
	}

	if r := u.del("/api/albums/" + aid); r.code != 204 {
		t.Fatalf("delete: %d %s", r.code, r.raw)
	}
	var n int
	_ = e.d.QueryRow(`SELECT count(*) FROM albums`).Scan(&n)
	if n != 0 {
		t.Fatal("album remains")
	}
	if r := u.del("/api/albums/" + aid); r.code != 404 {
		t.Errorf("second: %d", r.code)
	}
}

func TestAlbumItems(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	mallory := e.user("u2")
	c1 := u.newCollection("one")
	c2 := u.newCollection("two")
	other := mallory.newCollection("x")
	aid := u.post("/api/albums", `{"title":"A","visibility":"private"}`).body["id"].(string)
	path := "/api/albums/" + aid + "/items"

	r := u.put(path, jsonBody(map[string]any{"collectionIds": []string{c2, c1}}))
	if r.code != 200 {
		t.Fatalf("items: %d %s", r.code, r.raw)
	}
	got, _ := r.body["items"].([]any)
	if len(got) != 2 {
		t.Fatalf("items: %s", r.raw)
	}
	for i, id := range []string{c2, c1} {
		it, _ := got[i].(map[string]any)
		if it["collectionId"] != id || it["position"] != float64(i) {
			t.Errorf("item %d: %v", i, it)
		}
	}

	for name, body := range map[string]string{
		"others":   jsonBody(map[string]any{"collectionIds": []string{c1, other}}),
		"unknown":  jsonBody(map[string]any{"collectionIds": []string{newID()}}),
		"dup":      jsonBody(map[string]any{"collectionIds": []string{c1, c1}}),
		"too many": jsonBody(map[string]any{"collectionIds": manyIDs(41)}),
		"null":     `{"collectionIds":null}`,
		"missing":  `{}`,
	} {
		if r := u.put(path, body); r.code != 400 {
			t.Errorf("%s: %d %s", name, r.code, r.raw)
		}
	}
	var n int
	_ = e.d.QueryRow(`SELECT count(*) FROM album_items WHERE album_id=?`, aid).Scan(&n)
	if n != 2 {
		t.Fatalf("invalid items wrote: %d rows", n)
	}
	if r := mallory.put(path, jsonBody(map[string]any{"collectionIds": []string{other}})); r.code != 404 {
		t.Errorf("mallory items: %d", r.code)
	}

	// 40 items is the boundary.
	ids := make([]string, 40)
	for i := range ids {
		ids[i] = u.newCollection("c")
	}
	if r := u.put(path, jsonBody(map[string]any{"collectionIds": ids})); r.code != 200 {
		t.Fatalf("40 items: %d %s", r.code, r.raw)
	}
	if r := u.put(path, `{"collectionIds":[]}`); r.code != 200 {
		t.Fatalf("empty: %d %s", r.code, r.raw)
	}
	_ = e.d.QueryRow(`SELECT count(*) FROM album_items`).Scan(&n)
	if n != 0 {
		t.Fatalf("%d rows after clear", n)
	}
}
