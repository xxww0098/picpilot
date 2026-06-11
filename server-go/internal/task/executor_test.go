package task

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/xxww0098/picpilot/server-go/internal/config"
	"github.com/xxww0098/picpilot/server-go/internal/db"
	"github.com/xxww0098/picpilot/server-go/internal/queue"
	"github.com/xxww0098/picpilot/server-go/internal/settings"
)

func TestIsRetryableErr(t *testing.T) {
	cases := map[string]bool{
		"network": true, "upstream_429": true, "upstream_500": true, "upstream_502": true, "upstream_503": true,
		"upstream_400": false, "upstream_401": false, "upstream_403": false, "upstream_404": false,
		"timeout": false, "cancelled": false, "config": false, "": false,
	}
	for in, want := range cases {
		if got := isRetryableErr(in); got != want {
			t.Errorf("isRetryableErr(%q)=%v want %v", in, got, want)
		}
	}
}

func newExecutorFor(t *testing.T, upstreamURL string, retries int) *Executor {
	return newExecutorWithConfig(t, upstreamURL, retries, nil)
}

func newExecutorWithConfig(t *testing.T, upstreamURL string, retries int, configure func(*config.Config)) *Executor {
	t.Helper()
	d, err := db.Open(filepath.Join(t.TempDir(), "t.db"), 10)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	cfg := &config.Config{APIProxyURL: upstreamURL + "/v1", APIProxyAPIKey: "k", UpstreamMaxRetries: retries, MaxConcurrent: 1, DefaultRequestTimeoutSeconds: 900}
	if configure != nil {
		configure(cfg)
	}
	q := queue.New(queue.Options{MaxConcurrent: 1, MaxQueue: 10})
	sp := settings.NewProvider(d, cfg)
	return NewExecutor(NewStore(d), q, sp, cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func TestUpstreamRetriesTransientFailures(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if hits.Add(1) <= 2 { // fail twice, then succeed
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = io.WriteString(w, `{"error":"transient"}`)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":[{"url":"http://img/ok.png"}]}`)
	}))
	defer srv.Close()
	exec := newExecutorFor(t, srv.URL, 2) // 2 retries -> up to 3 attempts
	status, result, errType, _ := exec.doUpstream(context.Background(), &Task{ID: "t1", UserID: "u1", Endpoint: "images/generations", RequestJSON: `{"prompt":"x"}`})
	if status != StatusSucceeded {
		t.Fatalf("want succeeded after retries, got %s (%s)", status, errType)
	}
	if hits.Load() != 3 {
		t.Fatalf("want 3 upstream attempts (2 fail + 1 ok), got %d", hits.Load())
	}
	if result == "" {
		t.Fatal("expected result body")
	}
}

func TestUpstreamReverseModeUsesReverseEndpointAndKey(t *testing.T) {
	var path, authHeader, body string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		path = req.URL.Path
		authHeader = req.Header.Get("Authorization")
		b, _ := io.ReadAll(req.Body)
		body = string(b)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":[{"url":"http://img/reverse.png"}]}`)
	}))
	defer srv.Close()
	exec := newExecutorWithConfig(t, srv.URL, 0, func(cfg *config.Config) {
		cfg.UpstreamMode = config.UpstreamModeReverse
		cfg.APIProxyURL = "http://api-mode-should-not-be-used.invalid/v1"
		cfg.APIProxyAPIKey = "api-key"
		cfg.ReverseProxyURL = srv.URL + "/v1"
		cfg.ReverseProxyAPIKey = "reverse-key"
	})

	status, result, errType, errMsg := exec.doUpstream(context.Background(), &Task{
		ID: "reverse", UserID: "u1", Endpoint: "images/generations", RequestJSON: `{"model":"gpt-image-2","prompt":"x"}`,
	})
	if status != StatusSucceeded {
		t.Fatalf("want succeeded, got %s/%s msg=%s", status, errType, errMsg)
	}
	if path != "/v1/images/generations" {
		t.Fatalf("upstream path=%q want /v1/images/generations", path)
	}
	if authHeader != "Bearer reverse-key" {
		t.Fatalf("auth=%q want reverse key", authHeader)
	}
	if !strings.Contains(body, `"prompt":"x"`) {
		t.Fatalf("request body not forwarded: %s", body)
	}
	if !strings.Contains(result, "reverse.png") {
		t.Fatalf("result not returned from reverse upstream: %s", result)
	}
}

