package media

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/davidbyttow/govips/v2/vips"
)

// PipelineVersion is mixed into DerivedHash; bump it when derived output
// changes so every photo gets fresh object keys.
const PipelineVersion = "MEDIA_PIPELINE_V1"

// DefaultMaxPixels applies when Options.MaxPixels is not positive. See
// Options for the memory budget it implies.
const DefaultMaxPixels = 60_000_000

// Permanent failures: the input itself is unacceptable, so retrying cannot
// help. Their Error() strings are fixed and never carry libvips text.
var (
	ErrUnsupported   = errors.New("media: unsupported format")
	ErrTooManyPixels = errors.New("media: too many pixels")
	ErrAnimated      = errors.New("media: animated images are not supported")
	ErrDecode        = errors.New("media: decode failed")
	// ErrInvalidWatermark means the watermark settings are out of range.
	ErrInvalidWatermark = errors.New("media: invalid watermark")
	// ErrWatermark means valid-looking watermark settings could not be
	// rendered. It is permanent and a property of the settings, not of
	// the photo: the caller should retry Process without the watermark
	// and publish the photo without the watermarked variant.
	ErrWatermark = errors.New("media: watermark could not be rendered")
	// ErrInternal is a processing fault after a successful decode,
	// including a failed metadata audit. No output is returned with it.
	ErrInternal = errors.New("media: processing failed")
)

// pipelineError keeps the libvips cause reachable through errors.Is/As
// while Error() stays the fixed category text.
type pipelineError struct {
	kind  error
	cause error
}

func (e *pipelineError) Error() string   { return e.kind.Error() }
func (e *pipelineError) Unwrap() []error { return []error{e.kind, e.cause} }

func fail(kind, cause error) error {
	if cause == nil {
		return kind
	}
	return &pipelineError{kind: kind, cause: cause}
}

// Options control one Process call.
//
// Memory budget per concurrent Process call (one per worker): the decoded
// original plus one in-memory 3-band 8-bit copy of the normalised image,
// about 3 bytes per pixel each, so roughly 180 MB apiece at the 60 MP
// default and up to ~3x that transiently while the copy is made (16-bit
// or alpha originals decode larger). The original is released once the
// copy exists; tiers are each a fraction of it. Budget MARKR_WORKERS
// accordingly.
type Options struct {
	// LocationMode is LocationOff (default when empty) or LocationArchive.
	LocationMode string
	// MaxPixels caps width*height; <= 0 means DefaultMaxPixels.
	MaxPixels int64
	// Salt is photos.derived_salt; it feeds Result.DerivedHash.
	Salt string
	// Watermark, when non-nil, adds Result.WatermarkOutput.
	Watermark *Watermark
}

// Output is one encoded, metadata-free derived object. Pixels are sRGB and
// the file carries no metadata at all, ICC included (StripMetadata), so
// it is untagged sRGB, which browsers interpret as sRGB.
// Key is the suffix
// "{tier}.{ext}"; the caller prefixes "d/{photoId}/{hash}/".
type Output struct {
	Key         string
	Bytes       []byte
	ContentType string
}

// Result is everything the worker persists for a processed photo.
type Result struct {
	// Width and Height are after EXIF auto-rotation.
	Width, Height int
	// Format is the input format: "jpeg", "png" or "webp".
	Format    string
	EXIF      EXIF
	Histogram [4][64]uint16
	// DerivedHash is DerivedHash(sha256(orig), opts.Salt).
	DerivedHash     string
	Outputs         []Output
	WatermarkOutput *Output
}

// DerivedHash is sha256(origSHA256Hex + PipelineVersion + salt), hex[:16].
func DerivedHash(origSHA256Hex, salt string) string {
	sum := sha256.Sum256([]byte(origSHA256Hex + PipelineVersion + salt))
	return hex.EncodeToString(sum[:])[:16]
}

type tier struct {
	name string
	edge int
}

var tiers = []tier{{"w480", 480}, {"w1280", 1280}, {"w2400", 2400}, {"w3840", 3840}}

const watermarkTier = "w2400"

var (
	vipsOnce sync.Once
	vipsErr  error
)

