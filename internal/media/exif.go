// Package media holds the photo-processing primitives used by the
// process_photo job: whitelist EXIF extraction and histogram computation.
package media

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// EXIF is the whitelisted subset of photo metadata stored in photo_exif
// (plus photos.latitude/longitude). Pointer fields are nil when the tag is
// absent, malformed or outside sanity bounds, so "absent" never collides
// with a real zero.
type EXIF struct {
	CameraMake, CameraModel, LensModel string

	FocalLengthMM, FocalLength35mm, Aperture, ExposureSeconds, ExposureBias *float64

	// ExposureTime is the display form: "1/250" below one second (reduced
	// rational), otherwise decimal seconds such as "2" or "2.5".
	ExposureTime string
	ISO          *int64
	// TakenAt is DateTimeOriginal in Unix milliseconds. OffsetTimeOriginal is
	// applied when present and valid; otherwise the wall-clock time is
	// interpreted as UTC.
	TakenAt *int64

	// Latitude and Longitude are signed decimal degrees. They are only ever
	// populated with location mode "archive".
	Latitude, Longitude *float64
}

// Location modes, matching upload_prefs.location_mode.
const (
	LocationOff     = "off"
	LocationArchive = "archive"
)

const (
	maxBlob        = 1 << 20 // 1 MiB
	maxIFDEntries  = 512
	maxIFDDepth    = 2
	maxStringBytes = 128
	// maxASCIIBytes is how much of an ASCII value is decoded before
	// sanitize cuts it to maxStringBytes.
	maxASCIIBytes = 256
	// maxDecodedBytes caps the value bytes decoded over a whole parse, so
	// many entries sharing one huge out-of-line block cannot amplify work.
	maxDecodedBytes = 64 << 10
)

// TIFF field types.
const (
	typeByte      = 1
	typeASCII     = 2
	typeShort     = 3
	typeLong      = 4
	typeRational  = 5
	typeUndefined = 7
	typeSRational = 10
)

// Whitelisted tags.
const (
	tagMake  = 0x010F
	tagModel = 0x0110

	tagExifIFD = 0x8769
	tagGPSIFD  = 0x8825

	tagExposureTime       = 0x829A
	tagFNumber            = 0x829D
	tagISO                = 0x8827
	tagDateTimeOriginal   = 0x9003
	tagOffsetTimeOriginal = 0x9011
	tagExposureBias       = 0x9204
	tagFocalLength        = 0x920A
	tagFocalLength35      = 0xA405
	tagLensModel          = 0xA434

	tagGPSLatRef = 1
	tagGPSLat    = 2
	tagGPSLonRef = 3
	tagGPSLon    = 4
)

// ifdVisitHook, when non-nil, is called each time an IFD is actually
// parsed. Tests use it to prove the GPS IFD is never touched with location
// off. It must stay nil in production.
var ifdVisitHook func(kind string, off uint32)

type entry struct {
	tag, typ uint16
	count    uint32
	val      []byte // the 4-byte value/offset field
}

type parser struct {
	b       []byte
	o       binary.ByteOrder
	visited map[uint32]bool
	decoded int // value bytes decoded so far, against maxDecodedBytes
}

