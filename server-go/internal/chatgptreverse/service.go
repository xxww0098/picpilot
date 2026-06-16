package chatgptreverse

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/xxww0098/picpilot/server-go/internal/config"
	"github.com/xxww0098/picpilot/server-go/internal/httpx"
	"github.com/xxww0098/picpilot/server-go/internal/outboundproxy"
	"github.com/xxww0098/picpilot/server-go/internal/settings"
)

const (
	defaultBaseURL               = "https://chatgpt.com"
	defaultResponsesModel        = "gpt-5.5"
	defaultImageModel            = "gpt-image-2"
	codexResponsesPath           = "/backend-api/codex/responses"
	codexImageInstructions       = "Use the image_generation tool to create exactly one image for the user's request. Return the generated image result."
	maxJSONBodyBytes       int64 = 80 << 20
	maxMultipartBytes      int64 = 96 << 20
)

// Service exposes a small OpenAI-compatible reverse backend backed by ChatGPT's
// Codex Responses endpoint. It intentionally does not implement chatgpt2api's
// management UI or full browser-conversation stack.
type Service struct {
	cfg      *config.Config
	store    *Store
	settings *settings.Provider
	logger   *slog.Logger
	client   *http.Client

	mu          sync.Mutex
	next        int
	accountBusy map[string]int
	accountWait chan struct{}
}

type account struct {
	Name             string
	AccessToken      string
	RefreshToken     string
	Email            string
	DefaultModelSlug string
	Raw              map[string]any
}

type imageItem struct {
	B64           string
	RevisedPrompt string
}

type retryableCodexStreamError struct {
	message string
}

func (e *retryableCodexStreamError) Error() string { return e.message }

func newRetryableCodexStreamError(message string) error {
	message = strings.TrimSpace(message)
	if message == "" {
		message = "ChatGPT 上游生成失败，请重试。"
	}
	return &retryableCodexStreamError{message: "ChatGPT 上游生成临时失败：" + message}
}

func isRetryableCodexStreamError(err error) bool {
	var target *retryableCodexStreamError
	return errors.As(err, &target)
}

// New constructs the built-in reverse service. It is cheap to create even when
// the feature is not enabled.
func New(cfg *config.Config, store *Store, logger *slog.Logger, sp ...*settings.Provider) *Service {
	var settingsProvider *settings.Provider
	if len(sp) > 0 {
		settingsProvider = sp[0]
	}
	base := http.DefaultTransport.(*http.Transport).Clone()
	base.Proxy = outboundproxy.ProxyFunc(settingsProvider)
	base.ForceAttemptHTTP2 = true
	base.MaxIdleConns = 100
	base.IdleConnTimeout = 90 * time.Second
	base.TLSHandshakeTimeout = 20 * time.Second
	return &Service{
		cfg:         cfg,
		store:       store,
		settings:    settingsProvider,
		logger:      logger,
		client:      &http.Client{Transport: base},
		accountBusy: map[string]int{},
		accountWait: make(chan struct{}),
	}
}

// Configured reports whether the service has any credential source to try.
func (s *Service) Configured() bool {
	if s == nil || s.store == nil {
		return false
	}
	count, err := s.store.CountActiveAuthAccounts(context.Background())
	return err == nil && count > 0
}

// ServeProxy handles an authenticated /api-proxy/* request after the caller has
// acquired the global queue slot.
func (s *Service) ServeProxy(w http.ResponseWriter, r *http.Request, endpoint string) {
	endpoint = cleanEndpoint(endpoint)
	switch {
	case r.Method == http.MethodGet && endpoint == "models":
		writeJSON(w, http.StatusOK, modelList())
	case r.Method == http.MethodPost && endpoint == "responses":
		s.handleResponses(w, r)
	case r.Method == http.MethodPost && endpoint == "images/generations":
		s.handleImageGenerations(w, r)
	case r.Method == http.MethodPost && endpoint == "images/edits":
		s.handleImageEdits(w, r)
	default:
		httpx.Error(w, http.StatusNotFound, "内置 reverse 暂不支持该接口。")
	}
}

