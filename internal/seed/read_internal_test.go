package seed

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// openRegular must not follow a symlink even when called directly, so a
// swap between Lstat and open cannot redirect the read.
func TestOpenRegularRefusesSymlinkAndNonRegular(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target.jpg")
	if err := os.WriteFile(target, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link.jpg")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(target) // what an Lstat raced against a swap would have seen
	if err != nil {
		t.Fatal(err)
	}
	if f, err := openRegular(link, st); err == nil {
		f.Close()
		t.Fatal("opened a symlink")
	}
	if f, err := openRegular(dir, st); err == nil {
		f.Close()
		t.Fatal("opened a directory")
	}

	// A file replaced after Lstat (a different inode) is refused.
	other := filepath.Join(dir, "other.jpg")
	if err := os.WriteFile(other, []byte("y"), 0o600); err != nil {
		t.Fatal(err)
	}
	if f, err := openRegular(other, st); !errors.Is(err, ErrInvalid) {
		if f != nil {
			f.Close()
		}
		t.Fatalf("swapped file: err = %v, want ErrInvalid", err)
	}

	f, err := openRegular(target, st)
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
}
