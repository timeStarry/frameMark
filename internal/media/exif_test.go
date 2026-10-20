package media

import (
	"encoding/binary"
	"fmt"
	"math"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

var orders = []struct {
	name  string
	order binary.ByteOrder
}{
	{"II", binary.LittleEndian},
	{"MM", binary.BigEndian},
}

// fullSpec covers every whitelisted tag, mixing inline (<=4 byte) and
// out-of-line values.
func fullSpec(o binary.ByteOrder) tiffSpec {
	return tiffSpec{
		order: o,
		ifd0: []tEntry{
			eASCII(0x010E, "ignored description"), // ImageDescription: not whitelisted
			eASCII(tagMake, "Sony"),               // 5 bytes: offset
			eASCII(tagModel, "A7"),                // 3 bytes: inline
		},
		exif: []tEntry{
			eRational(tagExposureTime, 10, 2500), // reduces to 1/250
			eRational(tagFNumber, 28, 10),
			eShort(tagISO, 400), // inline SHORT
			eASCII(tagDateTimeOriginal, "2024:05:01 12:34:56"),
			eASCII(tagOffsetTimeOriginal, "+08:00"),
			eSRational(tagExposureBias, -2, 3),
			eRational(tagFocalLength, 350, 10),
			eShort(tagFocalLength35, 52),
			eASCII(tagLensModel, "FE 35mm F1.8"),
			eUndefined(0x927C, []byte("MakerNote junk that must be ignored")),
		},
		gps: []tEntry{
			eASCII(tagGPSLatRef, "S"),
			eRational(tagGPSLat, 33, 1, 51, 1, 54, 1),
			eASCII(tagGPSLonRef, "W"),
			eRational(tagGPSLon, 151, 1, 12, 1, 36, 1),
		},
	}
}

func f64(v float64) *float64 { return &v }
func i64(v int64) *int64     { return &v }

func wantFull() EXIF {
	return EXIF{
		CameraMake:      "Sony",
		CameraModel:     "A7",
		LensModel:       "FE 35mm F1.8",
		FocalLengthMM:   f64(35),
		FocalLength35mm: f64(52),
		Aperture:        f64(2.8),
		ExposureSeconds: f64(1.0 / 250),
		ExposureBias:    f64(-2.0 / 3),
		ExposureTime:    "1/250",
		ISO:             i64(400),
		TakenAt:         i64(time.Date(2024, 5, 1, 4, 34, 56, 0, time.UTC).UnixMilli()),
	}
}

func mustExtract(t *testing.T, blob []byte, mode string) EXIF {
	t.Helper()
	e, err := ExtractEXIF(blob, mode)
	if err != nil {
		t.Fatalf("ExtractEXIF(%q): %v", mode, err)
	}
	return e
}

func approx(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func assertEXIF(t *testing.T, got, want EXIF) {
	t.Helper()
	if got.CameraMake != want.CameraMake || got.CameraModel != want.CameraModel ||
		got.LensModel != want.LensModel || got.ExposureTime != want.ExposureTime {
		t.Errorf("strings: got %+v want %+v", got, want)
	}
	fp := map[string][2]*float64{
		"FocalLengthMM":   {got.FocalLengthMM, want.FocalLengthMM},
		"FocalLength35mm": {got.FocalLength35mm, want.FocalLength35mm},
		"Aperture":        {got.Aperture, want.Aperture},
		"ExposureSeconds": {got.ExposureSeconds, want.ExposureSeconds},
		"ExposureBias":    {got.ExposureBias, want.ExposureBias},
		"Latitude":        {got.Latitude, want.Latitude},
		"Longitude":       {got.Longitude, want.Longitude},
	}
	for name, p := range fp {
		g, w := p[0], p[1]
		switch {
		case g == nil && w == nil:
		case g == nil || w == nil:
			t.Errorf("%s: got %v want %v", name, fmtp(g), fmtp(w))
		case !approx(*g, *w):
			t.Errorf("%s: got %v want %v", name, *g, *w)
		}
	}
	ip := map[string][2]*int64{"ISO": {got.ISO, want.ISO}, "TakenAt": {got.TakenAt, want.TakenAt}}
	for name, p := range ip {
		if !reflect.DeepEqual(p[0], p[1]) {
			t.Errorf("%s: got %v want %v", name, fmti(p[0]), fmti(p[1]))
		}
	}
}

func fmtp(p *float64) any {
	if p == nil {
		return "nil"
	}
	return *p
}

func fmti(p *int64) any {
	if p == nil {
		return "nil"
	}
	return *p
}

func TestExtractEXIFWhitelistBothOrders(t *testing.T) {
	for _, bo := range orders {
		for _, prefix := range []bool{false, true} {
			s := fullSpec(bo.order)
			s.prefix = prefix
			blob, _, _ := buildTIFF(s)
			t.Run(fmt.Sprintf("%s/prefix=%v", bo.name, prefix), func(t *testing.T) {
				assertEXIF(t, mustExtract(t, blob, "off"), wantFull())
				want := wantFull()
				want.Latitude = f64(-(33 + 51.0/60 + 54.0/3600))
				want.Longitude = f64(-(151 + 12.0/60 + 36.0/3600))
				assertEXIF(t, mustExtract(t, blob, "archive"), want)
			})
		}
	}
}

func TestExtractEXIFGPSNorthEast(t *testing.T) {
	for _, bo := range orders {
		s := fullSpec(bo.order)
		s.gps = []tEntry{
			eASCII(tagGPSLatRef, "N"),
			eRational(tagGPSLat, 31, 1, 30, 1, 0, 1),
			eASCII(tagGPSLonRef, "E"),
			eRational(tagGPSLon, 121, 1, 2830, 100, 0, 1), // 121° 28.3'
		}
		blob, _, _ := buildTIFF(s)
		e := mustExtract(t, blob, "archive")
		if e.Latitude == nil || !approx(*e.Latitude, 31.5) {
			t.Errorf("%s lat %v", bo.name, fmtp(e.Latitude))
		}
		if e.Longitude == nil || !approx(*e.Longitude, 121+28.3/60) {
			t.Errorf("%s lon %v", bo.name, fmtp(e.Longitude))
		}
		off := mustExtract(t, blob, "off")
		if off.Latitude != nil || off.Longitude != nil {
			t.Errorf("%s: GPS leaked with location off", bo.name)
		}
	}
}

func TestExtractEXIFGPSOutOfRange(t *testing.T) {
	cases := map[string][]tEntry{
		"lat>90": {
			eASCII(tagGPSLatRef, "N"), eRational(tagGPSLat, 95, 1, 0, 1, 0, 1),
			eASCII(tagGPSLonRef, "E"), eRational(tagGPSLon, 10, 1, 0, 1, 0, 1),
		},
		"lon>180": {
			eASCII(tagGPSLatRef, "N"), eRational(tagGPSLat, 10, 1, 0, 1, 0, 1),
			eASCII(tagGPSLonRef, "W"), eRational(tagGPSLon, 181, 1, 0, 1, 0, 1),
		},
		"bad ref": {
			eASCII(tagGPSLatRef, "X"), eRational(tagGPSLat, 10, 1, 0, 1, 0, 1),
			eASCII(tagGPSLonRef, "E"), eRational(tagGPSLon, 10, 1, 0, 1, 0, 1),
		},
		"zero den": {
			eASCII(tagGPSLatRef, "N"), eRational(tagGPSLat, 10, 0, 0, 1, 0, 1),
			eASCII(tagGPSLonRef, "E"), eRational(tagGPSLon, 10, 1, 0, 1, 0, 1),
		},
		"short count": {
			eASCII(tagGPSLatRef, "N"), eRational(tagGPSLat, 10, 1),
			eASCII(tagGPSLonRef, "E"), eRational(tagGPSLon, 10, 1, 0, 1, 0, 1),
		},
	}
	for name, gps := range cases {
		s := fullSpec(binary.LittleEndian)
		s.gps = gps
		blob, _, _ := buildTIFF(s)
		e := mustExtract(t, blob, "archive")
		if e.Latitude != nil || e.Longitude != nil {
			t.Errorf("%s: want nil lat/lon, got %v %v", name, fmtp(e.Latitude), fmtp(e.Longitude))
		}
		if e.CameraMake != "Sony" {
			t.Errorf("%s: other tags lost", name)
		}
	}
}

// TestExtractEXIFNeverVisitsGPSWhenOff points the GPS IFD at corrupt bytes
// and proves, via the IFD visit hook, that it is never read with location
// off, and that results equal those of the same EXIF without a GPS pointer.
func TestExtractEXIFNeverVisitsGPSWhenOff(t *testing.T) {
	corrupt := []byte{0xFF, 0xFF, 0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x01, 0x00, 0x05, 0xFF, 0xFF, 0xFF, 0xFF}
	for _, bo := range orders {
		clean := fullSpec(bo.order)
		clean.gps = nil
		cleanBlob, _, _ := buildTIFF(clean)
		baseline := mustExtract(t, cleanBlob, "off")

		variants := map[string]tiffSpec{}
		s := fullSpec(bo.order)
		s.gps, s.gpsAtTail, s.tail = nil, true, corrupt
		variants["corrupt-tail"] = s
		s2 := fullSpec(bo.order)
		s2.gps, s2.gpsPtr = nil, u32p(0xFFFFFFF0)
		variants["out-of-range"] = s2
		s3 := fullSpec(bo.order)
		s3.gps, s3.gpsPtr = nil, u32p(8) // loops back to IFD0
		variants["loop"] = s3
		valid := fullSpec(bo.order)
		variants["valid"] = valid

		for name, spec := range variants {
			blob, _, gpsOff := buildTIFF(spec)
			var visited []string
			ifdVisitHook = func(kind string, off uint32) { visited = append(visited, kind) }
			got := mustExtract(t, blob, "off")
			ifdVisitHook = nil
			for _, k := range visited {
				if k == "gps" {
					t.Fatalf("%s/%s: GPS IFD visited with location off (gpsOff=%d)", bo.name, name, gpsOff)
				}
			}
			if !reflect.DeepEqual(visited, []string{"ifd0", "exif"}) {
				t.Errorf("%s/%s: visited %v", bo.name, name, visited)
			}
			assertEXIF(t, got, baseline)
			if !reflect.DeepEqual(got, baseline) {
				t.Errorf("%s/%s: result differs from no-GPS baseline", bo.name, name)
			}
			// archive must not panic either, and corrupt GPS yields nil.
			arch := mustExtract(t, blob, "archive")
			if name != "valid" && (arch.Latitude != nil || arch.Longitude != nil) {
				t.Errorf("%s/%s: corrupt GPS produced coordinates", bo.name, name)
			}
		}
	}
}

func TestExtractEXIFArchiveVisitsGPS(t *testing.T) {
	blob, _, _ := buildTIFF(fullSpec(binary.BigEndian))
	var visited []string
	ifdVisitHook = func(kind string, off uint32) { visited = append(visited, kind) }
	defer func() { ifdVisitHook = nil }()
	mustExtract(t, blob, "archive")
	if !reflect.DeepEqual(visited, []string{"ifd0", "exif", "gps"}) {
		t.Fatalf("visited %v", visited)
	}
}

func TestExtractEXIFBadLocationMode(t *testing.T) {
	blob, _, _ := buildTIFF(fullSpec(binary.LittleEndian))
	for _, m := range []string{"", "on", "ARCHIVE", "Off"} {
		if _, err := ExtractEXIF(blob, m); err == nil {
			t.Errorf("mode %q: want error", m)
		}
	}
	if _, err := ExtractEXIF(nil, "bogus"); err == nil {
		t.Error("nil blob, bad mode: want error")
	}
}

func TestExtractEXIFMalformedHeaders(t *testing.T) {
	good, _, _ := buildTIFF(fullSpec(binary.LittleEndian))
	badMagic := append([]byte(nil), good...)
	badMagic[2] = 43
	badIFD := append([]byte(nil), good...)
	binary.LittleEndian.PutUint32(badIFD[4:], 0xFFFFFFFF)
	cases := map[string][]byte{
		"nil":          nil,
		"empty":        {},
		"exif only":    []byte("Exif\x00\x00"),
		"junk":         []byte("not a tiff header at all"),
		"mixed order":  []byte("IM*\x00\x08\x00\x00\x00"),
		"bad magic":    badMagic,
		"ifd0 offset":  badIFD,
		"too large":    append(append([]byte(nil), good...), make([]byte, maxBlob)...),
		"jpeg markers": {0xFF, 0xD8, 0xFF, 0xE1},
	}
	for name, b := range cases {
		e, err := ExtractEXIF(b, "archive")
		if err != nil {
			t.Errorf("%s: unexpected error %v", name, err)
		}
		if !reflect.DeepEqual(e, EXIF{}) {
			t.Errorf("%s: want empty EXIF, got %+v", name, e)
		}
	}
}

func TestExtractEXIFTruncated(t *testing.T) {
	for _, bo := range orders {
		blob, _, _ := buildTIFF(fullSpec(bo.order))
		for n := 0; n < len(blob); n++ {
			for _, m := range []string{"off", "archive"} {
				e, err := ExtractEXIF(blob[:n], m)
				if err != nil {
					t.Fatalf("%s len %d: %v", bo.name, n, err)
				}
				if m == "off" && (e.Latitude != nil || e.Longitude != nil) {
					t.Fatalf("GPS with off")
				}
			}
		}
	}
}

func TestExtractEXIFSelfLoop(t *testing.T) {
	for _, bo := range orders {
		s := fullSpec(bo.order)
		s.exif, s.exifPtr = nil, u32p(8) // ExifIFDPointer -> IFD0 itself
		s.gps, s.gpsPtr = nil, u32p(8)
		blob, _, _ := buildTIFF(s)
		var visited []string
		ifdVisitHook = func(kind string, off uint32) { visited = append(visited, kind) }
		e := mustExtract(t, blob, "archive")
		ifdVisitHook = nil
		if e.CameraMake != "Sony" || e.ISO != nil {
			t.Errorf("%s: got %+v", bo.name, e)
		}
		if !reflect.DeepEqual(visited, []string{"ifd0"}) {
			t.Errorf("%s: visited %v", bo.name, visited)
		}
	}
	// Exif and GPS pointing at the same IFD: second visit rejected.
	s := fullSpec(binary.LittleEndian)
	blob, exifOff, _ := buildTIFF(s)
	s.gps, s.gpsPtr = nil, u32p(exifOff)
	blob, _, _ = buildTIFF(s)
	e := mustExtract(t, blob, "archive")
	if e.Latitude != nil || e.ISO == nil {
		t.Errorf("shared IFD: got %+v", e)
	}
}

func TestExtractEXIFHugeEntryCount(t *testing.T) {
	for _, bo := range orders {
		s := fullSpec(bo.order)
		s.ifd0Count = u16p(65535)
		blob, _, _ := buildTIFF(s)
		e := mustExtract(t, blob, "archive")
		if !reflect.DeepEqual(e, EXIF{}) {
			t.Errorf("%s: want empty, got %+v", bo.name, e)
		}
		// 513 is just above the cap; 512 entries that fit are fine.
		s.ifd0Count = u16p(maxIFDEntries + 1)
		blob, _, _ = buildTIFF(s)
		if e := mustExtract(t, blob, "off"); !reflect.DeepEqual(e, EXIF{}) {
			t.Errorf("%s: 513 entries: want empty", bo.name)
		}
	}
}

func TestExtractEXIFHugeCountTimesSize(t *testing.T) {
	for _, bo := range orders {
		s := fullSpec(bo.order)
		s.ifd0 = []tEntry{
			eHostile(tagMake, typeASCII, 0xFFFFFFFF, 8),
			eASCII(tagModel, "A7"),
		}
		s.exif = []tEntry{
			eHostile(tagExposureTime, typeRational, 0x20000000, 0x10), // 8*count wraps uint32
			eHostile(tagFNumber, typeRational, 0xFFFFFFFF, 0xFFFFFFF8),
			eHostile(tagLensModel, typeASCII, 64, 0xFFFFFFF0), // offset+size overflows
			eHostile(tagISO, 99, 1, 400),                      // unknown type
			eShort(tagFocalLength35, 52),
		}
		blob, _, _ := buildTIFF(s)
		e := mustExtract(t, blob, "archive")
		if e.CameraMake != "" || e.ExposureTime != "" || e.Aperture != nil || e.LensModel != "" || e.ISO != nil {
			t.Errorf("%s: hostile tags not skipped: %+v", bo.name, e)
		}
		if e.CameraModel != "A7" || e.FocalLength35mm == nil || *e.FocalLength35mm != 52 {
			t.Errorf("%s: valid neighbours lost: %+v", bo.name, e)
		}
	}
}

func TestExtractEXIFValueForms(t *testing.T) {
	for _, bo := range orders {
		s := tiffSpec{order: bo.order,
			ifd0: []tEntry{
				eShort(tagMake, 5),     // wrong type for a string tag: skipped
				eASCII(tagModel, "X1"), // inline
			},
			exif: []tEntry{
				eLong(tagISO, 12800, 100),        // LONG array: first value, offset form
				eRational(tagExposureTime, 5, 2), // 2.5 s
				eLong(tagFocalLength35, 28),
				eASCII(tagLensModel, "Lens"), // exactly 5 bytes with NUL
			},
		}
		blob, _, _ := buildTIFF(s)
		e := mustExtract(t, blob, "off")
		if e.CameraMake != "" || e.CameraModel != "X1" || e.LensModel != "Lens" {
			t.Errorf("%s strings: %+v", bo.name, e)
		}
		if e.ISO == nil || *e.ISO != 12800 {
			t.Errorf("%s ISO %v", bo.name, fmti(e.ISO))
		}
		if e.ExposureTime != "2.5" || e.ExposureSeconds == nil || *e.ExposureSeconds != 2.5 {
			t.Errorf("%s exposure %q %v", bo.name, e.ExposureTime, fmtp(e.ExposureSeconds))
		}
		if e.FocalLength35mm == nil || *e.FocalLength35mm != 28 {
			t.Errorf("%s 35mm %v", bo.name, fmtp(e.FocalLength35mm))
		}
	}
}

func exifOnly(entries ...tEntry) []byte {
	b, _, _ := buildTIFF(tiffSpec{order: binary.LittleEndian, exif: entries})
	return b
}

func TestExtractEXIFExposureFormatting(t *testing.T) {
	cases := []struct {
		num, den uint32
		want     string
		secs     float64
	}{
		{1, 250, "1/250", 1.0 / 250},
		{10, 2500, "1/250", 1.0 / 250},
		{2, 3, "0.7", 2.0 / 3},
		{3, 10, "0.3", 0.3},
		{4, 10, "0.4", 0.4},
		{1, 3, "1/3", 1.0 / 3},
		{2, 750, "1/375", 2.0 / 750},
		{3, 1000, "1/333", 0.003},
		{1, 4, "1/4", 0.25},
		{99, 100, "1", 0.99},
		{1, 1, "1", 1},
		{2, 1, "2", 2},
		{30, 1, "30", 30},
		{5, 2, "2.5", 2.5},
		{13, 10, "1.3", 1.3},
	}
	for _, c := range cases {
		e := mustExtract(t, exifOnly(eRational(tagExposureTime, c.num, c.den)), "off")
		if e.ExposureTime != c.want || e.ExposureSeconds == nil || !approx(*e.ExposureSeconds, c.secs) {
			t.Errorf("%d/%d: got %q %v", c.num, c.den, e.ExposureTime, fmtp(e.ExposureSeconds))
		}
	}
}

func TestExtractEXIFSanityBounds(t *testing.T) {
	nilCases := map[string]tEntry{
		"focal 0":         eRational(tagFocalLength, 0, 1),
		"focal 5001":      eRational(tagFocalLength, 5001, 1),
		"focal35 0":       eShort(tagFocalLength35, 0),
		"focal35 6000":    eShort(tagFocalLength35, 6000),
		"aperture 0.4":    eRational(tagFNumber, 4, 10),
		"aperture 129":    eRational(tagFNumber, 129, 1),
		"exposure tiny":   eRational(tagExposureTime, 1, 200000),
		"exposure 3601":   eRational(tagExposureTime, 3601, 1),
		"exposure den 0":  eRational(tagExposureTime, 1, 0),
		"exposure 0":      eRational(tagExposureTime, 0, 1),
		"iso 0":           eShort(tagISO, 0),
		"iso huge":        eLong(tagISO, 10_000_001),
		"bias -21":        eSRational(tagExposureBias, -21, 1),
		"bias 21":         eSRational(tagExposureBias, 21, 1),
		"bias den 0":      eSRational(tagExposureBias, 1, 0),
		"focal rational0": eRational(tagFocalLength, 35, 0),
	}
	for name, ent := range nilCases {
		e := mustExtract(t, exifOnly(ent), "off")
		if !reflect.DeepEqual(e, EXIF{}) {
			t.Errorf("%s: want empty, got %+v", name, e)
		}
	}
	okCases := map[string]struct {
		ent   tEntry
		check func(EXIF) bool
	}{
		"focal 5000":    {eRational(tagFocalLength, 5000, 1), func(e EXIF) bool { return e.FocalLengthMM != nil && *e.FocalLengthMM == 5000 }},
		"aperture 0.5":  {eRational(tagFNumber, 1, 2), func(e EXIF) bool { return e.Aperture != nil && *e.Aperture == 0.5 }},
		"aperture 128":  {eRational(tagFNumber, 128, 1), func(e EXIF) bool { return e.Aperture != nil && *e.Aperture == 128 }},
		"exposure min":  {eRational(tagExposureTime, 1, 100000), func(e EXIF) bool { return e.ExposureTime == "1/100000" }},
		"exposure 3600": {eRational(tagExposureTime, 3600, 1), func(e EXIF) bool { return e.ExposureTime == "3600" }},
		"iso 1":         {eShort(tagISO, 1), func(e EXIF) bool { return e.ISO != nil && *e.ISO == 1 }},
		"iso 10M":       {eLong(tagISO, 10_000_000), func(e EXIF) bool { return e.ISO != nil && *e.ISO == 10_000_000 }},
		"bias -20":      {eSRational(tagExposureBias, -20, 1), func(e EXIF) bool { return e.ExposureBias != nil && *e.ExposureBias == -20 }},
		"bias 0":        {eSRational(tagExposureBias, 0, 1), func(e EXIF) bool { return e.ExposureBias != nil && *e.ExposureBias == 0 }},
		"bias rational": {eRational(tagExposureBias, 1, 3), func(e EXIF) bool { return e.ExposureBias != nil && approx(*e.ExposureBias, 1.0/3) }},
	}
	for name, c := range okCases {
		if e := mustExtract(t, exifOnly(c.ent), "off"); !c.check(e) {
			t.Errorf("%s: got %+v", name, e)
		}
	}
}

func TestExtractEXIFTakenAt(t *testing.T) {
	utc := func(y int, mo time.Month, d, h, mi, s int) *int64 {
		return i64(time.Date(y, mo, d, h, mi, s, 0, time.UTC).UnixMilli())
	}
	cases := []struct {
		name    string
		entries []tEntry
		want    *int64
	}{
		{"no offset is UTC", []tEntry{eASCII(tagDateTimeOriginal, "2024:05:01 12:34:56")}, utc(2024, 5, 1, 12, 34, 56)},
		{"+08:00", []tEntry{eASCII(tagDateTimeOriginal, "2024:05:01 12:34:56"), eASCII(tagOffsetTimeOriginal, "+08:00")}, utc(2024, 5, 1, 4, 34, 56)},
		{"-05:30", []tEntry{eASCII(tagDateTimeOriginal, "2024:01:01 00:00:00"), eASCII(tagOffsetTimeOriginal, "-05:30")}, utc(2024, 1, 1, 5, 30, 0)},
		{"bad offset falls back to UTC", []tEntry{eASCII(tagDateTimeOriginal, "2024:05:01 12:34:56"), eASCII(tagOffsetTimeOriginal, "8h")}, utc(2024, 5, 1, 12, 34, 56)},
		{"offset out of range", []tEntry{eASCII(tagDateTimeOriginal, "2024:05:01 12:34:56"), eASCII(tagOffsetTimeOriginal, "+25:00")}, utc(2024, 5, 1, 12, 34, 56)},
		{"zero date", []tEntry{eASCII(tagDateTimeOriginal, "0000:00:00 00:00:00")}, nil},
		{"blank date", []tEntry{eASCII(tagDateTimeOriginal, "    :  :     :  :  ")}, nil},
		{"invalid", []tEntry{eASCII(tagDateTimeOriginal, "2024:13:45 99:00:00")}, nil},
		{"wrong format", []tEntry{eASCII(tagDateTimeOriginal, "2024-05-01T12:34:56")}, nil},
		{"leap second clamps to 59", []tEntry{eASCII(tagDateTimeOriginal, "2016:12:31 23:59:60")}, utc(2016, 12, 31, 23, 59, 59)},
		{"second 61 rejected", []tEntry{eASCII(tagDateTimeOriginal, "2016:12:31 23:59:61")}, nil},
		{"trailing garbage", []tEntry{eASCII(tagDateTimeOriginal, "2024:05:01 12:34:56xyz")}, nil},
	}
	for _, c := range cases {
		e := mustExtract(t, exifOnly(c.entries...), "off")
		if !reflect.DeepEqual(e.TakenAt, c.want) {
			t.Errorf("%s: got %v want %v", c.name, fmti(e.TakenAt), fmti(c.want))
		}
	}
}

func TestExtractEXIFTakenOffset(t *testing.T) {
	dto := eASCII(tagDateTimeOriginal, "2024:05:01 12:34:56")
	cases := []struct {
		name    string
		entries []tEntry
		want    *int64
	}{
		{"+08:00", []tEntry{dto, eASCII(tagOffsetTimeOriginal, "+08:00")}, i64(480)},
		{"-05:30", []tEntry{dto, eASCII(tagOffsetTimeOriginal, "-05:30")}, i64(-330)},
		{"+14:00", []tEntry{dto, eASCII(tagOffsetTimeOriginal, "+14:00")}, i64(840)},
		{"+00:00", []tEntry{dto, eASCII(tagOffsetTimeOriginal, "+00:00")}, i64(0)},
		{"invalid", []tEntry{dto, eASCII(tagOffsetTimeOriginal, "8h")}, nil},
		{"out of range", []tEntry{dto, eASCII(tagOffsetTimeOriginal, "+25:00")}, nil},
		{"beyond column bound", []tEntry{dto, eASCII(tagOffsetTimeOriginal, "+14:30")}, nil},
		{"missing", []tEntry{dto}, nil},
	}
	for _, c := range cases {
		e := mustExtract(t, exifOnly(c.entries...), "off")
		if !reflect.DeepEqual(e.TakenOffsetMin, c.want) {
			t.Errorf("%s: got %v want %v", c.name, fmti(e.TakenOffsetMin), fmti(c.want))
		}
	}
}

func TestExtractEXIFStringSanitizing(t *testing.T) {
	long := strings.Repeat("a", 127) + "é" // 129 bytes, é straddles the cap
	cases := []struct {
		name string
		raw  []byte
		want string
	}{
		{"trim", []byte("  Canon \x00\x00"), "Canon"},
		{"stop at NUL", []byte("Nikon\x00garbage"), "Nikon"},
		{"control chars", []byte("Fu\x01ji\x7f\tfilm\x00"), "Fujifilm"},
		{"invalid utf8", []byte("Le\xffica\x00"), "Leica"},
		{"utf8 kept", []byte("尼康\x00"), "尼康"},
		{"cap on rune boundary", append([]byte(long), 0), strings.Repeat("a", 127)},
		{"all control", []byte("\x01\x02\x03"), ""},
		{"no NUL", []byte("Pentax"), "Pentax"},
		{"bidi override", []byte("Fu\u202ejifilm\x00"), "Fujifilm"},
		{"zero width space", []byte("Ca\u200bnon\x00"), "Canon"},
	}
	for _, c := range cases {
		blob, _, _ := buildTIFF(tiffSpec{order: binary.BigEndian, ifd0: []tEntry{eRawASCII(tagMake, c.raw)}})
		e := mustExtract(t, blob, "off")
		if e.CameraMake != c.want {
			t.Errorf("%s: got %q want %q", c.name, e.CameraMake, c.want)
		}
		if len(e.CameraMake) > maxStringBytes {
			t.Errorf("%s: %d bytes", c.name, len(e.CameraMake))
		}
	}
	// 200-byte ASCII is capped to exactly 128.
	blob, _, _ := buildTIFF(tiffSpec{order: binary.LittleEndian, exif: []tEntry{eASCII(tagLensModel, strings.Repeat("L", 200))}})
	if e := mustExtract(t, blob, "off"); len(e.LensModel) != 128 {
		t.Errorf("lens len %d", len(e.LensModel))
	}
}

func FuzzExtractEXIF(f *testing.F) {
	for _, bo := range orders {
		blob, _, _ := buildTIFF(fullSpec(bo.order))
		f.Add(blob)
		s := fullSpec(bo.order)
		s.prefix = true
		blob, _, _ = buildTIFF(s)
		f.Add(blob)
		s = fullSpec(bo.order)
		s.gps, s.gpsAtTail, s.tail = nil, true, []byte{0xFF, 0xFF, 1, 2, 3, 4}
		blob, _, _ = buildTIFF(s)
		f.Add(blob)
	}
	f.Add([]byte("II*\x00\x08\x00\x00\x00"))
	f.Add([]byte("MM\x00*\x00\x00\x00\x08"))
	f.Fuzz(func(t *testing.T, b []byte) {
		off, err := ExtractEXIF(b, "off")
		if err != nil {
			t.Fatalf("off: %v", err)
		}
		if off.Latitude != nil || off.Longitude != nil {
			t.Fatal("GPS returned with location off")
		}
		arch, err := ExtractEXIF(b, "archive")
		if err != nil {
			t.Fatalf("archive: %v", err)
		}
		if (arch.Latitude == nil) != (arch.Longitude == nil) {
			t.Fatal("half a coordinate")
		}
		if arch.Latitude != nil && (*arch.Latitude < -90 || *arch.Latitude > 90 || *arch.Longitude < -180 || *arch.Longitude > 180) {
			t.Fatal("coordinate out of range")
		}
		// GPS must not influence any other field.
		arch.Latitude, arch.Longitude = nil, nil
		if !reflect.DeepEqual(off, arch) {
			t.Fatalf("modes disagree on non-GPS fields: %+v vs %+v", off, arch)
		}
		for _, s := range []string{off.CameraMake, off.CameraModel, off.LensModel} {
			if len(s) > maxStringBytes || !utf8.ValidString(s) {
				t.Fatalf("bad string %q", s)
			}
		}
	})
}

// amplificationBlob is the review's I1 scenario: a 1 MiB blob whose Exif
// IFD holds 512 entries of the same tag, all pointing at one huge shared
// out-of-line block.
func amplificationBlob(tag, typ uint16, unit int, fill []byte) []byte {
	o := binary.LittleEndian
	b := make([]byte, maxBlob)
	copy(b, "II")
	o.PutUint16(b[2:], 42)
	o.PutUint32(b[4:], 8)
	o.PutUint16(b[8:], 1) // IFD0: one entry
	o.PutUint16(b[10:], tagExifIFD)
	o.PutUint16(b[12:], typeLong)
	o.PutUint32(b[14:], 1)
	o.PutUint32(b[18:], 26)
	o.PutUint32(b[22:], 0)
	const dataOff = 8000
	count := uint32((maxBlob - dataOff) / unit)
	o.PutUint16(b[26:], maxIFDEntries)
	for i := 0; i < maxIFDEntries; i++ {
		p := 28 + 12*i
		o.PutUint16(b[p:], tag)
		o.PutUint16(b[p+2:], typ)
		o.PutUint32(b[p+4:], count)
		o.PutUint32(b[p+8:], dataOff)
	}
	for i := dataOff; i+len(fill) <= len(b); i += len(fill) {
		copy(b[i:], fill)
	}
	return b
}

func TestExtractEXIFBoundedDecoding(t *testing.T) {
	fnum := make([]byte, 8)
	binary.LittleEndian.PutUint32(fnum, 28)
	binary.LittleEndian.PutUint32(fnum[4:], 10)
	cases := map[string]struct {
		blob  []byte
		check func(EXIF) bool
	}{
		"512x FNumber rationals": {
			amplificationBlob(tagFNumber, typeRational, 8, fnum),
			func(e EXIF) bool { return e.Aperture != nil && approx(*e.Aperture, 2.8) },
		},
		"512x LensModel ascii": {
			amplificationBlob(tagLensModel, typeASCII, 1, []byte("L")),
			func(e EXIF) bool { return len(e.LensModel) == maxStringBytes },
		},
		"512x ISO longs": {
			amplificationBlob(tagISO, typeLong, 4, []byte{100, 0, 0, 0}),
			func(e EXIF) bool { return e.ISO != nil && *e.ISO == 100 },
		},
	}
	for name, c := range cases {
		if len(c.blob) != maxBlob {
			t.Fatalf("%s: blob is %d bytes", name, len(c.blob))
		}
		e := mustExtract(t, c.blob, "off")
		if !c.check(e) {
			t.Errorf("%s: unexpected result %+v", name, e)
		}
		allocs := testing.AllocsPerRun(50, func() {
			if _, err := ExtractEXIF(c.blob, "archive"); err != nil {
				t.Fatal(err)
			}
		})
		const runs = 20
		runtime.GC()
		var start, end runtime.MemStats
		runtime.ReadMemStats(&start)
		for i := 0; i < runs; i++ {
			if _, err := ExtractEXIF(c.blob, "archive"); err != nil {
				t.Fatal(err)
			}
		}
		runtime.ReadMemStats(&end)
		per := (end.TotalAlloc - start.TotalAlloc) / runs
		if per >= 1<<20 {
			t.Errorf("%s: %d bytes allocated per call, want < 1 MiB", name, per)
		}
		t.Logf("%s: %d B/op, %.1f allocs/op", name, per, allocs)
	}
}

func TestExtractEXIFDecodeBudget(t *testing.T) {
	p := &parser{b: make([]byte, 1<<20), o: binary.LittleEndian}
	e := entry{tag: tagLensModel, typ: typeASCII, count: 1 << 19, val: []byte{0, 0, 0, 0}}
	n := 0
	for {
		if _, ok := p.data(e, maxASCIIBytes); !ok {
			break
		}
		n++
		if n > 1000 {
			t.Fatal("decode budget never exhausted")
		}
	}
	if n != maxDecodedBytes/maxASCIIBytes {
		t.Errorf("decoded %d strings before budget stop, want %d", n, maxDecodedBytes/maxASCIIBytes)
	}
	// Once exhausted, even tiny values are refused.
	if _, ok := p.data(entry{typ: typeShort, count: 1, val: []byte{1, 0, 0, 0}}, 1); ok {
		t.Error("budget exhausted but short still decoded")
	}
}
