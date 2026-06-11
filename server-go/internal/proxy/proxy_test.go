package proxy

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
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
	"github.com/xxww0098/picpilot/server-go/internal/upstream"
	"github.com/xxww0098/picpilot/server-go/internal/upstreamcooldown"
)

func TestResolveTarget(t *testing.T) {
	cases := []struct{ base, path, raw, wantPath, wantQuery string }{
		{"http://up/v1", "/api-proxy/models", "", "/v1/models", ""},
		{"http://up/v1", "/api-proxy/v1/models", "", "/v1/models", ""}, // /v1 dedup
		{"http://up/v1", "/api-proxy/images/generations", "a=1", "/v1/images/generations", "a=1"},
		{"http://up", "/api-proxy/x/y", "", "/x/y", ""},
	}
	for _, c := range cases {
		u, err := (upstream.Target{URL: c.base, URLVar: "API_PROXY_URL"}).ResolveProxy(c.path, c.raw)
		if err != nil || u == nil {
			t.Fatalf("resolveTarget(%q,%q) -> %v / nil", c.base, c.path, err)
		}
		if u.Path != c.wantPath || u.RawQuery != c.wantQuery {
			t.Fatalf("resolveTarget(%q,%q) = %s?%s want %s?%s", c.base, c.path, u.Path, u.RawQuery, c.wantPath, c.wantQuery)
		}
	}
	if u, _ := (upstream.Target{URL: "", URLVar: "API_PROXY_URL"}).ResolveProxy("/api-proxy/x", ""); u != nil {
		t.Fatal("empty API_PROXY_URL should yield nil target")
	}
	if u, _ := (upstream.Target{URL: "http://up/v1", URLVar: "API_PROXY_URL"}).ResolveProxy("/api-proxy/", ""); u != nil {
		t.Fatal("empty endpoint should yield nil target")
	}
}

type upstreamRecord struct {
	path string
	auth string
	body string
}

func setup(t *testing.T, maxConc, maxQueue, maxBatch int, upstream http.HandlerFunc) (http.Handler, string, *queue.Queue) {
	return setupWithConfig(t, maxConc, maxQueue, maxBatch, upstream, nil)
}

func setupWithConfig(t *testing.T, maxConc, maxQueue, maxBatch int, upstream http.HandlerFunc, configure func(*config.Config, string)) (http.Handler, string, *queue.Queue) {
	t.Helper()
	d, err := db.Open(filepath.Join(t.TempDir(), "t.db"), maxBatch)
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
		DefaultMaxBatchImages:        maxBatch,
		DefaultGalleryAutoRetryCount: 1,
		MaxConcurrent:                maxConc,
		ProxyQueueMax:                maxQueue,
		DefaultStreamFallbackEnabled: true,
		DefaultRequestTimeoutSeconds: 900,
		PerUserPublicQuotaBytes:      1,
		APIProxyURL:                  up.URL + "/v1",
		APIProxyAPIKey:               "test-key",
	}
	if configure != nil {
		configure(cfg, up.URL)
	}
	q := queue.New(queue.Options{MaxConcurrent: maxConc, MaxQueue: maxQueue})
	sp := settings.NewProvider(d, cfg)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	a := auth.New(d, cfg, q, sp, logger)
	if err := a.Seed("admin:secret123", ""); err != nil {
		t.Fatal(err)
	}
	p := New(cfg, q, sp, a, logger)
	r := chi.NewRouter()
	a.Register(r)
	p.Register(r)

	// obtain a token
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
	return r, token, q
}

