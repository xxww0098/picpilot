package chatgptreverse

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/xxww0098/picpilot/server-go/internal/config"
	"github.com/xxww0098/picpilot/server-go/internal/db"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func testStore(t *testing.T) *Store {
	t.Helper()
	d, err := db.Open(filepath.Join(t.TempDir(), "reverse.db"), 10)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	return NewStore(d)
}

func saveTestAuth(t *testing.T, store *Store, name, raw string) {
	t.Helper()
	if err := store.SaveAuthAccount(t.Context(), StoredAuthAccount{Name: name, RawJSON: raw, Size: int64(len(raw))}); err != nil {
		t.Fatal(err)
	}
}

func TestSyncAuthAccountsFromDirImportsCodexJSONAndPreservesUnchangedMetadata(t *testing.T) {
	store := testStore(t)
	dir := t.TempDir()
	existingRaw := `{"email":"old@example.com","access_token":"old-token","type":"codex"}`
	saveTestAuth(t, store, "existing.json", existingRaw)
	quota := 5
	if err := store.UpdateAuthAccountMetadata(t.Context(), "existing.json", AuthAccountMetadata{
		Status:      AuthCheckStatusOK,
		AccountType: "plus",
		Quota:       &quota,
		CheckedAt:   1800000000000,
	}); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"existing.json": existingRaw,
		"new.json":      `{"email":"new@example.com","access_token":"new-token","refresh_token":"new-refresh","type":"codex"}`,
		"xai.json":      `{"email":"xai@example.com","access_token":"xai-token","type":"xai"}`,
		"invalid.json":  `{bad json`,
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	result, err := SyncAuthAccountsFromDir(t.Context(), store, dir)
	if err != nil {
		t.Fatal(err)
	}
	if result.Imported != 1 || result.Unchanged != 1 || result.Skipped != 2 {
		t.Fatalf("unexpected sync result: %+v", result)
	}
	records, err := store.ListAuthAccounts(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]StoredAuthAccount{}
	for _, record := range records {
		byName[record.Name] = record
	}
	if _, ok := byName["new.json"]; !ok {
		t.Fatalf("new account was not imported: %+v", byName)
	}
	if _, ok := byName["xai.json"]; ok {
		t.Fatalf("xai account should be skipped: %+v", byName["xai.json"])
	}
	existing := byName["existing.json"]
	if existing.Status != AuthCheckStatusOK || existing.Quota == nil || *existing.Quota != 5 || existing.LastCheckedAt != 1800000000000 {
		t.Fatalf("unchanged account metadata should be preserved: %+v", existing)
	}
}

