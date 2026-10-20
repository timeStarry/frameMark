package api_test

import (
	"encoding/base64"
	"fmt"
	"strings"
	"testing"

	"github.com/timeStarry/frameMark/internal/config"
)

// grid builds one collection per status × visibility for owner u1, each
// with one photo, and returns them keyed "status/visibility".
func grid(e *env, u1 *client) map[string]string {
	e.t.Helper()
	out := map[string]string{}
	for _, st := range []string{"draft", "published"} {
		for _, vis := range []string{"private", "unlisted", "public"} {
			out[st+"/"+vis] = u1.coll(st, vis, nil, e.mediaPhoto("u1", st+vis))
		}
	}
	return out
}

func viewers(e *env) (u1, u2, anon *client) {
	return e.user("u1"), e.user("u2"), e.anon()
}

func cardIDs(t *testing.T, v any) []string {
	t.Helper()
	arr, _ := v.([]any)
	out := []string{}
	for _, x := range arr {
		m, _ := x.(map[string]any)
		out = append(out, m["id"].(string))
	}
	return out
}

func TestReadCollectionVisibilityGrid(t *testing.T) {
	e := newEnv(t)
	u1, u2, anon := viewers(e)
	g := grid(e, u1)
	for key, id := range g {
		for name, cl := range map[string]*client{"owner": u1, "other": u2, "anon": anon} {
			want := name == "owner" || key == "published/unlisted" || key == "published/public"
			r := cl.get("/api/collections/" + id)
			if want && r.code != 200 || !want && r.code != 404 {
				t.Errorf("%s %s: %d %s", name, key, r.code, r.raw)
			}
			n := cl.get("/api/collections/" + id + "/neighbors")
			if want && n.code != 200 || !want && n.code != 404 {
				t.Errorf("neighbors %s %s: %d %s", name, key, n.code, n.raw)
			}
			if r.code == 200 {
				_, hasStatus := r.body["status"]
				if hasStatus != (name == "owner") {
					t.Errorf("%s %s: owner fields %s", name, key, r.raw)
				}
			}
		}
	}
	for _, path := range []string{"/api/collections/" + newID(), "/api/collections/nope", "/api/collections/" + newID() + "/neighbors"} {
		if r := anon.get(path); r.code != 404 {
			t.Errorf("%s: %d", path, r.code)
		}
	}
}

func TestReadCollectionShape(t *testing.T) {
	e := newEnv(t)
	u1, u2, _ := viewers(e)
	u1.put("/api/profile", `{"name":"Ann","bio":"","wallLayout":"grid"}`)
	a, b, c := e.mediaPhoto("u1", "A"), e.mediaPhoto("u1", "B"), e.mediaPhoto("u1", "C")
	e.exec(`INSERT INTO attributions(photo_id,source) VALUES(?,?)`, b, `{"author":"X","license":"CC0"}`)
	id := u1.newCollection("Shape")
	u1.mustFrames(id, textFrame("hello"), pair(b, c), frameIn{"layout": "matted", "matteRatio": 0.8, "photoIds": []string{a}})
	u1.updateCollection(id, map[string]any{"visibility": "unlisted", "coverPhotoId": a, "license": "by"})
	u1.post("/api/collections/"+id+"/publish", "")

	r := u2.get("/api/collections/" + id)
	if r.code != 200 {
		t.Fatalf("%d %s", r.code, r.raw)
	}
	for _, k := range []string{"id", "title", "intro", "owner", "license", "aiDeclaration", "originalDownload", "cover", "publishedAt", "frames"} {
		if _, ok := r.body[k]; !ok {
			t.Errorf("missing %s", k)
		}
	}
	if len(r.body) != 10 {
		t.Errorf("keys: %s", r.raw)
	}
	if o := r.body["owner"].(map[string]any); o["id"] != "u1" || o["name"] != "Ann" {
		t.Errorf("owner %v", o)
	}
	frames := r.body["frames"].([]any)
	if len(frames) != 3 {
		t.Fatalf("frames %v", frames)
	}
	f0, f1, f2 := frames[0].(map[string]any), frames[1].(map[string]any), frames[2].(map[string]any)
	if f0["layout"] != "text" || f0["text"] != "hello" || len(f0["photos"].([]any)) != 0 {
		t.Errorf("f0 %v", f0)
	}
	if ids := cardIDs(t, f1["photos"]); len(ids) != 2 || ids[0] != b || ids[1] != c {
		t.Errorf("pair order %v", ids)
	}
	if f2["layout"] != "matted" || f2["matteRatio"] != 0.8 {
		t.Errorf("f2 %v", f2)
	}
	if cover := r.body["cover"].(map[string]any); cover["id"] != a {
		t.Errorf("cover %v", cover)
	}
	pb := f1["photos"].([]any)[0].(map[string]any)
	for _, k := range []string{"id", "title", "caption", "width", "height", "media", "exif", "histogram", "attribution", "downloadable"} {
		if _, ok := pb[k]; !ok {
			t.Errorf("photo missing %s", k)
		}
	}
	if len(pb) != 10 {
		t.Errorf("photo keys %v", pb)
	}
	if at := pb["attribution"].(map[string]any); at["author"] != "X" {
		t.Errorf("attribution %v", at)
	}
	if pb["downloadable"] != false {
		t.Errorf("downloadable %v", pb["downloadable"])
	}
	// unlisted: media through /m with this collection as context
	m := pb["media"].(map[string]any)["tiers"].(map[string]any)["w480"].(map[string]any)
	if m["avif"] != "/m/"+b+"/"+hashA+"/w480.avif?c="+id {
		t.Errorf("media %v", m)
	}
}

