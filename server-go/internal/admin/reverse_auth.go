package admin

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/picpilot/server-go/internal/chatgptreverse"
	"github.com/xxww0098/picpilot/server-go/internal/httpx"
)

const maxReverseAuthUploadBytes int64 = 2 << 20
const maxReverseAuthEditRequestBytes int64 = maxReverseAuthUploadBytes*2 + 4096

var reverseAuthFilenameUnsafe = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)

type reverseAuthAccountView struct {
	Name              string `json:"name"`
	Email             string `json:"email,omitempty"`
	UserID            string `json:"userId,omitempty"`
	HasRefreshToken   bool   `json:"hasRefreshToken"`
	HasPasswordLogin  bool   `json:"hasPasswordLogin"`
	Disabled          bool   `json:"disabled"`
	Status            string `json:"status,omitempty"`
	StatusReason      string `json:"statusReason,omitempty"`
	HTTPStatus        *int   `json:"httpStatus,omitempty"`
	AccountType       string `json:"accountType,omitempty"`
	Quota             *int   `json:"quota,omitempty"`
	ImageQuotaUnknown bool   `json:"imageQuotaUnknown,omitempty"`
	RestoreAt         string `json:"restoreAt,omitempty"`
	DefaultModelSlug  string `json:"defaultModelSlug,omitempty"`
	LastCheckedAt     int64  `json:"lastCheckedAt,omitempty"`
	LastUsedAt        int64  `json:"lastUsedAt,omitempty"`
	SuccessCount      int    `json:"successCount"`
	FailCount         int    `json:"failCount"`
	Size              int64  `json:"size"`
	ModifiedAt        int64  `json:"modifiedAt"`
}

type cliproxyAuthFileCandidate struct {
	Name     string `json:"name"`
	Provider string `json:"provider,omitempty"`
	Type     string `json:"type,omitempty"`
}

type cliproxyImportSkipped struct {
	Name   string `json:"name"`
	Reason string `json:"reason"`
}

func (m *Module) getReverseAuth(w http.ResponseWriter, r *http.Request) {
	accounts, listErr := listReverseAuthAccounts(r.Context(), m.reverseStore)
	message := ""
	if listErr != nil {
		message = listErr.Error()
		accounts = []reverseAuthAccountView{}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"configured": true,
		"storage":    "database",
		"accounts":   accounts,
		"message":    nullableStr(message),
	})
}

func (m *Module) uploadReverseAuthAccount(w http.ResponseWriter, r *http.Request) {
	if m.reverseStore == nil {
		httpx.Error(w, http.StatusInternalServerError, "逆向账号数据库未初始化。")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxReverseAuthUploadBytes)
	if err := r.ParseMultipartForm(maxReverseAuthUploadBytes); err != nil {
		httpx.Error(w, http.StatusBadRequest, "上传内容无法解析，请选择 2MB 以内的 JSON。")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "请选择要上传的 JSON。")
		return
	}
	defer file.Close()

	raw, err := io.ReadAll(io.LimitReader(file, maxReverseAuthUploadBytes+1))
	if err != nil || int64(len(raw)) > maxReverseAuthUploadBytes {
		httpx.Error(w, http.StatusBadRequest, "JSON 过大，请选择 2MB 以内的内容。")
		return
	}
	view, err := validateReverseAuthJSON(raw)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	name, err := uniqueReverseAuthName(r.Context(), m.reverseStore, header.Filename)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "读取逆向账号数据库失败。")
		return
	}
	now := time.Now().UnixMilli()
	if err := m.reverseStore.SaveAuthAccount(r.Context(), chatgptreverse.StoredAuthAccount{
		Name:      name,
		Email:     view.Email,
		RawJSON:   string(raw),
		Disabled:  view.Disabled,
		Size:      int64(len(raw)),
		CreatedAt: now,
		UpdatedAt: now,
	}); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "保存逆向账号失败，请检查数据库。")
		return
	}
	view.Name = name
	view.Size = int64(len(raw))
	view.ModifiedAt = now
	m.logger.Info("admin imported reverse auth account", "scope", "admin", "actor", m.actor(r), "name", name, "email", view.Email)
	httpx.JSON(w, http.StatusOK, map[string]any{"account": view})
}