// DoJSON handles an async task endpoint and returns an OpenAI-compatible JSON
// response body. It is for JSON endpoints only; multipart image edits stay on the
// sync proxy path.
func (s *Service) DoJSON(ctx context.Context, endpoint, payload string) (int, string, string) {
	endpoint = cleanEndpoint(endpoint)
	switch endpoint {
	case "responses":
		var body map[string]any
		if err := json.Unmarshal([]byte(payload), &body); err != nil {
			return http.StatusBadRequest, "application/json", jsonError("invalid_request_error", "请求 JSON 无法解析。")
		}
		response, err := s.collectCodexResponse(ctx, normalizeResponsesBody(body))
		if err != nil {
			return errorResponse(err)
		}
		return marshalJSONResponse(response)
	case "images/generations":
		var body map[string]any
		if err := json.Unmarshal([]byte(payload), &body); err != nil {
			return http.StatusBadRequest, "application/json", jsonError("invalid_request_error", "请求 JSON 无法解析。")
		}
		result, err := s.collectImages(ctx, body, nil)
		if err != nil {
			return errorResponse(err)
		}
		return marshalJSONResponse(result)
	default:
		return http.StatusNotFound, "application/json", jsonError("not_found", "内置 reverse 暂不支持该接口。")
	}
}

func (s *Service) handleResponses(w http.ResponseWriter, r *http.Request) {
	body, err := readJSONBody(r.Body)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	stream := truthy(body["stream"])
	normalized := normalizeResponsesBody(body)
	if stream {
		resp, err := s.startCodexStream(r.Context(), normalized)
		if err != nil {
			writeServiceError(w, err)
			return
		}
		defer resp.Body.Close()
		streamSSE(w, resp.Body)
		return
	}
	response, err := s.collectCodexResponse(r.Context(), normalized)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Service) handleImageGenerations(w http.ResponseWriter, r *http.Request) {
	body, err := readJSONBody(r.Body)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	stream := truthy(body["stream"])
	result, err := s.collectImages(r.Context(), body, nil)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	if stream {
		writeImageSSE(w, result)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Service) handleImageEdits(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxMultipartBytes)
	if err := r.ParseMultipartForm(16 << 20); err != nil {
		httpx.Error(w, http.StatusBadRequest, "图片编辑请求体无法解析。")
		return
	}
	body := map[string]any{
		"model":              formValue(r, "model", defaultImageModel),
		"prompt":             formValue(r, "prompt", ""),
		"size":               formValue(r, "size", "1024x1024"),
		"quality":            formValue(r, "quality", "auto"),
		"output_format":      formValue(r, "output_format", "png"),
		"output_compression": formValue(r, "output_compression", ""),
		"n":                  formValue(r, "n", "1"),
		"stream":             formValue(r, "stream", ""),
	}
	images, err := multipartImages(r)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	result, err := s.collectImages(r.Context(), body, images)
	if err != nil {
		writeServiceError(w, err)
		return
	}
	if truthy(body["stream"]) {
		writeImageSSE(w, result)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Service) collectImages(ctx context.Context, imageBody map[string]any, inputImages []string) (map[string]any, error) {
	if len(inputImages) == 0 && !isCodexImageModel(imageBody["model"]) {
		return s.collectWebImages(ctx, imageBody)
	}
	return s.collectCodexImages(ctx, imageBody, inputImages)
}

func (s *Service) collectCodexImages(ctx context.Context, imageBody map[string]any, inputImages []string) (map[string]any, error) {
	n := positiveInt(imageBody["n"], 1)
	if n < 1 {
		n = 1
	}
	data := make([]map[string]any, 0, n)
	for i := 0; i < n; i++ {
		items, err := s.collectCodexImageItems(ctx, codexBodyFromImageRequest(imageBody, inputImages))
		if err != nil {
			return nil, err
		}
		for _, item := range items {
			row := map[string]any{"b64_json": item.B64}
			if item.RevisedPrompt != "" {
				row["revised_prompt"] = item.RevisedPrompt
			}
			data = append(data, row)
		}
	}
	return map[string]any{
		"created":            time.Now().Unix(),
		"data":               data,
		"size":               stringValue(imageBody["size"], "1024x1024"),
		"quality":            stringValue(imageBody["quality"], "auto"),
		"output_format":      stringValue(imageBody["output_format"], "png"),
		"background":         imageBody["background"],
		"output_compression": imageBody["output_compression"],
	}, nil
}

func (s *Service) collectCodexImageItems(ctx context.Context, body map[string]any) ([]imageItem, error) {
	attempts := 1
	if s != nil && s.cfg != nil && s.cfg.UpstreamMaxRetries > 0 {
		attempts += s.cfg.UpstreamMaxRetries
	}
	var last error
	for attempt := 1; attempt <= attempts; attempt++ {
		response, err := s.collectCodexResponse(ctx, cloneMap(body))
		if err == nil {
			items := extractImageItems(response)
			if len(items) > 0 {
				return items, nil
			}
			err = newRetryableCodexStreamError("未从上游响应中解析到图片。")
		}
		last = err
		if attempt >= attempts || !isRetryableCodexStreamError(err) {
			return nil, err
		}
		if s.logger != nil {
			s.logger.Warn("chatgpt reverse codex image stream failed; retrying", "scope", "reverse", "attempt", attempt, "maxAttempts", attempts, "err", truncateLogValue(err.Error(), 240))
		}
	}
	return nil, last
}

func isCodexImageModel(value any) bool {
	return strings.EqualFold(strings.TrimSpace(stringValue(value, "")), "codex-gpt-image-2")
}

func (s *Service) collectCodexResponse(ctx context.Context, body map[string]any) (map[string]any, error) {
	body["stream"] = true
	resp, err := s.startCodexStream(ctx, body)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	events, err := readSSEEvents(resp.Body)
	if err != nil {
		return nil, err
	}
	if err := codexStreamFailure(events); err != nil {
		return nil, err
	}
	completed := completedResponse(events)
	if completed == nil {
		return nil, errors.New("内置 reverse 上游没有返回 response.completed。")
	}
	return completed, nil
}

func (s *Service) startCodexStream(ctx context.Context, body map[string]any) (*http.Response, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	return s.postCodex(ctx, payload)
}

func (s *Service) postCodex(ctx context.Context, payload []byte) (*http.Response, error) {
	accounts, err := s.loadAccounts(ctx)
	if err != nil {
		return nil, err
	}
	if len(accounts) == 0 {
		return nil, errors.New("内置 reverse 未配置 ChatGPT access_token。")
	}
	accountConcurrency := s.reverseAccountConcurrency()
	var last error
	tried := map[string]bool{}
	for {
		acc, key, release, err := s.acquireAccountSlot(ctx, accounts, tried, accountConcurrency)
		if err != nil {
			if errors.Is(err, errNoUntriedAccountSlots) {
				break
			}
			return nil, err
		}
		tried[key] = true
		active := acc
		if refreshed, ok := s.refreshIfNeeded(ctx, active, false); ok {
			active = refreshed
		}
		resp, err := s.postCodexWithToken(ctx, active.AccessToken, payload)
		if err != nil {
			release()
			last = err
			continue
		}
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			s.markAccountSuccess(ctx, active.Name)
			return responseWithAccountSlotRelease(resp, release), nil
		}
		if resp.StatusCode == http.StatusUnauthorized {
			_ = resp.Body.Close()
			if refreshed, ok := s.refreshIfNeeded(ctx, active, true); ok && refreshed.AccessToken != active.AccessToken {
				resp, err = s.postCodexWithToken(ctx, refreshed.AccessToken, payload)
				if err == nil && resp.StatusCode >= 200 && resp.StatusCode < 300 {
					s.markAccountSuccess(ctx, refreshed.Name)
					return responseWithAccountSlotRelease(resp, release), nil
				}
				if resp != nil {
					_ = resp.Body.Close()
				}
			}
			release()
			s.markAccountExpired(ctx, active.Name)
			last = errors.New("ChatGPT access_token 已失效。")
			continue
		}
		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
			_ = resp.Body.Close()
			release()
			last = fmt.Errorf("上游暂不可用：HTTP %d %s", resp.StatusCode, strings.TrimSpace(string(body)))
			continue
		}
		// A Cloudflare challenge 403 is transient and correlated with this account's
		// session/egress; rotate to the next account instead of failing the request.
		if resp.StatusCode == http.StatusForbidden && isCloudflareChallengeResponse(resp) {
			_ = resp.Body.Close()
			release()
			last = fmt.Errorf("上游被 Cloudflare 拦截（HTTP 403），已尝试其他账号。")
			continue
		}
		err = upstreamHTTPError(resp)
		release()
		return nil, err
	}
	if last != nil {
		return nil, last
	}
	return nil, errors.New("内置 reverse 请求失败。")
}