func TestExifAndHistogramPerCollection(t *testing.T) {
	e := newEnv(t)
	u1, u2, _ := viewers(e)
	p := e.mediaPhoto("u1", "P") // snapshot: iso, camera; histogram on
	plain := u1.coll("published", "public", nil, p)
	over := u1.coll("published", "public", nil, p)
	hidden := u1.coll("published", "public", nil, p)
	if r := u1.put("/api/collections/"+over+"/overrides/"+p, `{"publicFields":["lens","taken_date","shutter"],"histogramPublic":false}`); r.code != 200 {
		t.Fatalf("%d %s", r.code, r.raw)
	}
	if r := u1.put("/api/collections/"+hidden+"/overrides/"+p, `{"publicFields":[]}`); r.code != 200 {
		t.Fatalf("%d %s", r.code, r.raw)
	}
	photo := func(cid string) map[string]any {
		r := u2.get("/api/collections/" + cid)
		return r.body["frames"].([]any)[0].(map[string]any)["photos"].([]any)[0].(map[string]any)
	}
	ex := photo(plain)["exif"].(map[string]any)
	if len(ex) != 2 || ex["iso"] != 400.0 || ex["camera"] != "FUJIFILM X-T5" {
		t.Errorf("plain exif %v", ex)
	}
	h, _ := photo(plain)["histogram"].([]any)
	if len(h) != 4 || len(h[0].([]any)) != 64 || h[0].([]any)[0] != 65535.0 {
		t.Errorf("histogram %v", h)
	}
	o := photo(over)
	ex = o["exif"].(map[string]any)
	if len(ex) != 4 || ex["lens"] != "XF23" || ex["takenAt"] != float64(t0) || ex["shutter"] != "1/250" ||
		ex["exposureSeconds"] != 0.004 || o["histogram"] != nil {
		t.Errorf("override exif %v hist %v", ex, o["histogram"])
	}
	hp := photo(hidden)
	if hp["exif"] != nil || hp["histogram"] == nil {
		t.Errorf("hidden: %v", hp)
	}
}