func (m *Module) importReverseAuthAccessToken(w http.ResponseWriter, r *http.Request) {
	if m.reverseStore == nil {
		httpx.Error(w, http.StatusInternalServerError, "逆向账号数据库未初始化。")
		return
	}
	var body struct {
		AccessToken string `json:"accessToken"`
		Email       string `json:"email"`
		Name        string `json:"name"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxReverseAuthEditRequestBytes)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "请求 JSON 无法解析。")
		return
	}
	token := strings.TrimSpace(body.AccessToken)
	if token == "" {
		httpx.Error(w, http.StatusBadRequest, "请填写 access_token。")
		return
	}
	if int64(len(token)) > maxReverseAuthUploadBytes {
		httpx.Error(w, http.StatusBadRequest, "access_token 过大，请控制在 2MB 以内。")
		return
	}
	email := strings.TrimSpace(body.Email)
	payload := map[string]any{"access_token": token}
	if email != "" {
		payload["email"] = email
	}
	raw, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "生成账号 JSON 失败。")
		return
	}
	view, err := validateReverseAuthJSON(raw)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	nameSource := strings.TrimSpace(body.Name)
	if nameSource == "" {
		nameSource = email
	}
	if nameSource == "" {
		nameSource = "access-token"
	}
	name, err := uniqueReverseAuthName(r.Context(), m.reverseStore, nameSource)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "读取逆向账号数据库失败。")
		return
	}
	now := time.Now().UnixMilli()
	if err := m.reverseStore.SaveAuthAccount(r.Context(), chatgptreverse.StoredAuthAccount{
		Name:      name,
		Email:     view.Email,
		RawJSON:   string(raw),
		Disabled:  view.Disabled,
		Size:      int64(len(raw)),
		CreatedAt: now,
		UpdatedAt: now,
	}); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "保存逆向账号失败，请检查数据库。")
		return
	}
	view.Name = name
	view.Size = int64(len(raw))
	view.ModifiedAt = now
	m.logger.Info("admin imported reverse auth access token", "scope", "admin", "actor", m.actor(r), "name", name, "email", view.Email)
	httpx.JSON(w, http.StatusOK, map[string]any{"account": view})
}

func (m *Module) getReverseAuthAccount(w http.ResponseWriter, r *http.Request) {
	record, ok := m.reverseAuthAccountByName(w, r)
	if !ok {
		return
	}
	view := reverseAuthViewFromRecord(record)
	httpx.JSON(w, http.StatusOK, map[string]any{
		"account": view,
		"rawJson": record.RawJSON,
	})
}

func (m *Module) updateReverseAuthAccount(w http.ResponseWriter, r *http.Request) {
	record, ok := m.reverseAuthAccountByName(w, r)
	if !ok {
		return
	}
	var body struct {
		RawJSON string `json:"rawJson"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxReverseAuthEditRequestBytes)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "请求 JSON 无法解析。")
		return
	}
	raw := []byte(body.RawJSON)
	if strings.TrimSpace(body.RawJSON) == "" {
		httpx.Error(w, http.StatusBadRequest, "请填写账号 JSON。")
		return
	}
	if int64(len(raw)) > maxReverseAuthUploadBytes {
		httpx.Error(w, http.StatusBadRequest, "JSON 过大，请控制在 2MB 以内。")
		return
	}
	view, err := validateReverseAuthJSON(raw)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	now := time.Now().UnixMilli()
	if err := m.reverseStore.SaveAuthAccount(r.Context(), chatgptreverse.StoredAuthAccount{
		Name:      record.Name,
		Email:     view.Email,
		RawJSON:   body.RawJSON,
		Disabled:  view.Disabled,
		Size:      int64(len(raw)),
		CreatedAt: record.CreatedAt,
		UpdatedAt: now,
	}); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "保存逆向账号失败，请检查数据库。")
		return
	}
	updated, found, err := m.reverseStore.GetAuthAccount(r.Context(), record.Name)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "读取逆向账号数据库失败。")
		return
	}
	if !found {
		httpx.Error(w, http.StatusNotFound, "逆向账号不存在。")
		return
	}
	m.logger.Info("admin updated reverse auth account json", "scope", "admin", "actor", m.actor(r), "name", record.Name, "email", view.Email)
	httpx.JSON(w, http.StatusOK, map[string]any{"account": reverseAuthViewFromRecord(updated)})
}