func proxyReq(r http.Handler, method, path, token, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("X-PicPilot-Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func proxyReqWithHeaders(r http.Handler, method, path, token, body string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("X-PicPilot-Authorization", "Bearer "+token)
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func apiReq(r http.Handler, method, path, token string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func TestProxyForwardsAndInjectsKey(t *testing.T) {
	rec := &upstreamRecord{}
	r, token, _ := setup(t, 5, 10, 10, func(w http.ResponseWriter, req *http.Request) {
		rec.path = req.URL.Path
		rec.auth = req.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":["m1"]}`)
	})

	resp := proxyReq(r, "GET", "/api-proxy/v1/models", token, "")
	if resp.Code != 200 {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	if rec.path != "/v1/models" {
		t.Fatalf("upstream path=%q want /v1/models (/v1 dedup)", rec.path)
	}
	if rec.auth != "Bearer test-key" {
		t.Fatalf("upstream auth=%q want injected key", rec.auth)
	}
	if !strings.Contains(resp.Body.String(), "m1") {
		t.Fatalf("body not forwarded: %s", resp.Body.String())
	}
	if cc := resp.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("Cache-Control=%q want no-store", cc)
	}
}

func TestUpstreamPreflightRejectsCloudflareChallenge(t *testing.T) {
	r, token, _ := setup(t, 5, 10, 10, func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path != "/v1/models" {
			t.Fatalf("upstream path=%q want /v1/models", req.URL.Path)
		}
		w.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(w, `{"error":{"message":"<html><span id=\"challenge-error-text\">Enable JavaScript and cookies to continue</span><script>window._cf_chl_opt={}</script></html>"}}`)
	})

	resp := apiReq(r, "GET", "/api/upstream/preflight?mode=api&model=gpt-image-2", token)
	if resp.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	if !strings.Contains(resp.Body.String(), "Cloudflare") {
		t.Fatalf("preflight response should mention Cloudflare: %s", resp.Body.String())
	}
}

func TestUpstreamPreflightRejectsRecentCloudflareLog(t *testing.T) {
	var hits atomic.Int32
	logDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(logDir, "error-v1-images-generations-cf.log"), []byte(`<html>Just a moment... cdn-cgi/challenge-platform</html>`), 0o600); err != nil {
		t.Fatal(err)
	}
	r, token, _ := setupWithConfig(t, 5, 10, 10, func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":[]}`)
	}, func(cfg *config.Config, _ string) {
		cfg.CLIProxyLogDir = logDir
	})

	resp := apiReq(r, "GET", "/api/upstream/preflight?mode=api&model=gpt-image-2", token)
	if resp.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	if hits.Load() != 0 {
		t.Fatalf("upstream should not be called when recent CF log exists, got %d hits", hits.Load())
	}
	if !strings.Contains(resp.Body.String(), "Cloudflare") {
		t.Fatalf("preflight response should mention Cloudflare: %s", resp.Body.String())
	}
}

func TestProxyUpstreamModeHeaderSelectsReverseMode(t *testing.T) {
	rec := &upstreamRecord{}
	r, token, _ := setupWithConfig(t, 5, 10, 10, func(w http.ResponseWriter, req *http.Request) {
		rec.path = req.URL.Path
		rec.auth = req.Header.Get("Authorization")
		if got := req.Header.Get("X-PicPilot-Upstream-Mode"); got != "" {
			t.Fatalf("internal upstream mode header leaked to upstream: %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":["reverse-selected"]}`)
	}, func(cfg *config.Config, upstreamURL string) {
		cfg.UpstreamMode = config.UpstreamModeAPI
		cfg.APIProxyURL = "http://api-mode-should-not-be-used.invalid/v1"
		cfg.APIProxyAPIKey = "api-key"
		cfg.ReverseProxyURL = upstreamURL + "/v1"
		cfg.ReverseProxyAPIKey = "reverse-key"
	})

	resp := proxyReqWithHeaders(r, "GET", "/api-proxy/v1/models", token, "", map[string]string{
		"X-PicPilot-Upstream-Mode": "reverse",
	})
	if resp.Code != 200 {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	if rec.path != "/v1/models" {
		t.Fatalf("upstream path=%q want /v1/models", rec.path)
	}
	if rec.auth != "Bearer reverse-key" {
		t.Fatalf("upstream auth=%q want reverse key", rec.auth)
	}
	if !strings.Contains(resp.Body.String(), "reverse-selected") {
		t.Fatalf("body not forwarded from reverse upstream: %s", resp.Body.String())
	}
}

func TestProxyUpstreamModeHeaderSelectsAPIMode(t *testing.T) {
	rec := &upstreamRecord{}
	r, token, _ := setupWithConfig(t, 5, 10, 10, func(w http.ResponseWriter, req *http.Request) {
		rec.path = req.URL.Path
		rec.auth = req.Header.Get("Authorization")
		if got := req.Header.Get("X-PicPilot-Upstream-Mode"); got != "" {
			t.Fatalf("internal upstream mode header leaked to upstream: %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":["api-selected"]}`)
	}, func(cfg *config.Config, upstreamURL string) {
		cfg.UpstreamMode = config.UpstreamModeReverse
		cfg.APIProxyURL = upstreamURL + "/v1"
		cfg.APIProxyAPIKey = "api-key"
		cfg.ReverseProxyURL = "http://reverse-mode-should-not-be-used.invalid/v1"
		cfg.ReverseProxyAPIKey = "reverse-key"
	})

	resp := proxyReqWithHeaders(r, "GET", "/api-proxy/v1/models", token, "", map[string]string{
		"X-PicPilot-Upstream-Mode": "api",
	})
	if resp.Code != 200 {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	if rec.path != "/v1/models" {
		t.Fatalf("upstream path=%q want /v1/models", rec.path)
	}
	if rec.auth != "Bearer api-key" {
		t.Fatalf("upstream auth=%q want api key", rec.auth)
	}
	if !strings.Contains(resp.Body.String(), "api-selected") {
		t.Fatalf("body not forwarded from API upstream: %s", resp.Body.String())
	}
}

func TestProxyReverseModeForwardsAndInjectsReverseKey(t *testing.T) {
	rec := &upstreamRecord{}
	r, token, _ := setupWithConfig(t, 5, 10, 10, func(w http.ResponseWriter, req *http.Request) {
		rec.path = req.URL.Path
		rec.auth = req.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":["reverse-model"]}`)
	}, func(cfg *config.Config, upstreamURL string) {
		cfg.UpstreamMode = config.UpstreamModeReverse
		cfg.APIProxyURL = "http://api-mode-should-not-be-used.invalid/v1"
		cfg.APIProxyAPIKey = "api-key"
		cfg.ReverseProxyURL = upstreamURL + "/v1"
		cfg.ReverseProxyAPIKey = "reverse-key"
	})

	resp := proxyReq(r, "GET", "/api-proxy/v1/models", token, "")
	if resp.Code != 200 {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	if rec.path != "/v1/models" {
		t.Fatalf("upstream path=%q want /v1/models", rec.path)
	}
	if rec.auth != "Bearer reverse-key" {
		t.Fatalf("upstream auth=%q want reverse key", rec.auth)
	}
	if !strings.Contains(resp.Body.String(), "reverse-model") {
		t.Fatalf("body not forwarded from reverse upstream: %s", resp.Body.String())
	}
}

func TestProxyRequiresAuth(t *testing.T) {
	r, _, _ := setup(t, 5, 10, 10, func(w http.ResponseWriter, _ *http.Request) {})
	if resp := proxyReq(r, "GET", "/api-proxy/models", "", ""); resp.Code != 401 {
		t.Fatalf("no token should be 401, got %d", resp.Code)
	}
}

func TestProxyBatchLimit429(t *testing.T) {
	called := false
	r, token, _ := setup(t, 5, 10, 2, func(w http.ResponseWriter, _ *http.Request) { called = true })
	resp := proxyReq(r, "POST", "/api-proxy/v1/images/generations", token, `{"n":5}`)
	if resp.Code != 429 {
		t.Fatalf("over-limit batch should be 429, got %d body=%s", resp.Code, resp.Body.String())
	}
	var b map[string]any
	_ = json.Unmarshal(resp.Body.Bytes(), &b)
	if b["maxBatchImages"] != float64(2) || b["requested"] != float64(5) {
		t.Fatalf("unexpected 429 body: %s", resp.Body.String())
	}
	if called {
		t.Fatal("upstream should not be called when batch limit exceeded")
	}
}

func TestProxyQueueFull429(t *testing.T) {
	r, token, q := setup(t, 1, 0, 10, func(w http.ResponseWriter, _ *http.Request) {})
	// Saturate the single slot; with maxQueue=0 the next acquire returns ErrQueueFull.
	if err := q.Acquire(context.Background(), 0, "blocker"); err != nil {
		t.Fatal(err)
	}
	if resp := proxyReq(r, "GET", "/api-proxy/models", token, ""); resp.Code != 429 {
		t.Fatalf("queue full should be 429, got %d", resp.Code)
	}
}

func TestProxyStreamsSSE(t *testing.T) {
	r, token, _ := setup(t, 5, 10, 10, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		_, _ = io.WriteString(w, ": ping\ndata: {\"step\":1}\n\n")
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
	})
	resp := proxyReq(r, "GET", "/api-proxy/v1/responses", token, "")
	if resp.Code != 200 {
		t.Fatalf("sse status=%d", resp.Code)
	}
	if !strings.Contains(resp.Body.String(), `data: {"step":1}`) {
		t.Fatalf("sse body not forwarded: %q", resp.Body.String())
	}
	if resp.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("sse response should have Cache-Control no-store")
	}
}

func discardLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func TestRetryTransportRetriesTransient(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		if hits.Add(1) <= 2 { // 503 twice, then 200
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ok")
	}))
	defer srv.Close()
	rt := &retryTransport{base: http.DefaultTransport, maxRetries: 2, logger: discardLogger()}
	req, _ := http.NewRequest(http.MethodPost, srv.URL, strings.NewReader(`{"prompt":"x"}`))
	resp, err := rt.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200 after retry, got %d", resp.StatusCode)
	}
	if hits.Load() != 3 {
		t.Fatalf("want 3 attempts (2x503 + 200), got %d", hits.Load())
	}
}

