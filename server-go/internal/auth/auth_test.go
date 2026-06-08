package auth

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

	"github.com/xxww0098/picpilot/server-go/internal/config"
	"github.com/xxww0098/picpilot/server-go/internal/db"
	"github.com/xxww0098/picpilot/server-go/internal/queue"
	"github.com/xxww0098/picpilot/server-go/internal/settings"
)

func newTestAuth(t *testing.T) (*Auth, http.Handler) {
	t.Helper()
	d, err := db.Open(filepath.Join(t.TempDir(), "t.db"), 10)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	cfg := &config.Config{
		JWTSecret:                    "0123456789abcdef0123456789abcdef",
		JWTExpiresInSeconds:          7200,
		JWTSessionMaxSeconds:         604800,
		DefaultMaxBatchImages:        10,
		DefaultGalleryAutoRetryCount: 1,
		MaxConcurrent:                5,
		ProxyQueueMax:                10,
		ProxyUserSoftLimit:           3,
		DefaultStreamFallbackEnabled: true,
		DefaultRequestTimeoutSeconds: 900,
		PerUserPublicQuotaBytes:      500 * 1024 * 1024,
	}
	q := queue.New(queue.Options{MaxConcurrent: 5, MaxQueue: 10, PerUserSoftLimit: 3})
	sp := settings.NewProvider(d, cfg)
	a := New(d, cfg, q, sp, slog.New(slog.NewTextHandler(io.Discard, nil)))
	r := chi.NewRouter()
	a.Register(r)
	return a, r
}

func do(router http.Handler, method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Real-IP", "203.0.113.9")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func decodeBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("decode body %q: %v", rec.Body.String(), err)
	}
	return m
}

func TestPasswordHashRoundtrip(t *testing.T) {
	h, err := hashPassword("secret123")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(h, "$2") {
		t.Fatalf("expected a bcrypt hash, got %q", h)
	}
	if !verifyPassword(h, "secret123") {
		t.Fatal("verify should succeed for correct password")
	}
	if verifyPassword(h, "wrong") {
		t.Fatal("verify should fail for wrong password")
	}
}

func TestJWTSignParseAndTamper(t *testing.T) {
	secret := "0123456789abcdef0123456789abcdef"
	tok, err := signToken(secret, 3600, "u1", "alice", true, 2, 0)
	if err != nil {
		t.Fatal(err)
	}
	c, err := parseToken(secret, tok)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if c.Subject != "u1" || c.Username != "alice" || !c.IsAdmin || c.TV != 2 {
		t.Fatalf("unexpected claims %+v", c)
	}
	if _, err := parseToken("wrong-secret-wrong-secret-wrong!", tok); err == nil {
		t.Fatal("parse should fail with wrong secret")
	}
	if _, err := parseToken(secret, tok+"x"); err == nil {
		t.Fatal("parse should fail for tampered token")
	}
}

func TestLoginMeRefreshFlow(t *testing.T) {
	a, r := newTestAuth(t)
	if err := a.Seed("admin:secret123", ""); err != nil {
		t.Fatal(err)
	}

	// login
	rec := do(r, "POST", "/api/auth/login", `{"username":"admin","password":"secret123"}`, nil)
	if rec.Code != 200 {
		t.Fatalf("login status=%d body=%s", rec.Code, rec.Body.String())
	}
	body := decodeBody(t, rec)
	token, _ := body["token"].(string)
	if token == "" {
		t.Fatal("expected token in login response")
	}
	if body["isAdmin"] != true {
		t.Fatalf("expected isAdmin true, got %v", body["isAdmin"])
	}
	if _, ok := body["maxConcurrent"]; !ok {
		t.Fatal("expected maxConcurrent in profile")
	}

	// wrong password
	if rec := do(r, "POST", "/api/auth/login", `{"username":"admin","password":"nope"}`, nil); rec.Code != 401 {
		t.Fatalf("wrong password should be 401, got %d", rec.Code)
	}

	// me with token
	rec = do(r, "GET", "/api/auth/me", "", map[string]string{"Authorization": "Bearer " + token})
	if rec.Code != 200 {
		t.Fatalf("me status=%d body=%s", rec.Code, rec.Body.String())
	}
	if decodeBody(t, rec)["username"] != "admin" {
		t.Fatal("me should return admin profile")
	}

	// me without token
	if rec := do(r, "GET", "/api/auth/me", "", nil); rec.Code != 401 {
		t.Fatalf("me without token should be 401, got %d", rec.Code)
	}

	// refresh
	rec = do(r, "POST", "/api/auth/refresh", "", map[string]string{"Authorization": "Bearer " + token})
	if rec.Code != 200 {
		t.Fatalf("refresh status=%d body=%s", rec.Code, rec.Body.String())
	}
	if decodeBody(t, rec)["token"] == "" {
		t.Fatal("refresh should return a new token")
	}
}

func TestRegisterWithInvite(t *testing.T) {
	a, r := newTestAuth(t)
	now := time.Now().UnixMilli()
	if _, err := a.db.Exec(
		"INSERT INTO invite_codes (code, created_by, created_at, max_uses, used_count) VALUES ('INV1','seed',?,1,0)", now,
	); err != nil {
		t.Fatal(err)
	}

	rec := do(r, "POST", "/api/auth/register", `{"invite":"INV1","username":"newuser","password":"secret123"}`, nil)
	if rec.Code != 200 {
		t.Fatalf("register status=%d body=%s", rec.Code, rec.Body.String())
	}
	if decodeBody(t, rec)["token"] == "" {
		t.Fatal("register should return a token")
	}

	// invite exhausted (max_uses=1)
	if rec := do(r, "POST", "/api/auth/register", `{"invite":"INV1","username":"another","password":"secret123"}`, nil); rec.Code != 400 {
		t.Fatalf("exhausted invite should be 400, got %d body=%s", rec.Code, rec.Body.String())
	}

	// the new user can log in
	if rec := do(r, "POST", "/api/auth/login", `{"username":"newuser","password":"secret123"}`, nil); rec.Code != 200 {
		t.Fatalf("new user login should succeed, got %d", rec.Code)
	}

	// duplicate username (case-insensitive) rejected via a fresh invite
	if _, err := a.db.Exec("INSERT INTO invite_codes (code, created_by, created_at, max_uses, used_count) VALUES ('INV2','seed',?,1,0)", now); err != nil {
		t.Fatal(err)
	}
	if rec := do(r, "POST", "/api/auth/register", `{"invite":"INV2","username":"NEWUSER","password":"secret123"}`, nil); rec.Code != 409 {
		t.Fatalf("duplicate username should be 409, got %d", rec.Code)
	}
}

func TestLoginRateLimit(t *testing.T) {
	a, r := newTestAuth(t)
	_ = a.Seed("admin:secret123", "")
	// 5 attempts allowed (bad creds -> 401), 6th from same IP -> 429
	for i := 0; i < 5; i++ {
		if rec := do(r, "POST", "/api/auth/login", `{"username":"admin","password":"bad"}`, nil); rec.Code != 401 {
			t.Fatalf("attempt %d expected 401, got %d", i+1, rec.Code)
		}
	}
	if rec := do(r, "POST", "/api/auth/login", `{"username":"admin","password":"bad"}`, nil); rec.Code != 429 {
		t.Fatalf("6th attempt expected 429, got %d", rec.Code)
	}
}