// ensureVips starts libvips once per process: one worker thread per
// operation (the job queue provides parallelism), no operation cache (each
// input is seen once and caching would pin untrusted buffers), and quiet
// logging.
func ensureVips() error {
	vipsOnce.Do(func() {
		vips.LoggingSettings(func(string, vips.LogLevel, string) {}, vips.LogLevelError)
		vipsErr = vips.Startup(&vips.Config{ConcurrencyLevel: 1, MaxCacheFiles: 0, MaxCacheMem: 0, MaxCacheSize: 0})
	})
	return vipsErr
}

// sniff returns the format name from magic bytes, or "".
func sniff(b []byte) string {
	switch {
	case len(b) >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF:
		return "jpeg"
	case len(b) >= 8 && bytes.Equal(b[:8], []byte("\x89PNG\r\n\x1a\n")):
		return "png"
	case len(b) >= 12 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WEBP":
		return "webp"
	}
	return ""
}

var vipsType = map[string]vips.ImageType{"jpeg": vips.ImageTypeJPEG, "png": vips.ImageTypePNG, "webp": vips.ImageTypeWEBP}

// pngHasACTL reports whether a PNG declares animation. An acTL chunk must
// precede the first IDAT; libvips 8.18 decodes APNG as a single page and
// reports n-pages=1, so this check is the only APNG guard.
func pngHasACTL(b []byte) bool {
	off := 8
	for off+8 <= len(b) {
		n := int64(binary.BigEndian.Uint32(b[off:]))
		typ := string(b[off+4 : off+8])
		switch typ {
		case "acTL":
			return true
		case "IDAT", "IEND":
			return false
		}
		next := int64(off) + 12 + n
		if next > int64(len(b)) {
			return false
		}
		off = int(next)
	}
	return false
}

// webpAnimFlag reports the VP8X animation flag (defence in depth; libvips
// already reports n-pages for animated WebP).
func webpAnimFlag(b []byte) bool {
	return len(b) > 20 && string(b[12:16]) == "VP8X" && b[20]&0x02 != 0
}

// Process validates, decodes and normalises an original photo and returns
// its EXIF, histogram and metadata-free derived outputs. It is pure: no
// storage or database access. Safe for concurrent use.
func Process(orig []byte, opts Options) (*Result, error) {
	if opts.Watermark != nil {
		if err := opts.Watermark.Validate(); err != nil {
			return nil, err
		}
	}
	mode := opts.LocationMode
	if mode == "" {
		mode = LocationOff
	}
	if mode != LocationOff && mode != LocationArchive {
		return nil, fmt.Errorf("media: invalid location mode %q", mode)
	}
	maxPixels := opts.MaxPixels
	if maxPixels <= 0 {
		maxPixels = DefaultMaxPixels
	}

	format := sniff(orig)
	if format == "" {
		return nil, ErrUnsupported
	}
	if (format == "png" && pngHasACTL(orig)) || (format == "webp" && webpAnimFlag(orig)) {
		return nil, ErrAnimated
	}
	if err := ensureVips(); err != nil {
		return nil, fail(ErrInternal, err)
	}
	if err := checkHeader(orig, format, maxPixels); err != nil {
		return nil, err
	}

	p := vips.NewImportParams()
	p.FailOnError.Set(true)
	p.AutoRotate.Set(false)
	img, err := vips.LoadImageFromBuffer(orig, p)
	if err != nil {
		return nil, fail(ErrDecode, err)
	}
	defer img.Close()
	// Loading is lazy; force the full decode now so a truncated or corrupt
	// body is reported as ErrDecode rather than surfacing mid-pipeline.
	if _, err := img.Average(); err != nil {
		return nil, fail(ErrDecode, err)
	}

	res := &Result{Format: format, DerivedHash: DerivedHash(sha256Hex(orig), opts.Salt)}
	res.EXIF, err = ExtractEXIF(img.GetBlob("exif-data"), mode)
	if err != nil {
		return nil, fail(ErrInternal, err)
	}

	if err := normalize(img); err != nil {
		return nil, fail(ErrInternal, err)
	}
	// Run the decode/rotate/ICC/flatten chain exactly once: render it to
	// a plain memory image and drop the original decode.
	base, err := materialize(img)
	img.Close()
	if err != nil {
		return nil, fail(ErrInternal, err)
	}
	defer base.Close()
	res.Width, res.Height = base.Width(), base.Height()

	if res.Histogram, err = histogramOf(base); err != nil {
		return nil, fail(ErrInternal, err)
	}

	// Largest tier first, each derived from the previous materialised
	// tier, so every resize reads a smaller in-memory source.
	var wmBase *vips.ImageRef
	perTier := make([][]Output, len(tiers))
	prev := base
	defer func() {
		if prev != base {
			prev.Close()
		}
		if wmBase != nil {
			wmBase.Close()
		}
	}()
	for i := len(tiers) - 1; i >= 0; i-- {
		t := tiers[i]
		cur, err := scaledTier(prev, t)
		if err != nil {
			return nil, err
		}
		outs, err := encodeTier(cur, t)
		if err != nil {
			cur.Close()
			return nil, err
		}
		perTier[i] = outs
		if t.name == watermarkTier && opts.Watermark != nil {
			if wmBase, err = cur.Copy(); err != nil {
				cur.Close()
				return nil, fail(ErrInternal, err)
			}
		}
		if prev != base {
			prev.Close()
		}
		prev = cur
	}
	for _, outs := range perTier {
		res.Outputs = append(res.Outputs, outs...)
	}

	if opts.Watermark != nil {
		out, err := renderWatermark(wmBase, *opts.Watermark)
		if err != nil {
			return nil, err
		}
		res.WatermarkOutput = out
	}
	return res, nil
}