// ExtractEXIF parses a raw EXIF blob: a TIFF header ("II*\0" or "MM\0*"),
// optionally preceded by "Exif\0\0" (the libvips exif-data form). Only
// whitelisted tags are read. The GPS IFD is followed only when locationMode
// is "archive"; with "off" its pointer is not even recorded.
//
// Untrusted input never causes an error: a missing or malformed blob yields
// an empty EXIF, and a malformed tag is skipped. An error is returned only
// for an invalid locationMode.
func ExtractEXIF(blob []byte, locationMode string) (EXIF, error) {
	var out EXIF
	if locationMode != LocationOff && locationMode != LocationArchive {
		return out, fmt.Errorf("media: invalid location mode %q", locationMode)
	}
	if len(blob) > maxBlob {
		return out, nil
	}
	blob = bytes.TrimPrefix(blob, []byte("Exif\x00\x00"))
	if len(blob) < 8 {
		return out, nil
	}
	p := &parser{b: blob, visited: map[uint32]bool{}}
	switch {
	case blob[0] == 'I' && blob[1] == 'I':
		p.o = binary.LittleEndian
	case blob[0] == 'M' && blob[1] == 'M':
		p.o = binary.BigEndian
	default:
		return out, nil
	}
	if p.o.Uint16(blob[2:]) != 42 {
		return out, nil
	}

	ifd0, ok := p.readIFD(p.o.Uint32(blob[4:]), "ifd0", 0)
	if !ok {
		return out, nil
	}
	var exifOff, gpsOff uint32
	var haveExif, haveGPS bool
	for _, e := range ifd0 {
		if p.decoded >= maxDecodedBytes {
			break
		}
		switch e.tag {
		case tagMake:
			if out.CameraMake == "" {
				out.CameraMake, _ = p.str(e)
			}
		case tagModel:
			if out.CameraModel == "" {
				out.CameraModel, _ = p.str(e)
			}
		case tagExifIFD:
			exifOff, haveExif = p.pointer(e)
		case tagGPSIFD:
			if locationMode == LocationArchive {
				gpsOff, haveGPS = p.pointer(e)
			}
		}
	}
	if haveExif {
		if entries, ok := p.readIFD(exifOff, "exif", 1); ok {
			p.applyExif(&out, entries)
		}
	}
	// Privacy: haveGPS can only be true in archive mode.
	if haveGPS && locationMode == LocationArchive {
		if entries, ok := p.readIFD(gpsOff, "gps", 1); ok {
			out.Latitude, out.Longitude = p.gps(entries)
		}
	}
	return out, nil
}

// readIFD returns the entries of the IFD at off, or false if the IFD is
// out of bounds, too large, too deep or already visited.
func (p *parser) readIFD(off uint32, kind string, depth int) ([]entry, bool) {
	if depth >= maxIFDDepth || p.visited[off] {
		return nil, false
	}
	p.visited[off] = true
	if ifdVisitHook != nil {
		ifdVisitHook(kind, off)
	}
	n := uint64(len(p.b))
	if uint64(off)+2 > n {
		return nil, false
	}
	count := uint64(p.o.Uint16(p.b[off:]))
	if count > maxIFDEntries || uint64(off)+2+12*count > n {
		return nil, false
	}
	entries := make([]entry, 0, count)
	base := uint64(off) + 2
	for i := uint64(0); i < count; i++ {
		e := p.b[base+12*i : base+12*i+12]
		entries = append(entries, entry{
			tag:   p.o.Uint16(e[0:]),
			typ:   p.o.Uint16(e[2:]),
			count: p.o.Uint32(e[4:]),
			val:   e[8:12],
		})
	}
	return entries, true
}

func typeSize(t uint16) uint64 {
	switch t {
	case typeByte, typeASCII, typeUndefined:
		return 1
	case typeShort:
		return 2
	case typeLong:
		return 4
	case typeRational, typeSRational:
		return 8
	}
	return 0
}

// data returns the bytes of the first min(count, max) values of an entry,
// inline or at its offset. It fails when the type is unknown, the count is
// zero, the full declared value does not fit in the blob, or the parse-wide
// decode budget would be exceeded. Size math is uint64 so it cannot wrap.
func (p *parser) data(e entry, max int) ([]byte, bool) {
	sz := typeSize(e.typ)
	if sz == 0 || e.count == 0 || max <= 0 {
		return nil, false
	}
	size := uint64(e.count) * sz
	n := uint64(e.count)
	if n > uint64(max) {
		n = uint64(max)
	}
	want := n * sz
	if uint64(p.decoded)+want > maxDecodedBytes {
		return nil, false
	}
	var d []byte
	if size <= 4 {
		d = e.val[:want]
	} else {
		off := uint64(p.o.Uint32(e.val))
		if off+size > uint64(len(p.b)) {
			return nil, false
		}
		d = p.b[off : off+want]
	}
	p.decoded += int(want)
	return d, true
}

func (p *parser) pointer(e entry) (uint32, bool) {
	if e.count != 1 || (e.typ != typeLong && e.typ != typeShort) {
		return 0, false
	}
	// IFD pointers are 4-byte inline values; they are not payload and
	// must not consume the decode budget.
	switch e.typ {
	case typeShort:
		return uint32(p.o.Uint16(e.val)), true
	case typeLong:
		return p.o.Uint32(e.val), true
	}
	return 0, false
}

