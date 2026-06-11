package admin

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"github.com/xxww0098/picpilot/server-go/internal/config"
	"github.com/xxww0098/picpilot/server-go/internal/httpx"
)

const maxReverseAuthSourcesRequestBytes int64 = 64 << 10
const reverseAuthImportSourcesKey = "reverseAuthImportSources"
const legacyCPAImportSourceID = "default-cpa"

var reverseAuthSourceIDUnsafe = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)

type reverseAuthImportSource struct {
	ID            string `json:"id"`
	Type          string `json:"type"`
	Name          string `json:"name"`
	BaseURL       string `json:"baseUrl"`
	ManagementKey string `json:"managementKey,omitempty"`
}

type reverseAuthImportSourceView struct {
	ID                      string `json:"id"`
	Type                    string `json:"type"`
	Name                    string `json:"name"`
	BaseURL                 string `json:"baseUrl"`
	ManagementKeyConfigured bool   `json:"managementKeyConfigured"`
}

type incomingReverseAuthImportSource struct {
	ID            string  `json:"id"`
	Type          string  `json:"type"`
	Name          string  `json:"name"`
	BaseURL       string  `json:"baseUrl"`
	ManagementKey *string `json:"managementKey"`
	AdminToken    *string `json:"adminToken"`
}

type reverseAuthCPAConfig struct {
	APIURL        string
	ManagementKey string
}

func (m *Module) listReverseAuthImportSources(w http.ResponseWriter, _ *http.Request) {
	if m.settings == nil {
		httpx.Error(w, http.StatusInternalServerError, "团队设置未初始化。")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"sources": reverseAuthImportSourceViews(m.effectiveReverseAuthImportSources())})
}

