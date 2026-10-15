package api_test

import (
	"encoding/json"
	"strings"
	"testing"
)

type dbFrame struct {
	Position int
	Layout   string
	PhotoIDs []string
}

// framesOf reads a collection's frames from the database in position order.
func (e *env) framesOf(cid string) []dbFrame {
	e.t.Helper()
	rows, err := e.d.Query(`SELECT f.position,f.layout,coalesce((SELECT group_concat(photo_id) FROM
		(SELECT photo_id FROM frame_photos WHERE frame_id=f.id ORDER BY slot)),'')
		FROM frames f WHERE f.collection_id=? ORDER BY f.position`, cid)
	if err != nil {
		e.t.Fatal(err)
	}
	defer rows.Close()
	var out []dbFrame
	for rows.Next() {
		var f dbFrame
		var ids string
		if err := rows.Scan(&f.Position, &f.Layout, &ids); err != nil {
			e.t.Fatal(err)
		}
		if ids != "" {
			f.PhotoIDs = strings.Split(ids, ",")
		}
		out = append(out, f)
	}
	return out
}

func TestDeletePhoto(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	a, b, c, d, e2 := e.readyPhoto("u1"), e.readyPhoto("u1"), e.readyPhoto("u1"), e.readyPhoto("u1"), e.readyPhoto("u1")
	keep := e.readyPhoto("u1")
	cid := u.newCollection("A")
	// Positions 0..3: full(a), pair(b,c), pair(d,e2,keep), text.
	u.mustFrames(cid, full(a), pair(b, c), pair(d, e2, keep), textFrame("stay"))
	u.publishPublic(cid)
	e.exec(`INSERT INTO photo_overrides(collection_id,photo_id,public_fields) VALUES(?,?,'[]')`, cid, a)
	e.exec(`INSERT INTO photo_exif(photo_id,iso) VALUES(?,100)`, a)
	e.exec(`INSERT INTO photo_histograms(photo_id,bins) VALUES(?,x'00')`, a)
	e.exec(`UPDATE photos SET derived_hash='deadbeefdeadbeef' WHERE id=?`, a)

	if r := u.del("/api/photos/" + a); r.code != 204 {
		t.Fatalf("delete a: %d %s", r.code, r.raw)
	}

	var n int
	_ = e.d.QueryRow(`SELECT count(*) FROM photos WHERE id=?`, a).Scan(&n)
	if n != 0 {
		t.Fatal("photo row remains")
	}
	_ = e.d.QueryRow(`SELECT count(*) FROM photo_exif WHERE photo_id=?`, a).Scan(&n)
	if n != 0 {
		t.Fatal("exif remains")
	}
	_ = e.d.QueryRow(`SELECT count(*) FROM photo_overrides`).Scan(&n)
	if n != 0 {
		t.Fatal("overrides remain")
	}

	got := e.framesOf(cid)
	if len(got) != 3 {
		t.Fatalf("want 3 remaining frames, got %+v", got)
	}
	if got[0].Position != 0 || got[0].Layout != "pair" || !sameIDs(got[0].PhotoIDs, []string{b, c}) ||
		got[1].Position != 1 || got[1].Layout != "pair" || !sameIDs(got[1].PhotoIDs, []string{d, e2, keep}) ||
		got[2].Position != 2 || got[2].Layout != "text" {
		t.Fatalf("frames after delete: %+v", got)
	}

	// The deleted photo itself is not rotated: delete_photo_objects removes
	// its derived objects. b..keep are still in the published frames.
	if got := e.rotated(); len(got) != 0 {
		t.Fatalf("rotated %v", got)
	}
	found := false
	for _, j := range e.jobs() {
		if j.Kind != "delete_photo_objects" {
			continue
		}
		found = true
		var p map[string]string
		if err := json.Unmarshal([]byte(j.Payload), &p); err != nil {
			t.Fatal(err)
		}
		if p["photoId"] != a || p["originalKey"] != "o/u1/"+a || p["derivedPrefix"] != "d/"+a+"/" {
			t.Fatalf("payload %s", j.Payload)
		}
	}
	if !found {
		t.Fatal("missing delete_photo_objects")
	}

	// Deleting c from pair(b,c) drops that frame; pair(d,e2,keep) stays.
	if r := u.del("/api/photos/" + c); r.code != 204 {
		t.Fatal(r.raw)
	}
	got = e.framesOf(cid)
	if len(got) != 2 || got[0].Layout != "pair" || !sameIDs(got[0].PhotoIDs, []string{d, e2, keep}) ||
		got[1].Layout != "text" || got[0].Position != 0 || got[1].Position != 1 {
		t.Fatalf("after pair drop: %+v", got)
	}
	// b left the collection with its frame, so it is withdrawn.
	if got := e.rotated(); !sameIDs(got, []string{b}) {
		t.Fatalf("rotated after pair drop %v", got)
	}

	// Deleting the middle photo of a 3-photo pair keeps the frame with
	// dense slots 0 and 1.
	if r := u.del("/api/photos/" + e2); r.code != 204 {
		t.Fatal(r.raw)
	}
	got = e.framesOf(cid)
	if len(got) != 2 || !sameIDs(got[0].PhotoIDs, []string{d, keep}) {
		t.Fatalf("after middle drop: %+v", got)
	}
	var maxSlot int
	_ = e.d.QueryRow(`SELECT max(slot) FROM frame_photos`).Scan(&maxSlot)
	if maxSlot != 1 {
		t.Fatalf("slots not compacted: max %d", maxSlot)
	}

	if r := u.del("/api/photos/" + a); r.code != 404 {
		t.Errorf("second delete: %d", r.code)
	}
	if r := u.del("/api/photos/" + newID()); r.code != 404 {
		t.Errorf("unknown: %d", r.code)
	}
}

