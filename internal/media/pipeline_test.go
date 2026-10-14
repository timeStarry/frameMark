package media

//go:generate sh testdata/gen.sh

import (
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"math"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/davidbyttow/govips/v2/vips"
)

// ---------- fixture helpers ----------

type rgb struct{ r, g, b byte }

// solid builds an sRGB uchar image of the given size and colour.
func solid(t *testing.T, w, h int, c rgb) *vips.ImageRef {
	t.Helper()
	ensureVips()
	px := make([]byte, w*h*3)
	for i := 0; i < len(px); i += 3 {
		px[i], px[i+1], px[i+2] = c.r, c.g, c.b
	}
	img, err := vips.NewImageFromMemory(px, w, h, 3, vips.BandFormatUchar, vips.InterpretationSRGB)
	if err != nil {
		t.Fatal(err)
	}
	return img
}

func encJPEG(t *testing.T, img *vips.ImageRef) []byte {
	t.Helper()
	b, _, err := img.ExportJpeg(&vips.JpegExportParams{Quality: 95, StripMetadata: true, SubsampleMode: vips.VipsForeignSubsampleOff})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func encPNG(t *testing.T, img *vips.ImageRef, bitdepth int) []byte {
	t.Helper()
	b, _, err := img.ExportPng(&vips.PngExportParams{StripMetadata: true, Compression: 6, Bitdepth: bitdepth})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// insertAPP1 puts an "Exif\0\0"+tiff APP1 segment directly after SOI.
func insertAPP1(t *testing.T, jpeg, tiff []byte) []byte {
	t.Helper()
	if len(jpeg) < 2 || jpeg[0] != 0xFF || jpeg[1] != 0xD8 {
		t.Fatal("not a jpeg")
	}
	payload := append([]byte("Exif\x00\x00"), tiff...)
	seg := []byte{0xFF, 0xE1, 0, 0}
	binary.BigEndian.PutUint16(seg[2:], uint16(len(payload)+2))
	seg = append(seg, payload...)
	out := append([]byte{0xFF, 0xD8}, seg...)
	return append(out, jpeg[2:]...)
}

const tagOrientation = 0x0112

func orientationTIFF(o uint16) []byte {
	b, _, _ := buildTIFF(tiffSpec{order: binary.BigEndian, ifd0: []tEntry{eShort(tagOrientation, o)}})
	return b
}

// quadrants returns a 32x32 JPEG whose 16x16 quadrants are TL red, TR green,
// BL blue, BR yellow.
var (
	cRed    = rgb{255, 0, 0}
	cGreen  = rgb{0, 255, 0}
	cBlue   = rgb{0, 0, 255}
	cYellow = rgb{255, 255, 0}
)

func quadrantsJPEG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := solid(t, w, h, cRed)
	defer img.Close()
	hw, hh := w/2, h/2
	for _, q := range []struct {
		x, y int
		c    rgb
	}{{hw, 0, cGreen}, {0, hh, cBlue}, {hw, hh, cYellow}} {
		if err := img.DrawRect(vips.ColorRGBA{R: q.c.r, G: q.c.g, B: q.c.b, A: 255}, q.x, q.y, w-hw, h-hh, true); err != nil {
			t.Fatal(err)
		}
	}
	return encJPEG(t, img)
}

// apng builds a minimal two-frame APNG (acTL + fcTL/fdAT).
func apng(t *testing.T) []byte {
	t.Helper()
	chunk := func(typ string, d []byte) []byte {
		b := make([]byte, 4, 12+len(d))
		binary.BigEndian.PutUint32(b, uint32(len(d)))
		b = append(b, typ...)
		b = append(b, d...)
		return binary.BigEndian.AppendUint32(b, crc32.ChecksumIEEE(append([]byte(typ), d...)))
	}
	const w, h = 8, 8
	var raw bytes.Buffer
	for y := 0; y < h; y++ {
		raw.WriteByte(0)
		raw.Write(bytes.Repeat([]byte{255, 0, 0}, w))
	}
	z := zlibBytes(t, raw.Bytes())
	ihdr := binary.BigEndian.AppendUint32(nil, w)
	ihdr = binary.BigEndian.AppendUint32(ihdr, h)
	ihdr = append(ihdr, 8, 2, 0, 0, 0)
	actl := binary.BigEndian.AppendUint32(nil, 2)
	actl = binary.BigEndian.AppendUint32(actl, 0)
	fctl := func(seq uint32) []byte {
		b := binary.BigEndian.AppendUint32(nil, seq)
		b = binary.BigEndian.AppendUint32(b, w)
		b = binary.BigEndian.AppendUint32(b, h)
		b = binary.BigEndian.AppendUint32(b, 0)
		b = binary.BigEndian.AppendUint32(b, 0)
		b = binary.BigEndian.AppendUint16(b, 1)
		b = binary.BigEndian.AppendUint16(b, 10)
		return append(b, 0, 0)
	}
	out := []byte("\x89PNG\r\n\x1a\n")
	out = append(out, chunk("IHDR", ihdr)...)
	out = append(out, chunk("acTL", actl)...)
	out = append(out, chunk("fcTL", fctl(0))...)
	out = append(out, chunk("IDAT", z)...)
	out = append(out, chunk("fcTL", fctl(1))...)
	out = append(out, chunk("fdAT", append(binary.BigEndian.AppendUint32(nil, 2), z...))...)
	out = append(out, chunk("IEND", nil)...)
	return out
}

func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func load(t *testing.T, b []byte) *vips.ImageRef {
	t.Helper()
	img, err := vips.NewImageFromBuffer(b)
	if err != nil {
		t.Fatal(err)
	}
	return img
}

func pixel(t *testing.T, img *vips.ImageRef, x, y int) rgb {
	t.Helper()
	p, err := img.GetPoint(x, y)
	if err != nil {
		t.Fatal(err)
	}
	if len(p) < 3 {
		t.Fatalf("pixel has %d bands", len(p))
	}
	return rgb{byte(math.Round(p[0])), byte(math.Round(p[1])), byte(math.Round(p[2]))}
}

func near(a, b rgb, tol int) bool {
	d := func(x, y byte) int {
		if x > y {
			return int(x - y)
		}
		return int(y - x)
	}
	return d(a.r, b.r) <= tol && d(a.g, b.g) <= tol && d(a.b, b.b) <= tol
}

func mustProcess(t *testing.T, b []byte, o Options) *Result {
	t.Helper()
	r, err := Process(b, o)
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	return r
}

func allOutputs(r *Result) []Output {
	out := append([]Output(nil), r.Outputs...)
	if r.WatermarkOutput != nil {
		out = append(out, *r.WatermarkOutput)
	}
	return out
}

// assertClean reloads every output and fails on any metadata survival.
func assertClean(t *testing.T, r *Result) {
	t.Helper()
	for _, o := range allOutputs(r) {
		if bytes.Contains(o.Bytes, []byte("Exif\x00\x00")) {
			t.Errorf("%s: contains Exif marker", o.Key)
		}
		if bytes.Contains(o.Bytes, []byte("GPS")) {
			t.Errorf("%s: contains GPS bytes", o.Key)
		}
		img := load(t, o.Bytes)
		for _, f := range img.ImageFields() {
			lf := strings.ToLower(f)
			for _, bad := range []string{"exif", "xmp", "iptc", "gps"} {
				if strings.Contains(lf, bad) {
					t.Errorf("%s: field %q survived", o.Key, f)
				}
			}
		}
		img.Close()
	}
}

func dims(t *testing.T, b []byte) (int, int) {
	t.Helper()
	img := load(t, b)
	defer img.Close()
	return img.Width(), img.Height()
}

// ---------- tests ----------

func TestDerivedHashVectors(t *testing.T) {
	cases := []struct{ sha, salt, want string }{
		{"abc", "", "b95f959539cd027e"},
		{"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "0123456789abcdef0123456789abcdef", "e823264b2d6b4b38"},
	}
	for _, c := range cases {
		if got := DerivedHash(c.sha, c.salt); got != c.want {
			t.Errorf("DerivedHash(%q,%q) = %q, want %q", c.sha, c.salt, got, c.want)
		}
	}
	if DerivedHash("abc", "x") == DerivedHash("abc", "") {
		t.Error("salt must change the hash")
	}
}

func TestWatermarkHash(t *testing.T) {
	w := Watermark{Text: "© Jane", Position: "br", Opacity: 0.5, Scale: 0.04}
	// sha256(`{"opacity":0.5,"position":"br","scale":0.04,"text":"© Jane"}`)
	got := WatermarkHash(w)
	if len(got) != 16 {
		t.Fatalf("len %d", len(got))
	}
	if got != WatermarkHash(w) {
		t.Fatal("not stable")
	}
	w2 := w
	w2.Opacity = 0.6
	if WatermarkHash(w2) == got {
		t.Fatal("opacity must change the hash")
	}
	if got != "6cb56c1b23635a2d" {
		t.Errorf("WatermarkHash = %q", got)
	}
}

func TestValidateWatermark(t *testing.T) {
	ok := Watermark{Text: "© Jane", Position: "br", Opacity: 0.5, Scale: 0.04}
	if err := ok.Validate(); err != nil {
		t.Fatal(err)
	}
	for name, mut := range map[string]func(*Watermark){
		"empty":      func(w *Watermark) { w.Text = "" },
		"long":       func(w *Watermark) { w.Text = strings.Repeat("字", 65) },
		"control":    func(w *Watermark) { w.Text = "a\nb" },
		"badutf8":    func(w *Watermark) { w.Text = "a\xffb" },
		"position":   func(w *Watermark) { w.Position = "middle" },
		"opacityLo":  func(w *Watermark) { w.Opacity = 0.05 },
		"opacityHi":  func(w *Watermark) { w.Opacity = 0.9 },
		"opacityNaN": func(w *Watermark) { w.Opacity = math.NaN() },
		"scaleLo":    func(w *Watermark) { w.Scale = 0.01 },
		"scaleHi":    func(w *Watermark) { w.Scale = 0.09 },
	} {
		w := ok
		mut(&w)
		if err := w.Validate(); !errors.Is(err, ErrInvalidWatermark) {
			t.Errorf("%s: err = %v", name, err)
		}
	}
	w := ok
	w.Text = strings.Repeat("字", 64)
	if err := w.Validate(); err != nil {
		t.Errorf("64 runes should pass: %v", err)
	}
}

func TestProcessRejects(t *testing.T) {
	gif := []byte("GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;")
	img := solid(t, 64, 64, cRed)
	good := encJPEG(t, img)
	img.Close()
	cases := []struct {
		name string
		in   []byte
		opts Options
		want error
	}{
		{"empty", nil, Options{}, ErrUnsupported},
		{"garbage", []byte("hello world, definitely not an image"), Options{}, ErrUnsupported},
		{"gif", gif, Options{}, ErrUnsupported},
		{"riffNotWebp", []byte("RIFF\x10\x00\x00\x00WAVEfmt "), Options{}, ErrUnsupported},
		{"truncatedJPEG", good[:len(good)/2], Options{}, ErrDecode},
		{"corruptPNG", []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDRjunkjunkjunk"), Options{}, ErrDecode},
		{"animatedWebP", readFixture(t, "anim.webp"), Options{}, ErrAnimated},
		{"apng", apng(t), Options{}, ErrAnimated},
		{"tooManyPixels", good, Options{MaxPixels: 64*64 - 1}, ErrTooManyPixels},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := Process(c.in, c.opts)
			if !errors.Is(err, c.want) {
				t.Fatalf("err = %v, want %v", err, c.want)
			}
			if strings.ContainsAny(err.Error(), "/\n") {
				t.Errorf("error string leaks detail: %q", err.Error())
			}
		})
	}
	if _, err := Process(good, Options{MaxPixels: 64 * 64}); err != nil {
		t.Fatalf("exactly MaxPixels must pass: %v", err)
	}
	if _, err := Process(good, Options{LocationMode: "everywhere"}); err == nil {
		t.Fatal("bad location mode must fail")
	}
}

func TestProcessOrientations(t *testing.T) {
	base := quadrantsJPEG(t, 48, 32) // landscape so 90° turns are visible
	// Expected colour at TL, TR, BL, BR of the upright output.
	want := map[uint16][4]rgb{
		1: {cRed, cGreen, cBlue, cYellow},
		2: {cGreen, cRed, cYellow, cBlue},
		3: {cYellow, cBlue, cGreen, cRed},
		4: {cBlue, cYellow, cRed, cGreen},
		5: {cRed, cBlue, cGreen, cYellow},
		6: {cBlue, cRed, cYellow, cGreen},
		7: {cYellow, cGreen, cBlue, cRed},
		8: {cGreen, cYellow, cRed, cBlue},
	}
	for o := uint16(1); o <= 8; o++ {
		in := insertAPP1(t, base, orientationTIFF(o))
		r := mustProcess(t, in, Options{})
		ww, wh := 48, 32
		if o >= 5 {
			ww, wh = 32, 48
		}
		if r.Width != ww || r.Height != wh {
			t.Errorf("o=%d: result %dx%d, want %dx%d", o, r.Width, r.Height, ww, wh)
		}
		var jpg []byte
		for _, out := range r.Outputs {
			if out.Key == "w480.jpg" {
				jpg = out.Bytes
			}
		}
		img := load(t, jpg)
		if img.Width() != ww || img.Height() != wh {
			t.Errorf("o=%d: output %dx%d", o, img.Width(), img.Height())
		}
		pts := [4][2]int{{3, 3}, {ww - 4, 3}, {3, wh - 4}, {ww - 4, wh - 4}}
		for i, p := range pts {
			if got := pixel(t, img, p[0], p[1]); !near(got, want[o][i], 40) {
				t.Errorf("o=%d corner %d: got %v want %v", o, i, got, want[o][i])
			}
		}
		img.Close()
		assertClean(t, r)
	}
}

func TestProcessEXIFAndStripping(t *testing.T) {
	img := quadrantsJPEG(t, 64, 48)
	spec := fullSpec(binary.LittleEndian)
	spec.ifd0 = append(spec.ifd0, eShort(tagOrientation, 1))
	tiff, _, _ := buildTIFF(spec)
	in := insertAPP1(t, img, tiff)
	if !bytes.Contains(in, []byte("Exif\x00\x00")) {
		t.Fatal("fixture lacks exif")
	}
	wm := &Watermark{Text: "© Jane", Position: "br", Opacity: 0.5, Scale: 0.05}

	off := mustProcess(t, in, Options{LocationMode: LocationOff, Watermark: wm})
	if off.EXIF.CameraMake != "Sony" || off.EXIF.ISO == nil || *off.EXIF.ISO != 400 {
		t.Errorf("EXIF not extracted: %+v", off.EXIF)
	}
	if off.EXIF.Latitude != nil || off.EXIF.Longitude != nil {
		t.Error("location leaked under off")
	}
	assertClean(t, off)

	arch := mustProcess(t, in, Options{LocationMode: LocationArchive, Watermark: wm})
	if arch.EXIF.Latitude == nil || arch.EXIF.Longitude == nil {
		t.Fatal("archive mode must yield location")
	}
	assertClean(t, arch)
	if off.Format != "jpeg" {
		t.Errorf("format %q", off.Format)
	}
}

func TestProcessTiersAndContentTypes(t *testing.T) {
	img := solid(t, 300, 200, rgb{10, 120, 200})
	in := encPNG(t, img, 8)
	img.Close()
	r := mustProcess(t, in, Options{Salt: "s"})
	if r.Format != "png" {
		t.Errorf("format %q", r.Format)
	}
	if len(r.Outputs) != 12 {
		t.Fatalf("outputs = %d", len(r.Outputs))
	}
	ct := map[string]string{"avif": "image/avif", "webp": "image/webp", "jpg": "image/jpeg"}
	seen := map[string]bool{}
	for _, o := range r.Outputs {
		seen[o.Key] = true
		ext := o.Key[strings.LastIndex(o.Key, ".")+1:]
		if o.ContentType != ct[ext] {
			t.Errorf("%s: content type %q", o.Key, o.ContentType)
		}
		if w, h := dims(t, o.Bytes); w != 300 || h != 200 {
			t.Errorf("%s: %dx%d, want 300x200", o.Key, w, h)
		}
	}
	for _, tier := range []string{"w480", "w1280", "w2400", "w3840"} {
		for _, ext := range []string{"avif", "webp", "jpg"} {
			if !seen[tier+"."+ext] {
				t.Errorf("missing %s.%s", tier, ext)
			}
		}
	}
	if r.WatermarkOutput != nil {
		t.Error("no watermark requested")
	}
	// Histogram: the blue channel's peak bin is 200>>2.
	if r.Histogram[3][200>>2] != 65535 || r.Histogram[1][10>>2] != 65535 {
		t.Errorf("histogram peaks wrong")
	}
	assertClean(t, r)
}

func TestProcessPanorama(t *testing.T) {
	img := solid(t, 8000, 500, rgb{90, 90, 90})
	in := encJPEG(t, img)
	img.Close()
	r := mustProcess(t, in, Options{})
	want := map[string][2]int{"w480": {480, 30}, "w1280": {1280, 80}, "w2400": {2400, 150}, "w3840": {3840, 240}}
	for _, o := range r.Outputs {
		tier := o.Key[:strings.Index(o.Key, ".")]
		w, h := dims(t, o.Bytes)
		if w != want[tier][0] || h != want[tier][1] {
			t.Errorf("%s: %dx%d, want %v", o.Key, w, h, want[tier])
		}
	}
	if r.Width != 8000 || r.Height != 500 {
		t.Errorf("result %dx%d", r.Width, r.Height)
	}
}

func TestProcessPortraitLongEdge(t *testing.T) {
	img := solid(t, 600, 1600, rgb{90, 90, 90})
	in := encJPEG(t, img)
	img.Close()
	r := mustProcess(t, in, Options{})
	for _, o := range r.Outputs {
		if o.Key != "w480.webp" {
			continue
		}
		if w, h := dims(t, o.Bytes); w != 180 || h != 480 {
			t.Errorf("w480 portrait: %dx%d", w, h)
		}
	}
}

func TestProcessDisplayP3(t *testing.T) {
	r := mustProcess(t, readFixture(t, "display-p3.jpg"), Options{})
	for _, o := range r.Outputs {
		img := load(t, o.Bytes)
		if icc := img.GetICCProfile(); len(icc) > 0 && bytes.Contains(icc, []byte("Display P3")) {
			t.Errorf("%s: P3 profile survived", o.Key)
		}
		if strings.HasSuffix(o.Key, ".jpg") || strings.HasSuffix(o.Key, ".webp") {
			// P3 (200,100,50) is roughly sRGB (215,93,31).
			if got := pixel(t, img, 8, 8); !near(got, rgb{215, 93, 31}, 8) {
				t.Errorf("%s: pixel %v not converted", o.Key, got)
			}
		}
		img.Close()
	}
}

func TestProcessPNGVariants(t *testing.T) {
	t.Run("16bit", func(t *testing.T) {
		px := make([]byte, 32*32*3*2)
		for i := 0; i < len(px); i += 6 {
			binary.LittleEndian.PutUint16(px[i:], 0xFFFF)   // R max
			binary.LittleEndian.PutUint16(px[i+2:], 0x8080) // G mid
			binary.LittleEndian.PutUint16(px[i+4:], 0)      // B 0
		}
		ensureVips()
		img, err := vips.NewImageFromMemory(px, 32, 32, 3, vips.BandFormatUshort, vips.InterpretationRGB16)
		if err != nil {
			t.Fatal(err)
		}
		in := encPNG(t, img, 16)
		img.Close()
		check := load(t, in)
		if check.BandFormat() != vips.BandFormatUshort {
			t.Fatalf("fixture is not 16-bit: %v", check.BandFormat())
		}
		check.Close()
		r := mustProcess(t, in, Options{})
		out := load(t, r.Outputs[2].Bytes) // a jpeg
		defer out.Close()
		if got := pixel(t, out, 16, 16); !near(got, rgb{255, 128, 0}, 6) {
			t.Errorf("pixel %v", got)
		}
		if r.Histogram[1][63] != 65535 {
			t.Error("16-bit histogram not scaled to 8-bit")
		}
	})
	t.Run("grey", func(t *testing.T) {
		px := bytes.Repeat([]byte{100}, 32*32)
		ensureVips()
		img, err := vips.NewImageFromMemory(px, 32, 32, 1, vips.BandFormatUchar, vips.InterpretationBW)
		if err != nil {
			t.Fatal(err)
		}
		in := encPNG(t, img, 8)
		img.Close()
		r := mustProcess(t, in, Options{})
		for _, o := range r.Outputs {
			img := load(t, o.Bytes)
			if got := pixel(t, img, 16, 16); !near(got, rgb{100, 100, 100}, 4) {
				t.Errorf("%s: pixel %v", o.Key, got)
			}
			img.Close()
		}
		if r.Histogram[0][100>>2] != 65535 {
			t.Error("grey luma histogram")
		}
	})
	t.Run("alpha", func(t *testing.T) {
		px := make([]byte, 32*32*4)
		for i := 0; i < len(px); i += 4 {
			px[i], px[i+1], px[i+2], px[i+3] = 255, 255, 255, 0 // transparent white
		}
		ensureVips()
		img, err := vips.NewImageFromMemory(px, 32, 32, 4, vips.BandFormatUchar, vips.InterpretationSRGB)
		if err != nil {
			t.Fatal(err)
		}
		in := encPNG(t, img, 8)
		img.Close()
		r := mustProcess(t, in, Options{})
		for _, o := range r.Outputs {
			img := load(t, o.Bytes)
			if img.HasAlpha() {
				t.Errorf("%s: alpha survived", o.Key)
			}
			if got := pixel(t, img, 16, 16); !near(got, rgb{0, 0, 0}, 4) {
				t.Errorf("%s: not flattened to black: %v", o.Key, got)
			}
			img.Close()
		}
	})
}

func TestProcessWebPInput(t *testing.T) {
	img := solid(t, 40, 30, rgb{0, 200, 0})
	b, _, err := img.ExportWebp(&vips.WebpExportParams{Quality: 90, StripMetadata: true})
	img.Close()
	if err != nil {
		t.Fatal(err)
	}
	r := mustProcess(t, b, Options{})
	if r.Format != "webp" || r.Width != 40 || r.Height != 30 {
		t.Errorf("%+v", r)
	}
}

func TestProcessWatermark(t *testing.T) {
	img := solid(t, 1200, 800, rgb{40, 40, 40})
	in := encJPEG(t, img)
	img.Close()
	wm := &Watermark{Text: "WATERMARK", Position: "br", Opacity: 0.8, Scale: 0.08}
	r := mustProcess(t, in, Options{Watermark: wm})
	if r.WatermarkOutput == nil {
		t.Fatal("no watermark output")
	}
	if r.WatermarkOutput.Key != "w2400.jpg" || r.WatermarkOutput.ContentType != "image/jpeg" {
		t.Errorf("watermark output %q %q", r.WatermarkOutput.Key, r.WatermarkOutput.ContentType)
	}
	var plain []byte
	for _, o := range r.Outputs {
		if o.Key == "w2400.jpg" {
			plain = o.Bytes
		}
	}
	pi, wi := load(t, plain), load(t, r.WatermarkOutput.Bytes)
	defer pi.Close()
	defer wi.Close()
	if pi.Width() != wi.Width() || pi.Height() != wi.Height() {
		t.Fatalf("dims differ: %dx%d vs %dx%d", pi.Width(), pi.Height(), wi.Width(), wi.Height())
	}
	// Max brightness in a region: watermark corner should get much lighter.
	maxIn := func(img *vips.ImageRef, x0, y0, x1, y1 int) int {
		m := 0
		for y := y0; y < y1; y += 2 {
			for x := x0; x < x1; x += 2 {
				p := pixel(t, img, x, y)
				if int(p.r) > m {
					m = int(p.r)
				}
			}
		}
		return m
	}
	w, h := wi.Width(), wi.Height()
	// bottom-right region of ~ text height above the margin
	brW, brP := maxIn(wi, w*2/3, h-h/6, w-1, h-1), maxIn(pi, w*2/3, h-h/6, w-1, h-1)
	if brW < brP+60 {
		t.Errorf("watermark corner not marked: wm=%d plain=%d", brW, brP)
	}
	tlW, tlP := maxIn(wi, 0, 0, w/3, h/6), maxIn(pi, 0, 0, w/3, h/6)
	if d := tlW - tlP; d > 8 || d < -8 {
		t.Errorf("opposite corner changed: wm=%d plain=%d", tlW, tlP)
	}
	assertClean(t, r)

	for _, pos := range []string{"bl", "tr", "tl", "center"} {
		r := mustProcess(t, in, Options{Watermark: &Watermark{Text: "x", Position: pos, Opacity: 0.3, Scale: 0.02}})
		if r.WatermarkOutput == nil {
			t.Errorf("%s: no output", pos)
		}
	}
	if _, err := Process(in, Options{Watermark: &Watermark{Text: "", Position: "br", Opacity: 0.5, Scale: 0.04}}); !errors.Is(err, ErrInvalidWatermark) {
		t.Errorf("invalid watermark err = %v", err)
	}
}

func TestProcessConcurrent(t *testing.T) {
	in := quadrantsJPEG(t, 200, 120)
	before := vips.OpenImageRefs()
	var wg sync.WaitGroup
	errs := make(chan error, 4)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := Process(in, Options{Watermark: &Watermark{Text: "c", Position: "tl", Opacity: 0.5, Scale: 0.04}})
			if err == nil && (r.Width != 200 || len(r.Outputs) != 12) {
				err = errors.New("bad result")
			}
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Error(err)
		}
	}
	if after := vips.OpenImageRefs(); after != before {
		t.Errorf("leaked ImageRefs: before=%d after=%d", before, after)
	}
}

func TestProcessNoLeaksOnErrors(t *testing.T) {
	ensureVips()
	before := vips.OpenImageRefs()
	img := solid(t, 64, 64, cRed)
	good := encJPEG(t, img)
	img.Close()
	_, _ = Process(good[:len(good)/2], Options{})
	_, _ = Process(readFixture(t, "anim.webp"), Options{})
	_, _ = Process(good, Options{MaxPixels: 10})
	_, _ = Process(good, Options{})
	if after := vips.OpenImageRefs(); after != before {
		t.Errorf("leaked ImageRefs: before=%d after=%d", before, after)
	}
}

func zlibBytes(t *testing.T, b []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zlib.NewWriter(&buf)
	if _, err := zw.Write(b); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}