func TestUpstreamHonorsModelCooldownBeforeRetry(t *testing.T) {
	var hits atomic.Int32
	start := time.Now()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		if time.Since(start) < 600*time.Millisecond {
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = io.WriteString(w, `{"error":{"code":"model_cooldown","message":"All credentials are cooling down","model":"gpt-image-2","provider":"codex","reset_seconds":0.65}}`)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":[{"url":"http://img/ok.png"}]}`)
	}))
	defer srv.Close()
	exec := newExecutorFor(t, srv.URL, 1)
	status, result, errType, errMsg := exec.doUpstream(context.Background(), &Task{ID: "cooldown", UserID: "u1", Endpoint: "images/generations", RequestJSON: `{"model":"gpt-image-2","prompt":"x"}`})
	if status != StatusSucceeded {
		t.Fatalf("want succeeded after cooldown retry, got %s/%s msg=%s", status, errType, errMsg)
	}
	if result == "" {
		t.Fatal("expected result body")
	}
	if hits.Load() != 2 {
		t.Fatalf("want 2 upstream attempts, got %d", hits.Load())
	}
}

func TestUpstreamRetriesCloudflareManagedChallenge403(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if hits.Add(1) == 1 {
			w.WriteHeader(http.StatusForbidden)
			_, _ = io.WriteString(w, `{"error":{"message":"<html><span id=\"challenge-error-text\">Enable JavaScript and cookies to continue</span><script>window._cf_chl_opt={cType:'managed'}</script></html>","type":"permission_error","code":"insufficient_quota"}}`)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":[{"url":"http://img/ok.png"}]}`)
	}))
	defer srv.Close()
	exec := newExecutorFor(t, srv.URL, 1)

	status, result, errType, errMsg := exec.doUpstream(context.Background(), &Task{ID: "cf", UserID: "u1", Endpoint: "responses", RequestJSON: `{"model":"gpt-5.5","input":"x"}`})
	if status != StatusSucceeded {
		t.Fatalf("want succeeded after Cloudflare challenge retry, got %s/%s msg=%s", status, errType, errMsg)
	}
	if !strings.Contains(result, "ok.png") {
		t.Fatalf("result not returned after retry: %s", result)
	}
	if hits.Load() != 2 {
		t.Fatalf("want 2 upstream attempts, got %d", hits.Load())
	}
}

func TestUpstreamDoesNotRetryClientError(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusBadRequest) // 400 -> not retryable
		_, _ = io.WriteString(w, `{"error":"bad prompt"}`)
	}))
	defer srv.Close()
	exec := newExecutorFor(t, srv.URL, 2)
	status, _, errType, _ := exec.doUpstream(context.Background(), &Task{ID: "t2", UserID: "u1", Endpoint: "images/generations", RequestJSON: `{}`})
	if status != StatusFailed || errType != "upstream_400" {
		t.Fatalf("want failed/upstream_400, got %s/%s", status, errType)
	}
	if hits.Load() != 1 {
		t.Fatalf("client error must not retry: want 1 attempt, got %d", hits.Load())
	}
}

func TestUpstreamNoRetryWhenDisabled(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	exec := newExecutorFor(t, srv.URL, 0) // retries disabled
	status, _, _, _ := exec.doUpstream(context.Background(), &Task{ID: "t3", UserID: "u1", Endpoint: "images/generations", RequestJSON: `{}`})
	if status != StatusFailed {
		t.Fatalf("want failed, got %s", status)
	}
	if hits.Load() != 1 {
		t.Fatalf("retries disabled: want 1 attempt, got %d", hits.Load())
	}
}
