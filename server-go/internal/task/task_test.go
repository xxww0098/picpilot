package task

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/picpilot/server-go/internal/auth"
	"github.com/xxww0098/picpilot/server-go/internal/config"
	"github.com/xxww0098/picpilot/server-go/internal/db"
	"github.com/xxww0098/picpilot/server-go/internal/queue"
	"github.com/xxww0098/picpilot/server-go/internal/settings"
)

type env struct {
	router http.Handler
	tokens map[string]string
	hits   *atomic.Int32
}

func setup(t *testing.T, upstream http.HandlerFunc) *env {
	return setupWithConfig(t, upstream, nil)
}

func setupWithConfig(t *testing.T, upstream http.HandlerFunc, configure func(*config.Config, string)) *env {
	t.Helper()
	d, err := db.Open(filepath.Join(t.TempDir(), "t.db"), 10)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	up := httptest.NewServer(upstream)
	t.Cleanup(up.Close)

	cfg := &config.Config{
		JWTSecret:                    "0123456789abcdef0123456789abcdef",
		JWTExpiresInSeconds:          7200,
		JWTSessionMaxSeconds:         604800,
		DefaultMaxBatchImages:        10,
		DefaultGalleryAutoRetryCount: 1,
		MaxConcurrent:                3,
		ProxyQueueMax:                10,
		DefaultStreamFallbackEnabled: true,
		DefaultRequestTimeoutSeconds: 900,
		PerUserPublicQuotaBytes:      1,
		APIProxyURL:                  up.URL + "/v1",
		APIProxyAPIKey:               "test-key",
	}
	if configure != nil {
		configure(cfg, up.URL)
	}
	q := queue.New(queue.Options{MaxConcurrent: 3, MaxQueue: 10})
	sp := settings.NewProvider(d, cfg)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	a := auth.New(d, cfg, q, sp, logger)
	if err := a.Seed("admin:secret123", "bob:secret123"); err != nil {
		t.Fatal(err)
	}
	m := New(d, q, sp, cfg, a, logger)
	m.Start()
	r := chi.NewRouter()
	a.Register(r)
	m.Register(r)

	e := &env{router: r, tokens: map[string]string{}}
	for _, u := range []string{"admin", "bob"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/api/auth/login", strings.NewReader(`{"username":"`+u+`","password":"secret123"}`))
		req.Header.Set("Content-Type", "application/json")
		r.ServeHTTP(rec, req)
		var b map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &b)
		tok, _ := b["token"].(string)
		if tok == "" {
			t.Fatalf("login %s failed: %s", u, rec.Body.String())
		}
		e.tokens[u] = tok
	}
	return e
}

func (e *env) req(method, path, token, body string) *httptest.ResponseRecorder {
	return e.reqWithHeaders(method, path, token, body, nil)
}

func (e *env) reqWithHeaders(method, path, token, body string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	rec := httptest.NewRecorder()
	e.router.ServeHTTP(rec, req)
	return rec
}

func decode(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	return m
}

func (e *env) poll(t *testing.T, token, id, want string, timeout time.Duration) map[string]any {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		b := decode(t, e.req("GET", "/api/tasks/"+id, token, ""))
		st, _ := b["status"].(string)
		if st == want {
			return b
		}
		if st == "succeeded" || st == "failed" || st == "canceled" {
			if st != want {
				t.Fatalf("task reached %q, wanted %q: %v", st, want, b)
			}
		}
		time.Sleep(15 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for status %q on task %s", want, id)
	return nil
}

func okUpstream(hits *atomic.Int32) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		if hits != nil {
			hits.Add(1)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":[{"url":"http://img/1.png"}]}`)
	}
}

func TestSubmitRunsAndSucceeds(t *testing.T) {
	var hits atomic.Int32
	e := setup(t, okUpstream(&hits))
	rec := e.req("POST", "/api/tasks", e.tokens["admin"], `{"endpoint":"images/generations","payload":{"prompt":"cat","n":1}}`)
	if rec.Code != 200 {
		t.Fatalf("submit status=%d body=%s", rec.Code, rec.Body.String())
	}
	id, _ := decode(t, rec)["id"].(string)
	if id == "" {
		t.Fatal("expected task id")
	}
	final := e.poll(t, e.tokens["admin"], id, "succeeded", 3*time.Second)
	result, _ := final["result"].(map[string]any)
	if result == nil {
		t.Fatalf("expected result payload, got %v", final)
	}
	if hits.Load() != 1 {
		t.Fatalf("upstream hit %d times, want 1", hits.Load())
	}
}