func TestCDNOnlyForPublicPublished(t *testing.T) {
	e := newEnvCfg(t, func(c *config.Config) { c.CDNBase = cdnBase })
	u1, u2, _ := viewers(e)
	p := e.mediaPhoto("u1", "P")
	pub := u1.coll("published", "public", nil, p)
	unl := u1.coll("published", "unlisted", nil, p)
	draft := u1.coll("draft", "public", nil, p)
	url := func(cl *client, cid string) string {
		r := cl.get("/api/collections/" + cid)
		ph := r.body["frames"].([]any)[0].(map[string]any)["photos"].([]any)[0].(map[string]any)
		return ph["media"].(map[string]any)["tiers"].(map[string]any)["w1280"].(map[string]any)["jpeg"].(string)
	}
	if got := url(u2, pub); got != cdnBase+"/d/"+p+"/"+hashA+"/w1280.jpg" {
		t.Errorf("public %q", got)
	}
	if got := url(u2, unl); got != "/m/"+p+"/"+hashA+"/w1280.jpg?c="+unl {
		t.Errorf("unlisted %q", got)
	}
	if got := url(u1, draft); got != "/m/"+p+"/"+hashA+"/w1280.jpg?c="+draft {
		t.Errorf("draft %q", got)
	}
	// owner view (archive context) never uses the CDN
	if m := u1.get("/api/photos/" + p).body["media"].(map[string]any); strings.Contains(fmt.Sprint(m), cdnBase) {
		t.Errorf("owner media %v", m)
	}
	// square card covers of public collections use the CDN
	sq := u2.get("/api/square")
	cover := sq.body["items"].([]any)[0].(map[string]any)["cover"].(map[string]any)
	if !strings.HasPrefix(fmt.Sprint(cover["tiers"]), "map[w1280:map[avif:"+cdnBase) {
		t.Errorf("square cover %v", cover)
	}
}

func TestFramelessPublishedHidden(t *testing.T) {
	e := newEnv(t)
	u1, u2, anon := viewers(e)
	id := u1.coll("published", "public", nil, e.mediaPhoto("u1", "P"))
	e.exec(`DELETE FROM frames WHERE collection_id=?`, id) // defensive: should not happen via the API
	for _, cl := range []*client{u2, anon} {
		if r := cl.get("/api/collections/" + id); r.code != 404 {
			t.Errorf("frameless: %d", r.code)
		}
		if ids := cardIDs(t, cl.get("/api/square").body["items"]); len(ids) != 0 {
			t.Errorf("square %v", ids)
		}
		if ids := cardIDs(t, cl.get("/api/u/u1").body["collections"]); len(ids) != 0 {
			t.Errorf("wall %v", ids)
		}
	}
	if r := u1.get("/api/collections/" + id); r.code != 200 {
		t.Errorf("owner: %d", r.code)
	}
}

