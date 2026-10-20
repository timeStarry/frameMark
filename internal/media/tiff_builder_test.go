package media

import "encoding/binary"

// Test-only deterministic TIFF/EXIF builder. It lays out a TIFF header,
// IFD0, the optional Exif and GPS sub-IFDs and their out-of-line value
// areas sequentially, in either byte order. Several knobs exist purely to
// produce malformed blobs for robustness tests.

type tEntry struct {
	tag, typ uint16
	count    uint32
	enc      func(binary.ByteOrder) []byte
	// raw, when non-nil, is written verbatim into the value/offset field
	// and enc is ignored. Used for hostile offsets and counts.
	raw *uint32
}

type tiffSpec struct {
	order     binary.ByteOrder
	prefix    bool // prepend "Exif\0\0"
	ifd0      []tEntry
	exif      []tEntry // nil = no Exif sub-IFD
	gps       []tEntry // nil = no GPS sub-IFD
	exifPtr   *uint32  // override ExifIFDPointer value (forces the entry)
	gpsPtr    *uint32  // override GPSInfo pointer value (forces the entry)
	gpsAtTail bool     // GPSInfo pointer -> start of tail (forces the entry)
	tail      []byte   // raw bytes appended after everything else
	ifd0Count *uint16  // override IFD0 entry-count field
}

func u32p(v uint32) *uint32 { return &v }
func u16p(v uint16) *uint16 { return &v }

func eASCII(tag uint16, s string) tEntry {
	b := append([]byte(s), 0)
	return tEntry{tag: tag, typ: 2, count: uint32(len(b)), enc: func(binary.ByteOrder) []byte { return b }}
}

// eRawASCII stores exactly b (no NUL appended).
func eRawASCII(tag uint16, b []byte) tEntry {
	return tEntry{tag: tag, typ: 2, count: uint32(len(b)), enc: func(binary.ByteOrder) []byte { return b }}
}

func eShort(tag uint16, vals ...uint16) tEntry {
	return tEntry{tag: tag, typ: 3, count: uint32(len(vals)), enc: func(o binary.ByteOrder) []byte {
		b := make([]byte, 2*len(vals))
		for i, v := range vals {
			o.PutUint16(b[2*i:], v)
		}
		return b
	}}
}

func eLong(tag uint16, vals ...uint32) tEntry {
	return tEntry{tag: tag, typ: 4, count: uint32(len(vals)), enc: func(o binary.ByteOrder) []byte {
		b := make([]byte, 4*len(vals))
		for i, v := range vals {
			o.PutUint32(b[4*i:], v)
		}
		return b
	}}
}

// eRational takes num, den pairs.
func eRational(tag uint16, nd ...uint32) tEntry {
	return tEntry{tag: tag, typ: 5, count: uint32(len(nd) / 2), enc: func(o binary.ByteOrder) []byte {
		b := make([]byte, 4*len(nd))
		for i, v := range nd {
			o.PutUint32(b[4*i:], v)
		}
		return b
	}}
}

func eSRational(tag uint16, nd ...int32) tEntry {
	return tEntry{tag: tag, typ: 10, count: uint32(len(nd) / 2), enc: func(o binary.ByteOrder) []byte {
		b := make([]byte, 4*len(nd))
		for i, v := range nd {
			o.PutUint32(b[4*i:], uint32(v))
		}
		return b
	}}
}

func eUndefined(tag uint16, data []byte) tEntry {
	return tEntry{tag: tag, typ: 7, count: uint32(len(data)), enc: func(binary.ByteOrder) []byte { return data }}
}

// eHostile writes an arbitrary type/count with a raw value/offset field.
func eHostile(tag, typ uint16, count, raw uint32) tEntry {
	return tEntry{tag: tag, typ: typ, count: count, raw: u32p(raw)}
}

type builtIFD struct {
	entries []tEntry
	data    [][]byte
	off     uint32
	dataOff []uint32
}

