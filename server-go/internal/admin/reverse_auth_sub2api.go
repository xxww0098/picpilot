package admin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/xxww0098/picpilot/server-go/internal/chatgptreverse"
	"github.com/xxww0098/picpilot/server-go/internal/httpx"
)

const maxSub2APIImportRequestBytes int64 = 16 << 10
const maxSub2APIDataBytes int64 = 16 << 20

type sub2APIDataPayload struct {
	Accounts []sub2APIDataAccount `json:"accounts"`
}

type sub2APIDataAccount struct {
	Name        string         `json:"name"`
	Platform    string         `json:"platform"`
	Type        string         `json:"type"`
	Credentials map[string]any `json:"credentials"`
	Extra       map[string]any `json:"extra"`
}

func (m *Module) importSub2APIReverseAuthAccounts(w http.ResponseWriter, r *http.Request) {
	if m.reverseStore == nil {
		httpx.Error(w, http.StatusInternalServerError, "逆向账号数据库未初始化。")
		return
	}
	var body struct {
		SourceID   string `json:"sourceId"`
		BaseURL    string `json:"baseUrl"`
		AdminToken string `json:"adminToken"`
		APIKey     string `json:"apiKey"`
		Search     string `json:"search"`
		Status     string `json:"status"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxSub2APIImportRequestBytes)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "请求 JSON 无法解析。")
		return
	}
	if sourceID := strings.TrimSpace(body.SourceID); sourceID != "" {
		source, err := m.reverseAuthImportSourceByID(sourceID, "sub2api")
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return
		}
		body.BaseURL = source.BaseURL
		body.AdminToken = source.ManagementKey
		body.APIKey = ""
	}
	dataURL, err := sub2APIAccountsDataURL(body.BaseURL, body.Search, body.Status)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	token := strings.TrimSpace(body.AdminToken)
	if token == "" {
		token = strings.TrimSpace(body.APIKey)
	}
	payload, err := fetchSub2APIAccountsData(r.Context(), dataURL, token)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	imported, skipped, err := m.saveSub2APIAccounts(r.Context(), payload.Accounts)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	m.logger.Info("admin imported reverse auth accounts from sub2api", "scope", "admin", "actor", m.actor(r), "imported", len(imported), "skipped", len(skipped))
	httpx.JSON(w, http.StatusOK, map[string]any{"imported": imported, "skipped": skipped})
}

func sub2APIAccountsDataURL(baseURL, search, status string) (string, error) {
	baseURL = strings.TrimSpace(baseURL)
	if baseURL == "" {
		return "", errors.New("请填写 sub2api 服务器地址。")
	}
	u, err := url.Parse(baseURL)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "", errors.New("sub2api 服务器地址必须是 http/https URL。")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", errors.New("sub2api 服务器地址必须是 http/https URL。")
	}
	path := strings.TrimRight(u.Path, "/")
	if strings.HasSuffix(path, "/api/v1") {
		u.Path = path + "/admin/accounts/data"
	} else {
		u.Path = path + "/api/v1/admin/accounts/data"
	}
	q := u.Query()
	q.Set("include_proxies", "false")
	q.Set("platform", "openai")
	q.Set("type", "oauth")
	if s := strings.TrimSpace(search); s != "" {
		q.Set("search", s)
	}
	if s := strings.TrimSpace(status); s != "" {
		q.Set("status", s)
	}
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func fetchSub2APIAccountsData(ctx context.Context, dataURL, adminToken string) (sub2APIDataPayload, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, dataURL, nil)
	if err != nil {
		return sub2APIDataPayload{}, errors.New("sub2api 服务器地址无效。")
	}
	req.Header.Set("Accept", "application/json")
	if adminToken != "" {
		req.Header.Set("Authorization", "Bearer "+adminToken)
		req.Header.Set("X-API-Key", adminToken)
	}
	resp, err := ssrfSafeClient.Do(req)
	if err != nil {
		return sub2APIDataPayload{}, fmt.Errorf("连接 sub2api 失败：%s", err.Error())
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxSub2APIDataBytes+1))
	if err != nil {
		return sub2APIDataPayload{}, errors.New("读取 sub2api 响应失败。")
	}
	if int64(len(body)) > maxSub2APIDataBytes {
		return sub2APIDataPayload{}, errors.New("sub2api 返回数据过大，请缩小筛选范围后重试。")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return sub2APIDataPayload{}, fmt.Errorf("sub2api 返回 HTTP %d：%s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return decodeSub2APIDataPayload(body)
}

func decodeSub2APIDataPayload(body []byte) (sub2APIDataPayload, error) {
	var root map[string]json.RawMessage
	if err := json.Unmarshal(body, &root); err != nil {
		return sub2APIDataPayload{}, errors.New("sub2api 账号导出 JSON 无法解析。")
	}
	if codeRaw, ok := root["code"]; ok {
		var code int
		_ = json.Unmarshal(codeRaw, &code)
		if code != 0 {
			message := "sub2api 返回错误。"
			if msgRaw, ok := root["message"]; ok {
				var msg string
				if json.Unmarshal(msgRaw, &msg) == nil && strings.TrimSpace(msg) != "" {
					message = "sub2api 返回错误：" + strings.TrimSpace(msg)
				}
			}
			return sub2APIDataPayload{}, errors.New(message)
		}
	}
	if dataRaw, ok := root["data"]; ok {
		var payload sub2APIDataPayload
		if err := json.Unmarshal(dataRaw, &payload); err != nil {
			return sub2APIDataPayload{}, errors.New("sub2api 账号导出 data 无法解析。")
		}
		return payload, nil
	}
	var payload sub2APIDataPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		return sub2APIDataPayload{}, errors.New("sub2api 账号导出 JSON 无法解析。")
	}
	return payload, nil
}

func (m *Module) saveSub2APIAccounts(ctx context.Context, accounts []sub2APIDataAccount) ([]reverseAuthAccountView, []cliproxyImportSkipped, error) {
	imported := []reverseAuthAccountView{}
	skipped := []cliproxyImportSkipped{}
	for _, account := range accounts {
		displayName := strings.TrimSpace(account.Name)
		if displayName == "" {
			displayName = "sub2api-account"
		}
		raw, err := sub2APIAccountReverseAuthJSON(account)
		if err != nil {
			skipped = append(skipped, cliproxyImportSkipped{Name: displayName, Reason: err.Error()})
			continue
		}
		view, err := validateReverseAuthJSON(raw)
		if err != nil {
			skipped = append(skipped, cliproxyImportSkipped{Name: displayName, Reason: err.Error()})
			continue
		}
		localName := reverseAuthImportTargetName(displayName)
		now := time.Now().UnixMilli()
		if err := m.reverseStore.SaveAuthAccount(ctx, chatgptreverse.StoredAuthAccount{
			Name:      localName,
			Email:     view.Email,
			RawJSON:   string(raw),
			Disabled:  view.Disabled,
			Size:      int64(len(raw)),
			CreatedAt: now,
			UpdatedAt: now,
		}); err != nil {
			skipped = append(skipped, cliproxyImportSkipped{Name: displayName, Reason: "保存逆向账号失败。"})
			continue
		}
		view.Name = localName
		view.Size = int64(len(raw))
		view.ModifiedAt = now
		imported = append(imported, view)
	}
	return imported, skipped, nil
}

func sub2APIAccountReverseAuthJSON(account sub2APIDataAccount) ([]byte, error) {
	if !strings.EqualFold(strings.TrimSpace(account.Platform), "openai") {
		return nil, errors.New("不是 OpenAI 账号。")
	}
	if !strings.EqualFold(strings.TrimSpace(account.Type), "oauth") {
		return nil, errors.New("不是 OpenAI OAuth 账号。")
	}
	if len(account.Credentials) == 0 {
		return nil, errors.New("缺少 credentials。")
	}
	raw := make(map[string]any, len(account.Credentials)+3)
	for key, value := range account.Credentials {
		if value != nil {
			raw[key] = value
		}
	}
	if stringValue(raw["access_token"], "") == "" {
		return nil, errors.New("credentials 中缺少 access_token。")
	}
	if stringValue(raw["email"], "") == "" {
		if email := firstStringValue(account.Extra, "email", "user_email", "account_email"); email != "" {
			raw["email"] = email
		}
	}
	if stringValue(raw["sub2api_account_name"], "") == "" && strings.TrimSpace(account.Name) != "" {
		raw["sub2api_account_name"] = strings.TrimSpace(account.Name)
	}
	if stringValue(raw["source"], "") == "" {
		raw["source"] = "sub2api"
	}
	return json.Marshal(raw)
}
