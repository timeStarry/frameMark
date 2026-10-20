package api_test

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// --- helpers ---

type change struct{ Kind, Detail string }

// check posts an exposure-check and returns widens and the change list.
func (c *client) check(cid string, body any) (bool, []change, resp) {
	c.e.t.Helper()
	r := c.post("/api/collections/"+cid+"/exposure-check", jsonBody(body))
	if r.code != 200 {
		return false, nil, r
	}
	var out struct {
		Widens  bool     `json:"widens"`
		Changes []change `json:"changes"`
	}
	if err := json.Unmarshal([]byte(r.raw), &out); err != nil {
		c.e.t.Fatal(err)
	}
	if out.Changes == nil {
		c.e.t.Fatalf("changes is null: %s", r.raw)
	}
	if out.Widens != (len(out.Changes) > 0) {
		c.e.t.Fatalf("widens disagrees with changes: %s", r.raw)
	}
	return out.Widens, out.Changes, r
}

func (c *client) mustCheck(cid string, body any) []change {
	c.e.t.Helper()
	_, ch, r := c.check(cid, body)
	if r.code != 200 {
		c.e.t.Fatalf("exposure-check: %d %s", r.code, r.raw)
	}
	return ch
}

func fmtChanges(ch []change) string {
	parts := make([]string, len(ch))
	for i, c := range ch {
		parts[i] = c.Kind + ":" + c.Detail
	}
	return strings.Join(parts, " | ")
}

func wantChanges(t *testing.T, label string, got []change, want ...string) {
	t.Helper()
	if g, w := fmtChanges(got), strings.Join(want, " | "); g != w {
		t.Errorf("%s:\n got  %s\n want %s", label, g, w)
	}
}

// collFields is a full collectionInput with defaults matching collectionBody.
func collFields(over map[string]any) map[string]any {
	b := map[string]any{"title": "T", "intro": "", "visibility": "private", "distribute": true,
		"originalDownload": false, "license": nil, "aiDeclaration": nil, "coverPhotoId": nil}
	for k, v := range over {
		b[k] = v
	}
	return b
}

// published returns a published collection by u1 with the given visibility
// (distribute off) and full frames for photos.
func published(u1 *client, vis string, photos ...string) string {
	return u1.coll("published", vis, map[string]any{"distribute": false}, photos...)
}

// --- tests ---

func TestExposureCheckKinds(t *testing.T) {
	e := newEnv(t)
	u1 := e.user("u1")
	a, b := e.mediaPhoto("u1", "A"), e.mediaPhoto("u1", "B") // camera+iso, histogram on

	unl := published(u1, "unlisted", a)
	cases := []struct {
		name string
		cid  string
		body map[string]any
		want []string
	}{
		{"photos", unl, map[string]any{"frames": []frameIn{full(a), full(b)}}, []string{"photos:新增 1 张公开照片", "fields:公开机身与ISO", "histogram:公开直方图"}},
		{"fields", unl, map[string]any{"override": map[string]any{"photoId": a, "publicFields": []string{"iso", "camera", "lens"}}},
			[]string{"fields:公开镜头"}},
		{"histogram", unl, nil, []string{"histogram:公开直方图"}}, // set below
		{"original", unl, map[string]any{"collection": collFields(map[string]any{"visibility": "unlisted", "distribute": false,
			"originalDownload": true})}, []string{"original:开放原图下载"}},
		{"unlisted→public", unl, map[string]any{"collection": collFields(map[string]any{"visibility": "public", "distribute": false})},
			[]string{"visibility:改为公开"}},
	}
	// histogram: hide it by override first, then propose showing it.
	if r := u1.put("/api/collections/"+unl+"/overrides/"+a, `{"histogramPublic":false}`); r.code != 200 {
		t.Fatalf("override: %d %s", r.code, r.raw)
	}
	cases[2].body = map[string]any{"override": map[string]any{"photoId": a, "histogramPublic": true}}
	// fields case must keep the histogram hidden so only fields widen.
	cases[1].body["override"].(map[string]any)["histogramPublic"] = false

	for _, tc := range cases {
		wantChanges(t, tc.name, u1.mustCheck(tc.cid, tc.body), tc.want...)
	}

	// private→unlisted: every photo becomes visible, with its fields.
	priv := published(u1, "private", b)
	wantChanges(t, "private→unlisted", u1.mustCheck(priv, map[string]any{
		"collection": collFields(map[string]any{"visibility": "unlisted", "distribute": false})}),
		"photos:新增 1 张公开照片", "fields:公开机身与ISO", "histogram:公开直方图", "visibility:改为仅链接")
	wantChanges(t, "private→public", u1.mustCheck(priv, map[string]any{
		"collection": collFields(map[string]any{"visibility": "public", "distribute": false})}),
		"photos:新增 1 张公开照片", "fields:公开机身与ISO", "histogram:公开直方图", "visibility:改为公开")

	// square: a public collection with distribute off turning it on.
	pub := published(u1, "public", b)
	wantChanges(t, "square", u1.mustCheck(pub, map[string]any{
		"collection": collFields(map[string]any{"visibility": "public", "distribute": true})}), "square:进入广场")
	// distribute on while staying unlisted is not the square.
	wantChanges(t, "distribute unlisted", u1.mustCheck(unl, map[string]any{
		"collection": collFields(map[string]any{"visibility": "unlisted", "distribute": true})}))

	// unlisted→public with distribute already on: both the visibility and the
	// square widen in one step (review Minor: this combination was untested).
	unlDist := u1.coll("published", "unlisted", map[string]any{"distribute": true}, b)
	wantChanges(t, "unlisted→public, distribute on", u1.mustCheck(unlDist, map[string]any{
		"collection": collFields(map[string]any{"visibility": "public", "distribute": true})}),
		"visibility:改为公开", "square:进入广场")
}