func TestSquare(t *testing.T) {
	e := newEnv(t)
	u1, u2, anon := viewers(e)
	var want []string
	for i := 0; i < 7; i++ {
		e.now.Store(t0 + int64(i%3)*1000) // ties on published_at
		want = append(want, u1.coll("published", "public", nil, e.mediaPhoto("u1", fmt.Sprint(i))))
	}
	e.now.Store(t0)
	u1.coll("published", "unlisted", nil, e.mediaPhoto("u1", "unl"))
	u1.coll("published", "public", map[string]any{"distribute": false}, e.mediaPhoto("u1", "nodist"))
	u1.coll("draft", "public", nil, e.mediaPhoto("u1", "draft"))
	u1.coll("published", "private", nil, e.mediaPhoto("u1", "priv"))

	// expected order: published_at DESC, id DESC
	var pubs = map[string]int64{}
	for i, id := range want {
		pubs[id] = int64(i % 3)
	}
	ordered := append([]string(nil), want...)
	for i := range ordered {
		for j := i + 1; j < len(ordered); j++ {
			a, b := ordered[i], ordered[j]
			if pubs[b] > pubs[a] || pubs[b] == pubs[a] && b > a {
				ordered[i], ordered[j] = b, a
			}
		}
	}

	var got []string
	cursor := ""
	for page := 0; page < 10; page++ {
		path := "/api/square?limit=3"
		if cursor != "" {
			path += "&cursor=" + cursor
		}
		r := anon.get(path)
		if r.code != 200 {
			t.Fatalf("%s: %d %s", path, r.code, r.raw)
		}
		if page > 0 && len(r.body["featured"].([]any)) != 0 {
			t.Errorf("featured on later page")
		}
		got = append(got, cardIDs(t, r.body["items"])...)
		nc, _ := r.body["nextCursor"].(string)
		if nc == "" {
			break
		}
		cursor = nc
	}
	if strings.Join(got, ",") != strings.Join(ordered, ",") {
		t.Fatalf("square order\n got %v\nwant %v", got, ordered)
	}

	// default page and card shape
	r := u2.get("/api/square")
	if len(cardIDs(t, r.body["items"])) != 7 || r.body["nextCursor"] != nil {
		t.Errorf("default page %s", r.raw)
	}
	c := r.body["items"].([]any)[0].(map[string]any)
	if pv, _ := c["previews"].([]any); len(c) != 6 || c["count"] != 1.0 || c["cover"] == nil || len(pv) != 1 || c["owner"].(map[string]any)["id"] != "u1" {
		t.Errorf("card %v", c)
	}

	// featured: ranked, only square-eligible
	e.exec(`UPDATE collections SET featured_rank=2 WHERE id=?`, want[0])
	e.exec(`UPDATE collections SET featured_rank=1 WHERE id=?`, want[3])
	e.exec(`UPDATE collections SET featured_rank=0 WHERE distribute=0`)
	if f := cardIDs(t, anon.get("/api/square").body["featured"]); strings.Join(f, ",") != want[3]+","+want[0] {
		t.Errorf("featured %v", f)
	}

	// limits and tampered cursors
	for _, q := range []string{"limit=0", "limit=49", "limit=x", "limit=03", "limit=1&limit=2"} {
		if r := anon.get("/api/square?" + q); r.code != 400 {
			t.Errorf("%s: %d", q, r.code)
		}
	}
	if r := anon.get("/api/square?limit=48"); r.code != 200 {
		t.Errorf("limit 48: %d", r.code)
	}
	good := base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf("%d.%s", t0, want[0])))
	if r := anon.get("/api/square?cursor=" + good); r.code != 200 {
		t.Errorf("good cursor: %d %s", r.code, r.raw)
	}
	for _, c := range []string{"", "!!", base64.RawURLEncoding.EncodeToString([]byte("1.nope")),
		base64.RawURLEncoding.EncodeToString([]byte("x." + want[0])),
		base64.RawURLEncoding.EncodeToString([]byte("01." + want[0])),
		base64.StdEncoding.EncodeToString([]byte(fmt.Sprintf("%d.%s", t0, want[0]))),
		base64.RawURLEncoding.EncodeToString([]byte("1' OR 1=1 --." + want[0])),
		good + "A"} {
		if r := anon.get("/api/square?cursor=" + c); r.code != 400 {
			t.Errorf("cursor %q: %d", c, r.code)
		}
	}
}

func TestCardPreviews(t *testing.T) {
	e := newEnv(t)
	u1, _, anon := viewers(e)
	var ps []string
	for i := 0; i < 7; i++ {
		ps = append(ps, e.mediaPhoto("u1", fmt.Sprint(i)))
	}
	np := e.readyPhoto("u1") // ready but without derived media: never a preview
	id := u1.coll("published", "public", nil, ps...)
	// frames: 0 | pair(1,2) | 0 again (dup) | no-media | 3 4 5 6 → 0 1 2 3 4, capped at 5
	u1.mustFrames(id, full(ps[0]), pair(ps[1], ps[2]), full(ps[0]), full(np),
		full(ps[3]), full(ps[4]), full(ps[5]), full(ps[6]))
	r := anon.get("/api/square")
	var c map[string]any
	for _, it := range r.body["items"].([]any) {
		if m := it.(map[string]any); m["id"] == id {
			c = m
		}
	}
	if c == nil {
		t.Fatalf("card missing: %s", r.raw)
	}
	pv := c["previews"].([]any)
	if len(pv) != 5 {
		t.Fatalf("previews %d: %v", len(pv), pv)
	}
	for i, want := range ps[:5] {
		jpeg := pv[i].(map[string]any)["tiers"].(map[string]any)["w480"].(map[string]any)["jpeg"].(string)
		if !strings.Contains(jpeg, want) {
			t.Errorf("preview %d = %s, want photo %s", i, jpeg, want)
		}
	}
	if strings.Contains(r.raw, np) {
		t.Errorf("photo without media leaked into previews")
	}

	// a collection without frames has previews [] (not null)
	empty := u1.coll("draft", "private", nil)
	for _, it := range u1.get("/api/u/u1").body["collections"].([]any) {
		m := it.(map[string]any)
		if m["id"] != empty {
			continue
		}
		if pv, ok := m["previews"].([]any); !ok || len(pv) != 0 {
			t.Errorf("empty previews %#v", m["previews"])
		}
		return
	}
	t.Errorf("empty collection not on owner wall")
}