func (s *Service) postCodexWithToken(ctx context.Context, token string, payload []byte) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(s.baseURL(), "/")+codexResponsesPath, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	setBrowserHeaders(req.Header)
	return s.client.Do(req)
}

func (s *Service) markAccountSuccess(ctx context.Context, name string) {
	if s == nil || s.store == nil || name == "" {
		return
	}
	if err := s.store.MarkAuthAccountSuccess(ctx, name); err != nil && s.logger != nil {
		s.logger.Warn("chatgpt reverse auth success update failed", "scope", "reverse", "name", name, "err", err.Error())
	}
}

func (s *Service) markAccountExpired(ctx context.Context, name string) {
	if s == nil || s.store == nil || name == "" {
		return
	}
	status := http.StatusUnauthorized
	if err := s.store.MarkAuthAccountFailure(ctx, name, AuthCheckStatusExpired, "登录态失效或 access_token 已过期，已从 reverse 池中禁用。", &status, true); err != nil && s.logger != nil {
		s.logger.Warn("chatgpt reverse auth failure update failed", "scope", "reverse", "name", name, "err", err.Error())
	}
}

func normalizeResponsesBody(body map[string]any) map[string]any {
	next := cloneMap(body)
	if strings.TrimSpace(stringValue(next["model"], "")) == "" {
		next["model"] = defaultResponsesModel
	}
	next["store"] = false
	if tools, ok := next["tools"].([]any); ok {
		for _, item := range tools {
			tool, ok := item.(map[string]any)
			if !ok || stringValue(tool["type"], "") != "image_generation" {
				continue
			}
			if stringValue(tool["model"], "") == "" {
				tool["model"] = defaultImageModel
			}
			if stringValue(tool["output_format"], "") == "" {
				tool["output_format"] = "png"
			}
		}
		next["tools"] = tools
		if _, ok := next["tool_choice"]; !ok {
			next["tool_choice"] = map[string]any{"type": "image_generation"}
		}
	}
	return next
}