func TestExposureCheckNarrowingAndNoop(t *testing.T) {
	e := newEnv(t)
	u1 := e.user("u1")
	a, b := e.mediaPhoto("u1", "A"), e.mediaPhoto("u1", "B")
	cid := u1.coll("published", "public", map[string]any{"originalDownload": true}, a, b)

	for name, body := range map[string]map[string]any{
		"empty body":    {},
		"same frames":   {"frames": []frameIn{full(a), full(b)}},
		"reorder":       {"frames": []frameIn{full(b), full(a)}},
		"pair same":     {"frames": []frameIn{pair(a, b), textFrame("x")}},
		"same coll":     {"collection": collFields(map[string]any{"visibility": "public", "originalDownload": true, "title": "New"})},
		"drop photo":    {"frames": []frameIn{full(a)}},
		"hide fields":   {"override": map[string]any{"photoId": a, "publicFields": []string{"iso"}, "histogramPublic": false}},
		"same fields":   {"override": map[string]any{"photoId": a, "publicFields": []string{"camera", "iso"}}},
		"hist null":     {"override": map[string]any{"photoId": a, "histogramPublic": nil}},
		"to unlisted":   {"collection": collFields(map[string]any{"visibility": "unlisted", "originalDownload": false})},
		"to private":    {"collection": collFields(map[string]any{"visibility": "private"})},
		"off square":    {"collection": collFields(map[string]any{"visibility": "public", "distribute": false, "originalDownload": true})},
		"ifUpdatedAt":   {"collection": collFields(map[string]any{"visibility": "public", "originalDownload": true, "ifUpdatedAt": 1})},
		"all three":     {"collection": collFields(map[string]any{"visibility": "public", "originalDownload": true}), "frames": []frameIn{full(a), full(b)}, "override": map[string]any{"photoId": b}},
		"frames+narrow": {"frames": []frameIn{full(b)}, "override": map[string]any{"photoId": b, "publicFields": []string{}}},
	} {
		widens, ch, r := u1.check(cid, body)
		if r.code != 200 || widens || len(ch) != 0 {
			t.Errorf("%s: %d widens=%v %s", name, r.code, widens, r.raw)
		}
	}
	if r := u1.post("/api/collections/"+cid+"/exposure-check", ""); r.code != 400 {
		t.Errorf("empty body: %d", r.code)
	}
}

