package chatgptreverse

import (
	"bytes"
	"image"
	"image/jpeg"
	"image/png"
	"regexp"
	"strconv"
	"strings"

	"github.com/xxww0098/picpilot/server-go/internal/imageproc"
)

const (
	webImageMaxRequestedEdge   = 3840
	webImageMaxRequestedPixels = 8_294_400
)

var webImageSizeRe = regexp.MustCompile(`^\s*(\d+)\s*[xX×]\s*(\d+)\s*$`)

type requestedImageSize struct {
	Width  int
	Height int
}

func resizeWebImageToRequestedSize(data []byte, body map[string]any) ([]byte, bool, error) {
	target, ok := requestedWebImageSize(body["size"])
	if !ok {
		return data, false, nil
	}
	img, err := imageproc.Decode(data)
	if err != nil {
		return data, false, nil
	}
	if img.Bounds().Dx() == target.Width && img.Bounds().Dy() == target.Height {
		return data, false, nil
	}
	out, err := encodeWebImageOutput(imageproc.ResizeCover(img, target.Width, target.Height), body["output_format"])
	if err != nil {
		return nil, false, err
	}
	return out, true, nil
}

func requestedWebImageSize(value any) (requestedImageSize, bool) {
	raw := strings.TrimSpace(stringValue(value, ""))
	match := webImageSizeRe.FindStringSubmatch(raw)
	if len(match) != 3 {
		return requestedImageSize{}, false
	}
	width, err := strconv.Atoi(match[1])
	if err != nil {
		return requestedImageSize{}, false
	}
	height, err := strconv.Atoi(match[2])
	if err != nil {
		return requestedImageSize{}, false
	}
	if width <= 0 || height <= 0 || width > webImageMaxRequestedEdge || height > webImageMaxRequestedEdge {
		return requestedImageSize{}, false
	}
	if width*height > webImageMaxRequestedPixels {
		return requestedImageSize{}, false
	}
	return requestedImageSize{Width: width, Height: height}, true
}

func encodeWebImageOutput(img image.Image, outputFormat any) ([]byte, error) {
	var buf bytes.Buffer
	switch strings.ToLower(strings.TrimSpace(stringValue(outputFormat, "png"))) {
	case "jpeg", "jpg":
		err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 95})
		return buf.Bytes(), err
	case "webp":
		return imageproc.EncodeWebP(img)
	default:
		err := png.Encode(&buf, img)
		return buf.Bytes(), err
	}
}
