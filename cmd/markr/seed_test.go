package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/timeStarry/frameMark/internal/db"
	"github.com/timeStarry/frameMark/internal/seed"
	"github.com/timeStarry/frameMark/internal/seed/seedtest"
)

func TestParseSeedArgs(t *testing.T) {
	a, err := parseSeedArgs([]string{"--manifest", "m.json", "--images", "imgs", "--apply"})
	if err != nil || a.manifest != "m.json" || a.images != "imgs" || !a.apply {
		t.Fatalf("args = %+v, %v", a, err)
	}
	if a, err := parseSeedArgs([]string{"--manifest=m.json", "--images=imgs"}); err != nil || a.apply {
		t.Fatalf("dry-run args = %+v, %v", a, err)
	}
	for _, bad := range [][]string{
		nil,
		{"--manifest", "m.json"},
		{"--images", "imgs"},
		{"--manifest", "m.json", "--images", "imgs", "extra"},
		{"--manifest", "m.json", "--images", "imgs", "--bogus"},
	} {
		if _, err := parseSeedArgs(bad); err == nil {
			t.Errorf("accepted %v", bad)
		}
	}
}

func TestSeedDemoRequiresMigratedDB(t *testing.T) {
	dir := t.TempDir()
	m, imgs := seedtest.Fixture(t, 8, 2)
	mp := seedtest.WriteManifest(t, m)
	var out bytes.Buffer
	err := dispatch(context.Background(), []string{"seed-demo", "--manifest", mp, "--images", imgs}, testEnv(dir), &out, &out)
	if err == nil || !strings.Contains(err.Error(), "migrate") {
		t.Fatalf("err = %v", err)
	}
}

// A dry run through the real command prints the plan and writes nothing; it
// never connects storage (the test endpoint is unreachable anyway).
func TestSeedDemoDryRunCommand(t *testing.T) {
	dir := t.TempDir()
	var logs bytes.Buffer
	if err := dispatch(context.Background(), []string{"migrate"}, testEnv(dir), &logs, &logs); err != nil {
		t.Fatal(err)
	}
	m, imgs := seedtest.Fixture(t, 8, 2)
	mp := seedtest.WriteManifest(t, m)

	var out bytes.Buffer
	if err := dispatch(context.Background(), []string{"seed-demo", "--manifest", mp, "--images", imgs}, testEnv(dir), &out, &logs); err != nil {
		t.Fatal(err)
	}
	var r seed.Report
	if err := json.Unmarshal(out.Bytes(), &r); err != nil {
		t.Fatalf("report %q: %v", out.String(), err)
	}
	if r.Mode != "dry-run" || r.Photos != 8 || r.Collections != 2 || len(r.Created) != 11 || len(r.Conflicts) != 0 {
		t.Fatalf("report = %+v", r)
	}
	for _, k := range []string{`"mode"`, `"photos"`, `"collections"`, `"created"`, `"unchanged"`, `"conflicts"`} {
		if !strings.Contains(out.String(), k) {
			t.Errorf("report missing %s", k)
		}
	}

	d, err := db.Open(filepath.Join(dir, dbFile))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	for _, tbl := range []string{"users", "photos", "collections", "attributions", "jobs"} {
		var n int
		if err := d.QueryRow(`SELECT count(*) FROM ` + tbl).Scan(&n); err != nil || n != 0 {
			t.Fatalf("%s rows = %d, %v", tbl, n, err)
		}
	}
}

func TestSeedDemoInvalidManifestFails(t *testing.T) {
	dir := t.TempDir()
	var logs bytes.Buffer
	if err := dispatch(context.Background(), []string{"migrate"}, testEnv(dir), &logs, &logs); err != nil {
		t.Fatal(err)
	}
	m, imgs := seedtest.Fixture(t, 7, 2)
	mp := seedtest.WriteManifest(t, m)
	var out bytes.Buffer
	err := dispatch(context.Background(), []string{"seed-demo", "--manifest", mp, "--images", imgs, "--apply"}, testEnv(dir), &out, &logs)
	if !errors.Is(err, seed.ErrInvalid) {
		t.Fatalf("err = %v", err)
	}
}

// --apply with no originals bucket fails before any storage or DB write.
func TestSeedDemoApplyRequiresBucket(t *testing.T) {
	dir := t.TempDir()
	var logs bytes.Buffer
	if err := dispatch(context.Background(), []string{"migrate"}, testEnv(dir), &logs, &logs); err != nil {
		t.Fatal(err)
	}
	m, imgs := seedtest.Fixture(t, 8, 2)
	mp := seedtest.WriteManifest(t, m)
	var out bytes.Buffer
	err := dispatch(context.Background(), []string{"seed-demo", "--manifest", mp, "--images", imgs, "--apply"},
		testEnv(dir, "MARKR_BUCKET_ORIGINALS="), &out, &logs)
	if err == nil || !strings.Contains(err.Error(), "MARKR_BUCKET_ORIGINALS") {
		t.Fatalf("err = %v", err)
	}
	if out.Len() != 0 {
		t.Fatalf("printed a report: %s", out.String())
	}
	// A dry run does not need the bucket.
	out.Reset()
	if err := dispatch(context.Background(), []string{"seed-demo", "--manifest", mp, "--images", imgs},
		testEnv(dir, "MARKR_BUCKET_ORIGINALS="), &out, &logs); err != nil {
		t.Fatalf("dry run: %v", err)
	}
}

func TestRefuseStorage(t *testing.T) {
	var s refuseStorage
	if s.Put(context.Background(), "b", "k", nil, "", "") == nil || s.Delete(context.Background(), "b", "k") == nil {
		t.Fatal("refuseStorage accepted a write")
	}
}