func sha256Hex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// checkHeader reads dimensions and page count without decoding pixels.
func checkHeader(orig []byte, format string, maxPixels int64) error {
	p := vips.NewImportParams()
	p.FailOnError.Set(true)
	p.Access.Set(vips.AccessSequential)
	h, err := vips.LoadImageFromBuffer(orig, p)
	if err != nil {
		return fail(ErrDecode, err)
	}
	defer h.Close()
	if h.Format() != vipsType[format] {
		return ErrUnsupported
	}
	if h.Pages() > 1 {
		return ErrAnimated
	}
	w, ht := int64(h.Width()), int64(h.Height())
	if w <= 0 || ht <= 0 {
		return ErrDecode
	}
	if w*ht > maxPixels {
		return ErrTooManyPixels
	}
	return nil
}

// normalize turns img into upright, 3-band, 8-bit sRGB with alpha
// flattened onto black and all non-technical metadata removed.
func normalize(img *vips.ImageRef) error {
	if err := img.AutoRotate(); err != nil {
		return err
	}
	converted := false
	if img.HasICCProfile() {
		// A broken embedded profile falls back to a plain colourspace
		// conversion below rather than failing the photo.
		if err := img.TransformICCProfile(vips.SRGBIEC6196621ICCProfilePath); err == nil {
			converted = true
		}
	}
	if !converted || img.Interpretation() != vips.InterpretationSRGB {
		// Handles grey, CMYK, RGB16/GREY16 (scaled down to 8-bit) and
		// ICC output at 16-bit depth.
		if err := img.ToColorSpace(vips.InterpretationSRGB); err != nil {
			return err
		}
	}
	if img.HasAlpha() {
		if err := img.Flatten(&vips.Color{}); err != nil {
			return err
		}
	}
	if img.BandFormat() != vips.BandFormatUchar {
		if err := img.Cast(vips.BandFormatUchar); err != nil {
			return err
		}
	}
	if img.Bands() > 3 {
		if err := img.ExtractBand(0, 3); err != nil {
			return err
		}
	}
	if img.Bands() != 3 || img.Interpretation() != vips.InterpretationSRGB {
		return fmt.Errorf("media: unexpected %d-band %v image after normalize", img.Bands(), img.Interpretation())
	}
	return img.RemoveMetadata()
}

func histogramOf(img *vips.ImageRef) ([4][64]uint16, error) {
	var zero [4][64]uint16
	t, err := img.Copy()
	if err != nil {
		return zero, err
	}
	defer t.Close()
	if err := t.ThumbnailWithSize(512, 512, vips.InterestingNone, vips.SizeDown); err != nil {
		return zero, err
	}
	if t.Bands() != 3 || t.BandFormat() != vips.BandFormatUchar {
		return zero, fmt.Errorf("media: histogram input is %d-band format %v", t.Bands(), t.BandFormat())
	}
	px, err := t.ToBytes()
	if err != nil {
		return zero, err
	}
	h, err := Histogram(px, t.Width(), t.Height())
	if err != nil {
		return zero, err
	}
	return NormalizeHistogram(h), nil
}