func TestSubmitPersistsAndUsesUpstreamModeHeader(t *testing.T) {
	var path, authHeader string
	var hits atomic.Int32
	e := setupWithConfig(t, func(w http.ResponseWriter, req *http.Request) {
		hits.Add(1)
		path = req.URL.Path
		authHeader = req.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":[{"url":"http://img/reverse.png"}]}`)
	}, func(cfg *config.Config, upstreamURL string) {
		cfg.UpstreamMode = config.UpstreamModeAPI
		cfg.APIProxyURL = "http://api-mode-should-not-be-used.invalid/v1"
		cfg.APIProxyAPIKey = "api-key"
		cfg.ReverseProxyURL = upstreamURL + "/v1"
		cfg.ReverseProxyAPIKey = "reverse-key"
	})

	rec := e.reqWithHeaders("POST", "/api/tasks", e.tokens["admin"], `{"endpoint":"images/generations","payload":{"prompt":"cat","n":1}}`, map[string]string{
		"X-PicPilot-Upstream-Mode": "reverse",
	})
	if rec.Code != 200 {
		t.Fatalf("submit status=%d body=%s", rec.Code, rec.Body.String())
	}
	start := decode(t, rec)
	if start["upstreamMode"] != config.UpstreamModeReverse {
		t.Fatalf("submitted upstreamMode=%v want reverse", start["upstreamMode"])
	}
	id, _ := start["id"].(string)
	final := e.poll(t, e.tokens["admin"], id, "succeeded", 3*time.Second)
	if final["upstreamMode"] != config.UpstreamModeReverse {
		t.Fatalf("final upstreamMode=%v want reverse", final["upstreamMode"])
	}
	if hits.Load() != 1 {
		t.Fatalf("upstream hit %d times, want 1", hits.Load())
	}
	if path != "/v1/images/generations" {
		t.Fatalf("upstream path=%q want /v1/images/generations", path)
	}
	if authHeader != "Bearer reverse-key" {
		t.Fatalf("auth=%q want reverse key", authHeader)
	}
}

func TestIdempotency(t *testing.T) {
	var hits atomic.Int32
	e := setup(t, okUpstream(&hits))
	body := `{"endpoint":"images/generations","payload":{"prompt":"x"},"idempotencyKey":"k1"}`
	id1, _ := decode(t, e.req("POST", "/api/tasks", e.tokens["admin"], body))["id"].(string)
	e.poll(t, e.tokens["admin"], id1, "succeeded", 3*time.Second)
	// Resubmitting with the same key returns the same task and does not hit upstream again.
	id2, _ := decode(t, e.req("POST", "/api/tasks", e.tokens["admin"], body))["id"].(string)
	if id1 != id2 {
		t.Fatalf("idempotency: ids differ %s != %s", id1, id2)
	}
	if hits.Load() != 1 {
		t.Fatalf("upstream hit %d times, want 1 (idempotent)", hits.Load())
	}
}

func TestOwnership404(t *testing.T) {
	e := setup(t, okUpstream(nil))
	id, _ := decode(t, e.req("POST", "/api/tasks", e.tokens["admin"], `{"endpoint":"images/generations","payload":{"p":1}}`))["id"].(string)
	if rec := e.req("GET", "/api/tasks/"+id, e.tokens["bob"], ""); rec.Code != 404 {
		t.Fatalf("other user should get 404, got %d", rec.Code)
	}
	if rec := e.req("GET", "/api/tasks/does-not-exist", e.tokens["admin"], ""); rec.Code != 404 {
		t.Fatalf("missing task should be 404, got %d", rec.Code)
	}
}

func TestCancelRunning(t *testing.T) {
	release := make(chan struct{})
	started := make(chan struct{}, 1)
	e := setup(t, func(w http.ResponseWriter, r *http.Request) {
		select {
		case started <- struct{}{}:
		default:
		}
		select {
		case <-r.Context().Done(): // canceled -> upstream connection aborts
			return
		case <-release:
			_, _ = io.WriteString(w, `{"ok":true}`)
		}
	})
	defer close(release)

	id, _ := decode(t, e.req("POST", "/api/tasks", e.tokens["admin"], `{"endpoint":"images/generations","payload":{"p":1}}`))["id"].(string)
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream never started")
	}
	if rec := e.req("POST", "/api/tasks/"+id+"/cancel", e.tokens["admin"], ""); rec.Code != 200 {
		t.Fatalf("cancel status=%d", rec.Code)
	}
	e.poll(t, e.tokens["admin"], id, "canceled", 3*time.Second)
}

func TestSSEStreamsToTerminal(t *testing.T) {
	var hits atomic.Int32
	e := setup(t, okUpstream(&hits))
	srv := httptest.NewServer(e.router)
	defer srv.Close()

	id, _ := decode(t, e.req("POST", "/api/tasks", e.tokens["admin"], `{"endpoint":"images/generations","payload":{"p":1}}`))["id"].(string)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL+"/api/tasks/"+id+"/events", nil)
	req.Header.Set("Authorization", "Bearer "+e.tokens["admin"])
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("Content-Type=%q want text/event-stream", ct)
	}
	sc := bufio.NewScanner(resp.Body)
	for sc.Scan() {
		if strings.Contains(sc.Text(), `"status":"succeeded"`) {
			return // saw the terminal event
		}
	}
	t.Fatal("did not receive a succeeded event over SSE")
}