func codexBodyFromImageRequest(body map[string]any, inputImages []string) map[string]any {
	prompt := stringValue(body["prompt"], "")
	action := "generate"
	if len(inputImages) > 0 {
		action = "edit"
	}
	content := []any{map[string]any{"type": "input_text", "text": prompt}}
	for _, image := range inputImages {
		content = append(content, map[string]any{"type": "input_image", "image_url": image})
	}
	tool := map[string]any{
		"type":          "image_generation",
		"model":         defaultImageModel,
		"action":        action,
		"size":          stringValue(body["size"], "1024x1024"),
		"quality":       stringValue(body["quality"], "auto"),
		"output_format": stringValue(body["output_format"], "png"),
	}
	if v := stringValue(body["output_compression"], ""); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			tool["output_compression"] = n
		}
	}
	return map[string]any{
		"model":        defaultResponsesModel,
		"instructions": codexImageInstructions,
		"store":        false,
		"input": []any{map[string]any{
			"role":    "user",
			"content": content,
		}},
		"tools":       []any{tool},
		"tool_choice": map[string]any{"type": "image_generation"},
		"stream":      true,
	}
}

func (s *Service) baseURL() string {
	base := strings.TrimSpace(s.cfg.ChatGPTReverseBaseURL)
	if base == "" {
		return defaultBaseURL
	}
	return base
}

func (s *Service) rotate(accounts []account) []account {
	s.mu.Lock()
	start := s.next
	s.next++
	s.mu.Unlock()
	if len(accounts) == 0 {
		return accounts
	}
	start %= len(accounts)
	out := make([]account, 0, len(accounts))
	out = append(out, accounts[start:]...)
	out = append(out, accounts[:start]...)
	return out
}

var errNoUntriedAccountSlots = errors.New("no untried account slots")

func (s *Service) reverseAccountConcurrency() int {
	if s == nil {
		return 1
	}
	if s.settings != nil {
		return config.NormalizeReverseAccountConcurrency(s.settings.Payload().ReverseAccountConcurrency, 1)
	}
	if s.cfg != nil {
		return config.NormalizeReverseAccountConcurrency(s.cfg.ReverseAccountConcurrency, 1)
	}
	return 1
}

