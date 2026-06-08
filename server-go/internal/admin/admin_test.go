package admin

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
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
	r        http.Handler
	db       *db.DB
	q        *queue.Queue
	adminTok string
	bobTok   string
	adminID  string
	bobID    string
}

func setup(t *testing.T) *env {
	t.Helper()
	dir := t.TempDir()
	d, err := db.Open(filepath.Join(dir, "t.db"), 10)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	cfg := &config.Config{
		JWTSecret:                    "0123456789abcdef0123456789abcdef",
		JWTExpiresInSeconds:          7200,
		JWTSessionMaxSeconds:         604800,
		DefaultMaxBatchImages:        10,
		MaxConcurrent:                5,
		ProxyQueueMax:                10,
		ProxyUserSoftLimit:           3,
		DefaultGalleryAutoRetryCount: 1,
		DefaultStreamFallbackEnabled: true,
		DefaultRequestTimeoutSeconds: 900,
		PublicDir:                    filepath.Join(dir, "public"),
		ThumbsDir:                    filepath.Join(dir, "public", "thumbs"),
		AvatarsDir:                   filepath.Join(dir, "avatars"),
	}
	for _, p := range []string{cfg.PublicDir, cfg.ThumbsDir, cfg.AvatarsDir} {
		_ = os.MkdirAll(p, 0o755)
	}
	q := queue.New(queue.Options{MaxConcurrent: 5, MaxQueue: 10, PerUserSoftLimit: 3})
	sp := settings.NewProvider(d, cfg)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	a := auth.New(d, cfg, q, sp, logger)
	if err := a.Seed("admin:secret123", "bob:secret123"); err != nil {
		t.Fatal(err)
	}
	r := chi.NewRouter()
	a.Register(r)
	New(d, cfg, q, sp, a, logger).Register(r)

	e := &env{r: r, db: d, q: q}
	e.adminTok = e.login(t, "admin")
	e.bobTok = e.login(t, "bob")
	_ = d.QueryRow("SELECT id FROM users WHERE username='admin'").Scan(&e.adminID)
	_ = d.QueryRow("SELECT id FROM users WHERE username='bob'").Scan(&e.bobID)
	return e
}

func (e *env) login(t *testing.T, user string) string {
	t.Helper()
	rec := e.req("POST", "/api/auth/login", "", `{"username":"`+user+`","password":"secret123"}`)
	var b map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &b)
	tok, _ := b["token"].(string)
	if tok == "" {
		t.Fatalf("login %s failed: %s", user, rec.Body.String())
	}
	return tok
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

func TestNonAdminForbidden(t *testing.T) {
	e := setup(t)
	if rec := e.req("GET", "/api/admin/users", e.bobTok, ""); rec.Code != 403 {
		t.Fatalf("non-admin should be 403, got %d", rec.Code)
	}
	if rec := e.req("GET", "/api/admin/users", "", ""); rec.Code != 401 {
		t.Fatalf("no token should be 401, got %d", rec.Code)
	}
}

func TestTeamSettingsRuntime(t *testing.T) {
	e := setup(t)
	rec := e.req("PATCH", "/api/admin/team-settings", e.adminTok, `{"maxConcurrent":9,"maxQueue":20}`)
	if rec.Code != 200 {
		t.Fatalf("patch status=%d body=%s", rec.Code, rec.Body.String())
	}
	if lim := e.q.Limits(); lim.MaxConcurrent != 9 || lim.MaxQueue != 20 {
		t.Fatalf("queue limits not applied at runtime: %+v", lim)
	}
	// invalid value rejected
	if rec := e.req("PATCH", "/api/admin/team-settings", e.adminTok, `{"maxConcurrent":999}`); rec.Code != 400 {
		t.Fatalf("out-of-range should be 400, got %d", rec.Code)
	}
}

func TestUserPasswordResetInvalidatesToken(t *testing.T) {
	e := setup(t)
	// bob's current token works
	if rec := e.req("GET", "/api/auth/me", e.bobTok, ""); rec.Code != 200 {
		t.Fatalf("bob me should be 200, got %d", rec.Code)
	}
	// admin resets bob's password -> token_version bumped
	if rec := e.req("PATCH", "/api/admin/users/"+e.bobID, e.adminTok, `{"password":"newpass123"}`); rec.Code != 200 {
		t.Fatalf("reset status=%d body=%s", rec.Code, rec.Body.String())
	}
	// bob's old token is now invalid
	if rec := e.req("GET", "/api/auth/me", e.bobTok, ""); rec.Code != 401 {
		t.Fatalf("old token after reset should be 401, got %d", rec.Code)
	}
}

func TestSelfGuards(t *testing.T) {
	e := setup(t)
	if rec := e.req("PATCH", "/api/admin/users/"+e.adminID, e.adminTok, `{"isAdmin":false}`); rec.Code != 400 {
		t.Fatalf("self-demote should be 400, got %d", rec.Code)
	}
	if rec := e.req("PATCH", "/api/admin/users/"+e.adminID, e.adminTok, `{"disabled":true}`); rec.Code != 400 {
		t.Fatalf("self-disable should be 400, got %d", rec.Code)
	}
	if rec := e.req("DELETE", "/api/admin/users/"+e.adminID, e.adminTok, ""); rec.Code != 400 {
		t.Fatalf("self-delete should be 400, got %d", rec.Code)
	}
}