func TestRetryTransportHonorsModelCooldown(t *testing.T) {
	var hits atomic.Int32
	start := time.Now()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		hits.Add(1)
		if time.Since(start) < 600*time.Millisecond {
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = io.WriteString(w, `{"error":{"code":"model_cooldown","message":"All credentials are cooling down","model":"gpt-image-2","provider":"codex","reset_seconds":0.65}}`)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ok")
	}))
	defer srv.Close()
	rt := &retryTransport{base: http.DefaultTransport, maxRetries: 1, logger: discardLogger(), cooldowns: upstreamcooldown.NewGate()}
	req, _ := http.NewRequest(http.MethodPost, srv.URL, strings.NewReader(`{"model":"gpt-image-2","prompt":"x"}`))
	req.Header.Set("Content-Type", "application/json")
	resp, err := rt.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("want 200 after cooldown retry, got %d body=%s", resp.StatusCode, string(body))
	}
	if hits.Load() != 2 {
		t.Fatalf("want 2 attempts, got %d", hits.Load())
	}
}

func TestRetryTransportRetriesCloudflareManagedChallenge403(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		if hits.Add(1) == 1 {
			w.WriteHeader(http.StatusForbidden)
			_, _ = io.WriteString(w, `{"error":{"message":"<html><span id=\"challenge-error-text\">Enable JavaScript and cookies to continue</span><script>window._cf_chl_opt={cType:'managed'}</script></html>","type":"permission_error","code":"insufficient_quota"}}`)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ok")
	}))
	defer srv.Close()
	rt := &retryTransport{base: http.DefaultTransport, maxRetries: 1, logger: discardLogger()}
	req, _ := http.NewRequest(http.MethodPost, srv.URL, strings.NewReader(`{"model":"gpt-5.5","input":"x"}`))
	req.Header.Set("Content-Type", "application/json")
	resp, err := rt.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("want 200 after Cloudflare challenge retry, got %d body=%s", resp.StatusCode, string(body))
	}
	if hits.Load() != 2 {
		t.Fatalf("want 2 attempts, got %d", hits.Load())
	}
}

func TestRetryTransportNoRetryOnSuccessOrClientError(t *testing.T) {
	rt := &retryTransport{base: http.DefaultTransport, maxRetries: 3, logger: discardLogger()}

	var okHits atomic.Int32
	okSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		okHits.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer okSrv.Close()
	req, _ := http.NewRequest(http.MethodPost, okSrv.URL, strings.NewReader(`{}`))
	resp, err := rt.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if okHits.Load() != 1 {
		t.Fatalf("2xx must not retry (streaming-safe), got %d attempts", okHits.Load())
	}

	var badHits atomic.Int32
	badSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		badHits.Add(1)
		w.WriteHeader(http.StatusBadRequest)
	}))
	defer badSrv.Close()
	req2, _ := http.NewRequest(http.MethodPost, badSrv.URL, strings.NewReader(`{}`))
	resp2, err := rt.RoundTrip(req2)
	if err != nil {
		t.Fatal(err)
	}
	resp2.Body.Close()
	if badHits.Load() != 1 {
		t.Fatalf("4xx must not retry, got %d attempts", badHits.Load())
	}
}

func TestIsCloudflareManagedChallenge(t *testing.T) {
	cases := []struct {
		name string
		body string
		want bool
	}{
		{"cf_chl script", `<script>window._cf_chl_opt={}</script>`, true},
		{"challenge error text", `<span id="challenge-error-text">x</span>`, true},
		{"just a moment interstitial", `<title>Just a moment...</title>`, true},
		{"challenge platform asset", `src="/cdn-cgi/challenge-platform/h/g/orchestrate"`, true},
		{"enable js and cookies", `Enable JavaScript and cookies to continue`, true},
		{"attention required block", `<h1>Attention Required! | Cloudflare</h1>`, true},
		{"you have been blocked", `Sorry, you have been blocked`, true},
		{"wrapped json challenge", `{"error":{"message":"<html>Just a moment...</html>"}}`, true},
		{"openai content policy 403", `{"error":{"code":"content_policy_violation"}}`, false},
		{"plain forbidden", `forbidden`, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := isCloudflareManagedChallenge(c.body); got != c.want {
				t.Fatalf("isCloudflareManagedChallenge(%q) = %v, want %v", c.body, got, c.want)
			}
		})
	}
}

func TestRetryTransportRetriesCloudflareChallengeHeader403(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		if hits.Add(1) == 1 {
			// Direct passthrough: CF block page with no challenge body markers, only the header.
			w.Header().Set("Cf-Mitigated", "challenge")
			w.WriteHeader(http.StatusForbidden)
			_, _ = io.WriteString(w, `blocked`)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ok")
	}))
	defer srv.Close()
	rt := &retryTransport{base: http.DefaultTransport, maxRetries: 1, logger: discardLogger()}
	req, _ := http.NewRequest(http.MethodPost, srv.URL, strings.NewReader(`{"model":"gpt-5.5","input":"x"}`))
	req.Header.Set("Content-Type", "application/json")
	resp, err := rt.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200 after cf-mitigated header retry, got %d", resp.StatusCode)
	}
	if hits.Load() != 2 {
		t.Fatalf("want 2 attempts, got %d", hits.Load())
	}
}