func TestDoJSONImagesGenerationsUsesWebConversation(t *testing.T) {
	var capturedAuth string
	var capturedPrepare map[string]any
	var capturedConversation map[string]any
	fileID := "file_00000000abcdefabcdefabcdefabcdef"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case chatRequirementsPath:
			capturedAuth = r.Header.Get("Authorization")
			writeJSON(w, http.StatusOK, map[string]any{
				"token":       "requirements-token",
				"proofofwork": map[string]any{"required": false},
				"turnstile":   map[string]any{"required": false},
			})
		case conversationPreparePath:
			if r.Header.Get("OpenAI-Sentinel-Chat-Requirements-Token") != "requirements-token" {
				t.Fatalf("requirements header=%q", r.Header.Get("OpenAI-Sentinel-Chat-Requirements-Token"))
			}
			if err := json.NewDecoder(r.Body).Decode(&capturedPrepare); err != nil {
				t.Fatalf("decode prepare: %v", err)
			}
			writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "conduit_token": "conduit-token"})
		case conversationPath:
			if r.Header.Get("X-Conduit-Token") != "conduit-token" {
				t.Fatalf("conduit header=%q", r.Header.Get("X-Conduit-Token"))
			}
			if err := json.NewDecoder(r.Body).Decode(&capturedConversation); err != nil {
				t.Fatalf("decode conversation: %v", err)
			}
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, `data: {"conversation_id":"conv_1","message":{"author":{"role":"tool"},"metadata":{"async_task_type":"image_gen"},"content":{"content_type":"multimodal_text","parts":[{"content_type":"image_asset_pointer","asset_pointer":"file-service://`+fileID+`"}]}}}`+"\n\n")
			_, _ = io.WriteString(w, "data: [DONE]\n\n")
		case filesPathPrefix + fileID + "/download":
			writeJSON(w, http.StatusOK, map[string]any{"download_url": upstreamURL(r) + "/image.png"})
		case "/image.png":
			if r.Header.Get("Authorization") != "Bearer test-token" {
				t.Fatalf("download auth=%q", r.Header.Get("Authorization"))
			}
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write([]byte("img"))
		default:
			t.Fatalf("unexpected path=%q", r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := testStore(t)
	saveTestAuth(t, store, "test.json", `{"access_token":"test-token"}`)
	svc := New(&config.Config{ChatGPTReverseBaseURL: upstream.URL}, store, testLogger())

	status, contentType, body := svc.DoJSON(t.Context(), "images/generations", `{"model":"gpt-image-2","prompt":"cat","size":"1024x1024"}`)
	if status != http.StatusOK {
		t.Fatalf("status=%d body=%s", status, body)
	}
	if !strings.Contains(contentType, "application/json") {
		t.Fatalf("contentType=%q", contentType)
	}
	if capturedAuth != "Bearer test-token" {
		t.Fatalf("auth=%q", capturedAuth)
	}
	if capturedPrepare["model"] != "gpt-5-3" {
		t.Fatalf("prepare model=%v", capturedPrepare["model"])
	}
	if capturedConversation["client_prepare_state"] != "sent" {
		t.Fatalf("conversation payload=%v", capturedConversation)
	}

	var result map[string]any
	if err := json.Unmarshal([]byte(body), &result); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	data, _ := result["data"].([]any)
	if len(data) != 1 {
		t.Fatalf("data=%v", result["data"])
	}
	first, _ := data[0].(map[string]any)
	if first["b64_json"] != "aW1n" || first["revised_prompt"] != "cat" {
		t.Fatalf("first=%v", first)
	}
}

func TestDoJSONImagesGenerationsWaitsForDownloadURLReadiness(t *testing.T) {
	oldTimeout := webImageDownloadURLReadyTimeout
	oldDelay := webImageDownloadURLRetryDelay
	webImageDownloadURLReadyTimeout = 250 * time.Millisecond
	webImageDownloadURLRetryDelay = time.Millisecond
	defer func() {
		webImageDownloadURLReadyTimeout = oldTimeout
		webImageDownloadURLRetryDelay = oldDelay
	}()

	fileID := "file_00000000abcdefabcdefabcdefabcdef"
	downloadAttempts := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case chatRequirementsPath:
			writeJSON(w, http.StatusOK, map[string]any{
				"token":       "requirements-token",
				"proofofwork": map[string]any{"required": false},
				"turnstile":   map[string]any{"required": false},
			})
		case conversationPreparePath:
			writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "conduit_token": "conduit-token"})
		case conversationPath:
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, `data: {"conversation_id":"conv_1","message":{"author":{"role":"tool"},"metadata":{"async_task_type":"image_gen"},"content":{"content_type":"multimodal_text","parts":[{"content_type":"image_asset_pointer","asset_pointer":"file-service://`+fileID+`"}]}}}`+"\n\n")
			_, _ = io.WriteString(w, "data: [DONE]\n\n")
		case filesPathPrefix + fileID + "/download":
			downloadAttempts++
			if downloadAttempts == 1 {
				writeJSON(w, http.StatusOK, map[string]any{"status": "processing"})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"status": "success", "download_url": upstreamURL(r) + "/image.png"})
		case "/image.png":
			if r.Header.Get("Authorization") != "Bearer test-token" {
				t.Fatalf("download auth=%q", r.Header.Get("Authorization"))
			}
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write([]byte("img"))
		default:
			t.Fatalf("unexpected path=%q", r.URL.Path)
		}
	}))
	defer upstream.Close()

	store := testStore(t)
	saveTestAuth(t, store, "test.json", `{"access_token":"test-token"}`)
	svc := New(&config.Config{ChatGPTReverseBaseURL: upstream.URL}, store, testLogger())

	status, _, body := svc.DoJSON(t.Context(), "images/generations", `{"model":"gpt-image-2","prompt":"cat","size":"1024x1024"}`)
	if status != http.StatusOK {
		t.Fatalf("status=%d body=%s", status, body)
	}
	if downloadAttempts < 2 {
		t.Fatalf("downloadAttempts=%d", downloadAttempts)
	}
	if !strings.Contains(body, `"b64_json":"aW1n"`) {
		t.Fatalf("body=%s", body)
	}
}

