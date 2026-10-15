package api_test

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/timeStarry/frameMark/internal/storage"
)

const (
	shaA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	shaB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

func uploadBody(filename string, bytes int64, sha, ct string) string {
	b, _ := json.Marshal(map[string]any{"filename": filename, "bytes": bytes, "sha256": sha, "contentType": ct})
	return string(b)
}

func shaN(n int) string { return fmt.Sprintf("%064x", n) }

func newID() string { return uuid.Must(uuid.NewV7()).String() }

// initiate creates an upload and returns its photoId.
func (c *client) initiate(sha string, bytes int64) string {
	c.e.t.Helper()
	r := c.post("/api/uploads", uploadBody("IMG_0001.JPG", bytes, sha, "image/jpeg"))
	if r.code != 201 {
		c.e.t.Fatalf("initiate: %d %s", r.code, r.raw)
	}
	id, _ := r.body["photoId"].(string)
	return id
}

func key(owner, id string) string { return "o/" + owner + "/" + id }

func TestUploadsRequireLoginAndCSRF(t *testing.T) {
	e := newEnv(t)
	body := uploadBody("a.jpg", 10, shaA, "image/jpeg")

	anon := e.anon()
	if r := anon.post("/api/uploads", body); r.code != 401 || r.errMsg() != "请先登录。" {
		t.Fatalf("anon: %d %s", r.code, r.raw)
	}
	if r := anon.get("/api/photos/" + newID()); r.code != 401 {
		t.Fatalf("anon get: %d %s", r.code, r.raw)
	}
	if r := anon.post("/api/uploads/"+newID()+"/complete", ""); r.code != 401 {
		t.Fatalf("anon complete: %d %s", r.code, r.raw)
	}

	u := e.user("u1")
	for name, hdr := range map[string]map[string]string{
		"wrong csrf":   {"X-CSRF-Token": strings.Repeat("A", 43)},
		"no csrf":      {"X-CSRF-Token": "<delete>"},
		"wrong origin": {"Origin": "https://evil.example"},
		"no origin":    {"Origin": "<delete>"},
	} {
		for _, path := range []string{"/api/uploads", "/api/uploads/" + newID() + "/complete"} {
			if r := u.do(http.MethodPost, path, body, hdr); r.code != 403 {
				t.Errorf("%s %s: %d %s", name, path, r.code, r.raw)
			}
		}
	}
	if n := len(e.st.presignCalls()); n != 0 {
		t.Fatalf("presigned %d times without auth", n)
	}
}

func TestCreateUploadValidation(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	limit := int64(maxMB) << 20
	for _, tc := range []struct{ name, body string }{
		{"bad json", `{`},
		{"not object", `[]`},
		{"empty body", ``},
		{"unknown field", `{"filename":"a.jpg","bytes":1,"sha256":"` + shaA + `","contentType":"image/jpeg","x":1}`},
		{"trailing data", uploadBody("a.jpg", 1, shaA, "image/jpeg") + `{}`},
		{"wrong type", `{"filename":"a.jpg","bytes":"1","sha256":"` + shaA + `","contentType":"image/jpeg"}`},
		{"content type gif", uploadBody("a.gif", 1, shaA, "image/gif")},
		{"content type params", uploadBody("a.jpg", 1, shaA, "image/jpeg; charset=x")},
		{"content type case", uploadBody("a.jpg", 1, shaA, "IMAGE/JPEG")},
		{"content type empty", uploadBody("a.jpg", 1, shaA, "")},
		{"zero bytes", uploadBody("a.jpg", 0, shaA, "image/jpeg")},
		{"negative bytes", uploadBody("a.jpg", -1, shaA, "image/jpeg")},
		{"too large", uploadBody("a.jpg", limit+1, shaA, "image/jpeg")},
		{"sha upper", uploadBody("a.jpg", 1, strings.ToUpper(shaA), "image/jpeg")},
		{"sha short", uploadBody("a.jpg", 1, shaA[:63], "image/jpeg")},
		{"sha nonhex", uploadBody("a.jpg", 1, strings.Repeat("g", 64), "image/jpeg")},
		{"sha missing", `{"filename":"a.jpg","bytes":1,"contentType":"image/jpeg"}`},
		{"filename empty", uploadBody("", 1, shaA, "image/jpeg")},
		{"filename slash", uploadBody("a/b.jpg", 1, shaA, "image/jpeg")},
		{"filename backslash", uploadBody(`a\b.jpg`, 1, shaA, "image/jpeg")},
		{"filename control", uploadBody("a\x00.jpg", 1, shaA, "image/jpeg")},
		{"filename del", uploadBody("a\x7f.jpg", 1, shaA, "image/jpeg")},
		{"filename too long", uploadBody(strings.Repeat("a", 256), 1, shaA, "image/jpeg")},
		{"filename bad utf8", `{"filename":"\udc00.jpg","bytes":1,"sha256":"` + shaA + `","contentType":"image/jpeg"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := u.post("/api/uploads", tc.body)
			if r.code != 400 || r.errMsg() == "" {
				t.Fatalf("%d %s", r.code, r.raw)
			}
		})
	}
	var n int
	_ = e.d.QueryRow(`SELECT count(*) FROM photos`).Scan(&n)
	if n != 0 || len(e.st.presignCalls()) != 0 {
		t.Fatalf("invalid uploads created %d photos, %d presigns", n, len(e.st.presignCalls()))
	}
	// The exact limit is accepted.
	if r := u.post("/api/uploads", uploadBody(strings.Repeat("a", 255), limit, shaA, "image/png")); r.code != 201 {
		t.Fatalf("limit: %d %s", r.code, r.raw)
	}
}

func TestCreateUploadSuccess(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	r := u.post("/api/uploads", uploadBody("Sunset at the Pier.v2.webp", 1234, shaA, "image/webp"))
	if r.code != 201 {
		t.Fatalf("%d %s", r.code, r.raw)
	}
	id, _ := r.body["photoId"].(string)
	if pid, err := uuid.Parse(id); err != nil || pid.Version() != 7 {
		t.Fatalf("photoId %q", id)
	}
	up, _ := r.body["upload"].(map[string]any)
	hdr, _ := up["headers"].(map[string]any)
	if up["method"] != "PUT" || !strings.HasPrefix(up["url"].(string), "https://storage.test/") ||
		hdr["Content-Type"] != "image/webp" || hdr["X-Amz-Checksum-Sha256"] != shaA {
		t.Fatalf("upload %v", up)
	}
	if exp, _ := r.body["expiresAt"].(float64); int64(exp) != t0+15*60_000 {
		t.Fatalf("expiresAt %v", r.body["expiresAt"])
	}
	calls := e.st.presignCalls()
	want := presignCall{bucket, key("u1", id), "image/webp", shaA, 15 * time.Minute}
	if len(calls) != 1 || calls[0] != want {
		t.Fatalf("presign %+v, want %+v", calls, want)
	}

	var (
		owner, status, okey, sha, format, title, fields string
		bytes                                           int64
		hist, orig                                      int
	)
	err := e.d.QueryRow(`SELECT owner_id,status,original_key,original_sha256,original_bytes,format,title,
		public_fields,histogram_public,original_download FROM photos WHERE id=?`, id).
		Scan(&owner, &status, &okey, &sha, &bytes, &format, &title, &fields, &hist, &orig)
	if err != nil {
		t.Fatal(err)
	}
	if owner != "u1" || status != "uploading" || okey != key("u1", id) || sha != shaA || bytes != 1234 ||
		format != "webp" || title != "Sunset at the Pier.v2" {
		t.Fatalf("row %s %s %s %s %d %s %q", owner, status, okey, sha, bytes, format, title)
	}
	if fields != `["aperture","shutter","iso","focal_length"]` || hist != 1 || orig != 0 {
		t.Fatalf("default prefs %s %d %d", fields, hist, orig)
	}

	g := u.get("/api/photos/" + id)
	if g.code != 200 || g.body["status"] != "uploading" || g.body["title"] != "Sunset at the Pier.v2" ||
		g.body["format"] != "webp" || g.body["histogramPublic"] != true || g.body["originalDownload"] != false {
		t.Fatalf("get %d %s", g.code, g.raw)
	}
}

func TestCreateUploadSnapshotsPrefs(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	e.exec(`INSERT INTO upload_prefs(user_id,public_fields,histogram_public,original_download,location_mode,updated_at)
		VALUES('u1','["camera","lens"]',0,1,'archive',?)`, t0)
	id := u.initiate(shaA, 10)
	g := u.get("/api/photos/" + id)
	pf, _ := g.body["publicFields"].([]any)
	if len(pf) != 2 || pf[0] != "camera" || pf[1] != "lens" || g.body["histogramPublic"] != false || g.body["originalDownload"] != true {
		t.Fatalf("%s", g.raw)
	}
	// A later prefs change does not touch the snapshot.
	e.exec(`UPDATE upload_prefs SET public_fields='[]', original_download=0`)
	if g := u.get("/api/photos/" + id); g.body["originalDownload"] != true {
		t.Fatalf("snapshot changed: %s", g.raw)
	}
}

// New photos get a random 16-byte hex derived_salt so derived URLs cannot
// be computed from the original's sha256 (Task 13 ruling I1).
func TestNewPhotoGetsRandomSalt(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	salt := func(id string) string {
		var s string
		if err := e.d.QueryRow(`SELECT derived_salt FROM photos WHERE id=?`, id).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	a, b := u.initiate(shaN(1), 10), u.initiate(shaN(2), 10)
	sa, sb := salt(a), salt(b)
	for _, s := range []string{sa, sb} {
		if len(s) != 32 || strings.Trim(s, "0123456789abcdef") != "" {
			t.Fatalf("salt %q", s)
		}
	}
	if sa == sb {
		t.Fatal("salts repeat")
	}
	// Re-initiating the same uploading row keeps its salt.
	if again := u.initiate(shaN(1), 10); again != a || salt(a) != sa {
		t.Fatalf("reuse changed salt: %s %q", again, salt(a))
	}
}

func TestTitleDefault(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	for i, tc := range []struct{ filename, want string }{
		{"IMG_0001.JPG", "IMG_0001"},
		{"photo", "photo"},
		{".hidden", ".hidden"},
		{"a.b.c.png", "a.b.c"},
		{"  spaced  .jpg", "spaced"},
		{strings.Repeat("相", 50) + strings.Repeat("a", 90) + ".jpg", strings.Repeat("相", 50) + strings.Repeat("a", 70)},
		{"bidi‮.jpg", "bidi"},
	} {
		r := u.post("/api/uploads", uploadBody(tc.filename, 10, shaN(100+i), "image/jpeg"))
		if r.code != 201 {
			t.Fatalf("%q: %d %s", tc.filename, r.code, r.raw)
		}
		var title string
		_ = e.d.QueryRow(`SELECT title FROM photos WHERE id=?`, r.body["photoId"]).Scan(&title)
		if title != tc.want {
			t.Errorf("%q: title %q, want %q", tc.filename, title, tc.want)
		}
		e.exec(`DELETE FROM photos`)
	}
}

func TestQuota(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	other := e.user("u2")
	for i := 0; i < quota-1; i++ {
		u.initiate(shaN(i), 10)
	}
	e.insertPhoto("u1", newID(), "failed", shaN(50)) // failed rows do not count
	e.insertPhoto("u2", newID(), "ready", shaN(51))  // other owners do not count
	u.initiate(shaN(quota), 10)
	r := u.post("/api/uploads", uploadBody("x.jpg", 10, shaN(99), "image/jpeg"))
	if r.code != 409 || r.errMsg() != "素材数量已达上限。" {
		t.Fatalf("%d %s", r.code, r.raw)
	}
	// A failed retry would add a counted row, so it is also refused at quota.
	if r := u.post("/api/uploads", uploadBody("x.jpg", 10, shaN(50), "image/jpeg")); r.code != 409 {
		t.Fatalf("failed retry at quota: %d %s", r.code, r.raw)
	}
	// Re-presigning an upload already counted is allowed at quota.
	if r := u.post("/api/uploads", uploadBody("x.jpg", 10, shaN(0), "image/jpeg")); r.code != 201 {
		t.Fatalf("uploading retry at quota: %d %s", r.code, r.raw)
	}
	if r := other.post("/api/uploads", uploadBody("x.jpg", 10, shaN(99), "image/jpeg")); r.code != 201 {
		t.Fatalf("other owner: %d %s", r.code, r.raw)
	}
}

func TestDedup(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	for _, st := range []string{"ready", "processing"} {
		t.Run(st, func(t *testing.T) {
			id, sha := newID(), shaN(len(st))
			e.insertPhoto("u1", id, st, sha)
			before := len(e.st.presignCalls())
			r := u.post("/api/uploads", uploadBody("again.jpg", 10, sha, "image/jpeg"))
			if r.code != 200 || r.body["id"] != id || r.body["status"] != st || r.body["upload"] != nil {
				t.Fatalf("%d %s", r.code, r.raw)
			}
			if len(e.st.presignCalls()) != before {
				t.Fatal("dedup presigned")
			}
		})
	}
	for _, st := range []string{"failed", "uploading"} {
		t.Run(st, func(t *testing.T) {
			id, sha := newID(), shaN(10+len(st))
			e.insertPhoto("u1", id, st, sha)
			e.exec(`UPDATE photos SET error='上传校验失败，请重新上传。' WHERE id=?`, id)
			r := u.post("/api/uploads", uploadBody("again.png", 777, sha, "image/png"))
			if r.code != 201 || r.body["photoId"] != id {
				t.Fatalf("%d %s", r.code, r.raw)
			}
			calls := e.st.presignCalls()
			if last := calls[len(calls)-1]; last.Key != key("u1", id) || last.ContentType != "image/png" {
				t.Fatalf("presign %+v", last)
			}
			status, msg := e.status(id)
			var bytes int64
			var format string
			_ = e.d.QueryRow(`SELECT original_bytes,format FROM photos WHERE id=?`, id).Scan(&bytes, &format)
			if status != "uploading" || msg.Valid || bytes != 777 || format != "png" {
				t.Fatalf("row %s %v %d %s", status, msg, bytes, format)
			}
		})
	}
	// The same hash from another owner is a separate photo.
	other := e.user("u2")
	id := other.initiate(shaN(len("ready")), 10)
	if id == "" {
		t.Fatal("no id")
	}
}

func TestCompleteMissingObject(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	id := u.initiate(shaA, 10)
	r := u.post("/api/uploads/"+id+"/complete", "")
	if r.code != 409 || r.errMsg() != "上传未完成。" {
		t.Fatalf("%d %s", r.code, r.raw)
	}
	if st, _ := e.status(id); st != "uploading" || len(e.jobs()) != 0 {
		t.Fatalf("status %s jobs %v", st, e.jobs())
	}
}

func TestCompleteVerificationFailures(t *testing.T) {
	for _, tc := range []struct {
		name string
		obj  storage.Object
	}{
		{"size mismatch", storage.Object{Size: 11, ChecksumSHA256Hex: shaA}},
		{"checksum mismatch", storage.Object{Size: 10, ChecksumSHA256Hex: shaB}},
		{"empty checksum", storage.Object{Size: 10}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newEnv(t)
			u := e.user("u1")
			id := u.initiate(shaA, 10)
			e.st.put(key("u1", id), tc.obj)
			r := u.post("/api/uploads/"+id+"/complete", "")
			if r.code != 422 || r.errMsg() != "上传校验失败，请重新上传。" {
				t.Fatalf("%d %s", r.code, r.raw)
			}
			st, msg := e.status(id)
			if st != "failed" || msg.String != "上传校验失败，请重新上传。" {
				t.Fatalf("status %s %v", st, msg)
			}
			if !e.st.wasDeleted(key("u1", id)) || e.st.has(key("u1", id)) {
				t.Fatal("object not deleted")
			}
			if len(e.jobs()) != 0 {
				t.Fatalf("jobs %v", e.jobs())
			}
			g := u.get("/api/photos/" + id)
			if g.body["status"] != "failed" || g.body["error"] != "上传校验失败，请重新上传。" {
				t.Fatalf("get %s", g.raw)
			}
			// A failed photo cannot be completed; re-initiate reuses the id.
			if r := u.post("/api/uploads/"+id+"/complete", ""); r.code != 409 {
				t.Fatalf("complete failed: %d %s", r.code, r.raw)
			}
			if again := u.initiate(shaA, 10); again != id {
				t.Fatalf("retry id %s, want %s", again, id)
			}
		})
	}
}

func TestCompleteSuccessAndIdempotent(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	id := u.initiate(shaA, 10)
	e.st.put(key("u1", id), storage.Object{Size: 10, ContentType: "image/jpeg", ChecksumSHA256Hex: shaA})
	r := u.post("/api/uploads/"+id+"/complete", "")
	if r.code != 202 || r.body["id"] != id || r.body["status"] != "processing" {
		t.Fatalf("%d %s", r.code, r.raw)
	}
	js := e.jobs()
	if len(js) != 1 || js[0].Kind != "process_photo" || js[0].Payload != `{"photoId":"`+id+`"}` {
		t.Fatalf("jobs %v", js)
	}
	if st, _ := e.status(id); st != "processing" {
		t.Fatalf("status %s", st)
	}
	r = u.post("/api/uploads/"+id+"/complete", "")
	if r.code != 200 || r.body["status"] != "processing" || len(e.jobs()) != 1 {
		t.Fatalf("second: %d %s jobs %d", r.code, r.raw, len(e.jobs()))
	}
	e.exec(`UPDATE photos SET status='ready' WHERE id=?`, id)
	if r := u.post("/api/uploads/"+id+"/complete", ""); r.code != 200 || r.body["status"] != "ready" || len(e.jobs()) != 1 {
		t.Fatalf("ready: %d %s", r.code, r.raw)
	}
	// Complete rejects a body other than empty or {}.
	if r := u.post("/api/uploads/"+id+"/complete", `{"x":1}`); r.code != 400 {
		t.Fatalf("body: %d %s", r.code, r.raw)
	}
}

func TestOtherOwnerGets404(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	mallory := e.user("u2")
	id := u.initiate(shaA, 10)
	e.st.put(key("u1", id), storage.Object{Size: 10, ChecksumSHA256Hex: shaA})
	if r := mallory.post("/api/uploads/"+id+"/complete", ""); r.code != 404 {
		t.Fatalf("complete: %d %s", r.code, r.raw)
	}
	if r := mallory.get("/api/photos/" + id); r.code != 404 {
		t.Fatalf("get: %d %s", r.code, r.raw)
	}
	if st, _ := e.status(id); st != "uploading" || len(e.jobs()) != 0 {
		t.Fatalf("status %s", st)
	}
	// Unknown but well-formed ids are 404 as well.
	if r := u.get("/api/photos/" + newID()); r.code != 404 {
		t.Fatalf("unknown: %d %s", r.code, r.raw)
	}
}

func TestGetPhotoShape(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	id := newID()
	e.insertPhoto("u1", id, "ready", shaA)
	e.exec(`UPDATE photos SET width=6000,height=4000,title='T',caption='C',latitude=12.5,longitude=-3.25 WHERE id=?`, id)

	g := u.get("/api/photos/" + id)
	if g.code != 200 {
		t.Fatalf("%d %s", g.code, g.raw)
	}
	for _, k := range []string{"id", "status", "error", "title", "caption", "width", "height", "format", "createdAt",
		"publicFields", "histogramPublic", "originalDownload", "exif", "media"} {
		if _, ok := g.body[k]; !ok {
			t.Errorf("missing %s: %s", k, g.raw)
		}
	}
	if len(g.body) != 14 {
		t.Errorf("unexpected keys: %s", g.raw)
	}
	if g.body["exif"] != nil || g.body["media"] != nil || g.body["error"] != nil ||
		g.body["width"] != float64(6000) || g.body["createdAt"] != float64(t0) {
		t.Fatalf("%s", g.raw)
	}

	e.exec(`INSERT INTO photo_exif(photo_id,camera_make,camera_model,lens_model,focal_length_mm,focal_length_35mm,
		aperture,exposure_time,exposure_seconds,iso,exposure_bias,taken_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
		id, "FUJIFILM", "X-T5", "XF23mmF1.4 R LM WR", 23.0, 35.0, 1.4, "1/250", 0.004, 400, -0.7, t0)
	g = u.get("/api/photos/" + id)
	want := map[string]any{"camera": "FUJIFILM X-T5", "lens": "XF23mmF1.4 R LM WR", "focalLength": 23.0,
		"focalLength35mm": 35.0, "aperture": 1.4, "shutter": "1/250", "exposureSeconds": 0.004, "iso": 400.0,
		"exposureBias": -0.7, "takenAt": float64(t0)}
	ex, _ := g.body["exif"].(map[string]any)
	if len(ex) != len(want) {
		t.Fatalf("exif %v", ex)
	}
	for k, v := range want {
		if ex[k] != v {
			t.Errorf("exif[%s] = %v, want %v", k, ex[k], v)
		}
	}
}

func TestExifOmitsNullsAndDedupesCamera(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	for i, tc := range []struct {
		make, model any
		want        any
	}{
		{"Canon", "Canon EOS R5", "Canon EOS R5"},
		{"NIKON CORPORATION", "NIKON Z 8", "NIKON CORPORATION NIKON Z 8"},
		{"SONY", "ILCE-7M4", "SONY ILCE-7M4"},
		{nil, "X100V", "X100V"},
		{"Apple", nil, "Apple"},
		{"", "", nil},
		{nil, nil, nil},
	} {
		id := newID()
		e.insertPhoto("u1", id, "ready", shaN(i))
		e.exec(`INSERT INTO photo_exif(photo_id,camera_make,camera_model,iso) VALUES(?,?,?,100)`, id, tc.make, tc.model)
		g := u.get("/api/photos/" + id)
		ex, _ := g.body["exif"].(map[string]any)
		if ex["camera"] != tc.want {
			t.Errorf("%v/%v: camera %v, want %v", tc.make, tc.model, ex["camera"], tc.want)
		}
		for _, k := range []string{"lens", "focalLength", "shutter", "takenAt"} {
			if _, ok := ex[k]; ok {
				t.Errorf("null %s not omitted: %s", k, g.raw)
			}
		}
	}
}

func TestExifHiddenUntilReady(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	id := newID()
	e.insertPhoto("u1", id, "processing", shaA)
	e.exec(`INSERT INTO photo_exif(photo_id,iso) VALUES(?,100)`, id)
	if g := u.get("/api/photos/" + id); g.body["exif"] != nil {
		t.Fatalf("%s", g.raw)
	}
}

func TestReuseFailedRowFullyResets(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	id := newID()
	e.insertPhoto("u1", id, "failed", shaA)
	e.exec(`UPDATE photos SET width=10,height=20,derived_hash='0123456789abcdef',derived_salt='salt',
		latitude=1.5,longitude=2.5,error='x' WHERE id=?`, id)
	e.exec(`INSERT INTO photo_exif(photo_id,iso) VALUES(?,100)`, id)
	e.exec(`INSERT INTO photo_histograms(photo_id,bins) VALUES(?,x'00')`, id)
	e.exec(`INSERT INTO upload_prefs(user_id,public_fields,histogram_public,original_download,updated_at)
		VALUES('u1','["camera"]',0,1,?)`, t0)

	if again := u.initiate(shaA, 10); again != id {
		t.Fatalf("id %s, want %s", again, id)
	}
	var (
		w, h, lat, lng, dh, msg sql.NullString
		salt, fields            string
		hist, orig, nExif, nH   int
	)
	err := e.d.QueryRow(`SELECT width,height,latitude,longitude,derived_hash,error,derived_salt,public_fields,
		histogram_public,original_download,(SELECT count(*) FROM photo_exif WHERE photo_id=p.id),
		(SELECT count(*) FROM photo_histograms WHERE photo_id=p.id) FROM photos p WHERE id=?`, id).
		Scan(&w, &h, &lat, &lng, &dh, &msg, &salt, &fields, &hist, &orig, &nExif, &nH)
	if err != nil {
		t.Fatal(err)
	}
	if w.Valid || h.Valid || lat.Valid || lng.Valid || dh.Valid || msg.Valid || nExif != 0 || nH != 0 {
		t.Fatalf("stale state: w=%v h=%v lat=%v lng=%v dh=%v err=%v exif=%d hist=%d", w, h, lat, lng, dh, msg, nExif, nH)
	}
	if salt != "salt" || fields != `["camera"]` || hist != 0 || orig != 1 {
		t.Fatalf("salt %q prefs %s %d %d", salt, fields, hist, orig)
	}
	g := u.get("/api/photos/" + id)
	if g.body["width"] != nil || g.body["exif"] != nil || g.body["status"] != "uploading" {
		t.Fatalf("%s", g.raw)
	}
}

func TestCompleteContentTypeMismatch(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	id := u.initiate(shaA, 10) // image/jpeg
	e.st.put(key("u1", id), storage.Object{Size: 10, ContentType: "image/png", ChecksumSHA256Hex: shaA})
	if r := u.post("/api/uploads/"+id+"/complete", ""); r.code != 422 {
		t.Fatalf("%d %s", r.code, r.raw)
	}
	if st, _ := e.status(id); st != "failed" || !e.st.wasDeleted(key("u1", id)) || len(e.jobs()) != 0 {
		t.Fatalf("status %s", st)
	}
}

func TestBytesTypeValidation(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	for _, v := range []string{"1.5", "1e9", "null", `"10"`, "true"} {
		body := `{"filename":"a.jpg","bytes":` + v + `,"sha256":"` + shaA + `","contentType":"image/jpeg"}`
		if r := u.post("/api/uploads", body); r.code != 400 {
			t.Errorf("bytes %s: %d %s", v, r.code, r.raw)
		}
	}
}

func TestOversizedBodyIs413(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	body := `{"filename":"` + strings.Repeat("a", 200<<10) + `","bytes":1,"sha256":"` + shaA + `","contentType":"image/jpeg"}`
	for _, path := range []string{"/api/uploads", "/api/uploads/" + newID() + "/complete"} {
		if r := u.post(path, body); r.code != 413 {
			t.Errorf("%s: %d %s", path, r.code, r.raw)
		}
	}
}

func TestPresignErrorKeepsRowRetryable(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	e.st.presignErr = errors.New("boom")
	r := u.post("/api/uploads", uploadBody("a.jpg", 10, shaA, "image/jpeg"))
	if r.code != 500 || strings.Contains(r.raw, "boom") {
		t.Fatalf("%d %s", r.code, r.raw)
	}
	var id, st string
	if err := e.d.QueryRow(`SELECT id,status FROM photos`).Scan(&id, &st); err != nil || st != "uploading" {
		t.Fatalf("%v %s", err, st)
	}
	e.st.presignErr = nil
	if again := u.initiate(shaA, 10); again != id {
		t.Fatalf("retry id %s, want %s", again, id)
	}
}

func TestDeleteErrorOnVerifyFailure(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	id := u.initiate(shaA, 10)
	e.st.put(key("u1", id), storage.Object{Size: 11, ContentType: "image/jpeg", ChecksumSHA256Hex: shaA})
	e.st.deleteErr = errors.New("boom")
	r := u.post("/api/uploads/"+id+"/complete", "")
	if r.code != 500 || strings.Contains(r.raw, "boom") {
		t.Fatalf("%d %s", r.code, r.raw)
	}
	if st, _ := e.status(id); st != "uploading" || !e.st.has(key("u1", id)) {
		t.Fatalf("status %s", st)
	}
	// Once Delete works, a retry fails the photo normally.
	e.st.deleteErr = nil
	if r := u.post("/api/uploads/"+id+"/complete", ""); r.code != 422 {
		t.Fatalf("retry: %d %s", r.code, r.raw)
	}
	if st, _ := e.status(id); st != "failed" || e.st.has(key("u1", id)) {
		t.Fatalf("status %s", st)
	}
}

// A verify failure must not delete the object once another complete has
// already moved the photo on.
func TestVerifyFailureDoesNotDeleteAfterConcurrentSuccess(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	id := u.initiate(shaA, 10)
	e.st.put(key("u1", id), storage.Object{Size: 11, ContentType: "image/jpeg", ChecksumSHA256Hex: shaA})
	e.st.onHead = func() {
		e.st.onHead = nil
		// Between this Head and the verdict, another request succeeded.
		e.exec(`UPDATE photos SET status='processing' WHERE id=?`, id)
	}
	r := u.post("/api/uploads/"+id+"/complete", "")
	if r.code != 200 || r.body["status"] != "processing" {
		t.Fatalf("%d %s", r.code, r.raw)
	}
	if e.st.wasDeleted(key("u1", id)) {
		t.Fatal("deleted the original of a processing photo")
	}
}

func TestConcurrentCreatesSameSHA(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	const n = 8
	var wg sync.WaitGroup
	results := make([]resp, n)
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = u.send(http.MethodPost, "/api/uploads", uploadBody("a.jpg", 10, shaA, "image/jpeg"), nil)
		}(i)
	}
	wg.Wait()
	ids := map[any]bool{}
	for i, r := range results {
		if errs[i] != nil {
			t.Fatal(errs[i])
		}
		if r.code != 201 {
			t.Fatalf("%d %s", r.code, r.raw)
		}
		ids[r.body["photoId"]] = true
	}
	var rows int
	_ = e.d.QueryRow(`SELECT count(*) FROM photos`).Scan(&rows)
	if len(ids) != 1 || rows != 1 {
		t.Fatalf("ids %v rows %d", ids, rows)
	}
}

func TestConcurrentCompletes(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	id := u.initiate(shaA, 10)
	e.st.put(key("u1", id), storage.Object{Size: 10, ContentType: "image/jpeg", ChecksumSHA256Hex: shaA})
	const n = 8
	var wg sync.WaitGroup
	codes := make([]int, n)
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			r, err := u.send(http.MethodPost, "/api/uploads/"+id+"/complete", "", nil)
			codes[i], errs[i] = r.code, err
		}(i)
	}
	wg.Wait()
	accepted := 0
	for i, c := range codes {
		if errs[i] != nil {
			t.Fatal(errs[i])
		}
		switch c {
		case 202:
			accepted++
		case 200:
		default:
			t.Fatalf("code %d", c)
		}
	}
	if accepted != 1 || len(e.jobs()) != 1 {
		t.Fatalf("accepted %d jobs %d", accepted, len(e.jobs()))
	}
}
