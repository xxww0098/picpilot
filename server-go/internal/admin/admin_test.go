package admin

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"log/slog"
	"mime/multipart"
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
	"github.com/xxww0098/picpilot/server-go/internal/chatgptreverse"
	"github.com/xxww0098/picpilot/server-go/internal/config"
	"github.com/xxww0098/picpilot/server-go/internal/db"
	"github.com/xxww0098/picpilot/server-go/internal/queue"
	"github.com/xxww0098/picpilot/server-go/internal/settings"
)

type env struct {
	r        http.Handler
	db       *db.DB
	q        *queue.Queue
	cfg      *config.Config
	adminTok string
	bobTok   string
	adminID  string
	bobID    string
}

func setup(t *testing.T) *env {
	return setupWithReverseChecker(t, nil)
}

func setupWithReverseChecker(t *testing.T, checker reverseAuthChecker) *env {
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
		ReverseAccountConcurrency:    1,
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
	if checker != nil {
		New(d, cfg, q, sp, a, logger, checker).Register(r)
	} else {
		New(d, cfg, q, sp, a, logger).Register(r)
	}

	e := &env{r: r, db: d, q: q, cfg: cfg}
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

func (e *env) uploadReverseAuth(t *testing.T, token, filename, body string) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	part, err := mw.CreateFormFile("file", filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write([]byte(body)); err != nil {
		t.Fatal(err)
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	rq := httptest.NewRequest("POST", "/api/admin/reverse-auth/accounts", &buf)
	rq.Header.Set("Content-Type", mw.FormDataContentType())
	if token != "" {
		rq.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	e.r.ServeHTTP(rec, rq)
	return rec
}

func httpxJSON(t *testing.T, w http.ResponseWriter, value any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		t.Fatal(err)
	}
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

func TestTeamSettingsReverseAccountConcurrencyRuntime(t *testing.T) {
	e := setup(t)
	rec := e.req("PATCH", "/api/admin/team-settings", e.adminTok, `{"reverseAccountConcurrency":2}`)
	if rec.Code != 200 {
		t.Fatalf("patch status=%d body=%s", rec.Code, rec.Body.String())
	}
	var body struct {
		ReverseAccountConcurrency int `json:"reverseAccountConcurrency"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode settings: %v", err)
	}
	if body.ReverseAccountConcurrency != 2 {
		t.Fatalf("reverse account concurrency not returned: %+v body=%s", body, rec.Body.String())
	}
	rec = e.req("GET", "/api/admin/team-settings", e.adminTok, "")
	if rec.Code != 200 {
		t.Fatalf("get status=%d body=%s", rec.Code, rec.Body.String())
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode persisted settings: %v", err)
	}
	if body.ReverseAccountConcurrency != 2 {
		t.Fatalf("reverse account concurrency not persisted: %+v body=%s", body, rec.Body.String())
	}
	if rec := e.req("PATCH", "/api/admin/team-settings", e.adminTok, `{"reverseAccountConcurrency":0}`); rec.Code != 400 {
		t.Fatalf("out-of-range should be 400, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestTeamSettingsOutboundProxy(t *testing.T) {
	e := setup(t)
	rec := e.req("PATCH", "/api/admin/team-settings", e.adminTok, `{"outboundProxyType":"socks5h","outboundProxyUrl":"127.0.0.1:1080"}`)
	if rec.Code != 200 {
		t.Fatalf("patch status=%d body=%s", rec.Code, rec.Body.String())
	}
	var body struct {
		OutboundProxyType string `json:"outboundProxyType"`
		OutboundProxyURL  string `json:"outboundProxyUrl"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode settings: %v", err)
	}
	if body.OutboundProxyType != "socks5h" || body.OutboundProxyURL != "127.0.0.1:1080" {
		t.Fatalf("proxy settings not returned: %+v body=%s", body, rec.Body.String())
	}

	rec = e.req("GET", "/api/admin/team-settings", e.adminTok, "")
	if rec.Code != 200 {
		t.Fatalf("get status=%d body=%s", rec.Code, rec.Body.String())
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode persisted settings: %v", err)
	}
	if body.OutboundProxyType != "socks5h" || body.OutboundProxyURL != "127.0.0.1:1080" {
		t.Fatalf("proxy settings not persisted: %+v body=%s", body, rec.Body.String())
	}

	if rec := e.req("PATCH", "/api/admin/team-settings", e.adminTok, `{"outboundProxyType":"ftp","outboundProxyUrl":"127.0.0.1:21"}`); rec.Code != 400 {
		t.Fatalf("invalid proxy type should be 400, got %d body=%s", rec.Code, rec.Body.String())
	}
	if rec := e.req("PATCH", "/api/admin/team-settings", e.adminTok, `{"outboundProxyType":"socks5","outboundProxyUrl":""}`); rec.Code != 400 {
		t.Fatalf("missing proxy url should be 400, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestTeamSettingsCLIProxyManagement(t *testing.T) {
	e := setup(t)
	rec := e.req("PATCH", "/api/admin/team-settings", e.adminTok, `{"cliproxyApiUrl":"http://cliproxy:8317","cliproxyManagementKey":"mgmt-secret"}`)
	if rec.Code != 200 {
		t.Fatalf("cliproxy settings patch status=%d body=%s", rec.Code, rec.Body.String())
	}
	var body struct {
		CLIProxyAPIURL                  string `json:"cliproxyApiUrl"`
		CLIProxyManagementKeyConfigured bool   `json:"cliproxyManagementKeyConfigured"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode cliproxy settings: %v", err)
	}
	if body.CLIProxyAPIURL != "http://cliproxy:8317" || !body.CLIProxyManagementKeyConfigured {
		t.Fatalf("cliproxy settings not returned: %+v body=%s", body, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "mgmt-secret") {
		t.Fatalf("management key should not be returned in team settings: %s", rec.Body.String())
	}

	rec = e.req("GET", "/api/admin/team-settings", e.adminTok, "")
	if rec.Code != 200 {
		t.Fatalf("cliproxy settings get status=%d body=%s", rec.Code, rec.Body.String())
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode persisted cliproxy settings: %v", err)
	}
	if body.CLIProxyAPIURL != "http://cliproxy:8317" || !body.CLIProxyManagementKeyConfigured {
		t.Fatalf("cliproxy settings not persisted: %+v body=%s", body, rec.Body.String())
	}

	if rec := e.req("PATCH", "/api/admin/team-settings", e.adminTok, `{"cliproxyApiUrl":"ftp://cliproxy:21"}`); rec.Code != 400 {
		t.Fatalf("invalid cliproxy url should be 400, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestReverseAuthUploadListAndDelete(t *testing.T) {
	e := setup(t)
	payload := `{"email":"a@example.com","password":"secret123","access_token":"tok_123","refresh_token":"ref_123"}`
	rec := e.uploadReverseAuth(t, e.adminTok, "../account.json", payload)
	if rec.Code != 200 {
		t.Fatalf("upload status=%d body=%s", rec.Code, rec.Body.String())
	}
	var uploaded struct {
		Account struct {
			Name             string `json:"name"`
			Email            string `json:"email"`
			HasRefreshToken  bool   `json:"hasRefreshToken"`
			HasPasswordLogin bool   `json:"hasPasswordLogin"`
		} `json:"account"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &uploaded)
	if uploaded.Account.Name != "account.json" || uploaded.Account.Email != "a@example.com" || !uploaded.Account.HasRefreshToken || !uploaded.Account.HasPasswordLogin {
		t.Fatalf("unexpected upload response: %s", rec.Body.String())
	}
	var savedRaw string
	if err := e.db.QueryRow("SELECT raw_json FROM reverse_auth_accounts WHERE name = ?", uploaded.Account.Name).Scan(&savedRaw); err != nil {
		t.Fatalf("uploaded account missing from db: %v", err)
	}
	if !strings.Contains(savedRaw, `"access_token":"tok_123"`) {
		t.Fatalf("unexpected saved json: %s", savedRaw)
	}
	if _, err := e.db.Exec(`
UPDATE reverse_auth_accounts
SET status = 'ok',
    status_reason = '账号可用，网页图片剩余额度 7。',
    http_status = 200,
    account_type = 'plus',
    quota = 7,
    image_quota_unknown = 0,
    restore_at = '2026-06-10T00:00:00Z',
    default_model_slug = 'gpt-5-3',
    last_checked_at = 1800000000000,
    user_id = 'user-a'
WHERE name = ?`, uploaded.Account.Name); err != nil {
		t.Fatal(err)
	}

	rec = e.req("GET", "/api/admin/reverse-auth", e.adminTok, "")
	if rec.Code != 200 {
		t.Fatalf("list status=%d body=%s", rec.Code, rec.Body.String())
	}
	var listed struct {
		Configured bool   `json:"configured"`
		Storage    string `json:"storage"`
		Accounts   []struct {
			Name             string `json:"name"`
			Email            string `json:"email"`
			UserID           string `json:"userId"`
			HasPasswordLogin bool   `json:"hasPasswordLogin"`
			Status           string `json:"status"`
			StatusReason     string `json:"statusReason"`
			HTTPStatus       *int   `json:"httpStatus"`
			AccountType      string `json:"accountType"`
			Quota            *int   `json:"quota"`
			RestoreAt        string `json:"restoreAt"`
			DefaultModelSlug string `json:"defaultModelSlug"`
			LastCheckedAt    int64  `json:"lastCheckedAt"`
		} `json:"accounts"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &listed)
	if !listed.Configured || listed.Storage != "database" || len(listed.Accounts) != 1 || listed.Accounts[0].Name != uploaded.Account.Name {
		t.Fatalf("unexpected list response: %s", rec.Body.String())
	}
	account := listed.Accounts[0]
	if account.Status != "ok" || account.StatusReason == "" || account.HTTPStatus == nil || *account.HTTPStatus != 200 || account.AccountType != "plus" || account.Quota == nil || *account.Quota != 7 {
		t.Fatalf("metadata missing from list response: %+v body=%s", account, rec.Body.String())
	}
	if account.UserID != "user-a" || account.RestoreAt != "2026-06-10T00:00:00Z" || account.DefaultModelSlug != "gpt-5-3" || account.LastCheckedAt != 1800000000000 {
		t.Fatalf("identity/quota metadata missing from list response: %+v body=%s", account, rec.Body.String())
	}
	if !account.HasPasswordLogin {
		t.Fatalf("password relogin capability missing from list response: %+v body=%s", account, rec.Body.String())
	}

	rec = e.req("DELETE", "/api/admin/reverse-auth/accounts/"+uploaded.Account.Name, e.adminTok, "")
	if rec.Code != 200 {
		t.Fatalf("delete status=%d body=%s", rec.Code, rec.Body.String())
	}
	var count int
	if err := e.db.QueryRow("SELECT COUNT(*) FROM reverse_auth_accounts WHERE name = ?", uploaded.Account.Name).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("account should be deleted, count=%d", count)
	}
}

func TestReverseAuthRawExportAndUpdate(t *testing.T) {
	e := setup(t)
	first := e.uploadReverseAuth(t, e.adminTok, "first.json", `{"email":"first@example.com","access_token":"tok_1","refresh_token":"ref_1"}`)
	if first.Code != 200 {
		t.Fatalf("first upload status=%d body=%s", first.Code, first.Body.String())
	}
	second := e.uploadReverseAuth(t, e.adminTok, "second.json", `{"email":"second@example.com","access_token":"tok_2"}`)
	if second.Code != 200 {
		t.Fatalf("second upload status=%d body=%s", second.Code, second.Body.String())
	}
	if _, err := e.db.Exec(`
UPDATE reverse_auth_accounts
SET status = 'ok',
    status_reason = '账号可用，网页图片剩余额度 7。',
    http_status = 200,
    account_type = 'plus',
    quota = 7,
    image_quota_unknown = 0,
    restore_at = '2026-06-10T00:00:00Z',
    default_model_slug = 'gpt-5-3',
    last_checked_at = 1800000000000,
    last_used_at = 1800000000100,
    success_count = 3,
    fail_count = 2,
    user_id = 'user-old'
WHERE name = 'first.json'`); err != nil {
		t.Fatal(err)
	}

	rec := e.req("GET", "/api/admin/reverse-auth/accounts/first.json", e.adminTok, "")
	if rec.Code != 200 {
		t.Fatalf("raw get status=%d body=%s", rec.Code, rec.Body.String())
	}
	var rawBody struct {
		Account struct {
			Name  string `json:"name"`
			Email string `json:"email"`
		} `json:"account"`
		RawJSON string `json:"rawJson"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &rawBody); err != nil {
		t.Fatalf("decode raw get: %v", err)
	}
	if rawBody.Account.Name != "first.json" || rawBody.Account.Email != "first@example.com" || !strings.Contains(rawBody.RawJSON, `"access_token":"tok_1"`) {
		t.Fatalf("unexpected raw get response: %s", rec.Body.String())
	}

	rec = e.req("GET", "/api/admin/reverse-auth/accounts/export", e.adminTok, "")
	if rec.Code != 200 {
		t.Fatalf("export status=%d body=%s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "application/json") {
		t.Fatalf("export Content-Type=%q", ct)
	}
	if cd := rec.Header().Get("Content-Disposition"); !strings.Contains(cd, "attachment") || !strings.Contains(cd, "picpilot-reverse-auth-") {
		t.Fatalf("export Content-Disposition=%q", cd)
	}
	var exported struct {
		Accounts []struct {
			Name    string `json:"name"`
			RawJSON string `json:"rawJson"`
		} `json:"accounts"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &exported); err != nil {
		t.Fatalf("decode export: %v body=%s", err, rec.Body.String())
	}
	if len(exported.Accounts) != 2 {
		t.Fatalf("expected 2 exported accounts, got %+v body=%s", exported.Accounts, rec.Body.String())
	}
	exportedByName := map[string]string{}
	for _, account := range exported.Accounts {
		exportedByName[account.Name] = account.RawJSON
	}
	if !strings.Contains(exportedByName["first.json"], `"access_token":"tok_1"`) || !strings.Contains(exportedByName["second.json"], `"access_token":"tok_2"`) {
		t.Fatalf("export did not include raw account json: %s", rec.Body.String())
	}

	rec = e.req("PATCH", "/api/admin/reverse-auth/accounts/first.json", e.adminTok, `{"rawJson":"{\"email\":\"new@example.com\",\"access_token\":\"tok_new\"}"}`)
	if rec.Code != 200 {
		t.Fatalf("patch status=%d body=%s", rec.Code, rec.Body.String())
	}
	var updated struct {
		Account struct {
			Name            string `json:"name"`
			Email           string `json:"email"`
			HasRefreshToken bool   `json:"hasRefreshToken"`
			Status          string `json:"status"`
			Quota           *int   `json:"quota"`
			LastCheckedAt   int64  `json:"lastCheckedAt"`
			SuccessCount    int    `json:"successCount"`
			FailCount       int    `json:"failCount"`
		} `json:"account"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &updated); err != nil {
		t.Fatalf("decode patch: %v", err)
	}
	if updated.Account.Name != "first.json" || updated.Account.Email != "new@example.com" || updated.Account.HasRefreshToken {
		t.Fatalf("unexpected patch account: %+v body=%s", updated.Account, rec.Body.String())
	}
	if updated.Account.Status != "" || updated.Account.Quota != nil || updated.Account.LastCheckedAt != 0 || updated.Account.SuccessCount != 0 || updated.Account.FailCount != 0 {
		t.Fatalf("patch should reset stale check metadata: %+v body=%s", updated.Account, rec.Body.String())
	}
	var savedRaw string
	var status, userID sql.NullString
	var quota, lastCheckedAt, lastUsedAt, successCount, failCount sql.NullInt64
	if err := e.db.QueryRow(`
SELECT raw_json, status, user_id, quota, last_checked_at, last_used_at, success_count, fail_count
FROM reverse_auth_accounts
WHERE name = 'first.json'`).Scan(&savedRaw, &status, &userID, &quota, &lastCheckedAt, &lastUsedAt, &successCount, &failCount); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(savedRaw, `"access_token":"tok_new"`) || status.Valid || userID.Valid || quota.Valid || lastCheckedAt.Valid || lastUsedAt.Valid || successCount.Int64 != 0 || failCount.Int64 != 0 {
		t.Fatalf("updated db row kept stale data: raw=%s status=%+v userID=%+v quota=%+v checked=%+v used=%+v success=%+v fail=%+v", savedRaw, status, userID, quota, lastCheckedAt, lastUsedAt, successCount, failCount)
	}

	if rec := e.req("PATCH", "/api/admin/reverse-auth/accounts/first.json", e.adminTok, `{"rawJson":"{\"refresh_token\":\"ref\"}"}`); rec.Code != 400 {
		t.Fatalf("missing access_token patch should be 400, got %d body=%s", rec.Code, rec.Body.String())
	}
	if rec := e.req("PATCH", "/api/admin/reverse-auth/accounts/missing.json", e.adminTok, `{"rawJson":"{\"access_token\":\"tok\"}"}`); rec.Code != 404 {
		t.Fatalf("missing account patch should be 404, got %d body=%s", rec.Code, rec.Body.String())
	}
	if rec := e.req("GET", "/api/admin/reverse-auth/accounts/bad:name.json", e.adminTok, ""); rec.Code != 400 {
		t.Fatalf("invalid raw get name should be 400, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestReverseAuthUploadGuards(t *testing.T) {
	e := setup(t)
	if rec := e.uploadReverseAuth(t, e.bobTok, "account.json", `{"access_token":"tok"}`); rec.Code != 403 {
		t.Fatalf("non-admin upload should be 403, got %d", rec.Code)
	}
	if rec := e.uploadReverseAuth(t, e.adminTok, "account.json", `{"refresh_token":"ref"}`); rec.Code != 400 {
		t.Fatalf("missing access_token should be 400, got %d", rec.Code)
	}
	if rec := e.uploadReverseAuth(t, e.adminTok, "account.json", `{bad json`); rec.Code != 400 {
		t.Fatalf("invalid json should be 400, got %d", rec.Code)
	}
}

func TestReverseAuthImportAccessToken(t *testing.T) {
	e := setup(t)
	rec := e.req("POST", "/api/admin/reverse-auth/accounts/access-token", e.adminTok, `{"accessToken":"tok_pasted","email":"pasted@example.com","name":"pasted-token"}`)
	if rec.Code != 200 {
		t.Fatalf("import access token status=%d body=%s", rec.Code, rec.Body.String())
	}
	var imported struct {
		Account struct {
			Name            string `json:"name"`
			Email           string `json:"email"`
			HasRefreshToken bool   `json:"hasRefreshToken"`
		} `json:"account"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &imported); err != nil {
		t.Fatalf("decode import access token: %v", err)
	}
	if imported.Account.Name != "pasted-token.json" || imported.Account.Email != "pasted@example.com" || imported.Account.HasRefreshToken {
		t.Fatalf("unexpected imported token account: %+v body=%s", imported.Account, rec.Body.String())
	}
	var savedRaw string
	if err := e.db.QueryRow("SELECT raw_json FROM reverse_auth_accounts WHERE name = ?", imported.Account.Name).Scan(&savedRaw); err != nil {
		t.Fatalf("imported access token missing from db: %v", err)
	}
	if !strings.Contains(savedRaw, `"access_token": "tok_pasted"`) || !strings.Contains(savedRaw, `"email": "pasted@example.com"`) {
		t.Fatalf("unexpected saved access token json: %s", savedRaw)
	}

	if rec := e.req("POST", "/api/admin/reverse-auth/accounts/access-token", e.bobTok, `{"accessToken":"tok"}`); rec.Code != 403 {
		t.Fatalf("non-admin access token import should be 403, got %d body=%s", rec.Code, rec.Body.String())
	}
	if rec := e.req("POST", "/api/admin/reverse-auth/accounts/access-token", e.adminTok, `{"accessToken":"   "}`); rec.Code != 400 {
		t.Fatalf("empty access token import should be 400, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestReverseAuthImportFromCLIProxy(t *testing.T) {
	e := setup(t)
	downloaded := []string{}
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer mgmt-secret" || r.Header.Get("X-Management-Key") != "mgmt-secret" {
			t.Fatalf("missing management auth headers: authorization=%q x-key=%q", r.Header.Get("Authorization"), r.Header.Get("X-Management-Key"))
		}
		switch r.URL.Path {
		case "/v0/management/auth-files":
			httpxJSON(t, w, map[string]any{
				"authFiles": []map[string]any{
					{"name": "openai-plus.json", "provider": "openai", "type": "oauth"},
					{"name": "codex-team.json", "provider": "codex", "type": "oauth"},
					{"name": "claude.json", "provider": "claude", "type": "oauth"},
					{"name": "openai-key.txt", "provider": "openai", "type": "api-key"},
				},
			})
		case "/v0/management/auth-files/download":
			name := r.URL.Query().Get("name")
			downloaded = append(downloaded, name)
			switch name {
			case "openai-plus.json":
				httpxJSON(t, w, map[string]any{"email": "openai@example.com", "access_token": "tok_openai", "refresh_token": "ref_openai", "type": "codex"})
			case "codex-team.json":
				httpxJSON(t, w, map[string]any{"email": "codex@example.com", "access_token": "tok_codex", "refresh_token": "ref_codex", "type": "codex"})
			default:
				http.Error(w, "not found", http.StatusNotFound)
			}
		default:
			t.Fatalf("unexpected cliproxy path=%q", r.URL.Path)
		}
	}))
	defer remote.Close()

	rec := e.req("PATCH", "/api/admin/team-settings", e.adminTok, `{"cliproxyApiUrl":"`+remote.URL+`","cliproxyManagementKey":"mgmt-secret"}`)
	if rec.Code != 200 {
		t.Fatalf("configure cliproxy status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = e.req("GET", "/api/admin/reverse-auth/cliproxy/accounts", e.adminTok, "")
	if rec.Code != 200 {
		t.Fatalf("cliproxy account list status=%d body=%s", rec.Code, rec.Body.String())
	}
	var listed struct {
		Accounts []struct {
			Name     string `json:"name"`
			Provider string `json:"provider"`
		} `json:"accounts"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decode cliproxy account list: %v", err)
	}
	if len(listed.Accounts) != 2 || listed.Accounts[0].Name != "openai-plus.json" || listed.Accounts[1].Name != "codex-team.json" {
		t.Fatalf("unexpected cliproxy candidates: %+v body=%s", listed.Accounts, rec.Body.String())
	}

	rec = e.req("POST", "/api/admin/reverse-auth/cliproxy/import", e.adminTok, `{"names":["openai-plus.json","codex-team.json","claude.json","openai-plus.json"]}`)
	if rec.Code != 200 {
		t.Fatalf("cliproxy import status=%d body=%s", rec.Code, rec.Body.String())
	}
	var imported struct {
		Imported []struct {
			Name  string `json:"name"`
			Email string `json:"email"`
		} `json:"imported"`
		Skipped []struct {
			Name   string `json:"name"`
			Reason string `json:"reason"`
		} `json:"skipped"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &imported); err != nil {
		t.Fatalf("decode cliproxy import: %v", err)
	}
	if len(imported.Imported) != 2 || imported.Imported[0].Email != "openai@example.com" || imported.Imported[1].Email != "codex@example.com" {
		t.Fatalf("unexpected imported accounts: %+v body=%s", imported.Imported, rec.Body.String())
	}
	if len(imported.Skipped) != 1 || imported.Skipped[0].Name != "claude.json" {
		t.Fatalf("unexpected skipped accounts: %+v body=%s", imported.Skipped, rec.Body.String())
	}
	if strings.Join(downloaded, ",") != "openai-plus.json,codex-team.json" {
		t.Fatalf("unexpected downloaded auth files: %v", downloaded)
	}
	for _, want := range []string{"openai-plus.json", "codex-team.json"} {
		var raw string
		if err := e.db.QueryRow("SELECT raw_json FROM reverse_auth_accounts WHERE name = ?", want).Scan(&raw); err != nil {
			t.Fatalf("%s missing from reverse store: %v", want, err)
		}
		if !strings.Contains(raw, "access_token") {
			t.Fatalf("%s raw json missing access token: %s", want, raw)
		}
	}
}

func TestReverseAuthImportFromSub2API(t *testing.T) {
	e := setup(t)
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sub-secret" {
			t.Fatalf("missing sub2api auth header: %q", r.Header.Get("Authorization"))
		}
		if r.URL.Path != "/api/v1/admin/accounts/data" {
			t.Fatalf("unexpected sub2api path=%q", r.URL.Path)
		}
		q := r.URL.Query()
		if q.Get("platform") != "openai" || q.Get("type") != "oauth" || q.Get("include_proxies") != "false" || q.Get("search") != "plus" {
			t.Fatalf("unexpected sub2api query=%s", r.URL.RawQuery)
		}
		httpxJSON(t, w, map[string]any{
			"code": 0,
			"data": map[string]any{
				"accounts": []map[string]any{
					{
						"name":     "plus-oauth",
						"platform": "openai",
						"type":     "oauth",
						"credentials": map[string]any{
							"email":         "plus@example.com",
							"access_token":  "tok_plus",
							"refresh_token": "ref_plus",
							"id_token":      "id_plus",
							"plan_type":     "plus",
						},
					},
					{
						"name":        "openai-key",
						"platform":    "openai",
						"type":        "api_key",
						"credentials": map[string]any{"api_key": "sk-test"},
					},
					{
						"name":        "claude-oauth",
						"platform":    "claude",
						"type":        "oauth",
						"credentials": map[string]any{"access_token": "tok_claude"},
					},
					{
						"name":        "missing-token",
						"platform":    "openai",
						"type":        "oauth",
						"credentials": map[string]any{"refresh_token": "ref_only"},
					},
				},
			},
		})
	}))
	defer remote.Close()

	rec := e.req("POST", "/api/admin/reverse-auth/sub2api/import", e.adminTok, `{"baseUrl":"`+remote.URL+`","adminToken":"sub-secret","search":"plus"}`)
	if rec.Code != 200 {
		t.Fatalf("sub2api import status=%d body=%s", rec.Code, rec.Body.String())
	}
	var imported struct {
		Imported []struct {
			Name  string `json:"name"`
			Email string `json:"email"`
		} `json:"imported"`
		Skipped []struct {
			Name   string `json:"name"`
			Reason string `json:"reason"`
		} `json:"skipped"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &imported); err != nil {
		t.Fatalf("decode sub2api import: %v", err)
	}
	if len(imported.Imported) != 1 || imported.Imported[0].Name != "plus-oauth.json" || imported.Imported[0].Email != "plus@example.com" {
		t.Fatalf("unexpected imported sub2api accounts: %+v body=%s", imported.Imported, rec.Body.String())
	}
	if len(imported.Skipped) != 3 {
		t.Fatalf("unexpected skipped sub2api accounts: %+v body=%s", imported.Skipped, rec.Body.String())
	}
	var raw string
	if err := e.db.QueryRow("SELECT raw_json FROM reverse_auth_accounts WHERE name = 'plus-oauth.json'").Scan(&raw); err != nil {
		t.Fatalf("imported sub2api account missing from reverse store: %v", err)
	}
	for _, want := range []string{`"access_token":"tok_plus"`, `"refresh_token":"ref_plus"`, `"email":"plus@example.com"`} {
		if !strings.Contains(raw, want) {
			t.Fatalf("imported raw json missing %s: %s", want, raw)
		}
	}
}

func TestReverseAuthBulkDelete(t *testing.T) {
	e := setup(t)
	first := e.uploadReverseAuth(t, e.adminTok, "first.json", `{"email":"first@example.com","access_token":"tok_1"}`)
	if first.Code != 200 {
		t.Fatalf("first upload status=%d body=%s", first.Code, first.Body.String())
	}
	second := e.uploadReverseAuth(t, e.adminTok, "second.json", `{"email":"second@example.com","access_token":"tok_2"}`)
	if second.Code != 200 {
		t.Fatalf("second upload status=%d body=%s", second.Code, second.Body.String())
	}

	rec := e.req("POST", "/api/admin/reverse-auth/accounts/bulk-delete", e.adminTok, `{"names":["first.json","second.json","first.json"]}`)
	if rec.Code != 200 {
		t.Fatalf("bulk delete status=%d body=%s", rec.Code, rec.Body.String())
	}
	for _, name := range []string{"first.json", "second.json"} {
		var count int
		if err := e.db.QueryRow("SELECT COUNT(*) FROM reverse_auth_accounts WHERE name = ?", name).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Fatalf("%s should be deleted, count=%d", name, count)
		}
	}
}

type asyncReverseAuthChecker struct {
	results       []chatgptreverse.AuthCheckResult
	firstSent     chan struct{}
	releaseSecond chan struct{}
}

func (c *asyncReverseAuthChecker) CheckAuthAccounts(ctx context.Context) ([]chatgptreverse.AuthCheckResult, error) {
	return c.CheckAuthAccountsWithProgress(ctx, func(chatgptreverse.AuthCheckResult) {})
}

func (c *asyncReverseAuthChecker) CountAuthAccounts(context.Context) (int, error) {
	return len(c.results), nil
}

func (c *asyncReverseAuthChecker) CheckAuthAccountsWithProgress(ctx context.Context, onResult func(chatgptreverse.AuthCheckResult)) ([]chatgptreverse.AuthCheckResult, error) {
	onResult(c.results[0])
	close(c.firstSent)
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-c.releaseSecond:
	}
	onResult(c.results[1])
	return c.results, nil
}

func TestReverseAuthCheckJobReportsProgress(t *testing.T) {
	checker := &asyncReverseAuthChecker{
		results: []chatgptreverse.AuthCheckResult{
			{Name: "first.json", Status: chatgptreverse.AuthCheckStatusOK, CheckedAt: 1800000000001},
			{Name: "second.json", Status: chatgptreverse.AuthCheckStatusQuotaOrRateLimited, CheckedAt: 1800000000002},
		},
		firstSent:     make(chan struct{}),
		releaseSecond: make(chan struct{}),
	}
	e := setupWithReverseChecker(t, checker)
	rec := e.req("POST", "/api/admin/reverse-auth/check-jobs", e.adminTok, "")
	if rec.Code != 200 {
		t.Fatalf("start job status=%d body=%s", rec.Code, rec.Body.String())
	}
	var started struct {
		Job struct {
			ID     string `json:"id"`
			Status string `json:"status"`
			Total  int    `json:"total"`
		} `json:"job"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &started); err != nil {
		t.Fatalf("decode start: %v", err)
	}
	if started.Job.ID == "" || started.Job.Status != "running" || started.Job.Total != 2 {
		t.Fatalf("unexpected started job: %+v body=%s", started.Job, rec.Body.String())
	}
	select {
	case <-checker.firstSent:
	case <-time.After(2 * time.Second):
		t.Fatal("checker did not report first account")
	}

	rec = e.req("GET", "/api/admin/reverse-auth/check-jobs/"+started.Job.ID, e.adminTok, "")
	var mid struct {
		Job struct {
			Status    string                           `json:"status"`
			Total     int                              `json:"total"`
			Completed int                              `json:"completed"`
			Results   []chatgptreverse.AuthCheckResult `json:"results"`
		} `json:"job"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &mid); err != nil {
		t.Fatalf("decode mid: %v body=%s", err, rec.Body.String())
	}
	if mid.Job.Status != "running" || mid.Job.Total != 2 || mid.Job.Completed != 1 || len(mid.Job.Results) != 1 {
		t.Fatalf("unexpected mid job: %+v body=%s", mid.Job, rec.Body.String())
	}

	close(checker.releaseSecond)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		rec = e.req("GET", "/api/admin/reverse-auth/check-jobs/"+started.Job.ID, e.adminTok, "")
		var final struct {
			Job struct {
				Status     string                           `json:"status"`
				Total      int                              `json:"total"`
				Completed  int                              `json:"completed"`
				FinishedAt int64                            `json:"finishedAt"`
				Results    []chatgptreverse.AuthCheckResult `json:"results"`
			} `json:"job"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &final); err != nil {
			t.Fatalf("decode final: %v body=%s", err, rec.Body.String())
		}
		if final.Job.Status == "succeeded" {
			if final.Job.Total != 2 || final.Job.Completed != 2 || final.Job.FinishedAt == 0 || len(final.Job.Results) != 2 {
				t.Fatalf("unexpected final job: %+v body=%s", final.Job, rec.Body.String())
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("job did not finish")
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