func upstreamURL(r *http.Request) string {
	return "http://" + r.Host
}

func TestNormalizeResponsesBodyAddsImageToolDefaults(t *testing.T) {
	body := normalizeResponsesBody(map[string]any{
		"input": "draw",
		"tools": []any{map[string]any{
			"type": "image_generation",
		}},
	})
	if body["model"] != defaultResponsesModel {
		t.Fatalf("model=%v", body["model"])
	}
	if body["store"] != false {
		t.Fatalf("store=%v", body["store"])
	}
	tools := body["tools"].([]any)
	tool := tools[0].(map[string]any)
	if tool["model"] != defaultImageModel || tool["output_format"] != "png" {
		t.Fatalf("tool=%v", tool)
	}
	if _, ok := body["tool_choice"].(map[string]any); !ok {
		t.Fatalf("tool_choice missing: %v", body)
	}
}

func TestCheckAuthAccountsClassifiesQuotaOrRateLimit(t *testing.T) {
	store := testStore(t)
	saveTestAuth(t, store, "ok.json", `{"email":"ok@example.com","access_token":"ok-token","refresh_token":"ref-ok"}`)
	saveTestAuth(t, store, "quota.json", `{"email":"quota@example.com","access_token":"quota-token"}`)
	saveTestAuth(t, store, "disabled.json", `{"email":"disabled@example.com","access_token":"disabled-token","disabled":true}`)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		switch r.URL.Path {
		case webConversationInitPath:
			switch auth {
			case "Bearer ok-token":
				writeJSON(w, http.StatusOK, map[string]any{
					"default_model_slug": "gpt-5-3",
					"limits_progress": []any{map[string]any{
						"feature_name": "image_gen",
						"remaining":    7,
						"reset_after":  "2026-06-10T00:00:00Z",
					}},
				})
			case "Bearer quota-token":
				writeJSON(w, http.StatusOK, map[string]any{
					"default_model_slug": "gpt-5-3",
					"limits_progress": []any{map[string]any{
						"feature_name": "image_gen",
						"remaining":    0,
						"reset_after":  "2026-06-10T00:00:00Z",
					}},
				})
			default:
				t.Fatalf("unexpected auth=%q", auth)
			}
		case webMePath:
			switch auth {
			case "Bearer ok-token":
				writeJSON(w, http.StatusOK, map[string]any{"email": "ok-remote@example.com", "id": "user-ok"})
			case "Bearer quota-token":
				writeJSON(w, http.StatusOK, map[string]any{"email": "quota-remote@example.com", "id": "user-quota"})
			default:
				t.Fatalf("unexpected auth=%q", auth)
			}
		case webAccountCheckRoutePath:
			writeJSON(w, http.StatusOK, map[string]any{
				"accounts": map[string]any{
					"default": map[string]any{
						"account": map[string]any{"plan_type": "plus"},
					},
				},
			})
		default:
			t.Fatalf("unexpected path=%q", r.URL.Path)
		}
	}))
	defer upstream.Close()

	svc := New(&config.Config{ChatGPTReverseBaseURL: upstream.URL}, store, testLogger())

	results, err := svc.CheckAuthAccounts(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	statuses := map[string]string{}
	quotas := map[string]int{}
	for _, result := range results {
		statuses[result.Name] = result.Status
		if result.Quota != nil {
			quotas[result.Name] = *result.Quota
		}
	}
	if statuses["ok.json"] != AuthCheckStatusOK {
		t.Fatalf("ok status=%q results=%v", statuses["ok.json"], results)
	}
	if quotas["ok.json"] != 7 {
		t.Fatalf("ok quota=%d results=%v", quotas["ok.json"], results)
	}
	if statuses["quota.json"] != AuthCheckStatusQuotaOrRateLimited {
		t.Fatalf("quota status=%q results=%v", statuses["quota.json"], results)
	}
	if quotas["quota.json"] != 0 {
		t.Fatalf("quota value=%d results=%v", quotas["quota.json"], results)
	}
	if statuses["disabled.json"] != AuthCheckStatusDisabled {
		t.Fatalf("disabled status=%q results=%v", statuses["disabled.json"], results)
	}

	records, err := store.ListAuthAccounts(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]StoredAuthAccount{}
	for _, record := range records {
		byName[record.Name] = record
	}
	okRecord := byName["ok.json"]
	if okRecord.Status != AuthCheckStatusOK || okRecord.Email != "ok-remote@example.com" || okRecord.UserID != "user-ok" {
		t.Fatalf("ok metadata not persisted: %+v", okRecord)
	}
	if okRecord.AccountType != "plus" || okRecord.Quota == nil || *okRecord.Quota != 7 || okRecord.RestoreAt != "2026-06-10T00:00:00Z" || okRecord.DefaultModelSlug != "gpt-5-3" {
		t.Fatalf("ok quota metadata not persisted: %+v", okRecord)
	}
	quotaRecord := byName["quota.json"]
	if quotaRecord.Status != AuthCheckStatusQuotaOrRateLimited || quotaRecord.Quota == nil || *quotaRecord.Quota != 0 {
		t.Fatalf("quota metadata not persisted: %+v", quotaRecord)
	}
	disabledRecord := byName["disabled.json"]
	if disabledRecord.Status != AuthCheckStatusDisabled || disabledRecord.LastCheckedAt == 0 {
		t.Fatalf("disabled metadata not persisted: %+v", disabledRecord)
	}
}

