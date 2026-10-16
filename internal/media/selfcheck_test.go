package media

import (
	"errors"
	"strings"
	"testing"

	"github.com/davidbyttow/govips/v2/vips"
)

// This machine's libvips has heifsave, so every format encodes.
func TestSelfCheckPasses(t *testing.T) {
	if err := SelfCheck(); err != nil {
		t.Fatal(err)
	}
}

func TestSelfCheckNamesMissingFormat(t *testing.T) {
	encs := []selfCheckEncoder{
		{"JPEG", func(img *vips.ImageRef) ([]byte, error) { b, _, err := exportJPEG(img); return b, err }},
		{"AVIF", func(*vips.ImageRef) ([]byte, error) { return nil, errors.New("heifsave: no such operation") }},
	}
	err := selfCheck(encs)
	if err == nil || !strings.Contains(err.Error(), "AVIF") || !strings.Contains(err.Error(), "heifsave") {
		t.Fatalf("err = %v", err)
	}
	empty := []selfCheckEncoder{{"WebP", func(*vips.ImageRef) ([]byte, error) { return nil, nil }}}
	if err := selfCheck(empty); err == nil || !strings.Contains(err.Error(), "WebP") {
		t.Fatalf("empty output err = %v", err)
	}
}
