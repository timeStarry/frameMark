package media

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"html"
	"math"
	"unicode"
	"unicode/utf8"

	"github.com/davidbyttow/govips/v2/vips"
)

// Watermark is the upload_prefs watermark configuration.
type Watermark struct {
	Text     string  `json:"text"`
	Position string  `json:"position"` // br | bl | tr | tl | center
	Opacity  float64 `json:"opacity"`  // 0.1–0.8
	Scale    float64 `json:"scale"`    // text height / short edge, 0.02–0.08
}

const maxWatermarkRunes = 64

// Validate checks the watermark against its documented ranges.
func (w Watermark) Validate() error {
	if !utf8.ValidString(w.Text) {
		return ErrInvalidWatermark
	}
	n := utf8.RuneCountInString(w.Text)
	if n < 1 || n > maxWatermarkRunes {
		return ErrInvalidWatermark
	}
	visible := false
	for _, r := range w.Text {
		if unicode.IsControl(r) || isBidiControl(r) {
			return ErrInvalidWatermark
		}
		if !invisible(r) {
			visible = true
		}
	}
	// Text that renders no glyph makes libvips produce an empty image.
	if !visible {
		return ErrInvalidWatermark
	}
	switch w.Position {
	case "br", "bl", "tr", "tl", "center":
	default:
		return ErrInvalidWatermark
	}
	// The negated comparisons also reject NaN.
	if !(w.Opacity >= 0.1 && w.Opacity <= 0.8) || !(w.Scale >= 0.02 && w.Scale <= 0.08) {
		return ErrInvalidWatermark
	}
	return nil
}

// isBidiControl reports the embedding/override (U+202A–202E) and isolate
// (U+2066–2069) controls, which could visually reorder the rendered text.
func isBidiControl(r rune) bool {
	return (r >= 0x202A && r <= 0x202E) || (r >= 0x2066 && r <= 0x2069)
}

// invisible reports runes that render no glyph: whitespace, format (Cf)
// and separator (Zs, Zl, Zp) characters, plus the Hangul and Braille
// fillers, which are letters/symbols by category but draw nothing.
func invisible(r rune) bool {
	switch r {
	case 0x115F, 0x1160, 0x3164, 0xFFA0, 0x2800:
		return true
	}
	return unicode.IsSpace(r) || unicode.In(r, unicode.Cf, unicode.Zs, unicode.Zl, unicode.Zp)
}

// WatermarkHash is sha256 of the canonical JSON (keys sorted, no
// whitespace) of w, hex[:16]. It names the watermarked object prefix
// d/{photoId}/{derivedHash}-wm{WatermarkHash}/.
func WatermarkHash(w Watermark) string {
	// A map marshals with sorted keys, which fixes the canonical form
	// independently of struct field order.
	b, err := json.Marshal(map[string]any{
		"opacity":  w.Opacity,
		"position": w.Position,
		"scale":    w.Scale,
		"text":     w.Text,
	})
	if err != nil {
		// Only NaN/Inf can fail, and Validate rejects those; hash the
		// textual form so the function stays total.
		b = []byte(fmt.Sprintf("%v|%s|%v|%s", w.Opacity, w.Position, w.Scale, w.Text))
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])[:16]
}

// renderWatermark composites w onto a copy of base (the w2400 tier) and
// encodes it as an audited JPEG keyed "w2400.jpg".
func renderWatermark(base *vips.ImageRef, w Watermark) (*Output, error) {
	img, err := base.Copy()
	if err != nil {
		return nil, fail(ErrInternal, err)
	}
	defer img.Close()

	short := min(img.Width(), img.Height())
	textH := max(1, int(math.Round(w.Scale*float64(short))))
	margin := int(math.Round(0.02 * float64(short)))
	boxW := max(1, img.Width()-2*margin)

	// White text; width+height makes libvips autofit the size into the
	// box. An unknown font falls back through fontconfig, never panics.
	text, err := vips.Text(&vips.TextParams{
		Text:  `<span foreground="white">` + html.EscapeString(w.Text) + `</span>`,
		Font:  "sans",
		Width: boxW, Height: textH,
		RGBA: true,
		Wrap: vips.TextWrapNone,
	})
	if err != nil {
		if text != nil {
			text.Close()
		}
		return nil, fail(ErrWatermark, err)
	}
	defer text.Close()
	if text.Bands() != 4 || text.Width() < 1 || text.Height() < 1 {
		return nil, fail(ErrWatermark, fmt.Errorf("media: watermark text is %dx%d with %d bands", text.Width(), text.Height(), text.Bands()))
	}
	if err := text.Linear([]float64{1, 1, 1, w.Opacity}, []float64{0, 0, 0, 0}); err != nil {
		return nil, fail(ErrWatermark, err)
	}
	if err := text.Cast(vips.BandFormatUchar); err != nil {
		return nil, fail(ErrWatermark, err)
	}

	tw, th := text.Width(), text.Height()
	left, top := margin, margin
	right := img.Width() - margin - tw
	bottom := img.Height() - margin - th
	switch w.Position {
	case "br":
		left, top = right, bottom
	case "bl":
		top = bottom
	case "tr":
		left = right
	case "center":
		left, top = (img.Width()-tw)/2, (img.Height()-th)/2
	}
	left, top = max(0, left), max(0, top)

	if err := img.Composite(text, vips.BlendModeOver, left, top); err != nil {
		return nil, fail(ErrWatermark, err)
	}
	if img.HasAlpha() {
		if err := img.Flatten(&vips.Color{}); err != nil {
			return nil, fail(ErrInternal, err)
		}
	}
	if img.BandFormat() != vips.BandFormatUchar {
		if err := img.Cast(vips.BandFormatUchar); err != nil {
			return nil, fail(ErrInternal, err)
		}
	}
	b, _, err := exportJPEG(img)
	if err != nil {
		return nil, fail(ErrInternal, err)
	}
	if err := auditClean(b); err != nil {
		return nil, fail(ErrInternal, err)
	}
	return &Output{Key: watermarkTier + ".jpg", Bytes: b, ContentType: "image/jpeg"}, nil
}
