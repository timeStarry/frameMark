// Package db opens the SQLite database and applies embedded, forward-only
// migrations tracked by PRAGMA user_version.
package db

import (
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"sort"
	"strconv"
	"strings"

	_ "modernc.org/sqlite" // registers the "sqlite" driver
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Open opens the SQLite database at path with WAL, foreign keys and a 5s busy
// timeout applied to every connection.
func Open(path string) (*sql.DB, error) {
	d, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)")
	if err != nil {
		return nil, err
	}
	d.SetMaxOpenConns(1) // SQLite has a single writer
	if err := d.Ping(); err != nil {
		d.Close()
		return nil, err
	}
	return d, nil
}

type migration struct {
	version int
	name    string
}

// loadMigrations returns the migrations in fsys's migrations/ directory named
// NNNN_*.sql, sorted by version. Duplicate or malformed versions are an error.
func loadMigrations(fsys fs.FS) ([]migration, error) {
	entries, err := fs.ReadDir(fsys, "migrations")
	if err != nil {
		return nil, err
	}
	var out []migration
	seen := map[int]string{}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".sql") {
			continue
		}
		prefix, _, ok := strings.Cut(name, "_")
		if !ok || len(prefix) != 4 {
			return nil, fmt.Errorf("migration %q: name must be NNNN_*.sql", name)
		}
		v, err := strconv.Atoi(prefix)
		if err != nil || v <= 0 {
			return nil, fmt.Errorf("migration %q: invalid version", name)
		}
		if prev, dup := seen[v]; dup {
			return nil, fmt.Errorf("migration %q: duplicate version with %q", name, prev)
		}
		seen[v] = name
		out = append(out, migration{version: v, name: name})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].version < out[j].version })
	return out, nil
}

// Migrate applies every embedded migration whose version exceeds the current
// PRAGMA user_version. Each migration and its user_version bump run in one
// transaction, so a failed migration leaves the database at the prior version.
// A database newer than the highest embedded migration is refused.
func Migrate(d *sql.DB) error {
	return migrate(d, migrationsFS)
}

func migrate(d *sql.DB, fsys fs.FS) error {
	migrations, err := loadMigrations(fsys)
	if err != nil {
		return err
	}
	var current int
	if err := d.QueryRow(`PRAGMA user_version`).Scan(&current); err != nil {
		return err
	}
	maxVersion := 0
	if len(migrations) > 0 {
		maxVersion = migrations[len(migrations)-1].version
	}
	if current > maxVersion {
		return fmt.Errorf("database version %d is newer than this binary (max %d)", current, maxVersion)
	}
	for _, m := range migrations {
		if m.version <= current {
			continue
		}
		if err := apply(d, fsys, m); err != nil {
			return err
		}
		current = m.version
	}
	return nil
}

func apply(d *sql.DB, fsys fs.FS, m migration) error {
	body, err := fs.ReadFile(fsys, "migrations/"+m.name)
	if err != nil {
		return err
	}
	tx, err := d.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(string(body)); err != nil {
		return fmt.Errorf("migration %s: %w", m.name, err)
	}
	// PRAGMA does not accept bound parameters; version is a parsed int.
	if _, err := tx.Exec(fmt.Sprintf(`PRAGMA user_version = %d`, m.version)); err != nil {
		return fmt.Errorf("migration %s: set user_version: %w", m.name, err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("migration %s: commit: %w", m.name, err)
	}
	return nil
}