func TestUserWall(t *testing.T) {
	e := newEnv(t)
	u1, u2, anon := viewers(e)
	g := grid(e, u1)
	u1.put("/api/profile", `{"name":"Ann","bio":"b","wallLayout":"grid"}`)
	mkAlbum := func(vis string, members ...string) string {
		r := u1.post("/api/albums", jsonBody(map[string]any{"title": "A " + vis, "visibility": vis}))
		id := r.body["id"].(string)
		u1.put("/api/albums/"+id+"/items", jsonBody(map[string]any{"collectionIds": members}))
		return id
	}
	pubAlbum := mkAlbum("public", g["published/private"], g["published/public"], g["published/unlisted"])
	unlAlbum := mkAlbum("unlisted", g["published/public"])
	privAlbum := mkAlbum("private", g["published/public"])

	r := anon.get("/api/u/u1")
	if r.code != 200 {
		t.Fatalf("%d %s", r.code, r.raw)
	}
	if p := r.body["profile"].(map[string]any); p["id"] != "u1" || p["name"] != "Ann" || p["bio"] != "b" || p["wallLayout"] != "grid" || len(p) != 4 {
		t.Errorf("profile %v", p)
	}
	for _, cl := range []*client{anon, u2} {
		r := cl.get("/api/u/u1")
		if ids := cardIDs(t, r.body["collections"]); strings.Join(ids, ",") != g["published/public"] {
			t.Errorf("non-owner wall %v", ids)
		}
		albums := r.body["albums"].([]any)
		if len(albums) != 1 {
			t.Fatalf("albums %v", albums)
		}
		a := albums[0].(map[string]any)
		// private and unlisted members are filtered: count only readable ones
		if a["id"] != pubAlbum || a["count"] != 2.0 || a["cover"] == nil || len(a) != 5 {
			t.Errorf("album card %v", a)
		}
	}
	own := u1.get("/api/u/u1")
	ids := cardIDs(t, own.body["collections"])
	if len(ids) != 6 {
		t.Errorf("owner wall %v", ids)
	}
	if as := cardIDs(t, own.body["albums"]); len(as) != 3 || !strings.Contains(strings.Join(as, ","), unlAlbum) || !strings.Contains(strings.Join(as, ","), privAlbum) {
		t.Errorf("owner albums %v", as)
	}
	// wall order follows wall_rank
	e.exec(`UPDATE collections SET wall_rank=-1 WHERE id=?`, g["draft/private"])
	if ids := cardIDs(t, u1.get("/api/u/u1").body["collections"]); ids[0] != g["draft/private"] {
		t.Errorf("wall_rank order %v", ids)
	}
	// unknown user, bad ids, a user with no profile
	for _, path := range []string{"/api/u/nobody", "/api/u/" + strings.Repeat("a", 65), "/api/u/a%20b"} {
		if r := anon.get(path); r.code != 404 {
			t.Errorf("%s: %d", path, r.code)
		}
	}
	e.exec(`INSERT INTO users(id,email,password,created_at) VALUES('markr-demo','demo@x.test','!',?)`, t0)
	if r := anon.get("/api/u/markr-demo"); r.code != 200 || r.body["profile"].(map[string]any)["wallLayout"] != "salon" {
		t.Errorf("demo: %d %s", r.code, r.raw)
	}
}