func (m *Module) saveReverseAuthImportSources(w http.ResponseWriter, r *http.Request) {
	if m.settings == nil {
		httpx.Error(w, http.StatusInternalServerError, "团队设置未初始化。")
		return
	}
	var body struct {
		Sources []incomingReverseAuthImportSource `json:"sources"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxReverseAuthSourcesRequestBytes)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpx.Error(w, http.StatusBadRequest, "请求 JSON 无法解析。")
		return
	}
	if len(body.Sources) > 20 {
		httpx.Error(w, http.StatusBadRequest, "最多保存 20 个导入来源。")
		return
	}

	previous := m.effectiveReverseAuthImportSources()
	previousByID := map[string]reverseAuthImportSource{}
	for _, source := range previous {
		previousByID[source.ID] = source
	}

	sources := make([]reverseAuthImportSource, 0, len(body.Sources))
	usedIDs := map[string]bool{}
	for index, item := range body.Sources {
		source, err := normalizeIncomingReverseAuthImportSource(item, index, previousByID, usedIDs)
		if err != nil {
			httpx.Error(w, http.StatusBadRequest, err.Error())
			return
		}
		usedIDs[source.ID] = true
		sources = append(sources, source)
	}

	record := m.settings.Record()
	record[reverseAuthImportSourcesKey] = sources
	if err := m.settings.Save(record, m.actor(r)); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "保存导入来源失败，请稍后重试。")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"sources": reverseAuthImportSourceViews(sources)})
}

func normalizeIncomingReverseAuthImportSource(item incomingReverseAuthImportSource, index int, previousByID map[string]reverseAuthImportSource, usedIDs map[string]bool) (reverseAuthImportSource, error) {
	sourceType := normalizeReverseAuthImportSourceType(item.Type)
	if sourceType == "" {
		return reverseAuthImportSource{}, errors.New("导入来源类型只能是 CPA 或 Sub2API。")
	}
	baseURL, err := normalizeReverseAuthSourceBaseURL(item.BaseURL)
	if err != nil {
		return reverseAuthImportSource{}, err
	}
	id := cleanReverseAuthSourceID(item.ID)
	if id == "" || usedIDs[id] {
		id = newReverseAuthSourceID()
	}
	name := strings.TrimSpace(item.Name)
	if name == "" {
		if sourceType == "cpa" {
			name = "CPA"
		} else {
			name = "Sub2API"
		}
		if index > 0 {
			name = fmt.Sprintf("%s %d", name, index+1)
		}
	}
	if len(name) > 80 {
		name = name[:80]
	}

	managementKey := ""
	if previous, ok := previousByID[id]; ok && previous.Type == sourceType {
		managementKey = previous.ManagementKey
	}
	switch {
	case item.ManagementKey != nil:
		key, ok := normalizeReverseAuthSourceManagementKey(*item.ManagementKey)
		if !ok {
			return reverseAuthImportSource{}, errors.New("管理令牌必须是 4096 字以内的单行文本。")
		}
		managementKey = key
	case item.AdminToken != nil:
		key, ok := normalizeReverseAuthSourceManagementKey(*item.AdminToken)
		if !ok {
			return reverseAuthImportSource{}, errors.New("管理令牌必须是 4096 字以内的单行文本。")
		}
		managementKey = key
	}

	return reverseAuthImportSource{
		ID:            id,
		Type:          sourceType,
		Name:          name,
		BaseURL:       baseURL,
		ManagementKey: managementKey,
	}, nil
}

func normalizeReverseAuthImportSourceType(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "cpa", "cliproxy", "cliproxyapi":
		return "cpa"
	case "sub2api", "sub":
		return "sub2api"
	default:
		return ""
	}
}

func normalizeReverseAuthSourceBaseURL(value string) (string, error) {
	baseURL := strings.TrimSpace(value)
	if baseURL == "" {
		return "", errors.New("请填写导入来源地址。")
	}
	if len(baseURL) > 2048 {
		return "", errors.New("导入来源地址必须是 2048 字以内的 http/https URL。")
	}
	u, err := url.Parse(baseURL)
	if err != nil || u.Scheme == "" || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "", errors.New("导入来源地址必须是 http/https URL。")
	}
	return strings.TrimRight(baseURL, "/"), nil
}

func normalizeReverseAuthSourceManagementKey(value string) (string, bool) {
	key := strings.TrimSpace(value)
	if strings.ContainsAny(key, "\r\n") || len(key) > 4096 {
		return "", false
	}
	return key, true
}

func cleanReverseAuthSourceID(value string) string {
	id := reverseAuthSourceIDUnsafe.ReplaceAllString(strings.TrimSpace(value), "-")
	id = strings.Trim(id, ".-_")
	if len(id) > 64 {
		id = id[:64]
	}
	return id
}

func newReverseAuthSourceID() string {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "source"
	}
	return "source-" + hex.EncodeToString(b[:])
}

func reverseAuthImportSourcesFromRecord(record map[string]any) []reverseAuthImportSource {
	raw, ok := record[reverseAuthImportSourcesKey]
	if !ok || raw == nil {
		return nil
	}
	data, err := json.Marshal(raw)
	if err != nil {
		return nil
	}
	var sources []reverseAuthImportSource
	if err := json.Unmarshal(data, &sources); err != nil {
		return nil
	}
	out := make([]reverseAuthImportSource, 0, len(sources))
	usedIDs := map[string]bool{}
	for index, source := range sources {
		id := cleanReverseAuthSourceID(source.ID)
		sourceType := normalizeReverseAuthImportSourceType(source.Type)
		baseURL, err := normalizeReverseAuthSourceBaseURL(source.BaseURL)
		if id == "" || sourceType == "" || err != nil || usedIDs[id] {
			continue
		}
		name := strings.TrimSpace(source.Name)
		if name == "" {
			if sourceType == "cpa" {
				name = "CPA"
			} else {
				name = "Sub2API"
			}
			if index > 0 {
				name = fmt.Sprintf("%s %d", name, index+1)
			}
		}
		key, ok := normalizeReverseAuthSourceManagementKey(source.ManagementKey)
		if !ok {
			key = ""
		}
		usedIDs[id] = true
		out = append(out, reverseAuthImportSource{
			ID:            id,
			Type:          sourceType,
			Name:          name,
			BaseURL:       baseURL,
			ManagementKey: key,
		})
	}
	return out
}

func (m *Module) effectiveReverseAuthImportSources() []reverseAuthImportSource {
	record := m.settings.Record()
	if sources := reverseAuthImportSourcesFromRecord(record); len(sources) > 0 {
		return sources
	}
	cfg := m.settings.CLIProxyConfig()
	if strings.TrimSpace(cfg.APIURL) == "" {
		return []reverseAuthImportSource{}
	}
	return []reverseAuthImportSource{{
		ID:            legacyCPAImportSourceID,
		Type:          "cpa",
		Name:          "默认 CPA",
		BaseURL:       cfg.APIURL,
		ManagementKey: cfg.ManagementKey,
	}}
}

func reverseAuthImportSourceViews(sources []reverseAuthImportSource) []reverseAuthImportSourceView {
	views := make([]reverseAuthImportSourceView, 0, len(sources))
	for _, source := range sources {
		views = append(views, reverseAuthImportSourceView{
			ID:                      source.ID,
			Type:                    source.Type,
			Name:                    source.Name,
			BaseURL:                 source.BaseURL,
			ManagementKeyConfigured: strings.TrimSpace(source.ManagementKey) != "",
		})
	}
	return views
}

func (m *Module) reverseAuthImportSourceByID(sourceID, sourceType string) (reverseAuthImportSource, error) {
	sourceID = strings.TrimSpace(sourceID)
	sourceType = normalizeReverseAuthImportSourceType(sourceType)
	if sourceID == "" || sourceType == "" {
		return reverseAuthImportSource{}, errors.New("导入来源无效。")
	}
	for _, source := range m.effectiveReverseAuthImportSources() {
		if source.ID == sourceID && source.Type == sourceType {
			return source, nil
		}
	}
	return reverseAuthImportSource{}, errors.New("导入来源不存在或类型不匹配。")
}

func (m *Module) cpaConfigForSourceID(sourceID string) (reverseAuthCPAConfig, error) {
	if strings.TrimSpace(sourceID) == "" {
		if m.settings == nil {
			return reverseAuthCPAConfig{}, errors.New("团队设置未初始化。")
		}
		cfg := m.settings.CLIProxyConfig()
		return reverseAuthCPAConfig{APIURL: cfg.APIURL, ManagementKey: cfg.ManagementKey}, nil
	}
	source, err := m.reverseAuthImportSourceByID(sourceID, "cpa")
	if err != nil {
		return reverseAuthCPAConfig{}, err
	}
	return reverseAuthCPAConfig{APIURL: source.BaseURL, ManagementKey: source.ManagementKey}, nil
}

func newCLIProxyManagementRequestWithConfig(ctx context.Context, method, path string, cfg reverseAuthCPAConfig) (*http.Request, error) {
	apiURL := config.NormalizeCLIProxyAPIURL(cfg.APIURL)
	key := config.NormalizeCLIProxyManagementKey(cfg.ManagementKey)
	if strings.TrimSpace(apiURL) == "" {
		return nil, errors.New("请先配置 CPA 服务器地址。")
	}
	if strings.TrimSpace(key) == "" {
		return nil, errors.New("请先配置 CPA 管理令牌。")
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(apiURL, "/")+path, nil)
	if err != nil {
		return nil, errors.New("CPA 服务器地址无效。")
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("X-Management-Key", key)
	return req, nil
}
