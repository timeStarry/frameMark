// Package seedtest builds demo-seed fixtures for tests: a manifest with the
// schema of ops/demo/manifest.json plus small generated JPEGs whose sha256
// values are computed at build time. The real demo photos are never needed.
package seedtest

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"os"
	"path/filepath"
	"testing"
)

// JPEG returns a distinct 64x48 gradient JPEG for each i.
func JPEG(t testing.TB, i int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 64, 48))
	for y := 0; y < 48; y++ {
		for x := 0; x < 64; x++ {
			img.Set(x, y, color.RGBA{uint8(x*4 + i*29), uint8(y*5 + i*13), uint8(128 + i*41), 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// SHA returns the lowercase hex sha256 of b.
func SHA(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

// Fixture writes n JPEGs into a fresh images directory and returns a valid
// manifest (as generic JSON) for them. Photos are spread round-robin over c
// collections; photo-1 is the featured one and photo-2 the profile cover.
func Fixture(t testing.TB, n, c int) (map[string]any, string) {
	t.Helper()
	dir := t.TempDir()
	var photos []any
	members := make([][]any, c)
	for i := 1; i <= n; i++ {
		file := fmt.Sprintf("photo-%d.jpg", i)
		body := JPEG(t, i)
		if err := os.WriteFile(filepath.Join(dir, file), body, 0o600); err != nil {
			t.Fatal(err)
		}
		coll := fmt.Sprintf("coll-%d", (i-1)%c+1)
		members[(i-1)%c] = append(members[(i-1)%c], fmt.Sprintf("photo-%d", i))
		p := map[string]any{
			"id":         fmt.Sprintf("photo-%d", i),
			"file":       file,
			"sha256":     SHA(body),
			"title":      fmt.Sprintf("照片 %d · 演示", i),
			"text":       fmt.Sprintf("照片 %d · Markr Demo 展示选图", i),
			"collection": coll,
			"source": map[string]any{
				"title":       fmt.Sprintf("Photo %d", i),
				"author":      "Test Author",
				"authorUrl":   "https://unsplash.com/@test",
				"sourcePage":  fmt.Sprintf("https://commons.wikimedia.org/wiki/File:Photo_%d.jpg", i),
				"downloadURL": fmt.Sprintf("https://upload.wikimedia.org/wikipedia/commons/%d.jpg", i),
				"licenseName": "CC0 1.0 Universal",
				"licenseURL":  "https://creativecommons.org/publicdomain/zero/1.0/",
				"changes":     "无改动。",
				"verifiedAt":  "2026-10-04",
				"originalDimensions": []any{
					64, 48,
				},
			},
		}
		if i == 1 {
			p["featuredRank"] = 1
		}
		photos = append(photos, p)
	}
	var colls []any
	for j := 1; j <= c; j++ {
		colls = append(colls, map[string]any{
			"id":     fmt.Sprintf("coll-%d", j),
			"title":  fmt.Sprintf("合集 %d · 演示", j),
			"text":   fmt.Sprintf("合集 %d 的介绍。", j),
			"photos": members[j-1],
		})
	}
	m := map[string]any{
		"version": 1,
		"seed":    "markr-demo-v1",
		"owner":   "markr-demo",
		"profile": map[string]any{
			"name":    "Markr Demo · 演示图库",
			"bio":     "不可登录的展示身份。",
			"accent":  "#ccd4c4",
			"layout":  "grid",
			"modules": []any{"collections", "works"},
			"cover":   "photo-2",
		},
		"photos":      photos,
		"collections": colls,
	}
	return m, dir
}

// Photo returns the i-th (0-based) photo object of m.
func Photo(m map[string]any, i int) map[string]any { return m["photos"].([]any)[i].(map[string]any) }

// Source returns the source object of the i-th photo.
func Source(m map[string]any, i int) map[string]any { return Photo(m, i)["source"].(map[string]any) }

// Collection returns the j-th (0-based) collection object of m.
func Collection(m map[string]any, j int) map[string]any {
	return m["collections"].([]any)[j].(map[string]any)
}

// WriteManifest writes m indented (so stored source JSON keeps the file's
// whitespace) to a temp file and returns its path.
func WriteManifest(t testing.TB, m map[string]any) string {
	t.Helper()
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(t.TempDir(), "manifest.json")
	if err := os.WriteFile(p, b, 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}
