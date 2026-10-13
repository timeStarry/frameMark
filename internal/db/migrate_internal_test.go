package db

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

func openRaw(t *testing.T) *sql.DB {
	t.Helper()
	d, err := Open(filepath.Join(t.TempDir(), "m.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	return d
}

func version(t *testing.T, d *sql.DB) int {
	t.Helper()
	var v int
	if err := d.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

func file(s string) *fstest.MapFile { return &fstest.MapFile{Data: []byte(s)} }

func TestMigrateFailingMigrationRollsBack(t *testing.T) {
	d := openRaw(t)
	fsys := fstest.MapFS{
		"migrations/0001_a.sql": file(`CREATE TABLE a (id INTEGER PRIMARY KEY);`),
		"migrations/0002_b.sql": file(`CREATE TABLE b (id INTEGER PRIMARY KEY);
INSERT INTO no_such_table VALUES (1);`),
	}
	err := migrate(d, fsys)
	if err == nil || !strings.Contains(err.Error(), "0002_b.sql") {
		t.Fatalf("migrate err = %v, want failure naming 0002_b.sql", err)
	}
	if v := version(t, d); v != 1 {
		t.Fatalf("user_version = %d, want 1", v)
	}
	var n int
	if err := d.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='b'`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("table b count = %d err=%v, want 0 (rolled back)", n, err)
	}
	if err := d.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='a'`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("table a count = %d err=%v, want 1", n, err)
	}
}

func TestMigrateRejectsBadFileNames(t *testing.T) {
	cases := map[string]fstest.MapFS{
		"duplicate": {
			"migrations/0001_a.sql": file(`SELECT 1;`),
			"migrations/0001_b.sql": file(`SELECT 1;`),
		},
		"no underscore": {"migrations/0001.sql": file(`SELECT 1;`)},
		"short prefix":  {"migrations/001_a.sql": file(`SELECT 1;`)},
		"non-numeric":   {"migrations/abcd_a.sql": file(`SELECT 1;`)},
		"zero version":  {"migrations/0000_a.sql": file(`SELECT 1;`)},
	}
	for name, fsys := range cases {
		t.Run(name, func(t *testing.T) {
			d := openRaw(t)
			if err := migrate(d, fsys); err == nil {
				t.Fatal("migrate accepted bad migration set")
			}
			if v := version(t, d); v != 0 {
				t.Fatalf("user_version = %d, want 0", v)
			}
		})
	}
}

func TestMigrateRejectsNewerDatabase(t *testing.T) {
	d := openRaw(t)
	if _, err := d.Exec(`PRAGMA user_version = 5`); err != nil {
		t.Fatal(err)
	}
	fsys := fstest.MapFS{"migrations/0001_a.sql": file(`CREATE TABLE a (id INTEGER PRIMARY KEY);`)}
	err := migrate(d, fsys)
	want := "database version 5 is newer than this binary (max 1)"
	if err == nil || err.Error() != want {
		t.Fatalf("migrate err = %v, want %q", err, want)
	}
}
