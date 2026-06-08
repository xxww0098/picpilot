package static

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/xxww0098/picpilot/server-go/internal/config"
)

func setup(t *testing.T) *Handler {
	t.Helper()
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "index.html"), []byte("<!doctype html><title>app</title>"), 0o644)
	_ = os.MkdirAll(filepath.Join(dir, "assets"), 0o755)
	_ = os.WriteFile(filepath.Join(dir, "assets", "app-abc.js"), []byte("console.log(1)"), 0o644)
	return New(dir, config.MimeTypes)
}

func do(h *Handler, method, target string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(method, target, nil))
	return rec
}

func TestServesIndex(t *testing.T) {
	h := setup(t)
	rec := do(h, "GET", "/")
	if rec.Code != 200 || rec.Header().Get("Content-Type") != "text/html; charset=utf-8" {
		t.Fatalf("index: code=%d ct=%s", rec.Code, rec.Header().Get("Content-Type"))
	}
	if rec.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("index cache=%s want no-cache", rec.Header().Get("Cache-Control"))
	}
}

func TestServesAssetImmutable(t *testing.T) {
	h := setup(t)
	rec := do(h, "GET", "/assets/app-abc.js")
	if rec.Code != 200 {
		t.Fatalf("asset code=%d", rec.Code)
	}
	if rec.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
		t.Fatalf("asset cache=%s", rec.Header().Get("Cache-Control"))
	}
	if rec.Header().Get("Content-Type") != "text/javascript; charset=utf-8" {
		t.Fatalf("asset ct=%s", rec.Header().Get("Content-Type"))
	}
}

func TestSPAFallback(t *testing.T) {
	h := setup(t)
	rec := do(h, "GET", "/gallery/some/client/route")
	if rec.Code != 200 || rec.Header().Get("Content-Type") != "text/html; charset=utf-8" {
		t.Fatalf("SPA fallback: code=%d ct=%s body=%s", rec.Code, rec.Header().Get("Content-Type"), rec.Body.String())
	}
}

func TestTraversalBlocked(t *testing.T) {
	h := setup(t)
	// A traversal attempt resolves harmlessly to the SPA fallback (index.html), never /etc/passwd.
	rec := do(h, "GET", "/../../../../etc/passwd")
	if rec.Code != 200 || rec.Header().Get("Content-Type") != "text/html; charset=utf-8" {
		t.Fatalf("traversal not contained: code=%d ct=%s", rec.Code, rec.Header().Get("Content-Type"))
	}
}

func TestNonGet404(t *testing.T) {
	h := setup(t)
	if rec := do(h, "POST", "/whatever"); rec.Code != http.StatusNotFound {
		t.Fatalf("POST should be 404, got %d", rec.Code)
	}
}

func TestMissingBuild404(t *testing.T) {
	h := New(filepath.Join(t.TempDir(), "does-not-exist"), config.MimeTypes)
	if rec := do(h, "GET", "/"); rec.Code != http.StatusNotFound {
		t.Fatalf("missing build should 404, got %d", rec.Code)
	}
}