// buildTIFF returns the blob and the offsets (relative to the TIFF header)
// of the Exif and GPS IFDs it laid out (0 when absent).
func buildTIFF(s tiffSpec) (blob []byte, exifOff, gpsOff uint32) {
	o := s.order
	ifd0 := append([]tEntry(nil), s.ifd0...)
	hasExif := s.exif != nil || s.exifPtr != nil
	hasGPS := s.gps != nil || s.gpsPtr != nil || s.gpsAtTail
	exifIdx, gpsIdx := -1, -1
	if hasExif {
		exifIdx = len(ifd0)
		ifd0 = append(ifd0, eLong(tagExifIFD, 0))
	}
	if hasGPS {
		gpsIdx = len(ifd0)
		ifd0 = append(ifd0, eLong(tagGPSIFD, 0))
	}

	ifds := []*builtIFD{{entries: ifd0}}
	var exifB, gpsB *builtIFD
	if s.exif != nil {
		exifB = &builtIFD{entries: s.exif}
		ifds = append(ifds, exifB)
	}
	if s.gps != nil {
		gpsB = &builtIFD{entries: s.gps}
		ifds = append(ifds, gpsB)
	}

	// Pass 1: layout. Pointer entries are inline LONGs, so their values do
	// not affect sizes.
	pos := uint32(8)
	for _, d := range ifds {
		d.off = pos
		pos += 2 + 12*uint32(len(d.entries)) + 4
		d.data = make([][]byte, len(d.entries))
		d.dataOff = make([]uint32, len(d.entries))
		for i, e := range d.entries {
			if e.raw != nil {
				continue
			}
			b := e.enc(o)
			d.data[i] = b
			if len(b) > 4 {
				d.dataOff[i] = pos
				pos += uint32(len(b))
				if pos%2 == 1 {
					pos++
				}
			}
		}
	}
	tailOff := pos
	total := pos + uint32(len(s.tail))

	if exifB != nil {
		exifOff = exifB.off
	}
	if gpsB != nil {
		gpsOff = gpsB.off
	}
	ptr := func(idx int, v uint32) {
		b := make([]byte, 4)
		o.PutUint32(b, v)
		ifds[0].data[idx] = b
	}
	if exifIdx >= 0 {
		v := exifOff
		if s.exifPtr != nil {
			v = *s.exifPtr
		}
		ptr(exifIdx, v)
	}
	if gpsIdx >= 0 {
		v := gpsOff
		switch {
		case s.gpsPtr != nil:
			v = *s.gpsPtr
		case s.gpsAtTail:
			v = tailOff
			gpsOff = tailOff
		}
		ptr(gpsIdx, v)
	}

	// Pass 2: write.
	buf := make([]byte, total)
	if o == binary.ByteOrder(binary.LittleEndian) {
		copy(buf, "II")
	} else {
		copy(buf, "MM")
	}
	o.PutUint16(buf[2:], 42)
	o.PutUint32(buf[4:], 8)
	for n, d := range ifds {
		p := d.off
		cnt := uint16(len(d.entries))
		if n == 0 && s.ifd0Count != nil {
			cnt = *s.ifd0Count
		}
		o.PutUint16(buf[p:], cnt)
		p += 2
		for i, e := range d.entries {
			o.PutUint16(buf[p:], e.tag)
			o.PutUint16(buf[p+2:], e.typ)
			o.PutUint32(buf[p+4:], e.count)
			switch {
			case e.raw != nil:
				o.PutUint32(buf[p+8:], *e.raw)
			case len(d.data[i]) > 4:
				o.PutUint32(buf[p+8:], d.dataOff[i])
				copy(buf[d.dataOff[i]:], d.data[i])
			default:
				copy(buf[p+8:], d.data[i])
			}
			p += 12
		}
		o.PutUint32(buf[p:], 0) // next IFD: none
	}
	copy(buf[tailOff:], s.tail)
	if s.prefix {
		buf = append([]byte("Exif\x00\x00"), buf...)
	}
	return buf, exifOff, gpsOff
}
