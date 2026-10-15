package api_test

import (
	"encoding/base64"
	"fmt"
	"net/url"
	"strings"
	"testing"
	"time"
)

func ms(y int, m time.Month, d int) int64 {
	return time.Date(y, m, d, 12, 0, 0, 0, time.UTC).UnixMilli()
}

// archivePhoto inserts a photo with EXIF; taken == 0 means no taken_at.
func (e *env) archivePhoto(owner, status, mk, model, lens string, focal float64, taken, created int64) string {
	e.t.Helper()
	id := e.mediaPhoto(owner, "A")
	e.exec(`UPDATE photos SET status=?,created_at=? WHERE id=?`, status, created, id)
	var tk any
	if taken != 0 {
		tk = taken
	}
	e.exec(`UPDATE photo_exif SET camera_make=?,camera_model=?,lens_model=?,focal_length_mm=?,taken_at=? WHERE photo_id=?`,
		mk, model, lens, focal, tk, id)
	return id
}

func itemIDs(t *testing.T, r resp) []string { t.Helper(); return cardIDs(t, r.body["items"]) }

func TestArchive(t *testing.T) {
	e := newEnv(t)
	u1, u2, anon := viewers(e)
	p1 := e.archivePhoto("u1", "ready", "FUJIFILM", "X-T5", "XF23", 23, ms(2024, 5, 1), ms(2025, 1, 1))
	p2 := e.archivePhoto("u1", "ready", "Canon", "Canon EOS R5", "RF50", 50, ms(2023, 3, 1), ms(2025, 1, 2))
	p3 := e.archivePhoto("u1", "ready", "FUJIFILM", "X-T5", "XF56", 56, 0, ms(2025, 2, 1)) // sorts by created_at
	p4 := e.archivePhoto("u1", "processing", "FUJIFILM", "X-T5", "XF23", 23, ms(2022, 1, 1), ms(2025, 3, 1))
	other := e.archivePhoto("u2", "ready", "Sony", "A7", "FE35", 35, ms(2024, 1, 1), ms(2025, 1, 1))
	c := u1.coll("published", "public", nil, p1)
	_ = c

	if r := anon.get("/api/archive"); r.code != 401 {
		t.Fatalf("anon: %d", r.code)
	}
	r := u1.get("/api/archive")
	if r.code != 200 {
		t.Fatalf("%d %s", r.code, r.raw)
	}
	if got, want := strings.Join(itemIDs(t, r), ","), strings.Join([]string{p3, p1, p2, p4}, ","); got != want {
		t.Fatalf("order\n got %s\nwant %s", got, want)
	}
	if r.body["nextCursor"] != nil {
		t.Errorf("cursor %v", r.body["nextCursor"])
	}
	// owner photo view, media via /m with empty c
	it := r.body["items"].([]any)[1].(map[string]any)
	if it["status"] != "ready" || it["publicFields"] == nil {
		t.Errorf("item %v", it)
	}
	m := it["media"].(map[string]any)["tiers"].(map[string]any)["w480"].(map[string]any)
	if m["webp"] != "/m/"+p1+"/"+hashA+"/w480.webp?c=" {
		t.Errorf("media %v", m)
	}
	f := r.body["facets"].(map[string]any)
	if fmt.Sprint(f["years"]) != "[map[count:1 year:2025] map[count:1 year:2024] map[count:1 year:2023]]" {
		t.Errorf("years %v", f["years"])
	}
	if fmt.Sprint(f["cameras"]) != "[map[count:2 name:FUJIFILM X-T5] map[count:1 name:Canon EOS R5]]" {
		t.Errorf("cameras %v", f["cameras"])
	}
	if fmt.Sprint(f["lenses"]) != "[map[count:1 name:RF50] map[count:1 name:XF23] map[count:1 name:XF56]]" {
		t.Errorf("lenses %v", f["lenses"])
	}
	if strings.Contains(r.raw, other) || strings.Contains(r.raw, "Sony") {
		t.Errorf("leaks other owner: %s", r.raw)
	}
	if ids := itemIDs(t, u2.get("/api/archive")); len(ids) != 1 || ids[0] != other {
		t.Errorf("u2 archive %v", ids)
	}

	filters := map[string][]string{
		"year=2024": {p1},
		"year=2025": {p3},
		"camera=" + url.QueryEscape("FUJIFILM X-T5"): {p3, p1, p4},
		"camera=" + url.QueryEscape("Canon EOS R5"):  {p2},
		"lens=XF23":                                {p1, p4},
		"focal_min=30":                             {p3, p2},
		"focal_max=50":                             {p1, p2, p4},
		"focal_min=24&focal_max=55":                {p2},
		"focal_min=23.0&focal_max=23":              {p1, p4},
		"in_collection=true":                       {p1},
		"in_collection=false":                      {p3, p2, p4},
		"status=processing":                        {p4},
		"status=ready&lens=XF23":                   {p1},
		"camera=" + url.QueryEscape("' OR 1=1 --"): {},
	}
	for q, want := range filters {
		r := u1.get("/api/archive?" + q)
		if r.code != 200 {
			t.Errorf("%s: %d %s", q, r.code, r.raw)
			continue
		}
		if got := strings.Join(itemIDs(t, r), ","); got != strings.Join(want, ",") {
			t.Errorf("%s: got %s want %s", q, got, strings.Join(want, ","))
		}
		// facets are over all ready photos regardless of filters
		if fmt.Sprint(r.body["facets"].(map[string]any)["years"]) != fmt.Sprint(f["years"]) {
			t.Errorf("%s: facets changed", q)
		}
	}
	for _, q := range []string{"year=1899", "year=2101", "year=x", "year=2024&year=2025", "focal_min=0", "focal_min=-1",
		"focal_max=abc", "focal_min=NaN", "focal_max=Inf", "focal_min=50&focal_max=20", "in_collection=yes",
		"status=deleted", "limit=0", "limit=101", "cursor=!!", "camera=" + strings.Repeat("a", 201)} {
		if r := u1.get("/api/archive?" + q); r.code != 400 {
			t.Errorf("%s: %d %s", q, r.code, r.raw)
		}
	}
	// pagination: stable, no duplicates
	var got []string
	cur := ""
	for i := 0; i < 10; i++ {
		path := "/api/archive?limit=1"
		if cur != "" {
			path += "&cursor=" + cur
		}
		r := u1.get(path)
		if r.code != 200 {
			t.Fatalf("%s: %d %s", path, r.code, r.raw)
		}
		got = append(got, itemIDs(t, r)...)
		nc, _ := r.body["nextCursor"].(string)
		if nc == "" {
			break
		}
		cur = nc
	}
	if strings.Join(got, ",") != strings.Join([]string{p3, p1, p2, p4}, ",") {
		t.Errorf("paged %v", got)
	}
	bad := base64.RawURLEncoding.EncodeToString([]byte("1.not-a-uuid"))
	if r := u1.get("/api/archive?cursor=" + bad); r.code != 400 {
		t.Errorf("tampered cursor: %d", r.code)
	}
}