func TestReadAlbum(t *testing.T) {
	e := newEnv(t)
	u1, u2, anon := viewers(e)
	g := grid(e, u1)
	members := []string{g["published/public"], g["draft/public"], g["published/private"], g["published/unlisted"]}
	albums := map[string]string{}
	for _, vis := range []string{"private", "unlisted", "public"} {
		r := u1.post("/api/albums", jsonBody(map[string]any{"title": "A", "visibility": vis}))
		albums[vis] = r.body["id"].(string)
		u1.put("/api/albums/"+albums[vis]+"/items", jsonBody(map[string]any{"collectionIds": members}))
	}
	for vis, id := range albums {
		for name, cl := range map[string]*client{"owner": u1, "other": u2, "anon": anon} {
			r := cl.get("/api/albums/" + id)
			if name != "owner" && vis == "private" {
				if r.code != 404 {
					t.Errorf("%s %s: %d", name, vis, r.code)
				}
				continue
			}
			if r.code != 200 {
				t.Fatalf("%s %s: %d %s", name, vis, r.code, r.raw)
			}
			ids := cardIDs(t, r.body["members"])
			want := []string{g["published/public"], g["published/unlisted"]}
			if name == "owner" {
				want = members
			}
			if strings.Join(ids, ",") != strings.Join(want, ",") {
				t.Errorf("%s %s members %v want %v", name, vis, ids, want)
			}
			_, hasVis := r.body["visibility"]
			if hasVis != (name == "owner") {
				t.Errorf("%s visibility field %s", name, r.raw)
			}
		}
	}
	if r := anon.get("/api/albums/" + newID()); r.code != 404 {
		t.Errorf("unknown: %d", r.code)
	}
}

func TestNeighbors(t *testing.T) {
	e := newEnv(t)
	u1, u2, anon := viewers(e)
	u3 := e.user("u3")
	// u1 wall: a b c (public), h (unlisted); u3 has x (public) published last.
	var cs []string
	for i := 0; i < 3; i++ {
		e.now.Store(t0 + int64(i)*1000)
		cs = append(cs, u1.coll("published", "public", nil, e.mediaPhoto("u1", fmt.Sprint(i))))
	}
	a, b, c := cs[0], cs[1], cs[2]
	hidden := u1.coll("published", "unlisted", nil, e.mediaPhoto("u1", "h"))
	priv := u1.coll("published", "private", nil, e.mediaPhoto("u1", "p"))
	e.now.Store(t0 + 9000)
	x := u3.coll("published", "public", nil, e.mediaPhoto("u3", "x"))

	nb := func(cl *client, id, wall string) (string, string, string, []string) {
		t.Helper()
		r := cl.get("/api/collections/" + id + "/neighbors?wall=" + wall)
		if r.code != 200 {
			t.Fatalf("%s %s: %d %s", id, wall, r.code, r.raw)
		}
		get := func(k string) string {
			if m, ok := r.body[k].(map[string]any); ok {
				return m["id"].(string)
			}
			return ""
		}
		return r.body["wall"].(string), get("prev"), get("next"), cardIDs(t, r.body["strip"])
	}
	// square: x c b a
	if w, p, n, s := nb(anon, b, "square"); w != "square" || p != c || n != a || strings.Join(s, ",") != strings.Join([]string{x, c, b, a}, ",") {
		t.Errorf("square: %s %s %s %v", w, p, n, s)
	}
	if w, p, n, _ := nb(anon, x, "square"); w != "square" || p != "" || n != c {
		t.Errorf("square head: %s %s %s", w, p, n)
	}
	// user: wall_rank a b c
	if w, p, n, s := nb(u2, b, "user"); w != "user:u1" || p != a || n != c || len(s) != 3 {
		t.Errorf("user: %s %s %s %v", w, p, n, s)
	}
	// legacy "user", id-scoped "user:{owner}" and a foreign "user:{other}" all resolve to the owner's wall
	for _, in := range []string{"user", "user:u1", "user:u3", "user:"} {
		if w, p, n, _ := nb(u2, b, in); w != "user:u1" || p != a || n != c {
			t.Errorf("%q: %s %s %s", in, w, p, n)
		}
	}
	// owner's own user wall includes unlisted and private
	if _, _, n, s := nb(u1, c, "user"); n != hidden || len(s) != 5 {
		t.Errorf("owner user: %s %v", n, s)
	}
	// album: order c, priv, a — priv filtered for others
	r := u1.post("/api/albums", jsonBody(map[string]any{"title": "A", "visibility": "public"}))
	al := r.body["id"].(string)
	u1.put("/api/albums/"+al+"/items", jsonBody(map[string]any{"collectionIds": []string{c, priv, a}}))
	if w, p, n, s := nb(anon, a, "album:"+al); w != "album:"+al || p != c || n != "" || len(s) != 2 {
		t.Errorf("album: %s %s %s %v", w, p, n, s)
	}
	if _, p, _, _ := nb(u1, a, "album:"+al); p != priv {
		t.Errorf("owner album prev %s", p)
	}
	// fallbacks to user
	privAlbum := u1.post("/api/albums", jsonBody(map[string]any{"title": "P", "visibility": "private"})).body["id"].(string)
	u1.put("/api/albums/"+privAlbum+"/items", jsonBody(map[string]any{"collectionIds": []string{a, b}}))
	for _, wall := range []string{"", "bogus", "album:", "album:nope", "album:" + newID(), "album:" + privAlbum, "square%20"} {
		if w, p, n, _ := nb(anon, b, wall); w != "user:u1" || p != a || n != c {
			t.Errorf("fallback %q: %s %s %s", wall, w, p, n)
		}
	}
	// album that does not contain the collection falls back too
	if w, _, _, _ := nb(anon, x, "album:"+al); w != "user:u3" {
		t.Errorf("album without member: %s", w)
	}
	// unlisted collection: not in square, not on the non-owner wall
	if w, p, n, s := nb(anon, hidden, "square"); w != "user:u1" || p != "" || n != "" || len(s) != 3 {
		t.Errorf("unlisted: %s %s %s %v", w, p, n, s)
	}
	// strip is bounded and centered
	for i := 0; i < 20; i++ {
		u3.coll("published", "public", nil, e.mediaPhoto("u3", fmt.Sprint("y", i)))
	}
	if _, p, n, s := nb(anon, x, "user"); len(s) != 12 || p != "" || n == "" || s[0] != x {
		t.Errorf("strip head: %s %s %v", p, n, s)
	}
}

