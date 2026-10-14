package media

import (
	"encoding/binary"
	"errors"
	"fmt"
)

// HistogramBytes is the size of an encoded histogram (photo_histograms.bins).
const HistogramBytes = 4 * 64 * 2

// luma returns Rec.709 luminance of gamma-encoded 8-bit values, rounded,
// in integer arithmetic.
func luma(r, g, b byte) byte {
	return byte((2126*uint32(r) + 7152*uint32(g) + 722*uint32(b) + 5000) / 10000)
}

// Histogram counts interleaved 8-bit sRGB RGB pixels into 64 bins per
// channel: 0 luminance (Rec.709), 1 R, 2 G, 3 B. Bin = value >> 2.
func Histogram(rgb []byte, width, height int) ([4][64]uint32, error) {
	var h [4][64]uint32
	if width <= 0 || height <= 0 {
		return h, fmt.Errorf("media: invalid histogram dimensions %dx%d", width, height)
	}
	// Division avoids overflow in width*height*3.
	if len(rgb)%3 != 0 || len(rgb)/3%width != 0 || len(rgb)/3/width != height {
		return h, fmt.Errorf("media: pixel buffer length %d does not match %dx%d RGB", len(rgb), width, height)
	}
	for i := 0; i+2 < len(rgb); i += 3 {
		r, g, b := rgb[i], rgb[i+1], rgb[i+2]
		h[0][luma(r, g, b)>>2]++
		h[1][r>>2]++
		h[2][g>>2]++
		h[3][b>>2]++
	}
	return h, nil
}

// NormalizeHistogram scales each channel by its own maximum to 0..65535,
// rounding to nearest. An all-zero channel stays zero.
func NormalizeHistogram(h [4][64]uint32) [4][64]uint16 {
	var n [4][64]uint16
	for c := range h {
		var max uint32
		for _, v := range h[c] {
			if v > max {
				max = v
			}
		}
		if max == 0 {
			continue
		}
		m := uint64(max)
		for i, v := range h[c] {
			n[c][i] = uint16((uint64(v)*65535 + m/2) / m)
		}
	}
	return n
}

// EncodeHistogram serialises to 512 bytes: little-endian uint16, channel-major.
func EncodeHistogram(n [4][64]uint16) []byte {
	b := make([]byte, HistogramBytes)
	for c := range n {
		for i, v := range n[c] {
			binary.LittleEndian.PutUint16(b[(c*64+i)*2:], v)
		}
	}
	return b
}

// DecodeHistogram is the inverse of EncodeHistogram.
func DecodeHistogram(b []byte) ([4][64]uint16, error) {
	var n [4][64]uint16
	if len(b) != HistogramBytes {
		return n, errors.New("media: encoded histogram must be 512 bytes")
	}
	for c := range n {
		for i := range n[c] {
			n[c][i] = binary.LittleEndian.Uint16(b[(c*64+i)*2:])
		}
	}
	return n, nil
}