func TestExposureCheckHistogramNullOverride(t *testing.T) {
	e := newEnv(t)
	u1 := e.user("u1")
	a := e.mediaPhoto("u1", "A") // histogram_public=1
	cid := published(u1, "public", a)
	if r := u1.put("/api/collections/"+cid+"/overrides/"+a, `{"histogramPublic":false}`); r.code != 200 {
		t.Fatalf("override: %d %s", r.code, r.raw)
	}
	// null means "use the photo's own value", which is public: widens.
	wantChanges(t, "null over hidden", u1.mustCheck(cid, map[string]any{
		"override": map[string]any{"photoId": a, "histogramPublic": nil}}), "histogram:公开直方图")
	// With the photo's own value hidden, null does not widen.
	e.exec(`UPDATE photos SET histogram_public=0 WHERE id=?`, a)
	wantChanges(t, "null over own hidden", u1.mustCheck(cid, map[string]any{
		"override": map[string]any{"photoId": a, "histogramPublic": nil}}))
}

func TestExposureCheckDraft(t *testing.T) {
	e := newEnv(t)
	u1 := e.user("u1")
	a, b := e.mediaPhoto("u1", "A"), e.mediaPhoto("u1", "B")
	cid := u1.coll("draft", "private", nil, a)
	widens, ch, r := u1.check(cid, map[string]any{
		"collection": collFields(map[string]any{"visibility": "public", "originalDownload": true}),
		"frames":     []frameIn{full(a), full(b)},
		"override":   map[string]any{"photoId": b, "publicFields": []string{"lens"}, "histogramPublic": true},
	})
	if r.code != 200 || widens || len(ch) != 0 || !strings.Contains(r.raw, `"changes":[]`) {
		t.Fatalf("draft: %d %s", r.code, r.raw)
	}
	// Invalid input is still 400 on a draft.
	if _, _, r := u1.check(cid, map[string]any{"frames": []frameIn{{"layout": "bogus", "photoIds": []string{a}}}}); r.code != 400 || r.errMsg() != "帧版式无效。" {
		t.Fatalf("draft invalid: %d %s", r.code, r.raw)
	}
}