func (s *Service) acquireAccountSlot(ctx context.Context, accounts []account, tried map[string]bool, limit int) (account, string, func(), error) {
	limit = config.NormalizeReverseAccountConcurrency(limit, 1)
	for {
		s.mu.Lock()
		if s.accountBusy == nil {
			s.accountBusy = map[string]int{}
		}
		if s.accountWait == nil {
			s.accountWait = make(chan struct{})
		}
		if err := ctx.Err(); err != nil {
			s.mu.Unlock()
			return account{}, "", nil, err
		}
		start := s.next
		untried := 0
		for i := 0; i < len(accounts); i++ {
			idx := (start + i) % len(accounts)
			acc := accounts[idx]
			key := accountSlotKey(acc)
			if key == "" || tried[key] {
				continue
			}
			untried++
			if s.accountBusy[key] >= limit {
				continue
			}
			s.accountBusy[key]++
			s.next = idx + 1
			s.mu.Unlock()
			var once sync.Once
			release := func() {
				once.Do(func() {
					s.releaseAccountSlot(key)
				})
			}
			return acc, key, release, nil
		}
		if untried == 0 {
			s.mu.Unlock()
			return account{}, "", nil, errNoUntriedAccountSlots
		}
		wait := s.accountWait
		s.mu.Unlock()

		select {
		case <-ctx.Done():
			return account{}, "", nil, ctx.Err()
		case <-wait:
		}
	}
}

func (s *Service) releaseAccountSlot(key string) {
	if key == "" {
		return
	}
	s.mu.Lock()
	if s.accountBusy != nil {
		if count := s.accountBusy[key]; count <= 1 {
			delete(s.accountBusy, key)
		} else {
			s.accountBusy[key] = count - 1
		}
	}
	wait := s.accountWait
	s.accountWait = make(chan struct{})
	s.mu.Unlock()
	if wait != nil {
		close(wait)
	}
}

func accountSlotKey(acc account) string {
	if acc.Name != "" {
		return "name:" + acc.Name
	}
	if acc.AccessToken != "" {
		return "token:" + acc.AccessToken
	}
	return ""
}

func responseWithAccountSlotRelease(resp *http.Response, release func()) *http.Response {
	if resp == nil {
		release()
		return nil
	}
	if resp.Body == nil {
		release()
		return resp
	}
	resp.Body = &accountSlotReadCloser{ReadCloser: resp.Body, release: release}
	return resp
}

type accountSlotReadCloser struct {
	io.ReadCloser
	release func()
	once    sync.Once
}

func (r *accountSlotReadCloser) Close() error {
	err := r.ReadCloser.Close()
	r.once.Do(r.release)
	return err
}

func (s *Service) loadAccounts(ctx context.Context) ([]account, error) {
	if s == nil || s.store == nil {
		return []account{}, nil
	}
	seen := map[string]bool{}
	var out []account
	records, err := s.store.ListAuthAccounts(ctx)
	if err != nil {
		return nil, err
	}
	for _, record := range records {
		var raw map[string]any
		if json.Unmarshal([]byte(record.RawJSON), &raw) != nil {
			continue
		}
		if truthy(raw["disabled"]) {
			continue
		}
		if record.Disabled && !passwordLoginAvailable(raw) {
			continue
		}
		if !authAccountUsableForPool(record, raw) {
			continue
		}
		token := stringValue(raw["access_token"], "")
		if token == "" || seen[token] {
			continue
		}
		seen[token] = true
		out = append(out, account{
			Name:             record.Name,
			AccessToken:      token,
			RefreshToken:     stringValue(raw["refresh_token"], ""),
			Email:            stringValue(raw["email"], ""),
			DefaultModelSlug: record.DefaultModelSlug,
			Raw:              raw,
		})
	}
	return out, nil
}

func authAccountUsableForPool(record StoredAuthAccount, raw map[string]any) bool {
	switch record.Status {
	case "", AuthCheckStatusOK:
		return true
	case AuthCheckStatusExpired, AuthCheckStatusInvalid, AuthCheckStatusError:
		return passwordLoginAvailable(raw)
	case AuthCheckStatusQuotaOrRateLimited, AuthCheckStatusDisabled:
		return false
	default:
		return true
	}
}

