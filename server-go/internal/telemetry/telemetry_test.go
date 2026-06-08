package telemetry

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
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
	r     http.Handler
	db    *db.DB
	token string
	uid   string
}

func setup(t *testing.T) *env {
	t.Helper()
	d, err := db.Open(filepath.Join(t.TempDir(), "t.db"), 10)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	cfg := &config.Config{
		JWTSecret: "0123456789abcdef0123456789abcdef", JWTExpiresInSeconds: 7200, JWTSessionMaxSeconds: 604800,
		DefaultMaxBatchImages: 10, MaxConcurrent: 5, ProxyQueueMax: 10,
	}
	q := queue.New(queue.Options{MaxConcurrent: 5, MaxQueue: 10})
	sp := settings.NewProvider(d, cfg)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	a := auth.New(d, cfg, q, sp, logger)
	if err := a.Seed("admin:secret123", ""); err != nil {
		t.Fatal(err)
	}
	r := chi.NewRouter()
	a.Register(r)
	New(d, a, logger, 30).Register(r)

	e := &env{r: r, db: d}
	rec := e.req("POST", "/api/auth/login", "", `{"username":"admin","password":"secret123"}`)
	var b map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &b)
	e.token, _ = b["token"].(string)
	_ = d.QueryRow("SELECT id FROM users WHERE username='admin'").Scan(&e.uid)
	return e
}

func (e *env) req(method, path, token, body string) *httptest.ResponseRecorder {
	rq := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		rq.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		rq.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	e.r.ServeHTTP(rec, rq)
	return rec
}

func TestTelemetryEventUpsertsStats(t *testing.T) {
	e := setup(t)
	// one success, one failure
	if rec := e.req("POST", "/api/telemetry/event", e.token, `{"event_type":"success","duration_ms":1200,"output_bytes":5000,"model":"gpt-image","app_mode":"gallery"}`); rec.Code != 200 {
		t.Fatalf("event 1 status=%d body=%s", rec.Code, rec.Body.String())
	}
	if rec := e.req("POST", "/api/telemetry/event", e.token, `{"event_type":"failure","duration_ms":800,"error_type":"timeout"}`); rec.Code != 200 {
		t.Fatalf("event 2 status=%d", rec.Code)
	}
	var total, success, failure, dur, outBytes int64
	err := e.db.QueryRow("SELECT total_requests, success_count, failure_count, total_duration_ms, total_output_bytes FROM user_stats WHERE user_id=?", e.uid).
		Scan(&total, &success, &failure, &dur, &outBytes)
	if err != nil {
		t.Fatalf("user_stats not found: %v", err)
	}
	if total != 2 || success != 1 || failure != 1 || dur != 2000 || outBytes != 5000 {
		t.Fatalf("stats wrong: total=%d success=%d failure=%d dur=%d out=%d", total, success, failure, dur, outBytes)
	}
	var events int
	_ = e.db.QueryRow("SELECT COUNT(*) FROM request_events WHERE user_id=?", e.uid).Scan(&events)
	if events != 2 {
		t.Fatalf("expected 2 request_events, got %d", events)
	}
	// invalid event -> 400
	if rec := e.req("POST", "/api/telemetry/event", e.token, `{}`); rec.Code != 400 {
		t.Fatalf("event without event_type should be 400, got %d", rec.Code)
	}
}

func TestNotifications(t *testing.T) {
	e := setup(t)
	now := time.Now().UnixMilli()
	for i := 0; i < 2; i++ {
		_, err := e.db.Exec(
			"INSERT INTO notifications (user_id, type, title, body, metadata, created_at) VALUES (?,?,?,?,?,?)",
			e.uid, "gallery_revoked", "公开图已被撤下", "body text", `{"image_id":"x"}`, now-int64(i))
		if err != nil {
			t.Fatal(err)
		}
	}
	rec := e.req("GET", "/api/notifications", e.token, "")
	var list struct {
		Items  []map[string]any `json:"items"`
		Total  int              `json:"total"`
		Unread int              `json:"unread"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &list)
	if list.Total != 2 || list.Unread != 2 || len(list.Items) != 2 {
		t.Fatalf("unexpected notifications: %s", rec.Body.String())
	}
	if meta, _ := list.Items[0]["metadata"].(map[string]any); meta["image_id"] != "x" {
		t.Fatalf("metadata not parsed as object: %v", list.Items[0]["metadata"])
	}
	// mark all read
	if rec := e.req("POST", "/api/notifications/read", e.token, `{}`); rec.Code != 200 {
		t.Fatalf("mark read status=%d", rec.Code)
	}
	rec = e.req("GET", "/api/notifications/unread-count", e.token, "")
	var uc struct {
		Unread int `json:"unread"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &uc)
	if uc.Unread != 0 {
		t.Fatalf("after mark-all-read unread should be 0, got %d", uc.Unread)
	}
}