func TestExposureCheckValidation(t *testing.T) {
	e := newEnv(t)
	u1 := e.user("u1")
	a := e.mediaPhoto("u1", "A")
	e.user("u2")
	other := e.readyPhoto("u2")
	cid := published(u1, "public", a)
	missing := newID()

	many := make([]frameIn, 201)
	for i := range many {
		many[i] = full(a)
	}
	cases := []struct {
		name string
		body string
		code int
		msg  string
	}{
		{"layout", jsonBody(map[string]any{"frames": []frameIn{{"layout": "bogus", "photoIds": []string{a}}}}), 400, "帧版式无效。"},
		{"photos count", jsonBody(map[string]any{"frames": []frameIn{{"layout": "full", "photoIds": []string{}}}}), 400, "帧中的照片数量与版式不符。"},
		{"matte", jsonBody(map[string]any{"frames": []frameIn{{"layout": "matted", "photoIds": []string{a}}}}), 400, "留白帧的画面占比需在 0.5–0.95 之间，其他版式不能设置。"},
		{"text", jsonBody(map[string]any{"frames": []frameIn{{"layout": "text", "text": "  "}}}), 400, "文字帧需要 1–2000 个字符的文字，且只有文字帧可以带文字。"},
		{"too many", jsonBody(map[string]any{"frames": many}), 400, "帧序列最多 200 帧。"},
		{"empty published", `{"frames":[]}`, 400, "已发布的合集至少需要一帧。"},
		{"foreign photo", jsonBody(map[string]any{"frames": []frameIn{full(other)}}), 400, "帧引用的照片不存在或尚未处理完成。"},
		{"missing photo", jsonBody(map[string]any{"frames": []frameIn{full(missing)}}), 400, "帧引用的照片不存在或尚未处理完成。"},
		{"unknown field", `{"frames":[],"extra":1}`, 400, "请求格式无效。"},
		{"unknown frame field", `{"frames":[{"layout":"full","photoIds":["` + a + `"],"x":1}]}`, 400, "请求格式无效。"},
		{"bare array", `[]`, 400, "请求格式无效。"},
		{"title", jsonBody(map[string]any{"collection": collFields(map[string]any{"title": ""})}), 400, "标题需为 1–120 个字符。"},
		{"visibility", jsonBody(map[string]any{"collection": collFields(map[string]any{"visibility": "x"})}), 400, "可见性无效。"},
		{"license", jsonBody(map[string]any{"collection": collFields(map[string]any{"license": "x"})}), 400, "许可协议无效。"},
		{"distribute missing", `{"collection":{"title":"T","visibility":"public","originalDownload":false}}`, 400, "请求格式无效。"},
		{"cover", jsonBody(map[string]any{"collection": collFields(map[string]any{"visibility": "public", "coverPhotoId": other})}), 400, "封面必须是合集中已处理完成的照片。"},
		{"public fields", jsonBody(map[string]any{"override": map[string]any{"photoId": a, "publicFields": []string{"gps"}}}), 400, "公开字段无效。"},
		{"override photo absent", jsonBody(map[string]any{"override": map[string]any{"photoId": other}}), 404, "照片不在该合集中。"},
		{"override photo id", jsonBody(map[string]any{"override": map[string]any{"photoId": "nope"}}), 404, "照片不在该合集中。"},
		{"override unknown", jsonBody(map[string]any{"override": map[string]any{"photoId": a, "x": 1}}), 400, "请求格式无效。"},
	}
	for _, tc := range cases {
		r := u1.post("/api/collections/"+cid+"/exposure-check", tc.body)
		if r.code != tc.code || r.errMsg() != tc.msg {
			t.Errorf("%s: %d %q, want %d %q", tc.name, r.code, r.errMsg(), tc.code, tc.msg)
		}
	}
	// The cover may be a photo that only the proposed frames add.
	b := e.mediaPhoto("u1", "B")
	if _, _, r := u1.check(cid, map[string]any{"frames": []frameIn{full(a), full(b)},
		"collection": collFields(map[string]any{"visibility": "public", "coverPhotoId": b})}); r.code != 200 {
		t.Errorf("cover in proposed frames: %d %s", r.code, r.raw)
	}
	// An override may target a photo the proposed frames add.
	if _, _, r := u1.check(cid, map[string]any{"frames": []frameIn{full(a), full(b)},
		"override": map[string]any{"photoId": b}}); r.code != 200 {
		t.Errorf("override in proposed frames: %d %s", r.code, r.raw)
	}
}

func TestExposureCheckAuth(t *testing.T) {
	e := newEnv(t)
	u1, u2 := e.user("u1"), e.user("u2")
	a := e.mediaPhoto("u1", "A")
	cid := published(u1, "public", a)
	path := "/api/collections/" + cid + "/exposure-check"
	for name, r := range map[string]resp{
		"non-owner":  u2.post(path, `{}`),
		"missing":    u1.post("/api/collections/"+newID()+"/exposure-check", `{}`),
		"bad id":     u1.post("/api/collections/nope/exposure-check", `{}`),
		"non-owner+": u2.post(path, jsonBody(map[string]any{"frames": []frameIn{full(a)}})),
	} {
		if r.code != 404 || r.errMsg() != "合集不存在。" {
			t.Errorf("%s: %d %s", name, r.code, r.raw)
		}
	}
	if r := e.anon().post(path, `{}`); r.code != 401 {
		t.Errorf("anon: %d", r.code)
	}
	for name, hdr := range map[string]map[string]string{
		"no csrf":      {"X-CSRF-Token": "<delete>"},
		"wrong origin": {"Origin": "https://evil.example"},
	} {
		if r := u1.do("POST", path, `{}`, hdr); r.code != 403 {
			t.Errorf("%s: %d", name, r.code)
		}
	}
}

func TestExposureCheckWritesNothing(t *testing.T) {
	e := newEnv(t)
	u1 := e.user("u1")
	a, b := e.mediaPhoto("u1", "A"), e.mediaPhoto("u1", "B")
	cid := published(u1, "private", a)
	before := u1.get("/api/collections/" + cid).raw
	u1.mustCheck(cid, map[string]any{
		"collection": collFields(map[string]any{"visibility": "public", "originalDownload": true}),
		"frames":     []frameIn{full(a), full(b)},
		"override":   map[string]any{"photoId": b, "publicFields": []string{"lens"}},
	})
	if after := u1.get("/api/collections/" + cid).raw; after != before || len(e.jobs()) != 0 {
		t.Fatalf("exposure-check wrote:\n%s\n%s", before, after)
	}
}