// materialize renders img's lazy pipeline into a new 3-band uchar sRGB
// memory image. The copy carries no metadata.
func materialize(img *vips.ImageRef) (*vips.ImageRef, error) {
	if img.Bands() != 3 || img.BandFormat() != vips.BandFormatUchar {
		return nil, fmt.Errorf("media: cannot materialise %d-band format %v", img.Bands(), img.BandFormat())
	}
	px, err := img.ToBytes()
	if err != nil {
		return nil, err
	}
	return vips.NewImageFromMemory(px, img.Width(), img.Height(), 3, vips.BandFormatUchar, vips.InterpretationSRGB)
}

// scaledTier returns a new materialised image of src fitted (downscale
// only) to the tier's long edge. src is left untouched.
func scaledTier(src *vips.ImageRef, t tier) (*vips.ImageRef, error) {
	c, err := src.Copy()
	if err != nil {
		return nil, fail(ErrInternal, err)
	}
	defer c.Close()
	if err := c.ThumbnailWithSize(t.edge, t.edge, vips.InterestingNone, vips.SizeDown); err != nil {
		return nil, fail(ErrInternal, err)
	}
	m, err := materialize(c)
	if err != nil {
		return nil, fail(ErrInternal, err)
	}
	return m, nil
}

// encodeTier encodes an already-sized tier image as AVIF, WebP and JPEG,
// auditing each.
func encodeTier(img *vips.ImageRef, t tier) ([]Output, error) {
	type enc struct {
		ext, ct string
		fn      func() ([]byte, *vips.ImageMetadata, error)
	}
	encs := []enc{
		{"avif", "image/avif", func() ([]byte, *vips.ImageMetadata, error) {
			return img.ExportAvif(&vips.AvifExportParams{StripMetadata: true, Quality: 50, Effort: 4, Bitdepth: 8})
		}},
		{"webp", "image/webp", func() ([]byte, *vips.ImageMetadata, error) {
			return img.ExportWebp(&vips.WebpExportParams{StripMetadata: true, Quality: 80})
		}},
		{"jpg", "image/jpeg", func() ([]byte, *vips.ImageMetadata, error) { return exportJPEG(img) }},
	}
	outs := make([]Output, 0, len(encs))
	for _, e := range encs {
		b, _, err := e.fn()
		if err != nil {
			return nil, fail(ErrInternal, err)
		}
		if err := auditClean(b); err != nil {
			return nil, fail(ErrInternal, err)
		}
		outs = append(outs, Output{Key: t.name + "." + e.ext, Bytes: b, ContentType: e.ct})
	}
	return outs, nil
}

func exportJPEG(img *vips.ImageRef) ([]byte, *vips.ImageMetadata, error) {
	return img.ExportJpeg(&vips.JpegExportParams{StripMetadata: true, Quality: 85, Interlace: true})
}

// Byte markers of EXIF, XMP and IPTC payloads.
var metadataMarkers = [][]byte{
	[]byte("Exif\x00\x00"),
	[]byte("http://ns.adobe.com/xap/"),
	[]byte("Photoshop 3.0\x00"),
}

// auditClean reloads an encoded output and fails if any EXIF, XMP, IPTC or
// GPS metadata survived the export. Defence in depth behind StripMetadata.
func auditClean(b []byte) error {
	for _, m := range metadataMarkers {
		if bytes.Contains(b, m) {
			return errors.New("media: metadata marker in output")
		}
	}
	img, err := vips.NewImageFromBuffer(b)
	if err != nil {
		return fmt.Errorf("media: output does not reload: %w", err)
	}
	defer img.Close()
	for _, f := range img.ImageFields() {
		if isMetadataField(f) {
			return fmt.Errorf("media: metadata field %q survived export", f)
		}
	}
	return nil
}

// isMetadataField reports whether a libvips field name carries EXIF, XMP,
// IPTC, GPS or comment metadata.
func isMetadataField(f string) bool {
	lf := strings.ToLower(f)
	return strings.HasPrefix(lf, "exif") || strings.HasPrefix(lf, "xmp") ||
		strings.HasPrefix(lf, "iptc") || strings.Contains(lf, "gps") ||
		strings.Contains(lf, "comment")
}
