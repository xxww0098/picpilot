// Package static serves the built frontend (dist/) with SPA fallback to index.html.
// Path traversal is prevented via os.Root. Used as the router's NotFound handler for
// non-API paths (single-process mode; in the Caddy deploy the frontend is served there).
package static

import (
	"io"
	"net/http"
	"os"
	"path"
	"strconv"
	"strings"
)

// Handler serves files from Dir, falling back to index.html for unknown GET routes.
type Handler struct {
	dir  string
	mime map[string]string
}

func New(dir string, mime map[string]string) *Handler {
	return &Handler{dir: dir, mime: mime}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "Not Found", http.StatusNotFound)
		return
	}
	rel := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if rel == "" {
		rel = "index.html"
	}
	cache := "no-cache"
	if strings.Contains(rel, "assets/") {
		cache = "public, max-age=31536000, immutable"
	}
	if h.serveFile(w, rel, cache) {
		return
	}
	// SPA fallback: serve index.html for client-side routes.
	if !h.serveFile(w, "index.html", "no-cache") {
		http.Error(w, "Static build not found. Run `npm run build` first.", http.StatusNotFound)
	}
}

func (h *Handler) serveFile(w http.ResponseWriter, rel, cache string) bool {
	root, err := os.OpenRoot(h.dir)
	if err != nil {
		return false
	}
	defer root.Close()
	f, err := root.Open(rel)
	if err != nil {
		return false
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		return false
	}
	ct := h.mime[strings.ToLower(path.Ext(rel))]
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", cache)
	w.Header().Set("Content-Length", strconv.FormatInt(st.Size(), 10))
	_, _ = io.Copy(w, f) // for HEAD, net/http discards the body
	return true
}