func TestExposureCheckCombinedOrderAndLabels(t *testing.T) {
	e := newEnv(t)
	u1 := e.user("u1")
	a, b := e.mediaPhoto("u1", "A"), e.mediaPhoto("u1", "B")
	cid := published(u1, "unlisted", a)
	if r := u1.put("/api/collections/"+cid+"/overrides/"+a, `{"publicFields":[],"histogramPublic":false}`); r.code != 200 {
		t.Fatal(r.raw)
	}
	ch := u1.mustCheck(cid, map[string]any{
		"collection": collFields(map[string]any{"visibility": "public", "distribute": true, "originalDownload": true}),
		"frames":     []frameIn{full(a), full(b)},
		"override":   map[string]any{"photoId": a, "publicFields": []string{"taken_date", "focal_length", "camera", "lens"}, "histogramPublic": nil},
	})
	wantChanges(t, "combined", ch,
		"photos:新增 1 张公开照片", "fields:公开机身、镜头、焦段、ISO与拍摄日期", "histogram:公开直方图",
		"original:开放原图下载", "visibility:改为公开", "square:进入广场")

	// Labels: one, two, three, all eight.
	e.exec(`UPDATE photos SET public_fields='[]' WHERE id IN (?,?)`, a, b)
	pub := published(u1, "public", b)
	for _, tc := range []struct {
		fields []string
		want   string
	}{
		{[]string{"iso"}, "公开ISO"},
		{[]string{"lens", "camera"}, "公开机身与镜头"},
		{[]string{"focal_length", "camera", "lens"}, "公开机身、镜头与焦段"},
		{[]string{"taken_date", "exposure_bias", "iso", "shutter", "aperture", "focal_length", "lens", "camera"},
			"公开机身、镜头、焦段、光圈、快门、ISO、曝光补偿与拍摄日期"},
	} {
		got := u1.mustCheck(pub, map[string]any{"override": map[string]any{"photoId": b, "publicFields": tc.fields, "histogramPublic": true}})
		wantChanges(t, strings.Join(tc.fields, ","), got, "fields:"+tc.want)
	}
}

// exifKeys maps exifView JSON keys to public field keys.
var exifKeys = map[string]string{
	"camera": "camera", "lens": "lens", "focalLength": "focal_length", "focalLength35mm": "focal_length",
	"aperture": "aperture", "shutter": "shutter", "exposureSeconds": "shutter", "iso": "iso",
	"exposureBias": "exposure_bias", "takenAt": "taken_date", "takenOffsetMinutes": "taken_date",
}

var fieldLabel = map[string]string{"camera": "机身", "lens": "镜头", "focal_length": "焦段", "aperture": "光圈",
	"shutter": "快门", "iso": "ISO", "exposure_bias": "曝光补偿", "taken_date": "拍摄日期"}