func TestInvitesLifecycle(t *testing.T) {
	e := setup(t)
	rec := e.req("POST", "/api/admin/invites", e.adminTok, `{"count":3,"maxUses":5}`)
	if rec.Code != 200 {
		t.Fatalf("create invites status=%d", rec.Code)
	}
	var cr struct {
		Code  string   `json:"code"`
		Codes []string `json:"codes"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &cr)
	if len(cr.Codes) != 3 || cr.Code != cr.Codes[0] {
		t.Fatalf("unexpected invites response: %s", rec.Body.String())
	}
	// list shows them
	rec = e.req("GET", "/api/admin/invites", e.adminTok, "")
	var lst struct {
		Invites []map[string]any `json:"invites"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &lst)
	if len(lst.Invites) != 3 {
		t.Fatalf("expected 3 invites, got %d", len(lst.Invites))
	}
	// delete one, then 404 on re-delete
	if rec := e.req("DELETE", "/api/admin/invites/"+cr.Codes[0], e.adminTok, ""); rec.Code != 200 {
		t.Fatalf("delete invite status=%d", rec.Code)
	}
	if rec := e.req("DELETE", "/api/admin/invites/"+cr.Codes[0], e.adminTok, ""); rec.Code != 404 {
		t.Fatalf("re-delete should be 404, got %d", rec.Code)
	}
}

func TestEventsListAndExport(t *testing.T) {
	e := setup(t)
	now := time.Now().UnixMilli()
	for i := 0; i < 2; i++ {
		_, err := e.db.Exec(
			"INSERT INTO request_events (user_id, username, event_type, model, created_at) VALUES (?,?,?,?,?)",
			e.bobID, "bob", "success", "gpt-image", now-int64(i*1000))
		if err != nil {
			t.Fatal(err)
		}
	}
	rec := e.req("GET", "/api/admin/events?limit=10", e.adminTok, "")
	var lst struct {
		Events []map[string]any `json:"events"`
		Total  int              `json:"total"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &lst)
	if lst.Total != 2 || len(lst.Events) != 2 {
		t.Fatalf("expected 2 events, got %s", rec.Body.String())
	}
	// CSV export
	rec = e.req("GET", "/api/admin/events/export?since="+itoa(now-100000)+"&until="+itoa(now+100000), e.adminTok, "")
	if rec.Code != 200 {
		t.Fatalf("export status=%d body=%s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/csv") {
		t.Fatalf("export Content-Type=%q", ct)
	}
	body := rec.Body.String()
	if !strings.HasPrefix(body, "\ufeff") || !strings.Contains(body, "用户名") {
		t.Fatalf("CSV missing BOM/header: %.40q", body)
	}
	// export without dates -> 400
	if rec := e.req("GET", "/api/admin/events/export", e.adminTok, ""); rec.Code != 400 {
		t.Fatalf("export without dates should be 400, got %d", rec.Code)
	}
}

func TestGalleryFeatureAndRevoke(t *testing.T) {
	e := setup(t)
	now := time.Now().UnixMilli()
	if _, err := e.db.Exec(
		"INSERT INTO public_images (id, user_id, prompt, file_size, created_at) VALUES ('img1',?,?,1000,?)",
		e.bobID, "a nice product", now); err != nil {
		t.Fatal(err)
	}
	_, _ = e.db.Exec("UPDATE users SET public_storage_bytes=1000 WHERE id=?", e.bobID)

	// feature
	rec := e.req("POST", "/api/admin/gallery/img1/feature", e.adminTok, `{"featured":true}`)
	if rec.Code != 200 {
		t.Fatalf("feature status=%d", rec.Code)
	}
	var feat int
	_ = e.db.QueryRow("SELECT featured FROM public_images WHERE id='img1'").Scan(&feat)
	if feat != 1 {
		t.Fatal("image should be featured")
	}

	// revoke with reason -> deletes + notifies owner
	rec = e.req("POST", "/api/admin/gallery/img1/revoke", e.adminTok, `{"reason":"违规"}`)
	if rec.Code != 200 {
		t.Fatalf("revoke status=%d body=%s", rec.Code, rec.Body.String())
	}
	var cnt int
	_ = e.db.QueryRow("SELECT COUNT(*) FROM public_images WHERE id='img1'").Scan(&cnt)
	if cnt != 0 {
		t.Fatal("image should be deleted after revoke")
	}
	var notif int
	_ = e.db.QueryRow("SELECT COUNT(*) FROM notifications WHERE user_id=? AND type='gallery_revoked'", e.bobID).Scan(&notif)
	if notif != 1 {
		t.Fatalf("owner should have 1 revoke notification, got %d", notif)
	}
	var storage int64
	_ = e.db.QueryRow("SELECT public_storage_bytes FROM users WHERE id=?", e.bobID).Scan(&storage)
	if storage != 0 {
		t.Fatalf("storage should be reclaimed, got %d", storage)
	}
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }
