package task

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"

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
	t.Helper()
	d, err := db.Open(filepath.Join(t.TempDir(), "t.db"), 10)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	cfg := &config.Config{APIProxyURL: upstreamURL + "/v1", APIProxyAPIKey: "k", UpstreamMaxRetries: retries, MaxConcurrent: 1, DefaultRequestTimeoutSeconds: 900}
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