// TestExposureCheckMatchesRead starts from published private collections
// (nothing visible), so every "after" exposure shows up as a change. It then
// applies the proposal for real and reads anonymously: the visible photos,
// field union, histogram and download must match the prediction.
func TestExposureCheckMatchesRead(t *testing.T) {
	e := newEnv(t)
	u1 := e.user("u1")
	fixtures := []struct {
		name     string
		vis      string
		orig     bool
		override func(a, b string) map[string]any
		frames   func(a, b, c string) []frameIn
	}{
		{"unlisted plain", "unlisted", false, nil, func(a, b, c string) []frameIn { return []frameIn{full(a), pair(b, c)} }},
		{"public override", "public", true,
			func(a, b string) map[string]any {
				return map[string]any{"photoId": b, "publicFields": []string{"lens", "exposure_bias", "taken_date"}, "histogramPublic": false}
			},
			func(a, b, c string) []frameIn { return []frameIn{full(a), full(b), textFrame("t")} }},
		{"hide all", "public", false,
			func(a, b string) map[string]any {
				return map[string]any{"photoId": a, "publicFields": []string{}, "histogramPublic": false}
			},
			func(a, b, c string) []frameIn { return []frameIn{full(a)} }},
	}
	for _, fx := range fixtures {
		t.Run(fx.name, func(t *testing.T) {
			a, b, c := e.mediaPhoto("u1", "A"), e.mediaPhoto("u1", "B"), e.mediaPhoto("u1", "C")
			e.exec(`UPDATE photo_exif SET exposure_bias=-0.7 WHERE photo_id IN (?,?,?)`, a, b, c)
			cid := published(u1, "private", a)
			coll := collFields(map[string]any{"visibility": fx.vis, "distribute": false, "originalDownload": fx.orig})
			frames := fx.frames(a, b, c)
			body := map[string]any{"collection": coll, "frames": frames}
			var override map[string]any
			if fx.override != nil {
				override = fx.override(a, b)
				body["override"] = override
			}
			ch := u1.mustCheck(cid, body)

			// Apply for real: frames, then override, then fields (the desk's order).
			u1.mustFrames(cid, frames...)
			if override != nil {
				pid := override["photoId"].(string)
				rest := map[string]any{}
				for k, v := range override {
					if k != "photoId" {
						rest[k] = v
					}
				}
				if r := u1.put("/api/collections/"+cid+"/overrides/"+pid, jsonBody(rest)); r.code != 200 {
					t.Fatal(r.raw)
				}
			}
			if r := u1.put("/api/collections/"+cid, jsonBody(coll)); r.code != 200 {
				t.Fatal(r.raw)
			}

			r := e.anon().get("/api/collections/" + cid)
			if r.code != 200 {
				t.Fatalf("anon read: %d", r.code)
			}
			var read struct {
				Frames []struct {
					Photos []struct {
						ID           string                     `json:"id"`
						EXIF         map[string]json.RawMessage `json:"exif"`
						Histogram    json.RawMessage            `json:"histogram"`
						Downloadable bool                       `json:"downloadable"`
					} `json:"photos"`
				} `json:"frames"`
			}
			if err := json.Unmarshal([]byte(r.raw), &read); err != nil {
				t.Fatal(err)
			}
			ids, fields := map[string]bool{}, map[string]bool{}
			hist, dl := false, false
			for _, f := range read.Frames {
				for _, p := range f.Photos {
					ids[p.ID] = true
					for k := range p.EXIF {
						fields[exifKeys[k]] = true
					}
					hist = hist || (len(p.Histogram) > 0 && string(p.Histogram) != "null")
					dl = dl || p.Downloadable
				}
			}
			var want []string
			if n := len(ids); n > 0 {
				want = append(want, fmt.Sprintf("photos:新增 %d 张公开照片", n))
			}
			var labels []string
			for _, k := range []string{"camera", "lens", "focal_length", "aperture", "shutter", "iso", "exposure_bias", "taken_date"} {
				if fields[k] {
					labels = append(labels, fieldLabel[k])
				}
			}
			if len(labels) > 0 {
				want = append(want, "fields:公开"+joinLabels(labels))
			}
			if hist {
				want = append(want, "histogram:公开直方图")
			}
			if dl {
				want = append(want, "original:开放原图下载")
			}
			if fx.vis == "public" {
				want = append(want, "visibility:改为公开")
			} else {
				want = append(want, "visibility:改为仅链接")
			}
			wantChanges(t, fx.name, ch, want...)
			if fx.name == "hide all" && (len(fields) != 0 || hist) {
				t.Errorf("hide all exposed %v %v", fields, hist)
			}
		})
	}
}

func joinLabels(l []string) string {
	if len(l) <= 1 {
		return strings.Join(l, "")
	}
	return strings.Join(l[:len(l)-1], "、") + "与" + l[len(l)-1]
}