func TestCheckDueQuotaLimitedAccountsOnlyChecksRestoredAccounts(t *testing.T) {
	store := testStore(t)
	saveTestAuth(t, store, "due.json", `{"email":"due@example.com","access_token":"due-token"}`)
	saveTestAuth(t, store, "future.json", `{"email":"future@example.com","access_token":"future-token"}`)
	saveTestAuth(t, store, "ok.json", `{"email":"ok@example.com","access_token":"ok-token"}`)
	if err := store.UpdateAuthAccountMetadata(t.Context(), "due.json", AuthAccountMetadata{
		Status:    AuthCheckStatusQuotaOrRateLimited,
		RestoreAt: "2026-06-09T02:00:00Z",
		CheckedAt: time.Now().UnixMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpdateAuthAccountMetadata(t.Context(), "future.json", AuthAccountMetadata{
		Status:    AuthCheckStatusQuotaOrRateLimited,
		RestoreAt: "2026-06-09T04:00:00Z",
		CheckedAt: time.Now().UnixMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpdateAuthAccountMetadata(t.Context(), "ok.json", AuthAccountMetadata{
		Status:    AuthCheckStatusOK,
		CheckedAt: time.Now().UnixMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if auth != "Bearer due-token" {
			t.Fatalf("unexpected scheduled refresh auth=%q path=%q", auth, r.URL.Path)
		}
		switch r.URL.Path {
		case webConversationInitPath:
			writeJSON(w, http.StatusOK, map[string]any{
				"default_model_slug": "gpt-5-3",
				"limits_progress": []any{map[string]any{
					"feature_name": "image_gen",
					"remaining":    3,
					"reset_after":  "2026-06-10T00:00:00Z",
				}},
			})
		case webMePath:
			writeJSON(w, http.StatusOK, map[string]any{"email": "due-remote@example.com", "id": "user-due"})
		case webAccountCheckRoutePath:
			writeJSON(w, http.StatusOK, map[string]any{
				"accounts": map[string]any{
					"default": map[string]any{"account": map[string]any{"plan_type": "plus"}},
				},
			})
		default:
			t.Fatalf("unexpected path=%q", r.URL.Path)
		}
	}))
	defer upstream.Close()
	svc := New(&config.Config{ChatGPTReverseBaseURL: upstream.URL}, store, testLogger())
	now, _ := time.Parse(time.RFC3339, "2026-06-09T03:00:00Z")

	results, err := svc.CheckDueQuotaLimitedAccounts(t.Context(), now, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Name != "due.json" || results[0].Status != AuthCheckStatusOK || results[0].Quota == nil || *results[0].Quota != 3 {
		t.Fatalf("unexpected scheduled refresh results: %+v", results)
	}
	records, err := store.ListAuthAccounts(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]StoredAuthAccount{}
	for _, record := range records {
		byName[record.Name] = record
	}
	if byName["due.json"].Status != AuthCheckStatusOK || byName["due.json"].Quota == nil || *byName["due.json"].Quota != 3 {
		t.Fatalf("due account metadata not refreshed: %+v", byName["due.json"])
	}
	if byName["future.json"].Status != AuthCheckStatusQuotaOrRateLimited {
		t.Fatalf("future account should not be refreshed: %+v", byName["future.json"])
	}
	if byName["ok.json"].Status != AuthCheckStatusOK {
		t.Fatalf("ok account should not be changed: %+v", byName["ok.json"])
	}
}

func TestLoadAccountsSkipsKnownUnavailableAccounts(t *testing.T) {
	store := testStore(t)
	accounts := []struct {
		name   string
		status string
	}{
		{name: "unchecked.json", status: ""},
		{name: "ok.json", status: AuthCheckStatusOK},
		{name: "quota.json", status: AuthCheckStatusQuotaOrRateLimited},
		{name: "expired.json", status: AuthCheckStatusExpired},
		{name: "invalid.json", status: AuthCheckStatusInvalid},
		{name: "error.json", status: AuthCheckStatusError},
	}
	for _, account := range accounts {
		saveTestAuth(t, store, account.name, `{"access_token":"`+account.name+`"}`)
		if account.status != "" {
			if err := store.UpdateAuthAccountMetadata(t.Context(), account.name, AuthAccountMetadata{
				Status:    account.status,
				CheckedAt: time.Now().UnixMilli(),
			}); err != nil {
				t.Fatal(err)
			}
		}
	}
	svc := New(&config.Config{}, store, testLogger())

	loaded, err := svc.loadAccounts(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, account := range loaded {
		names[account.Name] = true
	}
	if !names["unchecked.json"] || !names["ok.json"] {
		t.Fatalf("expected unchecked and ok accounts in pool, got %+v", loaded)
	}
	for _, name := range []string{"quota.json", "expired.json", "invalid.json", "error.json"} {
		if names[name] {
			t.Fatalf("%s should be skipped from reverse pool: %+v", name, loaded)
		}
	}
}

func TestPostCodexDisablesExpiredTokenAndContinues(t *testing.T) {
	store := testStore(t)
	now := time.Now().UnixMilli()
	if err := store.SaveAuthAccount(t.Context(), StoredAuthAccount{Name: "good.json", RawJSON: `{"access_token":"good-token"}`, Size: 29, CreatedAt: now - 1000, UpdatedAt: now - 1000}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveAuthAccount(t.Context(), StoredAuthAccount{Name: "bad.json", RawJSON: `{"access_token":"bad-token"}`, Size: 28, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	attempts := []string{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != codexResponsesPath {
			t.Fatalf("unexpected path=%q", r.URL.Path)
		}
		auth := r.Header.Get("Authorization")
		attempts = append(attempts, auth)
		if auth == "Bearer bad-token" {
			http.Error(w, "expired", http.StatusUnauthorized)
			return
		}
		if auth != "Bearer good-token" {
			t.Fatalf("unexpected auth=%q", auth)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"type\":\"response.completed\"}\n\n")
	}))
	defer upstream.Close()
	svc := New(&config.Config{ChatGPTReverseBaseURL: upstream.URL}, store, testLogger())

	resp, err := svc.postCodex(t.Context(), []byte(`{"stream":true}`))
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if strings.Join(attempts, ",") != "Bearer bad-token,Bearer good-token" {
		t.Fatalf("attempts=%v", attempts)
	}
	records, err := store.ListAuthAccounts(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]StoredAuthAccount{}
	for _, record := range records {
		byName[record.Name] = record
	}
	bad := byName["bad.json"]
	if !bad.Disabled || bad.Status != AuthCheckStatusExpired || bad.FailCount == 0 {
		t.Fatalf("bad token should be disabled and marked expired: %+v", bad)
	}
}

func TestPostCodexReloginsWithPasswordAfterExpiredToken(t *testing.T) {
	store := testStore(t)
	var upstream *httptest.Server
	upstream = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/oauth/token":
			if err := r.ParseForm(); err != nil {
				t.Fatalf("parse login form: %v", err)
			}
			if r.Form.Get("grant_type") != "password" || r.Form.Get("username") != "login@example.com" || r.Form.Get("password") != "secret123" {
				t.Fatalf("unexpected login form: %v", r.Form)
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"access_token":  "fresh-token",
				"refresh_token": "fresh-refresh",
				"id_token":      "fresh-id",
			})
		case codexResponsesPath:
			auth := r.Header.Get("Authorization")
			if auth == "Bearer old-token" {
				http.Error(w, "expired", http.StatusUnauthorized)
				return
			}
			if auth != "Bearer fresh-token" {
				t.Fatalf("unexpected codex auth=%q", auth)
			}
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, "data: {\"type\":\"response.completed\"}\n\n")
		default:
			t.Fatalf("unexpected path=%q", r.URL.Path)
		}
	}))
	defer upstream.Close()
	raw := `{"email":"login@example.com","password":"secret123","access_token":"old-token","password_login_url":"` + upstream.URL + `/oauth/token"}`
	saveTestAuth(t, store, "login.json", raw)
	svc := New(&config.Config{ChatGPTReverseBaseURL: upstream.URL}, store, testLogger())

	resp, err := svc.postCodex(t.Context(), []byte(`{"stream":true}`))
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()

	record, found, err := store.GetAuthAccount(t.Context(), "login.json")
	if err != nil || !found {
		t.Fatalf("load account after relogin found=%v err=%v", found, err)
	}
	if record.Disabled || record.Status != AuthCheckStatusOK || record.SuccessCount == 0 {
		t.Fatalf("password relogin should recover account metadata: %+v", record)
	}
	var saved map[string]any
	if err := json.Unmarshal([]byte(record.RawJSON), &saved); err != nil {
		t.Fatal(err)
	}
	if saved["access_token"] != "fresh-token" || saved["refresh_token"] != "fresh-refresh" || saved["id_token"] != "fresh-id" || saved["last_password_login_at"] == "" {
		t.Fatalf("password relogin did not persist fresh tokens: %s", record.RawJSON)
	}
}

