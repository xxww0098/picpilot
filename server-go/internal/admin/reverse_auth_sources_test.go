package admin

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestReverseAuthImportSourcesSaveAndHideManagementKeys(t *testing.T) {
	e := setup(t)

	body := `{"sources":[
		{"id":"cpa-main","type":"cpa","name":"Main CPA","baseUrl":"https://cpa.example.com","managementKey":"cpa-secret"},
		{"id":"sub-main","type":"sub2api","name":"Main Sub2API","baseUrl":"https://sub.example.com","managementKey":"sub-secret"}
	]}`
	rec := e.req("PUT", "/api/admin/reverse-auth/sources", e.adminTok, body)
	if rec.Code != 200 {
		t.Fatalf("save sources status=%d body=%s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "cpa-secret") || strings.Contains(rec.Body.String(), "sub-secret") {
		t.Fatalf("source secrets leaked in response: %s", rec.Body.String())
	}

	rec = e.req("GET", "/api/admin/reverse-auth/sources", e.adminTok, "")
	if rec.Code != 200 {
		t.Fatalf("get sources status=%d body=%s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "cpa-secret") || strings.Contains(rec.Body.String(), "sub-secret") {
		t.Fatalf("source secrets leaked in get response: %s", rec.Body.String())
	}
	var got struct {
		Sources []struct {
			ID                      string `json:"id"`
			Type                    string `json:"type"`
			Name                    string `json:"name"`
			BaseURL                 string `json:"baseUrl"`
			ManagementKeyConfigured bool   `json:"managementKeyConfigured"`
		} `json:"sources"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode sources: %v", err)
	}
	if len(got.Sources) != 2 {
		t.Fatalf("sources len=%d body=%s", len(got.Sources), rec.Body.String())
	}
	if got.Sources[0].ID != "cpa-main" || got.Sources[0].Type != "cpa" || got.Sources[0].BaseURL != "https://cpa.example.com" || !got.Sources[0].ManagementKeyConfigured {
		t.Fatalf("unexpected first source: %+v", got.Sources[0])
	}
	if got.Sources[1].ID != "sub-main" || got.Sources[1].Type != "sub2api" || got.Sources[1].BaseURL != "https://sub.example.com" || !got.Sources[1].ManagementKeyConfigured {
		t.Fatalf("unexpected second source: %+v", got.Sources[1])
	}
}

func TestReverseAuthCLIProxyImportCanUseSavedSource(t *testing.T) {
	e := setup(t)
	downloaded := []string{}
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer cpa-secret" || r.Header.Get("X-Management-Key") != "cpa-secret" {
			t.Fatalf("missing cpa management auth headers: authorization=%q x-key=%q", r.Header.Get("Authorization"), r.Header.Get("X-Management-Key"))
		}
		switch r.URL.Path {
		case "/v0/management/auth-files":
			httpxJSON(t, w, map[string]any{
				"authFiles": []map[string]any{
					{"name": "openai-plus.json", "provider": "openai", "type": "oauth"},
				},
			})
		case "/v0/management/auth-files/download":
			name := r.URL.Query().Get("name")
			downloaded = append(downloaded, name)
			httpxJSON(t, w, map[string]any{"email": "plus@example.com", "access_token": "tok_plus", "refresh_token": "ref_plus"})
		default:
			t.Fatalf("unexpected cliproxy path=%q", r.URL.Path)
		}
	}))
	defer remote.Close()

	rec := e.req("PUT", "/api/admin/reverse-auth/sources", e.adminTok, `{"sources":[{"id":"cpa-main","type":"cpa","name":"Main CPA","baseUrl":"`+remote.URL+`","managementKey":"cpa-secret"}]}`)
	if rec.Code != 200 {
		t.Fatalf("save cpa source status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = e.req("GET", "/api/admin/reverse-auth/cliproxy/accounts?sourceId=cpa-main", e.adminTok, "")
	if rec.Code != 200 {
		t.Fatalf("cliproxy list by source status=%d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "openai-plus.json") {
		t.Fatalf("source list missing auth file: %s", rec.Body.String())
	}

	rec = e.req("POST", "/api/admin/reverse-auth/cliproxy/import", e.adminTok, `{"sourceId":"cpa-main","names":["openai-plus.json"]}`)
	if rec.Code != 200 {
		t.Fatalf("cliproxy import by source status=%d body=%s", rec.Code, rec.Body.String())
	}
	if strings.Join(downloaded, ",") != "openai-plus.json" {
		t.Fatalf("unexpected downloads: %v", downloaded)
	}
	var raw string
	if err := e.db.QueryRow("SELECT raw_json FROM reverse_auth_accounts WHERE name = 'openai-plus.json'").Scan(&raw); err != nil {
		t.Fatalf("imported cpa account missing from reverse store: %v", err)
	}
	if !strings.Contains(raw, "tok_plus") {
		t.Fatalf("imported raw json missing token: %s", raw)
	}
}

func TestReverseAuthCLIProxyImportOverwritesExistingSourceAccount(t *testing.T) {
	e := setup(t)
	rec := e.uploadReverseAuth(t, e.adminTok, "openai-plus.json", `{"email":"old@example.com","access_token":"tok_old","refresh_token":"ref_old"}`)
	if rec.Code != 200 {
		t.Fatalf("seed upload status=%d body=%s", rec.Code, rec.Body.String())
	}
	if _, err := e.db.Exec(`
UPDATE reverse_auth_accounts
SET status = 'ok',
    status_reason = 'old check',
    quota = 7,
    image_quota_unknown = 0,
    restore_at = '2026-06-10T00:00:00Z'
WHERE name = 'openai-plus.json'`); err != nil {
		t.Fatal(err)
	}

	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v0/management/auth-files":
			httpxJSON(t, w, map[string]any{
				"authFiles": []map[string]any{
					{"name": "openai-plus.json", "provider": "openai", "type": "oauth"},
				},
			})
		case "/v0/management/auth-files/download":
			httpxJSON(t, w, map[string]any{"email": "new@example.com", "access_token": "tok_new", "refresh_token": "ref_new"})
		default:
			t.Fatalf("unexpected cliproxy path=%q", r.URL.Path)
		}
	}))
	defer remote.Close()

	rec = e.req("PUT", "/api/admin/reverse-auth/sources", e.adminTok, `{"sources":[{"id":"cpa-main","type":"cpa","name":"Main CPA","baseUrl":"`+remote.URL+`","managementKey":"cpa-secret"}]}`)
	if rec.Code != 200 {
		t.Fatalf("save cpa source status=%d body=%s", rec.Code, rec.Body.String())
	}
	rec = e.req("POST", "/api/admin/reverse-auth/cliproxy/import", e.adminTok, `{"sourceId":"cpa-main","names":["openai-plus.json"]}`)
	if rec.Code != 200 {
		t.Fatalf("cliproxy import by source status=%d body=%s", rec.Code, rec.Body.String())
	}

	var imported struct {
		Imported []struct {
			Name string `json:"name"`
		} `json:"imported"`
		Skipped []cliproxyImportSkipped `json:"skipped"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &imported); err != nil {
		t.Fatalf("decode import response: %v", err)
	}
	if len(imported.Imported) != 1 || imported.Imported[0].Name != "openai-plus.json" || len(imported.Skipped) != 0 {
		t.Fatalf("unexpected import response: %+v body=%s", imported, rec.Body.String())
	}

	var count int
	if err := e.db.QueryRow("SELECT COUNT(*) FROM reverse_auth_accounts WHERE name LIKE 'openai-plus%'").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("source import should overwrite existing account instead of creating a second one; count=%d", count)
	}
	var raw string
	var status sql.NullString
	var quota sql.NullInt64
	if err := e.db.QueryRow("SELECT raw_json, status, quota FROM reverse_auth_accounts WHERE name = 'openai-plus.json'").Scan(&raw, &status, &quota); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(raw, "tok_new") || strings.Contains(raw, "tok_old") {
		t.Fatalf("existing cpa account was not overwritten: %s", raw)
	}
	if status.Valid || quota.Valid {
		t.Fatalf("overwrite should clear stale check metadata: status=%+v quota=%+v", status, quota)
	}
}

func TestReverseAuthSub2APIImportCanUseSavedSource(t *testing.T) {
	e := setup(t)
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sub-secret" || r.Header.Get("X-API-Key") != "sub-secret" {
			t.Fatalf("missing sub2api auth headers: authorization=%q x-api-key=%q", r.Header.Get("Authorization"), r.Header.Get("X-API-Key"))
		}
		if r.URL.Path != "/api/v1/admin/accounts/data" {
			t.Fatalf("unexpected sub2api path=%q", r.URL.Path)
		}
		if r.URL.Query().Get("search") != "plus" {
			t.Fatalf("unexpected sub2api query=%s", r.URL.RawQuery)
		}
		httpxJSON(t, w, map[string]any{
			"code": 0,
			"data": map[string]any{
				"accounts": []map[string]any{{
					"name":     "plus-oauth",
					"platform": "openai",
					"type":     "oauth",
					"credentials": map[string]any{
						"email":         "plus@example.com",
						"access_token":  "tok_plus",
						"refresh_token": "ref_plus",
					},
				}},
			},
		})
	}))
	defer remote.Close()

	rec := e.req("PUT", "/api/admin/reverse-auth/sources", e.adminTok, `{"sources":[{"id":"sub-main","type":"sub2api","name":"Main Sub2API","baseUrl":"`+remote.URL+`","managementKey":"sub-secret"}]}`)
	if rec.Code != 200 {
		t.Fatalf("save sub2api source status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = e.req("POST", "/api/admin/reverse-auth/sub2api/import", e.adminTok, `{"sourceId":"sub-main","search":"plus"}`)
	if rec.Code != 200 {
		t.Fatalf("sub2api import by source status=%d body=%s", rec.Code, rec.Body.String())
	}
	var raw string
	if err := e.db.QueryRow("SELECT raw_json FROM reverse_auth_accounts WHERE name = 'plus-oauth.json'").Scan(&raw); err != nil {
		t.Fatalf("imported sub2api account missing from reverse store: %v", err)
	}
	if !strings.Contains(raw, "tok_plus") {
		t.Fatalf("imported raw json missing token: %s", raw)
	}
}

func TestReverseAuthSub2APIImportOverwritesExistingSourceAccount(t *testing.T) {
	e := setup(t)
	rec := e.uploadReverseAuth(t, e.adminTok, "plus-oauth.json", `{"email":"old@example.com","access_token":"tok_old","refresh_token":"ref_old"}`)
	if rec.Code != 200 {
		t.Fatalf("seed upload status=%d body=%s", rec.Code, rec.Body.String())
	}
	if _, err := e.db.Exec("UPDATE reverse_auth_accounts SET status = 'ok', quota = 3 WHERE name = 'plus-oauth.json'"); err != nil {
		t.Fatal(err)
	}

	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/admin/accounts/data" {
			t.Fatalf("unexpected sub2api path=%q", r.URL.Path)
		}
		httpxJSON(t, w, map[string]any{
			"code": 0,
			"data": map[string]any{
				"accounts": []map[string]any{{
					"name":     "plus-oauth",
					"platform": "openai",
					"type":     "oauth",
					"credentials": map[string]any{
						"email":         "new@example.com",
						"access_token":  "tok_new",
						"refresh_token": "ref_new",
					},
				}},
			},
		})
	}))
	defer remote.Close()

	rec = e.req("PUT", "/api/admin/reverse-auth/sources", e.adminTok, `{"sources":[{"id":"sub-main","type":"sub2api","name":"Main Sub2API","baseUrl":"`+remote.URL+`","managementKey":"sub-secret"}]}`)
	if rec.Code != 200 {
		t.Fatalf("save sub2api source status=%d body=%s", rec.Code, rec.Body.String())
	}
	rec = e.req("POST", "/api/admin/reverse-auth/sub2api/import", e.adminTok, `{"sourceId":"sub-main"}`)
	if rec.Code != 200 {
		t.Fatalf("sub2api import by source status=%d body=%s", rec.Code, rec.Body.String())
	}

	var imported struct {
		Imported []struct {
			Name string `json:"name"`
		} `json:"imported"`
		Skipped []cliproxyImportSkipped `json:"skipped"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &imported); err != nil {
		t.Fatalf("decode import response: %v", err)
	}
	if len(imported.Imported) != 1 || imported.Imported[0].Name != "plus-oauth.json" || len(imported.Skipped) != 0 {
		t.Fatalf("unexpected import response: %+v body=%s", imported, rec.Body.String())
	}

	var count int
	if err := e.db.QueryRow("SELECT COUNT(*) FROM reverse_auth_accounts WHERE name LIKE 'plus-oauth%'").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("source import should overwrite existing account instead of creating a second one; count=%d", count)
	}
	var raw string
	var status sql.NullString
	var quota sql.NullInt64
	if err := e.db.QueryRow("SELECT raw_json, status, quota FROM reverse_auth_accounts WHERE name = 'plus-oauth.json'").Scan(&raw, &status, &quota); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(raw, "tok_new") || strings.Contains(raw, "tok_old") {
		t.Fatalf("existing sub2api account was not overwritten: %s", raw)
	}
	if status.Valid || quota.Valid {
		t.Fatalf("overwrite should clear stale check metadata: status=%+v quota=%+v", status, quota)
	}
}