// uint returns the first value of a SHORT or LONG entry.
func (p *parser) uint(e entry) (uint32, bool) {
	if e.typ != typeShort && e.typ != typeLong {
		return 0, false
	}
	d, ok := p.data(e, 1)
	if !ok {
		return 0, false
	}
	switch e.typ {
	case typeShort:
		return uint32(p.o.Uint16(d)), true
	case typeLong:
		return p.o.Uint32(d), true
	}
	return 0, false
}

// rationals returns the first min(count, max) num/den pairs of a RATIONAL
// or SRATIONAL entry.
func (p *parser) rationals(e entry, max int) ([][2]int64, bool) {
	if e.typ != typeRational && e.typ != typeSRational {
		return nil, false
	}
	d, ok := p.data(e, max)
	if !ok {
		return nil, false
	}
	out := make([][2]int64, 0, len(d)/8)
	for i := 0; i+8 <= len(d); i += 8 {
		n, m := p.o.Uint32(d[i:]), p.o.Uint32(d[i+4:])
		if e.typ == typeSRational {
			out = append(out, [2]int64{int64(int32(n)), int64(int32(m))})
		} else {
			out = append(out, [2]int64{int64(n), int64(m)})
		}
	}
	return out, true
}

// rational returns the first value as float64; a zero denominator fails.
func (p *parser) rational(e entry) (float64, bool) {
	r, ok := p.rationals(e, 1)
	if !ok || r[0][1] == 0 {
		return 0, false
	}
	return float64(r[0][0]) / float64(r[0][1]), true
}

func (p *parser) str(e entry) (string, bool) {
	if e.typ != typeASCII {
		return "", false
	}
	d, ok := p.data(e, maxASCIIBytes)
	if !ok {
		return "", false
	}
	return sanitize(d), true
}

// sanitize cuts at the first NUL, drops invalid UTF-8, control (Cc) and
// format (Cf: bidi overrides, zero-width) characters, trims whitespace and caps at maxStringBytes on a rune
// boundary.
func sanitize(d []byte) string {
	if i := bytes.IndexByte(d, 0); i >= 0 {
		d = d[:i]
	}
	s := strings.ToValidUTF8(string(d), "")
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, s)
	s = strings.TrimSpace(s)
	if len(s) > maxStringBytes {
		cut := maxStringBytes
		for cut > 0 && !utf8.RuneStart(s[cut]) {
			cut--
		}
		s = strings.TrimSpace(s[:cut])
	}
	return s
}

func inRange(v, lo, hi float64) *float64 {
	if math.IsNaN(v) || v < lo || v > hi {
		return nil
	}
	return &v
}

func (p *parser) applyExif(out *EXIF, entries []entry) {
	var dto, oto string
	for _, e := range entries {
		if p.decoded >= maxDecodedBytes {
			break
		}
		switch e.tag {
		case tagExposureTime:
			if out.ExposureSeconds == nil {
				p.exposure(out, e)
			}
		case tagFNumber:
			if out.Aperture == nil {
				if v, ok := p.rational(e); ok {
					out.Aperture = inRange(v, 0.5, 128)
				}
			}
		case tagISO:
			if out.ISO == nil {
				if v, ok := p.uint(e); ok && v >= 1 && v <= 10_000_000 {
					iso := int64(v)
					out.ISO = &iso
				}
			}
		case tagDateTimeOriginal:
			if dto == "" {
				dto, _ = p.str(e)
			}
		case tagOffsetTimeOriginal:
			if oto == "" {
				oto, _ = p.str(e)
			}
		case tagExposureBias:
			if out.ExposureBias == nil {
				if v, ok := p.rational(e); ok {
					out.ExposureBias = inRange(v, -20, 20)
				}
			}
		case tagFocalLength:
			if out.FocalLengthMM == nil {
				if v, ok := p.rational(e); ok && v > 0 {
					out.FocalLengthMM = inRange(v, 0, 5000)
				}
			}
		case tagFocalLength35:
			if out.FocalLength35mm == nil {
				if v, ok := p.uint(e); ok && v > 0 && v <= 5000 {
					f := float64(v)
					out.FocalLength35mm = &f
				}
			}
		case tagLensModel:
			if out.LensModel == "" {
				out.LensModel, _ = p.str(e)
			}
		}
	}
	out.TakenAt = takenAt(dto, oto)
}