func (m *Module) exportReverseAuthAccounts(w http.ResponseWriter, r *http.Request) {
	if m.reverseStore == nil {
		httpx.Error(w, http.StatusInternalServerError, "逆向账号数据库未初始化。")
		return
	}
	records, err := m.reverseStore.ListAuthAccounts(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "读取逆向账号数据库失败。")
		return
	}
	type exportedAccount struct {
		Name       string `json:"name"`
		Email      string `json:"email,omitempty"`
		Disabled   bool   `json:"disabled"`
		RawJSON    string `json:"rawJson"`
		Size       int64  `json:"size"`
		ModifiedAt int64  `json:"modifiedAt"`
	}
	accounts := make([]exportedAccount, 0, len(records))
	for _, record := range records {
		view := reverseAuthViewFromRecord(record)
		accounts = append(accounts, exportedAccount{
			Name:       record.Name,
			Email:      view.Email,
			Disabled:   view.Disabled,
			RawJSON:    record.RawJSON,
			Size:       view.Size,
			ModifiedAt: view.ModifiedAt,
		})
	}
	filename := fmt.Sprintf("picpilot-reverse-auth-%s.json", time.Now().UTC().Format("20060102-150405"))
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	if err := json.NewEncoder(w).Encode(map[string]any{
		"exportedAt": time.Now().UnixMilli(),
		"accounts":   accounts,
	}); err != nil {
		m.logger.Warn("admin reverse auth export encode failed", "scope", "admin", "actor", m.actor(r), "error", err)
	}
}

func (m *Module) listCLIProxyReverseAuthAccounts(w http.ResponseWriter, r *http.Request) {
	candidates, err := m.fetchCLIProxyAuthFileCandidates(r.Context(), strings.TrimSpace(r.URL.Query().Get("sourceId")))
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"accounts": candidates})
}