// anonExposure reads a collection anonymously and returns what a visitor sees:
// visible photo ids, the public field keys and the histogram per photo, and
// whether any photo is downloadable.
func anonExposure(t *testing.T, c *client, cid string) (map[string]map[string]bool, map[string]bool, bool) {
	t.Helper()
	r := c.get("/api/collections/" + cid)
	if r.code != 200 {
		t.Fatalf("anon read: %d %s", r.code, r.raw)
	}
	var read struct {
		Frames []struct {
			Photos []struct {
				ID           string                     `json:"id"`
				EXIF         map[string]json.RawMessage `json:"exif"`
				Histogram    json.RawMessage            `json:"histogram"`
				Downloadable bool                       `json:"downloadable"`
			} `json:"photos"`
		} `json:"frames"`
	}
	if err := json.Unmarshal([]byte(r.raw), &read); err != nil {
		t.Fatal(err)
	}
	fields, hist, dl := map[string]map[string]bool{}, map[string]bool{}, false
	for _, f := range read.Frames {
		for _, p := range f.Photos {
			if fields[p.ID] == nil {
				fields[p.ID] = map[string]bool{}
			}
			for k := range p.EXIF {
				fields[p.ID][exifKeys[k]] = true
			}
			hist[p.ID] = hist[p.ID] || (len(p.Histogram) > 0 && string(p.Histogram) != "null")
			dl = dl || p.Downloadable
		}
	}
	return fields, hist, dl
}

// TestExposureCheckMatchesReadFromVisible starts from a collection visitors can
// already see, so only what the change adds may be reported. It applies the
// proposal and compares the anonymous read before and after with the check's
// prediction (review Minor: the existing fixture starts from private).
func TestExposureCheckMatchesReadFromVisible(t *testing.T) {
	e := newEnv(t)
	u1 := e.user("u1")
	a, b := e.mediaPhoto("u1", "A"), e.mediaPhoto("u1", "B") // snapshot: camera+iso, histogram on
	cid := published(u1, "unlisted", a)
	// Start narrower than the snapshot: a shows only camera, no histogram.
	if r := u1.put("/api/collections/"+cid+"/overrides/"+a, `{"publicFields":["camera"],"histogramPublic":false}`); r.code != 200 {
		t.Fatal(r.raw)
	}
	beforeFields, beforeHist, beforeDL := anonExposure(t, e.anon(), cid)
	if len(beforeFields) != 1 || !beforeFields[a]["camera"] || beforeFields[a]["iso"] || beforeHist[a] || beforeDL {
		t.Fatalf("unexpected starting exposure: %v %v %v", beforeFields, beforeHist, beforeDL)
	}

	// Proposal: add b (snapshot camera+iso, histogram) after a. a is unchanged.
	frames := []frameIn{full(a), full(b)}
	ch := u1.mustCheck(cid, map[string]any{"frames": frames})

	if r := u1.put("/api/collections/"+cid+"/frames", jsonBody(frames)); r.code != 200 {
		t.Fatal(r.raw)
	}
	afterFields, afterHist, afterDL := anonExposure(t, e.anon(), cid)

	// Expected changes: only what is newly visible after the write.
	newPhotos := 0
	newFields := map[string]bool{}
	newHist := false
	for id, fs := range afterFields {
		if beforeFields[id] == nil {
			newPhotos++
		}
		for k := range fs {
			if !beforeFields[id][k] {
				newFields[k] = true
			}
		}
		if afterHist[id] && !beforeHist[id] {
			newHist = true
		}
	}
	var want []string
	if newPhotos > 0 {
		want = append(want, fmt.Sprintf("photos:新增 %d 张公开照片", newPhotos))
	}
	var labels []string
	for _, k := range []string{"camera", "lens", "focal_length", "aperture", "shutter", "iso", "exposure_bias", "taken_date"} {
		if newFields[k] {
			labels = append(labels, fieldLabel[k])
		}
	}
	if len(labels) > 0 {
		want = append(want, "fields:公开"+joinLabels(labels))
	}
	if newHist {
		want = append(want, "histogram:公开直方图")
	}
	if afterDL && !beforeDL {
		want = append(want, "original:开放原图下载")
	}
	wantChanges(t, "from visible", ch, want...)
	if len(want) == 0 {
		t.Fatal("fixture should widen; nothing was predicted")
	}
}
