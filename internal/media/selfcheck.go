package media

import (
	"fmt"

	"github.com/davidbyttow/govips/v2/vips"
)

// selfCheckEncoder is one output format SelfCheck must be able to write.
type selfCheckEncoder struct {
	name string
	fn   func(*vips.ImageRef) ([]byte, error)
}

var selfCheckEncoders = []selfCheckEncoder{
	{"AVIF", func(img *vips.ImageRef) ([]byte, error) {
		b, _, err := img.ExportAvif(&vips.AvifExportParams{StripMetadata: true, Quality: 50, Effort: 4, Bitdepth: 8})
		return b, err
	}},
	{"WebP", func(img *vips.ImageRef) ([]byte, error) {
		b, _, err := img.ExportWebp(&vips.WebpExportParams{StripMetadata: true, Quality: 80})
		return b, err
	}},
	{"JPEG", func(img *vips.ImageRef) ([]byte, error) { b, _, err := exportJPEG(img); return b, err }},
}

// SelfCheck starts libvips and encodes a 2×2 sRGB image as AVIF, WebP and
// JPEG, the formats every derived tier needs (spec §10). The worker must
// refuse to start when it fails: without, say, heifsave every photo would
// retry until dead. The error names the format that could not be written.
func SelfCheck() error {
	return selfCheck(selfCheckEncoders)
}

func selfCheck(encs []selfCheckEncoder) error {
	if err := ensureVips(); err != nil {
		return fmt.Errorf("media self-check: libvips startup failed: %w", err)
	}
	px := make([]byte, 2*2*3)
	for i := range px {
		px[i] = byte(i * 20)
	}
	img, err := vips.NewImageFromMemory(px, 2, 2, 3, vips.BandFormatUchar, vips.InterpretationSRGB)
	if err != nil {
		return fmt.Errorf("media self-check: cannot build test image: %w", err)
	}
	defer img.Close()
	for _, e := range encs {
		b, err := e.fn(img)
		if err != nil {
			return fmt.Errorf("media self-check: libvips cannot encode %s: %w", e.name, err)
		}
		if len(b) == 0 {
			return fmt.Errorf("media self-check: libvips cannot encode %s: empty output", e.name)
		}
	}
	return nil
}