func (m *Module) importCLIProxyReverseAuthAccounts(w http.ResponseWriter, r *http.Request) {
	if m.reverseStore == nil {
		httpx.Error(w, http.StatusInternalServerError, "逆向账号数据库未初始化。")
		return
	}
	var body struct {
		SourceID string   `json:"sourceId"`
		Names    []string `json:"names"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "请求 JSON 无法解析。")
		return
	}
	seen := map[string]bool{}
	names := make([]string, 0, len(body.Names))
	for _, raw := range body.Names {
		name := strings.TrimSpace(raw)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		names = append(names, name)
	}
	if len(names) == 0 {
		httpx.Error(w, http.StatusBadRequest, "请选择要导入的 CLIProxyAPI 账号。")
		return
	}
	if len(names) > 200 {
		httpx.Error(w, http.StatusBadRequest, "单次最多导入 200 个 CLIProxyAPI 账号。")
		return
	}
	sourceID := strings.TrimSpace(body.SourceID)
	candidates, err := m.fetchCLIProxyAuthFileCandidates(r.Context(), sourceID)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	candidateByName := map[string]cliproxyAuthFileCandidate{}
	for _, candidate := range candidates {
		candidateByName[candidate.Name] = candidate
	}
	imported := []reverseAuthAccountView{}
	skipped := []cliproxyImportSkipped{}
	for _, name := range names {
		candidate, ok := candidateByName[name]
		if !ok {
			skipped = append(skipped, cliproxyImportSkipped{Name: name, Reason: "不是 OpenAI OAuth 账号文件。"})
			continue
		}
		raw, err := m.downloadCLIProxyAuthFile(r.Context(), sourceID, candidate.Name)
		if err != nil {
			skipped = append(skipped, cliproxyImportSkipped{Name: name, Reason: err.Error()})
			continue
		}
		view, err := validateReverseAuthJSON(raw)
		if err != nil {
			skipped = append(skipped, cliproxyImportSkipped{Name: name, Reason: err.Error()})
			continue
		}
		localName := reverseAuthImportTargetName(candidate.Name)
		now := time.Now().UnixMilli()
		if err := m.reverseStore.SaveAuthAccount(r.Context(), chatgptreverse.StoredAuthAccount{
			Name:      localName,
			Email:     view.Email,
			RawJSON:   string(raw),
			Disabled:  view.Disabled,
			Size:      int64(len(raw)),
			CreatedAt: now,
			UpdatedAt: now,
		}); err != nil {
			skipped = append(skipped, cliproxyImportSkipped{Name: name, Reason: "保存逆向账号失败。"})
			continue
		}
		view.Name = localName
		view.Size = int64(len(raw))
		view.ModifiedAt = now
		imported = append(imported, view)
	}
	m.logger.Info("admin imported reverse auth accounts from cliproxy", "scope", "admin", "actor", m.actor(r), "imported", len(imported), "skipped", len(skipped))
	httpx.JSON(w, http.StatusOK, map[string]any{"imported": imported, "skipped": skipped})
}

func (m *Module) fetchCLIProxyAuthFileCandidates(ctx context.Context, sourceID string) ([]cliproxyAuthFileCandidate, error) {
	cfg, err := m.cpaConfigForSourceID(sourceID)
	if err != nil {
		return nil, err
	}
	req, err := newCLIProxyManagementRequestWithConfig(ctx, http.MethodGet, "/v0/management/auth-files", cfg)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("连接 CLIProxyAPI 失败：%s", err.Error())
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, fmt.Errorf("CLIProxyAPI 返回 HTTP %d：%s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var payload any
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&payload); err != nil {
		return nil, errors.New("CLIProxyAPI 账号列表 JSON 无法解析。")
	}
	files := extractCLIProxyAuthFiles(payload)
	out := make([]cliproxyAuthFileCandidate, 0, len(files))
	for _, file := range files {
		if isCLIProxyOpenAIOAuthCandidate(file) {
			out = append(out, file)
		}
	}
	return out, nil
}

func (m *Module) downloadCLIProxyAuthFile(ctx context.Context, sourceID, name string) ([]byte, error) {
	cfg, err := m.cpaConfigForSourceID(sourceID)
	if err != nil {
		return nil, err
	}
	req, err := newCLIProxyManagementRequestWithConfig(ctx, http.MethodGet, "/v0/management/auth-files/download?name="+url.QueryEscape(name), cfg)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("下载 %s 失败：%s", name, err.Error())
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, fmt.Errorf("下载 %s 失败：HTTP %d %s", name, resp.StatusCode, strings.TrimSpace(string(body)))
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxReverseAuthUploadBytes+1))
	if err != nil {
		return nil, fmt.Errorf("读取 %s 失败。", name)
	}
	if int64(len(raw)) > maxReverseAuthUploadBytes {
		return nil, errors.New("JSON 过大，请控制在 2MB 以内。")
	}
	return raw, nil
}

func extractCLIProxyAuthFiles(payload any) []cliproxyAuthFileCandidate {
	switch value := payload.(type) {
	case []any:
		return cliproxyAuthFilesFromArray(value)
	case map[string]any:
		for _, key := range []string{"authFiles", "auth_files", "files", "data"} {
			if items, ok := value[key].([]any); ok {
				return cliproxyAuthFilesFromArray(items)
			}
		}
	}
	return []cliproxyAuthFileCandidate{}
}

func cliproxyAuthFilesFromArray(items []any) []cliproxyAuthFileCandidate {
	out := make([]cliproxyAuthFileCandidate, 0, len(items))
	for _, item := range items {
		switch value := item.(type) {
		case string:
			out = append(out, cliproxyAuthFileCandidate{Name: strings.TrimSpace(value)})
		case map[string]any:
			out = append(out, cliproxyAuthFileCandidate{
				Name:     firstStringValue(value, "name", "filename", "file", "path"),
				Provider: firstStringValue(value, "provider", "providerName", "typeProvider"),
				Type:     firstStringValue(value, "type", "kind", "authType", "auth_type"),
			})
		}
	}
	return out
}

func firstStringValue(record map[string]any, keys ...string) string {
	for _, key := range keys {
		if value := stringValue(record[key], ""); value != "" {
			return value
		}
	}
	return ""
}

func isCLIProxyOpenAIOAuthCandidate(file cliproxyAuthFileCandidate) bool {
	name := strings.TrimSpace(file.Name)
	if name == "" || !strings.HasSuffix(strings.ToLower(name), ".json") {
		return false
	}
	typ := strings.ToLower(strings.TrimSpace(file.Type))
	if strings.Contains(typ, "api-key") || strings.Contains(typ, "apikey") || typ == "key" {
		return false
	}
	provider := strings.ToLower(strings.TrimSpace(file.Provider))
	if provider == "" {
		lowerName := strings.ToLower(filepath.Base(name))
		return strings.Contains(lowerName, "openai") || strings.Contains(lowerName, "codex") || strings.Contains(lowerName, "chatgpt")
	}
	return strings.Contains(provider, "openai") || strings.Contains(provider, "codex") || strings.Contains(provider, "chatgpt")
}

func (m *Module) checkReverseAuth(w http.ResponseWriter, r *http.Request) {
	if m.reverse == nil {
		httpx.Error(w, http.StatusBadRequest, "内置 reverse 未初始化，无法检查账号。")
		return
	}
	results, err := m.reverse.CheckAuthAccounts(r.Context())
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	m.logger.Info("admin checked reverse auth accounts", "scope", "admin", "actor", m.actor(r), "count", len(results))
	httpx.JSON(w, http.StatusOK, map[string]any{
		"checkedAt": time.Now().UnixMilli(),
		"results":   results,
	})
}

func (m *Module) deleteReverseAuthAccount(w http.ResponseWriter, r *http.Request) {
	if m.reverseStore == nil {
		httpx.Error(w, http.StatusInternalServerError, "逆向账号数据库未初始化。")
		return
	}
	name, ok := cleanReverseAuthFilename(chi.URLParam(r, "name"))
	if !ok {
		httpx.Error(w, http.StatusBadRequest, "账号名无效。")
		return
	}
	deleted, err := m.reverseStore.DeleteAuthAccount(r.Context(), name)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "删除逆向账号失败，请检查数据库。")
		return
	}
	if !deleted {
		httpx.Error(w, http.StatusNotFound, "逆向账号不存在。")
		return
	}
	m.logger.Info("admin deleted reverse auth account", "scope", "admin", "actor", m.actor(r), "name", name)
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (m *Module) bulkDeleteReverseAuthAccounts(w http.ResponseWriter, r *http.Request) {
	if m.reverseStore == nil {
		httpx.Error(w, http.StatusInternalServerError, "逆向账号数据库未初始化。")
		return
	}
	var body struct {
		Names []string `json:"names"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "请求 JSON 无法解析。")
		return
	}
	seen := map[string]bool{}
	names := make([]string, 0, len(body.Names))
	for _, raw := range body.Names {
		name, ok := cleanReverseAuthFilename(raw)
		if !ok {
			httpx.Error(w, http.StatusBadRequest, "账号名无效。")
			return
		}
		if !seen[name] {
			seen[name] = true
			names = append(names, name)
		}
	}
	if len(names) == 0 {
		httpx.Error(w, http.StatusBadRequest, "请选择要删除的逆向账号。")
		return
	}
	if len(names) > 200 {
		httpx.Error(w, http.StatusBadRequest, "单次最多删除 200 个逆向账号。")
		return
	}
	deleted, missing, err := m.reverseStore.DeleteAuthAccounts(r.Context(), names)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "删除逆向账号失败，请检查数据库。")
		return
	}
	m.logger.Info("admin bulk deleted reverse auth accounts", "scope", "admin", "actor", m.actor(r), "deleted", len(deleted), "missing", len(missing))
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "deleted": deleted, "missing": missing})
}