func TestDeletePhotoWithdrawal(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	a, b, shared := e.readyPhoto("u1"), e.readyPhoto("u1"), e.readyPhoto("u1")
	c1 := u.newCollection("one")
	c2 := u.newCollection("two")
	u.mustFrames(c1, pair(a, b), pair(a, shared))
	u.mustFrames(c2, full(shared))
	u.publishPublic(c1)
	u.publishPublic(c2)
	e.exec(`INSERT INTO photo_overrides(collection_id,photo_id,public_fields) VALUES(?,?,'[]')`, c1, b)
	// Deleting a empties both pairs below their minimum: b leaves every
	// public collection, shared is still in c2.
	if r := u.del("/api/photos/" + a); r.code != 204 {
		t.Fatal(r.raw)
	}
	if got := e.framesOf(c1); len(got) != 0 {
		t.Fatalf("frames %+v", got)
	}
	if got := e.rotated(); !sameIDs(got, []string{b}) {
		t.Fatalf("rotated %v", got)
	}
	var n int
	_ = e.d.QueryRow(`SELECT count(*) FROM photo_overrides`).Scan(&n)
	if n != 0 {
		t.Fatal("override of a photo that left the collection remains")
	}
	// Other owners' photos and collections are untouched.
	mallory := e.user("u2")
	mp := e.readyPhoto("u2")
	mc := mallory.newCollection("m")
	mallory.mustFrames(mc, full(mp))
	mallory.publishPublic(mc)
	if r := u.del("/api/photos/" + mp); r.code != 404 {
		t.Fatalf("cross-owner delete: %d", r.code)
	}
	if got := e.framesOf(mc); len(got) != 1 {
		t.Fatal("mallory's frame changed")
	}
}

func TestDeleteNonReadyPhoto(t *testing.T) {
	e := newEnv(t)
	u := e.user("u1")
	id := u.initiate(shaA, 10)
	if r := u.del("/api/photos/" + id); r.code != 204 {
		t.Fatalf("%d %s", r.code, r.raw)
	}
	if js := e.jobs(); len(js) != 1 || js[0].Kind != "delete_photo_objects" {
		t.Fatalf("jobs %v", js)
	}
}
