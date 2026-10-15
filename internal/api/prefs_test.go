package api_test

import (
	"strings"
	"testing"
)

func prefsBody(over map[string]any) string {
	b := map[string]any{"publicFields": []string{}, "histogramPublic": true, "originalDownload": false,
		"watermark": nil, "locationMode": "off"}
	for k, v := range over {
		if v == "<omit>" {
			delete(b, k)
		} else {
			b[k] = v
		}
	}
	return jsonBody(b)
}

func wm(text, pos string, opacity, scale float64) map[string]any {
	return map[string]any{"text": text, "position": pos, "opacity": opacity, "scale": scale}
}

func TestUploadPrefsDefaults(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	r := u.get("/api/upload-prefs")
	if r.code != 200 {
		t.Fatalf("%d %s", r.code, r.raw)
	}
	pf, _ := r.body["publicFields"].([]any)
	if len(pf) != 4 || pf[0] != "aperture" || pf[1] != "shutter" || pf[2] != "iso" || pf[3] != "focal_length" ||
		r.body["histogramPublic"] != true || r.body["originalDownload"] != false || r.body["watermark"] != nil ||
		r.body["defaultLicense"] != nil || r.body["defaultAiDeclaration"] != nil || r.body["locationMode"] != "off" ||
		r.body["updatedAt"] != nil || len(r.body) != 8 {
		t.Fatalf("defaults: %s", r.raw)
	}
	var n int
	_ = e.d.QueryRow(`SELECT count(*) FROM upload_prefs`).Scan(&n)
	if n != 0 {
		t.Fatal("GET wrote a row")
	}
}

func TestUploadPrefsPutAndSnapshot(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	ready := e.readyPhoto("u1")
	r := u.put("/api/upload-prefs", prefsBody(map[string]any{
		"publicFields": []string{"camera", "lens"}, "histogramPublic": false, "originalDownload": true,
		"watermark": wm("© Ada", "br", 0.3, 0.04), "defaultLicense": "by-sa",
		"defaultAiDeclaration": "no-generative-ai", "locationMode": "archive",
	}))
	if r.code != 200 {
		t.Fatalf("put: %d %s", r.code, r.raw)
	}
	pf, _ := r.body["publicFields"].([]any)
	if len(pf) != 2 || pf[0] != "camera" || r.body["histogramPublic"] != false || r.body["originalDownload"] != true ||
		r.body["locationMode"] != "archive" || r.body["defaultLicense"] != "by-sa" ||
		r.body["defaultAiDeclaration"] != "no-generative-ai" || r.body["updatedAt"] != float64(t0) {
		t.Fatalf("%s", r.raw)
	}
	got, _ := r.body["watermark"].(map[string]any)
	if got["text"] != "© Ada" || got["position"] != "br" || got["opacity"] != 0.3 || got["scale"] != 0.04 {
		t.Fatalf("wm: %v", got)
	}
	if g := u.get("/api/upload-prefs"); g.raw != r.raw {
		t.Fatalf("get != put:\n%s\n%s", g.raw, r.raw)
	}

	// Existing photos keep their snapshot.
	var fields string
	var hist, orig int
	_ = e.d.QueryRow(`SELECT public_fields,histogram_public,original_download FROM photos WHERE id=?`, ready).Scan(&fields, &hist, &orig)
	if fields != `["iso","camera"]` || hist != 0 || orig != 0 {
		t.Fatalf("ready snapshot changed: %s %d %d", fields, hist, orig)
	}
	// A new upload takes the new prefs; a later change leaves it alone.
	id := u.initiate(shaA, 10)
	if g := u.get("/api/photos/" + id); g.body["originalDownload"] != true || g.body["histogramPublic"] != false {
		t.Fatalf("new snapshot: %s", g.raw)
	}
	e.now.Add(1)
	r = u.put("/api/upload-prefs", prefsBody(nil))
	if r.code != 200 || r.body["watermark"] != nil || r.body["defaultLicense"] != nil || r.body["updatedAt"] != float64(t0+1) {
		t.Fatalf("clear: %d %s", r.code, r.raw)
	}
	if g := u.get("/api/photos/" + id); g.body["originalDownload"] != true {
		t.Fatalf("snapshot changed: %s", g.raw)
	}
	var n int
	_ = e.d.QueryRow(`SELECT count(*) FROM upload_prefs`).Scan(&n)
	if n != 1 {
		t.Fatalf("%d rows", n)
	}
}

func TestUploadPrefsValidation(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	for name, body := range map[string]string{
		"bad field":   prefsBody(map[string]any{"publicFields": []string{"gps"}}),
		"dup field":   prefsBody(map[string]any{"publicFields": []string{"iso", "iso"}}),
		"null fields": prefsBody(map[string]any{"publicFields": nil}),
		"bad license": prefsBody(map[string]any{"defaultLicense": "cc0"}),
		"bad ai":      prefsBody(map[string]any{"defaultAiDeclaration": "yes"}),
		"bad loc":     prefsBody(map[string]any{"locationMode": "on"}),
		"wm empty":    prefsBody(map[string]any{"watermark": wm("", "br", 0.3, 0.04)}),
		"wm blank":    prefsBody(map[string]any{"watermark": wm("ㅤ", "br", 0.3, 0.04)}),
		"wm long":     prefsBody(map[string]any{"watermark": wm(strings.Repeat("a", 65), "br", 0.3, 0.04)}),
		"wm pos":      prefsBody(map[string]any{"watermark": wm("x", "mid", 0.3, 0.04)}),
		"wm opacity":  prefsBody(map[string]any{"watermark": wm("x", "br", 0.09, 0.04)}),
		"wm scale":    prefsBody(map[string]any{"watermark": wm("x", "br", 0.3, 0.09)}),
		"wm extra":    prefsBody(map[string]any{"watermark": map[string]any{"text": "x", "position": "br", "opacity": 0.3, "scale": 0.04, "font": "x"}}),
		"missing loc": prefsBody(map[string]any{"locationMode": "<omit>"}),
		"missing wm":  prefsBody(map[string]any{"watermark": "<omit>"}),
		"missing pf":  prefsBody(map[string]any{"publicFields": "<omit>"}),
		"missing h":   prefsBody(map[string]any{"histogramPublic": "<omit>"}),
		"unknown":     prefsBody(map[string]any{"extra": 1}),
	} {
		if r := u.put("/api/upload-prefs", body); r.code != 400 {
			t.Errorf("%s: %d %s", name, r.code, r.raw)
		}
	}
	var n int
	_ = e.d.QueryRow(`SELECT count(*) FROM upload_prefs`).Scan(&n)
	if n != 0 {
		t.Fatal("invalid prefs written")
	}
	for name, body := range map[string]string{
		"all fields": prefsBody(map[string]any{"publicFields": []string{"camera", "lens", "focal_length", "aperture",
			"shutter", "iso", "exposure_bias", "taken_date"}}),
		"wm low":  prefsBody(map[string]any{"watermark": wm(strings.Repeat("字", 64), "center", 0.1, 0.02)}),
		"wm high": prefsBody(map[string]any{"watermark": wm("x", "tl", 0.8, 0.08)}),
	} {
		if r := u.put("/api/upload-prefs", body); r.code != 200 {
			t.Errorf("%s: %d %s", name, r.code, r.raw)
		}
	}
}