func TestCheckAuthAccountsReloginsDisabledExpiredAccountWithPassword(t *testing.T) {
	store := testStore(t)
	var upstream *httptest.Server
	upstream = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/oauth/token":
			if err := r.ParseForm(); err != nil {
				t.Fatalf("parse login form: %v", err)
			}
			if r.Form.Get("username") != "recover@example.com" || r.Form.Get("password") != "secret123" {
				t.Fatalf("unexpected login form: %v", r.Form)
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"access_token":  "recovered-token",
				"refresh_token": "recovered-refresh",
			})
		case webConversationInitPath:
			if r.Header.Get("Authorization") != "Bearer recovered-token" {
				t.Fatalf("unexpected init auth=%q", r.Header.Get("Authorization"))
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"default_model_slug": "gpt-5-3",
				"limits_progress": []any{map[string]any{
					"feature_name": "image_gen",
					"remaining":    4,
					"reset_after":  "2026-06-10T00:00:00Z",
				}},
			})
		case webMePath:
			if r.Header.Get("Authorization") != "Bearer recovered-token" {
				t.Fatalf("unexpected me auth=%q", r.Header.Get("Authorization"))
			}
			writeJSON(w, http.StatusOK, map[string]any{"email": "recover-remote@example.com", "id": "user-recovered"})
		case webAccountCheckRoutePath:
			if r.Header.Get("Authorization") != "Bearer recovered-token" {
				t.Fatalf("unexpected account auth=%q", r.Header.Get("Authorization"))
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"accounts": map[string]any{
					"default": map[string]any{"account": map[string]any{"plan_type": "plus"}},
				},
			})
		default:
			t.Fatalf("unexpected path=%q", r.URL.Path)
		}
	}))
	defer upstream.Close()
	raw := `{"email":"recover@example.com","password":"secret123","access_token":"old-token","password_login_url":"` + upstream.URL + `/oauth/token"}`
	saveTestAuth(t, store, "recover.json", raw)
	status := http.StatusUnauthorized
	if err := store.MarkAuthAccountFailure(t.Context(), "recover.json", AuthCheckStatusExpired, "expired", &status, true); err != nil {
		t.Fatal(err)
	}
	svc := New(&config.Config{ChatGPTReverseBaseURL: upstream.URL}, store, testLogger())

	results, err := svc.CheckAuthAccounts(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Status != AuthCheckStatusOK || results[0].Quota == nil || *results[0].Quota != 4 {
		t.Fatalf("expected disabled expired account to recover via password login: %+v", results)
	}
	record, found, err := store.GetAuthAccount(t.Context(), "recover.json")
	if err != nil || !found {
		t.Fatalf("load account after check found=%v err=%v", found, err)
	}
	if record.Disabled || record.Status != AuthCheckStatusOK || record.Email != "recover-remote@example.com" || record.UserID != "user-recovered" {
		t.Fatalf("recovered account metadata not persisted: %+v", record)
	}
	if !strings.Contains(record.RawJSON, `"access_token":"recovered-token"`) || !strings.Contains(record.RawJSON, `"refresh_token":"recovered-refresh"`) {
		t.Fatalf("recovered tokens not saved: %s", record.RawJSON)
	}
}