func (m *Module) reverseAuthAccountByName(w http.ResponseWriter, r *http.Request) (chatgptreverse.StoredAuthAccount, bool) {
	if m.reverseStore == nil {
		httpx.Error(w, http.StatusInternalServerError, "逆向账号数据库未初始化。")
		return chatgptreverse.StoredAuthAccount{}, false
	}
	name, ok := cleanReverseAuthFilename(chi.URLParam(r, "name"))
	if !ok {
		httpx.Error(w, http.StatusBadRequest, "账号名无效。")
		return chatgptreverse.StoredAuthAccount{}, false
	}
	record, found, err := m.reverseStore.GetAuthAccount(r.Context(), name)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "读取逆向账号数据库失败。")
		return chatgptreverse.StoredAuthAccount{}, false
	}
	if !found {
		httpx.Error(w, http.StatusNotFound, "逆向账号不存在。")
		return chatgptreverse.StoredAuthAccount{}, false
	}
	return record, true
}

func listReverseAuthAccounts(ctx context.Context, store *chatgptreverse.Store) ([]reverseAuthAccountView, error) {
	if store == nil {
		return []reverseAuthAccountView{}, errors.New("逆向账号数据库未初始化。")
	}
	records, err := store.ListAuthAccounts(ctx)
	if err != nil {
		return []reverseAuthAccountView{}, err
	}
	accounts := make([]reverseAuthAccountView, 0, len(records))
	for _, record := range records {
		accounts = append(accounts, reverseAuthViewFromRecord(record))
	}
	return accounts, nil
}

