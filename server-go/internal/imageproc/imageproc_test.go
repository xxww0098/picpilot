package imageproc

import (
	"bytes"
	"encoding/base64"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"testing"

	"golang.org/x/image/webp"
)

func sampleJPEG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{uint8(x % 256), uint8(y % 256), 128, 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func webpDims(t *testing.T, data []byte) (int, int) {
	t.Helper()
	img, err := webp.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("decode webp: %v", err)
	}
	return img.Bounds().Dx(), img.Bounds().Dy()
}

func TestEncodeDecodeWebPRoundtrip(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 64, 48))
	out, err := EncodeWebP(src)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if len(out) == 0 {
		t.Fatal("empty webp output")
	}
	if w, h := webpDims(t, out); w != 64 || h != 48 {
		t.Fatalf("roundtrip dims = %dx%d want 64x48", w, h)
	}
}

func TestResizeInsideNoEnlarge(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 1000, 500))
	// fits within 2048 -> unchanged
	if got := ResizeInside(src, 2048, 2048, false); got.Bounds().Dx() != 1000 {
		t.Fatalf("no-enlarge resize changed dims to %v", got.Bounds())
	}
	// shrink to fit 256
	got := ResizeInside(src, 256, 256, false)
	if got.Bounds().Dx() != 256 || got.Bounds().Dy() != 128 {
		t.Fatalf("shrink dims = %v want 256x128", got.Bounds())
	}
}

func TestResizeCoverSquare(t *testing.T) {
	src := image.NewRGBA(image.Rect(0, 0, 1000, 500))
	got := ResizeCover(src, 256, 256)
	if got.Bounds().Dx() != 256 || got.Bounds().Dy() != 256 {
		t.Fatalf("cover dims = %v want 256x256", got.Bounds())
	}
}

func TestProcessPublicFromJPEG(t *testing.T) {
	data := sampleJPEG(t, 1200, 800)
	p, err := ProcessPublic(data, 2048, 256)
	if err != nil {
		t.Fatalf("ProcessPublic: %v", err)
	}
	if p.Width != 1200 || p.Height != 800 {
		t.Fatalf("main dims = %dx%d want 1200x800 (no enlarge)", p.Width, p.Height)
	}
	if mw, _ := webpDims(t, p.Final); mw != 1200 {
		t.Fatalf("final webp width = %d want 1200", mw)
	}
	if tw, th := webpDims(t, p.Thumb); tw != 256 || th != 171 {
		t.Fatalf("thumb dims = %dx%d want 256x171", tw, th)
	}
}

func TestProcessAvatarFromJPEG(t *testing.T) {
	data := sampleJPEG(t, 640, 480)
	out, err := ProcessAvatar(data, 256)
	if err != nil {
		t.Fatalf("ProcessAvatar: %v", err)
	}
	if w, h := webpDims(t, out); w != 256 || h != 256 {
		t.Fatalf("avatar dims = %dx%d want 256x256", w, h)
	}
}

func TestDecodeBase64StripsDataURL(t *testing.T) {
	data := sampleJPEG(t, 8, 8)
	b64 := "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(data)
	got, err := DecodeBase64(b64)
	if err != nil {
		t.Fatalf("DecodeBase64: %v", err)
	}
	if !bytes.Equal(got, data) {
		t.Fatal("decoded bytes differ from original")
	}
}

func TestDecodeRejectsDecompressionBomb(t *testing.T) {
	// 4097*4097 = 16_793_609 > maxDecodePixels (4096*4096 = 16_777_216): must be
	// rejected by the header check without allocating the full pixel buffer.
	data := sampleJPEG(t, 4097, 4097)
	if _, err := Decode(data); !errors.Is(err, ErrImageTooLarge) {
		t.Fatalf("Decode(4097x4097) err = %v, want ErrImageTooLarge", err)
	}
}

func TestDecodeAcceptsAtPixelLimit(t *testing.T) {
	// 4096*4096 sits exactly at the cap and must still decode successfully.
	data := sampleJPEG(t, 4096, 4096)
	img, err := Decode(data)
	if err != nil {
		t.Fatalf("Decode(4096x4096) err = %v, want nil", err)
	}
	if img.Bounds().Dx() != 4096 || img.Bounds().Dy() != 4096 {
		t.Fatalf("decoded dims = %v want 4096x4096", img.Bounds())
	}
}
