package gallery

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/picpilot/server-go/internal/auth"
	"github.com/xxww0098/picpilot/server-go/internal/config"
	"github.com/xxww0098/picpilot/server-go/internal/db"
	"github.com/xxww0098/picpilot/server-go/internal/queue"
	"github.com/xxww0098/picpilot/server-go/internal/settings"
)

func jpegB64(t *testing.T, w, h int) string {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{uint8(x), uint8(y), 100, 255})
		}
	}
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, &jpeg.Options{Quality: 85})
	return "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(buf.Bytes())
}

func setup(t *testing.T, quota int64) (*Module, http.Handler, string) {
	t.Helper()
	dir := t.TempDir()
	d, err := db.Open(filepath.Join(dir, "t.db"), 10)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	cfg := &config.Config{
		JWTSecret:               "0123456789abcdef0123456789abcdef",
		JWTExpiresInSeconds:     7200,
		JWTSessionMaxSeconds:    604800,
		DefaultMaxBatchImages:   10,
		MaxConcurrent:           3,
		ProxyQueueMax:           10,
		PerUserPublicQuotaBytes: quota,
		PublicDir:               filepath.Join(dir, "public"),
		ThumbsDir:               filepath.Join(dir, "public", "thumbs"),
		AvatarsDir:              filepath.Join(dir, "avatars"),
	}
	for _, p := range []string{cfg.PublicDir, cfg.ThumbsDir, cfg.AvatarsDir} {
		if err := os.MkdirAll(p, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	q := queue.New(queue.Options{MaxConcurrent: 3, MaxQueue: 10})
	sp := settings.NewProvider(d, cfg)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	a := auth.New(d, cfg, q, sp, logger)
	if err := a.Seed("admin:secret123", ""); err != nil {
		t.Fatal(err)
	}
	m := New(d, cfg, a, logger)
	r := chi.NewRouter()
	a.Register(r)
	m.Register(r)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/auth/login", strings.NewReader(`{"username":"admin","password":"secret123"}`))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(rec, req)
	var lb map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &lb)
	token, _ := lb["token"].(string)
	if token == "" {
		t.Fatalf("login failed: %s", rec.Body.String())
	}
	return m, r, token
}

func req(r http.Handler, method, path, token, body string) *httptest.ResponseRecorder {
	rq := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		rq.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		rq.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, rq)
	return rec
}

func TestPublishListServeDelete(t *testing.T) {
	m, r, token := setup(t, 500*1024*1024)

	pubBody := `{"image_base64":"` + jpegB64(t, 400, 300) + `","prompt":"a product","originals":["` + jpegB64(t, 200, 200) + `"]}`
	rec := req(r, "POST", "/api/gallery", token, pubBody)
	if rec.Code != 200 {
		t.Fatalf("publish status=%d body=%s", rec.Code, rec.Body.String())
	}
	var pub map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &pub)
	id, _ := pub["id"].(string)
	if id == "" || pub["originals"] != float64(1) {
		t.Fatalf("unexpected publish response: %s", rec.Body.String())
	}
	// main + thumb files exist
	if _, err := os.Stat(m.publicPath(id)); err != nil {
		t.Fatalf("main webp not written: %v", err)
	}
	if _, err := os.Stat(m.thumbPath(id)); err != nil {
		t.Fatalf("thumb webp not written: %v", err)
	}

	// list
	rec = req(r, "GET", "/api/gallery", token, "")
	var lst struct {
		Images []map[string]any `json:"images"`
		Total  int              `json:"total"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &lst)
	if lst.Total != 1 || len(lst.Images) != 1 {
		t.Fatalf("expected 1 image, got %s", rec.Body.String())
	}
	originals, _ := lst.Images[0]["originals"].([]any)
	if len(originals) != 1 {
		t.Fatalf("expected 1 original in list, got %v", lst.Images[0]["originals"])
	}
	origID, _ := originals[0].(map[string]any)["id"].(string)

	// serve main, thumb, original
	if rec := req(r, "GET", "/api/gallery/image/"+id, token, ""); rec.Code != 200 || rec.Header().Get("Content-Type") != "image/webp" {
		t.Fatalf("serve main: code=%d ct=%s", rec.Code, rec.Header().Get("Content-Type"))
	}
	if rec := req(r, "GET", "/api/gallery/image/"+id+"?thumb=1", token, ""); rec.Code != 200 {
		t.Fatalf("serve thumb: code=%d", rec.Code)
	}
	if rec := req(r, "GET", "/api/gallery/image/"+origID, token, ""); rec.Code != 200 {
		t.Fatalf("serve original: code=%d", rec.Code)
	}

	// delete
	rec = req(r, "DELETE", "/api/gallery/"+id, token, "")
	if rec.Code != 200 {
		t.Fatalf("delete status=%d", rec.Code)
	}
	var del map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &del)
	if del["galleryCount"] != float64(0) || del["storageBytes"] != float64(0) {
		t.Fatalf("after delete expected empty, got %s", rec.Body.String())
	}
	if _, err := os.Stat(m.publicPath(id)); !os.IsNotExist(err) {
		t.Fatal("main webp should be removed after delete")
	}
}

func TestQuotaExceeded(t *testing.T) {
	_, r, token := setup(t, 10) // 10-byte quota: any real image exceeds it
	rec := req(r, "POST", "/api/gallery", token, `{"image_base64":"`+jpegB64(t, 100, 100)+`","prompt":"x"}`)
	if rec.Code != 413 {
		t.Fatalf("expected 413 quota, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestAvatarFlow(t *testing.T) {
	m, r, token := setup(t, 500*1024*1024)
	// who am I
	rec := req(r, "GET", "/api/auth/me", token, "")
	var me map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &me)
	uid, _ := me["userId"].(string)

	if rec := req(r, "POST", "/api/auth/avatar", token, `{"image_base64":"`+jpegB64(t, 300, 300)+`"}`); rec.Code != 200 {
		t.Fatalf("avatar upload status=%d body=%s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(m.cfg.AvatarsDir + "/" + uid + ".webp"); err != nil {
		t.Fatalf("avatar file not written: %v", err)
	}
	if rec := req(r, "GET", "/api/avatars/"+uid, token, ""); rec.Code != 200 || rec.Header().Get("Content-Type") != "image/webp" {
		t.Fatalf("avatar get: code=%d ct=%s", rec.Code, rec.Header().Get("Content-Type"))
	}
	if rec := req(r, "DELETE", "/api/auth/avatar", token, ""); rec.Code != 200 {
		t.Fatalf("avatar delete status=%d", rec.Code)
	}
	if rec := req(r, "GET", "/api/avatars/"+uid, token, ""); rec.Code != 404 {
		t.Fatalf("avatar get after delete should be 404, got %d", rec.Code)
	}
}
