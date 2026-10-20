package api

import (
	"errors"
	"path/filepath"
	"testing"

	"github.com/timeStarry/frameMark/internal/db"
)

func TestIsUniqueViolationUsesDriverCode(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "markr.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	if err := db.Migrate(d); err != nil {
		t.Fatal(err)
	}
	ins := `INSERT INTO users(id,email,password,created_at) VALUES(?,?,'x',0)`
	if _, err := d.Exec(ins, "u1", "a@example.test"); err != nil {
		t.Fatal(err)
	}
	_, dupEmail := d.Exec(ins, "u2", "a@example.test")
	_, dupPK := d.Exec(ins, "u1", "b@example.test")
	_, fk := d.Exec(`INSERT INTO photos(id,owner_id,status,original_key,original_sha256,original_bytes,format,
		public_fields,histogram_public,original_download,created_at,updated_at) VALUES('p','nobody','uploading','k','s',1,'jpeg','[]',0,0,0,0)`)
	if !isUniqueViolation(dupEmail) || !isUniqueViolation(dupPK) {
		t.Fatalf("unique not detected: %v / %v", dupEmail, dupPK)
	}
	if fk == nil || isUniqueViolation(fk) || isUniqueViolation(errors.New("UNIQUE constraint failed")) || isUniqueViolation(nil) {
		t.Fatalf("false positive: %v", fk)
	}
}
