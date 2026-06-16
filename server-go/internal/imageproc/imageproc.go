// Package imageproc provides CGO-free image processing for the gallery and avatars:
// decode (jpeg/png/gif/webp), resize (Catmull-Rom), and encode to WebP.
//
// NOTE: encoding uses github.com/HugoSmits86/nativewebp, which emits lossless VP8L
// WebP (the only pure-Go option). Files are valid .webp and decode everywhere, but are
// larger than the TS server's lossy sharp.webp({quality:85}). Restoring lossy parity
// would require a cgo build with libvips (govips); deferred to keep CGO_ENABLED=0.
package imageproc

import (
	"bytes"
	"encoding/base64"
	"errors"
	"image"
	_ "image/gif"  // register gif decoder
	_ "image/jpeg" // register jpeg decoder
	_ "image/png"  // register png decoder
	"math"
	"regexp"

	"github.com/HugoSmits86/nativewebp"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp" // register webp decoder (decode-only)
)

var dataURLRe = regexp.MustCompile(`^data:image/[a-zA-Z0-9.+-]+;base64,`)

// maxDecodePixels caps the decoded pixel dimensions accepted by Decode. A
// hostile "decompression bomb" can encode a tiny (<50MB) PNG/WebP that expands
// into gigabytes of uncompressed pixel buffer; reading the header first and
// rejecting oversized frames bounds peak memory regardless of input bytes.
// 4096*4096 ≈ 16.7M pixels (~67MB RGBA) is well above any legitimate gallery
// upload (which is resized down to maxLong) yet small enough to neutralize bombs.
const maxDecodePixels = 4096 * 4096

// ErrImageTooLarge is returned by Decode when the source image's pixel
// dimensions exceed maxDecodePixels.
var ErrImageTooLarge = errors.New("image dimensions exceed the maximum allowed size")

// DecodeBase64 strips an optional data-URL prefix and decodes standard base64.
func DecodeBase64(s string) ([]byte, error) {
	return base64.StdEncoding.DecodeString(dataURLRe.ReplaceAllString(s, ""))
}

// Decode decodes jpeg/png/gif/webp bytes into an image. It rejects images
// whose decoded pixel dimensions exceed maxDecodePixels to prevent
// decompression-bomb memory exhaustion.
func Decode(data []byte) (image.Image, error) {
	if cfg, _, err := image.DecodeConfig(bytes.NewReader(data)); err == nil {
		if int64(cfg.Width)*int64(cfg.Height) > maxDecodePixels {
			return nil, ErrImageTooLarge
		}
	} else {
		// DecodeConfig failed (unknown format, truncated header, etc.); fall
		// through to Decode so the original error surfaces unchanged.
		_ = err
	}
	img, _, err := image.Decode(bytes.NewReader(data))
	return img, err
}

// EncodeWebP encodes an image to lossless WebP.
func EncodeWebP(img image.Image) ([]byte, error) {
	var buf bytes.Buffer
	if err := nativewebp.Encode(&buf, img, nil); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func scaleTo(src image.Image, w, h int) *image.RGBA {
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, src.Bounds(), draw.Over, nil)
	return dst
}

// ResizeInside scales src to fit within maxW x maxH preserving aspect ratio.
// When allowEnlarge is false and the image already fits, it is returned unchanged.
func ResizeInside(src image.Image, maxW, maxH int, allowEnlarge bool) image.Image {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= 0 || h <= 0 {
		return src
	}
	scale := math.Min(float64(maxW)/float64(w), float64(maxH)/float64(h))
	if scale >= 1 && !allowEnlarge {
		return src
	}
	nw := max(1, int(math.Round(float64(w)*scale)))
	nh := max(1, int(math.Round(float64(h)*scale)))
	return scaleTo(src, nw, nh)
}

// ResizeCover scales src to cover w x h, then center-crops to exactly w x h.
// (Approximation of sharp fit:cover position:attention — center crop, no saliency.)
func ResizeCover(src image.Image, w, h int) image.Image {
	b := src.Bounds()
	sw, sh := b.Dx(), b.Dy()
	if sw <= 0 || sh <= 0 {
		return scaleTo(src, w, h)
	}
	scale := math.Max(float64(w)/float64(sw), float64(h)/float64(sh))
	rw := max(w, int(math.Round(float64(sw)*scale)))
	rh := max(h, int(math.Round(float64(sh)*scale)))
	scaled := scaleTo(src, rw, rh)
	ox, oy := (rw-w)/2, (rh-h)/2
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.Copy(dst, image.Point{}, scaled, image.Rect(ox, oy, ox+w, oy+h), draw.Src, nil)
	return dst
}

// Processed holds the encoded main image, its thumbnail, and the main dimensions.
type Processed struct {
	Final  []byte
	Thumb  []byte
	Width  int
	Height int
}

// ProcessPublic decodes raw image bytes and produces a resized main WebP (fit inside
// maxLong, no enlargement) plus a thumbnail WebP (fit inside thumbLong).
func ProcessPublic(data []byte, maxLong, thumbLong int) (*Processed, error) {
	img, err := Decode(data)
	if err != nil {
		return nil, err
	}
	main := ResizeInside(img, maxLong, maxLong, false)
	final, err := EncodeWebP(main)
	if err != nil {
		return nil, err
	}
	thumb, err := EncodeWebP(ResizeInside(img, thumbLong, thumbLong, true))
	if err != nil {
		return nil, err
	}
	return &Processed{Final: final, Thumb: thumb, Width: main.Bounds().Dx(), Height: main.Bounds().Dy()}, nil
}

// ProcessAvatar decodes raw image bytes and produces a square cover-cropped WebP.
func ProcessAvatar(data []byte, size int) ([]byte, error) {
	img, err := Decode(data)
	if err != nil {
		return nil, err
	}
	return EncodeWebP(ResizeCover(img, size, size))
}