func TestReadEndpointsAnonymousGetNoCSRF(t *testing.T) {
	e := newEnv(t)
	c := &client{e: e} // no session at all
	for _, path := range []string{"/api/square", "/api/u/nobody"} {
		r := c.get(path)
		if r.code != 200 && r.code != 404 {
			t.Errorf("%s: %d", path, r.code)
		}
	}
}

func TestTakenOffsetMinutes(t *testing.T) {
	e := newEnv(t)
	u1, u2, _ := viewers(e)
	p := e.mediaPhoto("u1", "P")
	e.exec(`UPDATE photo_exif SET taken_offset_min=480 WHERE photo_id=?`, p)

	// Owner view always carries it alongside takenAt.
	ex, _ := u1.get("/api/photos/" + p).body["exif"].(map[string]any)
	if ex["takenAt"] != float64(t0) || ex["takenOffsetMinutes"] != 480.0 {
		t.Errorf("owner exif %v", ex)
	}

	shown := u1.coll("published", "public", nil, p)
	hidden := u1.coll("published", "public", nil, p)
	if r := u1.put("/api/collections/"+shown+"/overrides/"+p, `{"publicFields":["taken_date"]}`); r.code != 200 {
		t.Fatalf("%d %s", r.code, r.raw)
	}
	photo := func(cid string) map[string]any {
		r := u2.get("/api/collections/" + cid)
		return r.body["frames"].([]any)[0].(map[string]any)["photos"].([]any)[0].(map[string]any)
	}
	ex, _ = photo(shown)["exif"].(map[string]any)
	if len(ex) != 2 || ex["takenAt"] != float64(t0) || ex["takenOffsetMinutes"] != 480.0 {
		t.Errorf("public exif with taken_date %v", ex)
	}
	// Default snapshot is iso+camera: taken_date hidden, so neither field.
	ex, _ = photo(hidden)["exif"].(map[string]any)
	for _, k := range []string{"takenAt", "takenOffsetMinutes"} {
		if _, ok := ex[k]; ok {
			t.Errorf("hidden taken_date leaks %s: %v", k, ex)
		}
	}

	// A NULL offset is omitted.
	e.exec(`UPDATE photo_exif SET taken_offset_min=NULL WHERE photo_id=?`, p)
	ex, _ = u1.get("/api/photos/" + p).body["exif"].(map[string]any)
	if _, ok := ex["takenOffsetMinutes"]; ok || ex["takenAt"] == nil {
		t.Errorf("null offset %v", ex)
	}
}