func (s *Service) refreshIfNeeded(ctx context.Context, acc account, force bool) (account, bool) {
	if !force && !tokenExpiresSoon(acc.AccessToken, time.Hour) {
		return acc, false
	}
	if acc.RefreshToken == "" {
		return s.passwordRelogin(ctx, acc)
	}
	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", acc.RefreshToken)
	form.Set("client_id", "app_2SKx67EdpoN0G6j64rFvigXD")
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://auth.openai.com/oauth/token", strings.NewReader(form.Encode()))
	if err != nil {
		return acc, false
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", defaultUserAgent())
	resp, err := s.client.Do(req)
	if err != nil {
		s.logRefreshError(acc, err)
		return s.passwordRelogin(ctx, acc)
	}
	defer resp.Body.Close()
	var body map[string]any
	_ = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&body)
	if resp.StatusCode != http.StatusOK || stringValue(body["access_token"], "") == "" {
		s.logRefreshError(acc, fmt.Errorf("oauth_refresh_http_%d", resp.StatusCode))
		return s.passwordRelogin(ctx, acc)
	}
	next := acc
	next.AccessToken = stringValue(body["access_token"], acc.AccessToken)
	next.RefreshToken = stringValue(body["refresh_token"], acc.RefreshToken)
	if acc.Name != "" && acc.Raw != nil && s.store != nil {
		raw := cloneMap(acc.Raw)
		raw["access_token"] = next.AccessToken
		raw["refresh_token"] = next.RefreshToken
		if idToken := stringValue(body["id_token"], ""); idToken != "" {
			raw["id_token"] = idToken
		}
		raw["last_token_refresh_at"] = time.Now().UTC().Format(time.RFC3339)
		raw["last_token_refresh_error"] = nil
		_ = s.store.UpdateAuthAccountJSON(ctx, acc.Name, raw)
		next.Raw = raw
	}
	return next, true
}

func (s *Service) passwordRelogin(ctx context.Context, acc account) (account, bool) {
	if !passwordLoginAvailable(acc.Raw) {
		return acc, false
	}
	username := passwordLoginUsername(acc.Raw)
	password := stringValue(acc.Raw["password"], "")
	form := url.Values{}
	form.Set("grant_type", "password")
	form.Set("username", username)
	form.Set("password", password)
	form.Set("client_id", stringValue(acc.Raw["client_id"], "app_2SKx67EdpoN0G6j64rFvigXD"))
	if scope := stringValue(acc.Raw["scope"], ""); scope != "" {
		form.Set("scope", scope)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, passwordLoginURL(acc.Raw), strings.NewReader(form.Encode()))
	if err != nil {
		return acc, false
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", defaultUserAgent())
	resp, err := s.client.Do(req)
	if err != nil {
		s.logPasswordLoginError(acc, err)
		return acc, false
	}
	defer resp.Body.Close()
	var body map[string]any
	_ = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&body)
	if resp.StatusCode != http.StatusOK || stringValue(body["access_token"], "") == "" {
		s.logPasswordLoginError(acc, fmt.Errorf("password_login_http_%d", resp.StatusCode))
		return acc, false
	}
	next := acc
	next.AccessToken = stringValue(body["access_token"], acc.AccessToken)
	next.RefreshToken = stringValue(body["refresh_token"], acc.RefreshToken)
	if acc.Name != "" && acc.Raw != nil && s.store != nil {
		raw := cloneMap(acc.Raw)
		raw["access_token"] = next.AccessToken
		if next.RefreshToken != "" {
			raw["refresh_token"] = next.RefreshToken
		}
		if idToken := stringValue(body["id_token"], ""); idToken != "" {
			raw["id_token"] = idToken
		}
		if email := stringValue(body["email"], ""); email != "" {
			raw["email"] = email
			next.Email = email
		}
		raw["last_password_login_at"] = time.Now().UTC().Format(time.RFC3339)
		raw["last_password_login_error"] = nil
		_ = s.store.UpdateAuthAccountJSON(ctx, acc.Name, raw)
		next.Raw = raw
	}
	return next, true
}

func passwordLoginAvailable(raw map[string]any) bool {
	return raw != nil && passwordLoginUsername(raw) != "" && stringValue(raw["password"], "") != ""
}

func passwordLoginUsername(raw map[string]any) string {
	for _, key := range []string{"username", "email", "login", "account"} {
		if value := stringValue(raw[key], ""); value != "" {
			return value
		}
	}
	return ""
}

func passwordLoginURL(raw map[string]any) string {
	for _, key := range []string{"password_login_url", "login_url", "oauth_token_url"} {
		if value := stringValue(raw[key], ""); value != "" {
			return value
		}
	}
	return "https://auth.openai.com/oauth/token"
}

func (s *Service) logRefreshError(acc account, err error) {
	if s.logger != nil {
		s.logger.Warn("chatgpt reverse token refresh failed", "scope", "reverse", "email", acc.Email, "err", err.Error())
	}
}

func (s *Service) logPasswordLoginError(acc account, err error) {
	if s.logger != nil {
		s.logger.Warn("chatgpt reverse password login failed", "scope", "reverse", "email", acc.Email, "err", err.Error())
	}
}
