package media

import (
	"bytes"
	"testing"
)

func sumCh(h [4][64]uint32, c int) uint64 {
	var s uint64
	for _, v := range h[c] {
		s += uint64(v)
	}
	return s
}

func fill(w, h int, r, g, b byte) []byte {
	px := make([]byte, w*h*3)
	for i := 0; i < len(px); i += 3 {
		px[i], px[i+1], px[i+2] = r, g, b
	}
	return px
}

func TestHistogramErrors(t *testing.T) {
	cases := []struct {
		px   []byte
		w, h int
	}{
		{nil, 0, 0},
		{make([]byte, 3), 0, 1},
		{make([]byte, 3), 1, -1},
		{make([]byte, 5), 1, 2},
		{make([]byte, 7), 1, 2},
		{make([]byte, 9), 2, 2},
		{make([]byte, 6), 1, 1},
	}
	for _, c := range cases {
		if _, err := Histogram(c.px, c.w, c.h); err == nil {
			t.Errorf("w=%d h=%d len=%d: want error", c.w, c.h, len(c.px))
		}
	}
}

func TestHistogramSumsAndPureColours(t *testing.T) {
	cases := []struct {
		name     string
		r, g, b  byte
		wantBins [4]int // luma, R, G, B
	}{
		{"black", 0, 0, 0, [4]int{0, 0, 0, 0}},
		{"white", 255, 255, 255, [4]int{63, 63, 63, 63}},
		// Y = (2126*255 + 5000)/10000 = 54.713 -> 54 (rounded: 54) -> bin 13
		{"red", 255, 0, 0, [4]int{13, 63, 0, 0}},
		// Y = 7152*255/10000 = 182.376 -> 182 -> bin 45
		{"green", 0, 255, 0, [4]int{45, 0, 63, 0}},
		// Y = 722*255/10000 = 18.411 -> 18 -> bin 4
		{"blue", 0, 0, 255, [4]int{4, 0, 0, 63}},
		{"gray128", 128, 128, 128, [4]int{32, 32, 32, 32}},
	}
	const w, h = 7, 5
	for _, c := range cases {
		hist, err := Histogram(fill(w, h, c.r, c.g, c.b), w, h)
		if err != nil {
			t.Fatal(err)
		}
		for ch := 0; ch < 4; ch++ {
			if s := sumCh(hist, ch); s != w*h {
				t.Errorf("%s ch%d sum %d", c.name, ch, s)
			}
			if hist[ch][c.wantBins[ch]] != w*h {
				t.Errorf("%s ch%d: bin %d = %d", c.name, ch, c.wantBins[ch], hist[ch][c.wantBins[ch]])
			}
		}
	}
}

func TestHistogramLumaRounding(t *testing.T) {
	// R=G=B=v must give Y=v exactly (weights sum to 10000).
	for v := 0; v < 256; v++ {
		if y := luma(byte(v), byte(v), byte(v)); int(y) != v {
			t.Fatalf("luma(%d,%d,%d)=%d", v, v, v, y)
		}
	}
	// 0.2126*3 + 0.7152*0 + 0.0722*7 = 1.1432 -> 1; 0.2126*0+0.7152*2+0.0722*0 = 1.4304 -> 1;
	// 0.7152*3 = 2.1456 -> 2; 0.2126*1+0.7152*1+0.0722*10 = 1.65 -> 2 (rounds up)
	cases := []struct{ r, g, b, y byte }{{3, 0, 7, 1}, {0, 2, 0, 1}, {0, 3, 0, 2}, {1, 1, 10, 2}}
	for _, c := range cases {
		if y := luma(c.r, c.g, c.b); y != c.y {
			t.Errorf("luma(%d,%d,%d)=%d want %d", c.r, c.g, c.b, y, c.y)
		}
	}
}

func TestHistogramGrayRamp(t *testing.T) {
	// 256 x 3 ramp: each value 0..255 appears 3 times -> every bin gets 4*3.
	const w, h = 256, 3
	px := make([]byte, 0, w*h*3)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			px = append(px, byte(x), byte(x), byte(x))
		}
	}
	hist, err := Histogram(px, w, h)
	if err != nil {
		t.Fatal(err)
	}
	for ch := 0; ch < 4; ch++ {
		for bin, v := range hist[ch] {
			if v != 12 {
				t.Fatalf("ch%d bin%d = %d, want 12", ch, bin, v)
			}
		}
	}
}

func TestNormalizeHistogram(t *testing.T) {
	var h [4][64]uint32
	h[0][0], h[0][10], h[0][63] = 1000, 500, 1
	h[1][5] = 7
	h[2][1], h[2][2] = 3, 1
	// h[3] all zero
	n := NormalizeHistogram(h)
	if n[0][0] != 65535 || n[0][10] != 32768 || n[0][63] != 66 || n[0][1] != 0 {
		t.Errorf("ch0: %d %d %d", n[0][0], n[0][10], n[0][63])
	}
	if n[1][5] != 65535 {
		t.Errorf("ch1 independent max: %d", n[1][5])
	}
	if n[2][1] != 65535 || n[2][2] != 21845 {
		t.Errorf("ch2: %d %d", n[2][1], n[2][2])
	}
	for _, v := range n[3] {
		if v != 0 {
			t.Fatal("zero channel not zero")
		}
	}
	// Max values near uint32 limit must not overflow.
	var big [4][64]uint32
	big[0][0], big[0][1] = ^uint32(0), ^uint32(0)/2
	nb := NormalizeHistogram(big)
	if nb[0][0] != 65535 || nb[0][1] != 32767 && nb[0][1] != 32768 {
		t.Errorf("big: %d %d", nb[0][0], nb[0][1])
	}
}

func TestEncodeDecodeHistogram(t *testing.T) {
	var n [4][64]uint16
	for c := 0; c < 4; c++ {
		for i := 0; i < 64; i++ {
			n[c][i] = uint16(c*1000 + i*13 + 0x0100)
		}
	}
	b := EncodeHistogram(n)
	if len(b) != 512 {
		t.Fatalf("len %d", len(b))
	}
	// Little-endian, channel-major: channel 1 bin 0 starts at byte 128.
	if b[0] != 0x00 || b[1] != 0x01 {
		t.Errorf("le bytes %x %x", b[0], b[1])
	}
	want1 := uint16(1000 + 0x0100)
	if got := uint16(b[128]) | uint16(b[129])<<8; got != want1 {
		t.Errorf("channel-major: got %d want %d", got, want1)
	}
	d, err := DecodeHistogram(b)
	if err != nil {
		t.Fatal(err)
	}
	if d != n {
		t.Error("round trip mismatch")
	}
	if !bytes.Equal(EncodeHistogram(d), b) {
		t.Error("re-encode mismatch")
	}
	for _, l := range []int{0, 511, 513} {
		if _, err := DecodeHistogram(make([]byte, l)); err == nil {
			t.Errorf("len %d: want error", l)
		}
	}
}