// ownerFields reports, for each card in v, whether it carries status and
// visibility; it fails if a card has one key without the other.
func ownerFields(t *testing.T, label string, v any) []bool {
	t.Helper()
	arr, _ := v.([]any)
	out := []bool{}
	for _, x := range arr {
		m := x.(map[string]any)
		_, s := m["status"]
		_, vis := m["visibility"]
		if s != vis {
			t.Errorf("%s: status/visibility mismatch %v", label, m)
		}
		out = append(out, s)
	}
	return out
}

func wantAll(t *testing.T, label string, got []bool, want bool) {
	t.Helper()
	if len(got) == 0 {
		t.Errorf("%s: no cards", label)
	}
	for i, g := range got {
		if g != want {
			t.Errorf("%s card %d: owner fields = %v, want %v", label, i, g, want)
		}
	}
}

func TestCardOwnerFields(t *testing.T) {
	e := newEnv(t)
	u1, u2, anon := viewers(e)
	g := grid(e, u1)
	r := u1.post("/api/albums", jsonBody(map[string]any{"title": "A", "visibility": "public"}))
	al := r.body["id"].(string)
	u1.put("/api/albums/"+al+"/items", jsonBody(map[string]any{"collectionIds": []string{g["published/public"], g["draft/private"]}}))

	e.exec(`UPDATE collections SET featured_rank=1 WHERE id=?`, g["published/public"])

	// Owner: each own card carries its real status and visibility.
	own := u1.get("/api/u/u1").body["collections"].([]any)
	wantAll(t, "owner wall", ownerFields(t, "owner wall", own), true)
	for _, x := range own {
		m := x.(map[string]any)
		if key := m["status"].(string) + "/" + m["visibility"].(string); g[key] != m["id"] {
			t.Errorf("card %v: status/visibility %s does not match", m["id"], key)
		}
	}
	wantAll(t, "owner square", ownerFields(t, "owner square", u1.get("/api/square").body["items"]), true)
	wantAll(t, "owner featured", ownerFields(t, "owner featured", u1.get("/api/square").body["featured"]), true)
	wantAll(t, "owner album", ownerFields(t, "owner album", u1.get("/api/albums/" + al).body["members"]), true)
	wantAll(t, "owner neighbors", ownerFields(t, "owner neighbors",
		u1.get("/api/collections/" + g["published/public"] + "/neighbors?wall=user").body["strip"]), true)

	// Others and anonymous: neither key, anywhere.
	for name, cl := range map[string]*client{"other": u2, "anon": anon} {
		wantAll(t, name+" wall", ownerFields(t, name, cl.get("/api/u/u1").body["collections"]), false)
		sq := cl.get("/api/square")
		wantAll(t, name+" square", ownerFields(t, name, sq.body["items"]), false)
		wantAll(t, name+" featured", ownerFields(t, name, sq.body["featured"]), false)
		wantAll(t, name+" album", ownerFields(t, name, cl.get("/api/albums/" + al).body["members"]), false)
		nb := cl.get("/api/collections/" + g["published/public"] + "/neighbors?wall=user")
		wantAll(t, name+" neighbors", ownerFields(t, name, nb.body["strip"]), false)
		for _, raw := range []string{sq.raw, nb.raw} {
			if strings.Contains(raw, `"status"`) || strings.Contains(raw, `"visibility"`) {
				t.Errorf("%s: owner fields in %s", name, raw)
			}
		}
	}

	// u2's own card on the square shows owner fields to u2 only.
	mine := u2.coll("published", "public", nil, e.mediaPhoto("u2", "mine"))
	for _, x := range u2.get("/api/square").body["items"].([]any) {
		m := x.(map[string]any)
		_, has := m["status"]
		if has != (m["id"] == mine) {
			t.Errorf("u2 square card %v: owner fields %v", m["id"], has)
		}
	}
}