func TestWebImageGenerationDisablesExpiredTokenAndContinues(t *testing.T) {
	store := testStore(t)
	now := time.Now().UnixMilli()
	if err := store.SaveAuthAccount(t.Context(), StoredAuthAccount{Name: "good.json", RawJSON: `{"access_token":"good-token"}`, Size: 29, CreatedAt: now - 1000, UpdatedAt: now - 1000}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveAuthAccount(t.Context(), StoredAuthAccount{Name: "bad.json", RawJSON: `{"access_token":"bad-token"}`, Size: 28, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	fileID := "file_00000000abcdefabcdefabcdefabcdef"
	attempts := []string{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		switch r.URL.Path {
		case chatRequirementsPath:
			attempts = append(attempts, auth)
			if auth == "Bearer bad-token" {
				http.Error(w, "expired", http.StatusUnauthorized)
				return
			}
			if auth != "Bearer good-token" {
				t.Fatalf("unexpected auth=%q", auth)
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"token":       "requirements-token",
				"proofofwork": map[string]any{"required": false},
				"turnstile":   map[string]any{"required": false},
			})
		case conversationPreparePath:
			if auth != "Bearer good-token" {
				t.Fatalf("prepare auth=%q", auth)
			}
			writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "conduit_token": "conduit-token"})
		case conversationPath:
			if auth != "Bearer good-token" {
				t.Fatalf("conversation auth=%q", auth)
			}
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, `data: {"conversation_id":"conv_1","message":{"author":{"role":"tool"},"metadata":{"async_task_type":"image_gen"},"content":{"content_type":"multimodal_text","parts":[{"content_type":"image_asset_pointer","asset_pointer":"file-service://`+fileID+`"}]}}}`+"\n\n")
			_, _ = io.WriteString(w, "data: [DONE]\n\n")
		case filesPathPrefix + fileID + "/download":
			if auth != "Bearer good-token" {
				t.Fatalf("download url auth=%q", auth)
			}
			writeJSON(w, http.StatusOK, map[string]any{"download_url": upstreamURL(r) + "/image.png"})
		case "/image.png":
			if auth != "Bearer good-token" {
				t.Fatalf("image download auth=%q", auth)
			}
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write([]byte("img"))
		default:
			t.Fatalf("unexpected path=%q", r.URL.Path)
		}
	}))
	defer upstream.Close()
	svc := New(&config.Config{ChatGPTReverseBaseURL: upstream.URL}, store, testLogger())

	status, _, body := svc.DoJSON(t.Context(), "images/generations", `{"model":"gpt-image-2","prompt":"cat"}`)
	if status != http.StatusOK {
		t.Fatalf("status=%d body=%s", status, body)
	}
	if strings.Join(attempts, ",") != "Bearer bad-token,Bearer good-token" {
		t.Fatalf("attempts=%v", attempts)
	}
	records, err := store.ListAuthAccounts(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]StoredAuthAccount{}
	for _, record := range records {
		byName[record.Name] = record
	}
	bad := byName["bad.json"]
	if !bad.Disabled || bad.Status != AuthCheckStatusExpired || bad.FailCount == 0 {
		t.Fatalf("bad token should be disabled and marked expired: %+v", bad)
	}
	good := byName["good.json"]
	if good.SuccessCount == 0 || good.LastUsedAt == 0 {
		t.Fatalf("good token should record successful web image use: %+v", good)
	}
}