func gcd(a, b uint64) uint64 {
	for b != 0 {
		a, b = b, a%b
	}
	return a
}

func (p *parser) exposure(out *EXIF, e entry) {
	if e.typ != typeRational {
		return
	}
	r, ok := p.rationals(e, 1)
	if !ok {
		return
	}
	num, den := uint64(r[0][0]), uint64(r[0][1])
	// Exact bounds 1/100000 <= num/den <= 3600; also rejects den == 0.
	if den == 0 || num*100000 < den || num > 3600*den {
		return
	}
	secs := float64(num) / float64(den)
	g := gcd(num, den)
	switch {
	case num < den && num/g == 1:
		// Exact unit fraction: "1/250".
		out.ExposureTime = "1/" + strconv.FormatUint(den/g, 10)
	case num < den && secs < 0.25:
		// Short non-unit fraction: nearest "1/N".
		out.ExposureTime = "1/" + strconv.FormatFloat(math.Round(1/secs), 'f', -1, 64)
	default:
		// 0.25 s and longer: decimal seconds, one place at most.
		out.ExposureTime = strconv.FormatFloat(math.Round(secs*10)/10, 'f', -1, 64)
	}
	out.ExposureSeconds = &secs
}

// takenAt parses "YYYY:MM:DD HH:MM:SS" with an optional "+HH:MM" offset.
// Without a valid offset the time is taken as UTC.
func takenAt(dto, oto string) *int64 {
	if dto == "" {
		return nil
	}
	// time.Parse rejects leap seconds; clamp :60 to :59.
	if len(dto) == 19 && dto[17:] == "60" {
		dto = dto[:17] + "59"
	}
	t, err := time.Parse("2006:01:02 15:04:05", dto)
	if err != nil || t.Year() < 1 {
		return nil
	}
	if off, ok := parseOffset(oto); ok {
		t = t.Add(-time.Duration(off) * time.Second)
	}
	ms := t.UnixMilli()
	return &ms
}

func parseOffset(s string) (int, bool) {
	if len(s) != 6 || (s[0] != '+' && s[0] != '-') || s[3] != ':' {
		return 0, false
	}
	h, err1 := strconv.Atoi(s[1:3])
	m, err2 := strconv.Atoi(s[4:6])
	if err1 != nil || err2 != nil || h > 14 || m > 59 || s[1] == '+' || s[1] == '-' || s[4] == '+' || s[4] == '-' {
		return 0, false
	}
	off := h*3600 + m*60
	if s[0] == '-' {
		off = -off
	}
	return off, true
}

// gps decodes signed decimal degrees; both coordinates or neither.
func (p *parser) gps(entries []entry) (*float64, *float64) {
	var latRef, lonRef string
	var lat, lon *float64
	for _, e := range entries {
		if p.decoded >= maxDecodedBytes {
			break
		}
		switch e.tag {
		case tagGPSLatRef:
			if latRef == "" {
				latRef, _ = p.str(e)
			}
		case tagGPSLonRef:
			if lonRef == "" {
				lonRef, _ = p.str(e)
			}
		case tagGPSLat:
			if lat == nil {
				lat = p.dms(e)
			}
		case tagGPSLon:
			if lon == nil {
				lon = p.dms(e)
			}
		}
	}
	if lat == nil || lon == nil {
		return nil, nil
	}
	switch latRef {
	case "N":
	case "S":
		*lat = -*lat
	default:
		return nil, nil
	}
	switch lonRef {
	case "E":
	case "W":
		*lon = -*lon
	default:
		return nil, nil
	}
	la, lo := inRange(*lat, -90, 90), inRange(*lon, -180, 180)
	if la == nil || lo == nil {
		return nil, nil
	}
	return la, lo
}

func (p *parser) dms(e entry) *float64 {
	if e.typ != typeRational {
		return nil
	}
	r, ok := p.rationals(e, 3)
	if !ok || len(r) < 3 {
		return nil
	}
	var v float64
	for i, div := range []float64{1, 60, 3600} {
		if r[i][1] == 0 {
			return nil
		}
		v += float64(r[i][0]) / float64(r[i][1]) / div
	}
	return &v
}