func reverseAuthViewFromRecord(record chatgptreverse.StoredAuthAccount) reverseAuthAccountView {
	view, err := parseReverseAuthView([]byte(record.RawJSON))
	if err != nil {
		view = reverseAuthAccountView{}
	}
	view.Name = record.Name
	if view.Email == "" {
		view.Email = record.Email
	}
	view.UserID = record.UserID
	view.Disabled = view.Disabled || record.Disabled
	view.Status = record.Status
	view.StatusReason = record.StatusReason
	view.HTTPStatus = record.HTTPStatus
	view.AccountType = record.AccountType
	view.Quota = record.Quota
	view.ImageQuotaUnknown = record.ImageQuotaUnknown
	view.RestoreAt = record.RestoreAt
	view.DefaultModelSlug = record.DefaultModelSlug
	view.LastCheckedAt = record.LastCheckedAt
	view.LastUsedAt = record.LastUsedAt
	view.SuccessCount = record.SuccessCount
	view.FailCount = record.FailCount
	view.Size = record.Size
	if view.Size == 0 {
		view.Size = int64(len(record.RawJSON))
	}
	view.ModifiedAt = record.UpdatedAt
	return view
}

func validateReverseAuthJSON(raw []byte) (reverseAuthAccountView, error) {
	view, err := parseReverseAuthView(raw)
	if err != nil {
		return reverseAuthAccountView{}, err
	}
	var record map[string]any
	if json.Unmarshal(raw, &record) != nil {
		return reverseAuthAccountView{}, errors.New("JSON 格式无效。")
	}
	if strings.TrimSpace(stringValue(record["access_token"], "")) == "" {
		return reverseAuthAccountView{}, errors.New("JSON 中必须包含 access_token。")
	}
	return view, nil
}

func parseReverseAuthView(raw []byte) (reverseAuthAccountView, error) {
	var record map[string]any
	if err := json.Unmarshal(raw, &record); err != nil {
		return reverseAuthAccountView{}, errors.New("JSON 格式无效。")
	}
	return reverseAuthAccountView{
		Email:            stringValue(record["email"], ""),
		HasRefreshToken:  strings.TrimSpace(stringValue(record["refresh_token"], "")) != "",
		HasPasswordLogin: reverseAuthPasswordLoginAvailable(record),
		Disabled:         truthy(record["disabled"]),
	}, nil
}

func reverseAuthPasswordLoginAvailable(record map[string]any) bool {
	if strings.TrimSpace(stringValue(record["password"], "")) == "" {
		return false
	}
	for _, key := range []string{"username", "email", "login", "account"} {
		if strings.TrimSpace(stringValue(record[key], "")) != "" {
			return true
		}
	}
	return false
}

func uniqueReverseAuthName(ctx context.Context, store *chatgptreverse.Store, original string) (string, error) {
	existing, err := existingReverseAuthNames(ctx, store)
	if err != nil {
		return "", err
	}
	base := reverseAuthImportTargetBase(original)
	candidate := reverseAuthImportTargetName(original)
	if !existing[candidate] {
		return candidate, nil
	}
	stamp := time.Now().UTC().Format("20060102-150405")
	for i := 0; i < 100; i++ {
		candidate = base + "-" + stamp + "-" + randomHex(3) + ".json"
		if !existing[candidate] {
			return candidate, nil
		}
	}
	return "chatgpt-auth-" + stamp + "-" + randomHex(8) + ".json", nil
}

func reverseAuthImportTargetName(original string) string {
	return reverseAuthImportTargetBase(original) + ".json"
}

func reverseAuthImportTargetBase(original string) string {
	base := strings.TrimSuffix(filepath.Base(original), filepath.Ext(original))
	base = strings.Trim(reverseAuthFilenameUnsafe.ReplaceAllString(base, "-"), ".-_")
	if base == "" || base == "." {
		base = "chatgpt-auth"
	}
	return base
}

func existingReverseAuthNames(ctx context.Context, store *chatgptreverse.Store) (map[string]bool, error) {
	records, err := store.ListAuthAccounts(ctx)
	if err != nil {
		return nil, err
	}
	out := make(map[string]bool, len(records))
	for _, record := range records {
		out[record.Name] = true
	}
	return out, nil
}

func cleanReverseAuthFilename(name string) (string, bool) {
	base := filepath.Base(name)
	if base != name || !strings.HasSuffix(strings.ToLower(base), ".json") {
		return "", false
	}
	if reverseAuthFilenameUnsafe.MatchString(base) || strings.HasPrefix(base, ".") {
		return "", false
	}
	return base, true
}

func randomHex(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "rnd"
	}
	return hex.EncodeToString(buf)
}

func stringValue(v any, def string) string {
	if s, ok := v.(string); ok {
		return strings.TrimSpace(s)
	}
	return def
}

func truthy(v any) bool {
	switch t := v.(type) {
	case bool:
		return t
	case string:
		s := strings.ToLower(strings.TrimSpace(t))
		return s == "1" || s == "true" || s == "yes"
	case float64:
		return t != 0
	default:
		return false
	}
}
