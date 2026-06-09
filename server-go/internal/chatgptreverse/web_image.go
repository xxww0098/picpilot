package chatgptreverse

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const (
	chatRequirementsPath    = "/backend-api/sentinel/chat-requirements"
	conversationPreparePath = "/backend-api/f/conversation/prepare"
	conversationPath        = "/backend-api/f/conversation"
	conversationGetPrefix   = "/backend-api/conversation/"
	filesPathPrefix         = "/backend-api/files/"
)

var (
	fileServiceIDRe   = regexp.MustCompile(`file-service://([A-Za-z0-9_-]+)`)
	realImageFileIDRe = regexp.MustCompile(`\bfile_00000000[a-f0-9]{24}\b`)
	sedimentIDRe      = regexp.MustCompile(`sediment://([A-Za-z0-9_-]+)`)
)

var (
	webImageDownloadURLReadyTimeout = 60 * time.Second
	webImageDownloadURLRetryDelay   = 2 * time.Second
)

type chatRequirements struct {
	Token          string
	ProofToken     string
	TurnstileToken string
	SOToken        string
}

type webImageState struct {
	ConversationID string
	FileIDs        []string
	SedimentIDs    []string
	Blocked        bool
	ToolInvoked    bool
	TurnUseCase    string
	Message        string
}

type webSession struct {
	AccessToken string
	DeviceID    string
	SessionID   string
}

type downloadURLCandidate struct {
	Source string
	ID     string
	Path   string
}

type downloadURLResult struct {
	URL    string
	Status string
}

func newWebSession(accessToken string) webSession {
	return webSession{
		AccessToken: accessToken,
		DeviceID:    randomID(),
		SessionID:   randomID(),
	}
}

func (s *Service) collectWebImages(ctx context.Context, imageBody map[string]any) (map[string]any, error) {
	n := positiveInt(imageBody["n"], 1)
	if n < 1 {
		n = 1
	}
	data := make([]map[string]any, 0, n)
	for i := 0; i < n; i++ {
		item, err := s.collectOneWebImage(ctx, imageBody)
		if err != nil {
			return nil, err
		}
		data = append(data, item)
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

func (s *Service) collectOneWebImage(ctx context.Context, imageBody map[string]any) (map[string]any, error) {
	accounts, err := s.loadAccounts(ctx)
	if err != nil {
		return nil, err
	}
	if len(accounts) == 0 {
		return nil, errors.New("内置 reverse 未配置 ChatGPT access_token。")
	}
	var last error
	for _, acc := range s.rotate(accounts) {
		active := acc
		if refreshed, ok := s.refreshIfNeeded(ctx, active, false); ok {
			active = refreshed
		}
		item, err := s.collectOneWebImageWithAccount(ctx, active, imageBody)
		if err == nil {
			s.markAccountSuccess(ctx, active.Name)
			return item, nil
		}
		last = err
		var statusErr *httpStatusError
		if errors.As(err, &statusErr) && statusErr.Status == http.StatusUnauthorized {
			if refreshed, ok := s.refreshIfNeeded(ctx, active, true); ok && refreshed.AccessToken != active.AccessToken {
				item, err = s.collectOneWebImageWithAccount(ctx, refreshed, imageBody)
				if err == nil {
					s.markAccountSuccess(ctx, refreshed.Name)
					return item, nil
				}
				last = err
				if errors.As(err, &statusErr) && statusErr.Status == http.StatusUnauthorized {
					s.markAccountExpired(ctx, active.Name)
				}
				continue
			}
			s.markAccountExpired(ctx, active.Name)
		}
	}
	if last != nil {
		return nil, last
	}
	return nil, errors.New("内置 reverse ChatGPT Web 生图失败。")
}

func (s *Service) collectOneWebImageWithAccount(ctx context.Context, acc account, imageBody map[string]any) (map[string]any, error) {
	prompt := webImagePrompt(imageBody)
	session := newWebSession(acc.AccessToken)
	requirements, err := s.getChatRequirements(ctx, session)
	if err != nil {
		return nil, err
	}
	s.logger.Info("chatgpt web image requirements ready", "scope", "reverse", "email", acc.Email, "proof", requirements.ProofToken != "", "turnstile", requirements.TurnstileToken != "", "so", requirements.SOToken != "")
	conduit, err := s.prepareImageConversation(ctx, session, requirements, prompt, stringValue(imageBody["model"], defaultImageModel))
	if err != nil {
		return nil, err
	}
	state, err := s.startImageConversation(ctx, session, requirements, conduit, prompt, stringValue(imageBody["model"], defaultImageModel))
	if err != nil {
		return nil, err
	}
	s.logger.Info("chatgpt web image stream ended", "scope", "reverse", "email", acc.Email, "conversationId", state.ConversationID, "fileIds", len(state.FileIDs), "sedimentIds", len(state.SedimentIDs), "toolInvoked", state.ToolInvoked, "turnUseCase", state.TurnUseCase, "blocked", state.Blocked, "message", truncateLogValue(state.Message, 160))
	if len(state.FileIDs) == 0 && len(state.SedimentIDs) == 0 && state.ConversationID != "" {
		_ = s.pollImageIDs(ctx, session, &state, 120*time.Second)
	}
	s.logger.Info("chatgpt web image ids resolved", "scope", "reverse", "email", acc.Email, "conversationId", state.ConversationID, "fileIds", len(state.FileIDs), "sedimentIds", len(state.SedimentIDs))
	urls, err := s.resolveImageURLs(ctx, session, state.ConversationID, state.FileIDs, state.SedimentIDs)
	if err != nil {
		return nil, err
	}
	if len(urls) == 0 {
		if state.Blocked && state.Message != "" {
			return nil, errors.New(state.Message)
		}
		if state.Message != "" {
			return nil, fmt.Errorf("ChatGPT Web 未返回图片：%s", state.Message)
		}
		return nil, errors.New("ChatGPT Web 未返回图片。")
	}
	imageBytes, err := s.downloadImage(ctx, session, urls[0])
	if err != nil {
		s.logger.Warn("chatgpt web image download failed", "scope", "reverse", "email", acc.Email, "conversationId", state.ConversationID, "err", truncateLogValue(err.Error(), 240))
		return nil, err
	}
	row := map[string]any{"b64_json": base64.StdEncoding.EncodeToString(imageBytes)}
	if prompt := stringValue(imageBody["prompt"], ""); prompt != "" {
		row["revised_prompt"] = prompt
	}
	return row, nil
}

func (s *Service) getChatRequirements(ctx context.Context, session webSession) (chatRequirements, error) {
	sourceP := buildLegacyRequirementsToken(defaultUserAgent())
	body, _ := json.Marshal(map[string]any{"p": sourceP})
	req, err := s.newWebRequest(ctx, http.MethodPost, chatRequirementsPath, session, bytes.NewReader(body), "application/json", "application/json")
	if err != nil {
		return chatRequirements{}, err
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return chatRequirements{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 32<<10))
		return chatRequirements{}, &httpStatusError{Status: resp.StatusCode, Body: strings.TrimSpace(string(body))}
	}
	var payload map[string]any
	if err := json.NewDecoder(io.LimitReader(resp.Body, 2<<20)).Decode(&payload); err != nil {
		return chatRequirements{}, err
	}
	requirements := chatRequirements{
		Token:   stringValue(payload["token"], ""),
		SOToken: stringValue(payload["so_token"], ""),
	}
	if requirements.Token == "" {
		return chatRequirements{}, errors.New("ChatGPT Web 未返回 requirements token。")
	}
	if proof, ok := payload["proofofwork"].(map[string]any); ok && truthy(proof["required"]) {
		token, err := buildProofToken(stringValue(proof["seed"], ""), stringValue(proof["difficulty"], ""), defaultUserAgent())
		if err != nil {
			return chatRequirements{}, err
		}
		requirements.ProofToken = token
	}
	if turnstile, ok := payload["turnstile"].(map[string]any); ok && truthy(turnstile["required"]) {
		dx := stringValue(turnstile["dx"], "")
		for _, key := range []string{sourceP, requirements.ProofToken, requirements.Token, ""} {
			if token := solveTurnstileToken(dx, key); token != "" {
				requirements.TurnstileToken = token
				break
			}
		}
	}
	return requirements, nil
}

func (s *Service) prepareImageConversation(ctx context.Context, session webSession, requirements chatRequirements, prompt, model string) (string, error) {
	body, _ := json.Marshal(map[string]any{
		"action":                "next",
		"fork_from_shared_post": false,
		"parent_message_id":     randomID(),
		"model":                 webImageModelSlug(model),
		"client_prepare_state":  "success",
		"timezone_offset_min":   -480,
		"timezone":              "Asia/Shanghai",
		"conversation_mode":     map[string]any{"kind": "primary_assistant"},
		"system_hints":          []any{"picture_v2"},
		"partial_query": map[string]any{
			"id":      randomID(),
			"author":  map[string]any{"role": "user"},
			"content": map[string]any{"content_type": "text", "parts": []any{prompt}},
		},
		"supports_buffering":     true,
		"supported_encodings":    []any{"v1"},
		"client_contextual_info": map[string]any{"app_name": "chatgpt.com"},
	})
	req, err := s.newImageRequest(ctx, http.MethodPost, conversationPreparePath, session, requirements, "", bytes.NewReader(body), "application/json")
	if err != nil {
		return "", err
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 32<<10))
		return "", &httpStatusError{Status: resp.StatusCode, Body: strings.TrimSpace(string(body))}
	}
	var payload map[string]any
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&payload); err != nil {
		return "", err
	}
	conduit := stringValue(payload["conduit_token"], "")
	if conduit == "" {
		return "", errors.New("ChatGPT Web 未返回 conduit token。")
	}
	return conduit, nil
}

func (s *Service) startImageConversation(ctx context.Context, session webSession, requirements chatRequirements, conduit, prompt, model string) (webImageState, error) {
	body, _ := json.Marshal(map[string]any{
		"action": "next",
		"messages": []any{map[string]any{
			"id":          randomID(),
			"author":      map[string]any{"role": "user"},
			"create_time": float64(time.Now().UnixNano()) / 1e9,
			"content":     map[string]any{"content_type": "text", "parts": []any{prompt}},
			"metadata": map[string]any{
				"developer_mode_connector_ids": []any{},
				"selected_github_repos":        []any{},
				"selected_all_github_repos":    false,
				"system_hints":                 []any{"picture_v2"},
				"serialization_metadata":       map[string]any{"custom_symbol_offsets": []any{}},
			},
		}},
		"parent_message_id":        randomID(),
		"model":                    webImageModelSlug(model),
		"client_prepare_state":     "sent",
		"timezone_offset_min":      -480,
		"timezone":                 "Asia/Shanghai",
		"conversation_mode":        map[string]any{"kind": "primary_assistant"},
		"enable_message_followups": true,
		"system_hints":             []any{"picture_v2"},
		"supports_buffering":       true,
		"supported_encodings":      []any{"v1"},
		"client_contextual_info": map[string]any{
			"is_dark_mode":      false,
			"time_since_loaded": 1200,
			"page_height":       1072,
			"page_width":        1724,
			"pixel_ratio":       1.2,
			"screen_height":     1440,
			"screen_width":      2560,
			"app_name":          "chatgpt.com",
		},
		"paragen_cot_summary_display_override": "allow",
		"force_parallel_switch":                "auto",
	})
	req, err := s.newImageRequest(ctx, http.MethodPost, conversationPath, session, requirements, conduit, bytes.NewReader(body), "text/event-stream")
	if err != nil {
		return webImageState{}, err
	}
	req.Header.Set("X-Oai-Turn-Trace-Id", randomID())
	resp, err := s.client.Do(req)
	if err != nil {
		return webImageState{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 32<<10))
		return webImageState{}, &httpStatusError{Status: resp.StatusCode, Body: strings.TrimSpace(string(body))}
	}
	events, err := readSSEEvents(resp.Body)
	if err != nil {
		return webImageState{}, err
	}
	return webImageStateFromEvents(events), nil
}

func (s *Service) pollImageIDs(ctx context.Context, session webSession, state *webImageState, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	if wait := 10 * time.Second; wait > 0 {
		if err := sleepContext(ctx, wait); err != nil {
			return err
		}
	}
	for time.Now().Before(deadline) {
		path := conversationGetPrefix + url.PathEscape(state.ConversationID)
		req, err := s.newWebRequest(ctx, http.MethodGet, path, session, nil, "", "application/json")
		if err != nil {
			return err
		}
		resp, err := s.client.Do(req)
		if err != nil {
			_ = sleepContext(ctx, 5*time.Second)
			continue
		}
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			var payload any
			_ = json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&payload)
			_ = resp.Body.Close()
			mergeImageIDs(state, payload, true)
			s.logger.Info("chatgpt web image poll check", "scope", "reverse", "conversationId", state.ConversationID, "fileIds", len(state.FileIDs), "sedimentIds", len(state.SedimentIDs))
			if len(state.FileIDs) > 0 || len(state.SedimentIDs) > 0 {
				return nil
			}
		} else {
			_ = resp.Body.Close()
		}
		if err := sleepContext(ctx, 10*time.Second); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) resolveImageURLs(ctx context.Context, session webSession, conversationID string, fileIDs, sedimentIDs []string) ([]string, error) {
	candidates := downloadURLCandidates(conversationID, fileIDs, sedimentIDs)
	if len(candidates) == 0 {
		return nil, nil
	}
	deadline := time.Now().Add(webImageDownloadURLReadyTimeout)
	attempt := 0
	var lastErr error
	var lastStatus string
	for {
		attempt++
		var out []string
		for _, candidate := range candidates {
			result, err := s.getDownloadURL(ctx, session, candidate.Path)
			if err != nil {
				lastErr = err
				if isTerminalDownloadURLError(err) {
					s.logger.Warn("chatgpt web file download url failed", "scope", "reverse", "source", candidate.Source, "id", candidate.ID, "err", truncateLogValue(err.Error(), 240))
					return nil, err
				}
				if attempt == 1 || attempt%5 == 0 {
					s.logger.Info("chatgpt web file download url not ready", "scope", "reverse", "source", candidate.Source, "id", candidate.ID, "attempt", attempt, "err", truncateLogValue(err.Error(), 240))
				}
				continue
			}
			lastStatus = result.Status
			if result.URL != "" && !containsString(out, result.URL) {
				out = append(out, result.URL)
			}
			if result.URL == "" && (attempt == 1 || attempt%5 == 0) {
				s.logger.Info("chatgpt web file download url not ready", "scope", "reverse", "source", candidate.Source, "id", candidate.ID, "attempt", attempt, "status", truncateLogValue(result.Status, 80))
			}
		}
		if len(out) > 0 {
			if attempt > 1 {
				s.logger.Info("chatgpt web file download url ready", "scope", "reverse", "attempt", attempt, "urls", len(out))
			}
			return out, nil
		}
		if !time.Now().Before(deadline) {
			if lastErr != nil {
				return nil, fmt.Errorf("ChatGPT Web 图片下载地址未就绪：%w", lastErr)
			}
			if lastStatus != "" {
				return nil, fmt.Errorf("ChatGPT Web 图片下载地址未就绪：status=%s", lastStatus)
			}
			return nil, errors.New("ChatGPT Web 图片下载地址未就绪。")
		}
		if err := sleepContext(ctx, webImageDownloadURLRetryDelay); err != nil {
			return nil, err
		}
	}
}

func downloadURLCandidates(conversationID string, fileIDs, sedimentIDs []string) []downloadURLCandidate {
	var out []downloadURLCandidate
	seen := map[string]bool{}
	for _, fileID := range fileIDs {
		if fileID == "" || fileID == "file_upload" {
			continue
		}
		path := filesPathPrefix + url.PathEscape(fileID) + "/download"
		key := "file:" + fileID + ":" + path
		if !seen[key] {
			seen[key] = true
			out = append(out, downloadURLCandidate{Source: "file", ID: fileID, Path: path})
		}
	}
	if conversationID != "" {
		for _, sedimentID := range sedimentIDs {
			if sedimentID == "" {
				continue
			}
			path := conversationGetPrefix + url.PathEscape(conversationID) + "/attachment/" + url.PathEscape(sedimentID) + "/download"
			key := "sediment:" + sedimentID + ":" + path
			if !seen[key] {
				seen[key] = true
				out = append(out, downloadURLCandidate{Source: "sediment", ID: sedimentID, Path: path})
			}
		}
	}
	return out
}

func isTerminalDownloadURLError(err error) bool {
	var statusErr *httpStatusError
	if !errors.As(err, &statusErr) {
		return false
	}
	return statusErr.Status == http.StatusUnauthorized || statusErr.Status == http.StatusForbidden
}

func (s *Service) getDownloadURL(ctx context.Context, session webSession, path string) (downloadURLResult, error) {
	req, err := s.newWebRequest(ctx, http.MethodGet, path, session, nil, "", "application/json")
	if err != nil {
		return downloadURLResult{}, err
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return downloadURLResult{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return downloadURLResult{}, upstreamHTTPError(resp)
	}
	var payload map[string]any
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&payload); err != nil {
		return downloadURLResult{}, err
	}
	return downloadURLResult{
		URL:    stringValue(payload["download_url"], stringValue(payload["url"], "")),
		Status: stringValue(payload["status"], ""),
	}, nil
}

func (s *Service) downloadImage(ctx context.Context, session webSession, imageURL string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, imageURL, nil)
	if err != nil {
		return nil, err
	}
	if session.AccessToken != "" {
		req.Header.Set("Authorization", "Bearer "+session.AccessToken)
	}
	setChatGPTDownloadHeaders(req.Header, imageURL, session)
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, upstreamHTTPError(resp)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 64<<20))
}

func setChatGPTDownloadHeaders(h http.Header, target string, session webSession) {
	h.Set("Accept", "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8")
	h.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8,en-US;q=0.7")
	h.Set("Cache-Control", "no-cache")
	h.Set("Origin", defaultBaseURL)
	h.Set("Pragma", "no-cache")
	h.Set("Referer", defaultBaseURL+"/")
	h.Set("Sec-Ch-Ua", `"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"`)
	h.Set("Sec-Ch-Ua-Mobile", "?0")
	h.Set("Sec-Ch-Ua-Platform", `"Windows"`)
	h.Set("Sec-Fetch-Dest", "image")
	h.Set("Sec-Fetch-Mode", "no-cors")
	h.Set("Sec-Fetch-Site", "same-origin")
	h.Set("User-Agent", defaultUserAgent())
	h.Set("OAI-Language", "zh-CN")
	h.Set("OAI-Client-Version", "prod-a194cd50d4416d3c0b47c740f206b12ce60f5887")
	h.Set("OAI-Client-Build-Number", "6708908")
	h.Set("OAI-Device-Id", session.DeviceID)
	h.Set("OAI-Session-Id", session.SessionID)
	h.Set("X-OpenAI-Target-Path", target)
	h.Set("X-OpenAI-Target-Route", target)
}

func (s *Service) newImageRequest(ctx context.Context, method, path string, session webSession, requirements chatRequirements, conduit string, body io.Reader, accept string) (*http.Request, error) {
	req, err := s.newWebRequest(ctx, method, path, session, body, "application/json", accept)
	if err != nil {
		return nil, err
	}
	req.Header.Set("OpenAI-Sentinel-Chat-Requirements-Token", requirements.Token)
	if requirements.ProofToken != "" {
		req.Header.Set("OpenAI-Sentinel-Proof-Token", requirements.ProofToken)
	}
	if requirements.TurnstileToken != "" {
		req.Header.Set("OpenAI-Sentinel-Turnstile-Token", requirements.TurnstileToken)
	}
	if requirements.SOToken != "" {
		req.Header.Set("OpenAI-Sentinel-SO-Token", requirements.SOToken)
	}
	if conduit != "" {
		req.Header.Set("X-Conduit-Token", conduit)
	}
	return req, nil
}

func (s *Service) newWebRequest(ctx context.Context, method, path string, session webSession, body io.Reader, contentType, accept string) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(s.baseURL(), "/")+path, body)
	if err != nil {
		return nil, err
	}
	if session.AccessToken != "" {
		req.Header.Set("Authorization", "Bearer "+session.AccessToken)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
	setChatGPTWebHeaders(req.Header, path, session)
	return req, nil
}

func setChatGPTWebHeaders(h http.Header, path string, session webSession) {
	h.Set("Origin", defaultBaseURL)
	h.Set("Referer", defaultBaseURL+"/")
	h.Set("User-Agent", defaultUserAgent())
	h.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8,en-US;q=0.7")
	h.Set("Cache-Control", "no-cache")
	h.Set("Pragma", "no-cache")
	h.Set("Priority", "u=1, i")
	h.Set("Sec-Ch-Ua", `"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"`)
	h.Set("Sec-Ch-Ua-Arch", `"x86"`)
	h.Set("Sec-Ch-Ua-Bitness", `"64"`)
	h.Set("Sec-Ch-Ua-Full-Version", `"143.0.3650.96"`)
	h.Set("Sec-Ch-Ua-Full-Version-List", `"Microsoft Edge";v="143.0.3650.96", "Chromium";v="143.0.7499.147", "Not A(Brand";v="24.0.0.0"`)
	h.Set("Sec-Ch-Ua-Mobile", "?0")
	h.Set("Sec-Ch-Ua-Model", `""`)
	h.Set("Sec-Ch-Ua-Platform", `"Windows"`)
	h.Set("Sec-Ch-Ua-Platform-Version", `"19.0.0"`)
	h.Set("Sec-Fetch-Dest", "empty")
	h.Set("Sec-Fetch-Mode", "cors")
	h.Set("Sec-Fetch-Site", "same-origin")
	h.Set("OAI-Language", "zh-CN")
	h.Set("OAI-Client-Version", "prod-a194cd50d4416d3c0b47c740f206b12ce60f5887")
	h.Set("OAI-Client-Build-Number", "6708908")
	h.Set("OAI-Device-Id", session.DeviceID)
	h.Set("OAI-Session-Id", session.SessionID)
	h.Set("X-OpenAI-Target-Path", path)
	h.Set("X-OpenAI-Target-Route", path)
}

func webImagePrompt(body map[string]any) string {
	prompt := strings.TrimSpace(stringValue(body["prompt"], ""))
	var hints []string
	if size := strings.TrimSpace(stringValue(body["size"], "")); size != "" {
		hints = append(hints, "输出图片尺寸为 "+size+"。")
	}
	if quality := strings.TrimSpace(stringValue(body["quality"], "")); quality != "" {
		hints = append(hints, "输出图片质量为 "+quality+"。")
	}
	if len(hints) == 0 {
		return prompt
	}
	return prompt + "\n\n" + strings.Join(hints, "")
}

func webImageModelSlug(model string) string {
	switch strings.ToLower(strings.TrimSpace(model)) {
	case "", "gpt-image-2":
		return "gpt-5-3"
	case "codex-gpt-image-2":
		return "codex-gpt-image-2"
	default:
		return "auto"
	}
}

func webImageStateFromEvents(events []map[string]any) webImageState {
	var state webImageState
	for _, event := range events {
		updateWebImageState(&state, event)
	}
	return state
}

func updateWebImageState(state *webImageState, event map[string]any) {
	if conversationID := stringValue(event["conversation_id"], ""); conversationID != "" {
		state.ConversationID = conversationID
	}
	if value, ok := event["v"].(map[string]any); ok {
		if conversationID := stringValue(value["conversation_id"], ""); conversationID != "" {
			state.ConversationID = conversationID
		}
	}
	if stringValue(event["type"], "") == "moderation" {
		if moderation, ok := event["moderation_response"].(map[string]any); ok && truthy(moderation["blocked"]) {
			state.Blocked = true
		}
	}
	if stringValue(event["type"], "") == "server_ste_metadata" {
		if metadata, ok := event["metadata"].(map[string]any); ok {
			if v, ok := metadata["tool_invoked"].(bool); ok {
				state.ToolInvoked = v
			}
			if turn := stringValue(metadata["turn_use_case"], ""); turn != "" {
				state.TurnUseCase = turn
			}
		}
	}
	if text := assistantTextFromEvent(event); text != "" {
		state.Message = text
	}
	body, _ := json.Marshal(event)
	if state.ConversationID == "" {
		if match := regexp.MustCompile(`"conversation_id"\s*:\s*"([^"]+)"`).FindStringSubmatch(string(body)); len(match) > 1 {
			state.ConversationID = match[1]
		}
	}
	if isImageToolEvent(event) || state.ToolInvoked || (strings.Contains(string(body), "asset_pointer") && !isUserMessageEvent(event)) {
		addUniqueStrings(&state.FileIDs, findSubmatchValues(fileServiceIDRe, string(body)))
		addUniqueStrings(&state.FileIDs, realImageFileIDRe.FindAllString(string(body), -1))
		addUniqueStrings(&state.SedimentIDs, findSubmatchValues(sedimentIDRe, string(body)))
	}
}

func mergeImageIDs(state *webImageState, payload any, force bool) {
	body, _ := json.Marshal(payload)
	if force || strings.Contains(string(body), "image_asset_pointer") || strings.Contains(string(body), "asset_pointer") {
		addUniqueStrings(&state.FileIDs, findSubmatchValues(fileServiceIDRe, string(body)))
		addUniqueStrings(&state.FileIDs, realImageFileIDRe.FindAllString(string(body), -1))
		addUniqueStrings(&state.SedimentIDs, findSubmatchValues(sedimentIDRe, string(body)))
	}
}

func isImageToolEvent(event map[string]any) bool {
	message := messageFromEvent(event)
	if message == nil {
		return false
	}
	author, _ := message["author"].(map[string]any)
	metadata, _ := message["metadata"].(map[string]any)
	content, _ := message["content"].(map[string]any)
	if stringValue(author["role"], "") != "tool" {
		return false
	}
	if stringValue(metadata["async_task_type"], "") == "image_gen" {
		return true
	}
	if stringValue(content["content_type"], "") != "multimodal_text" {
		return false
	}
	body, _ := json.Marshal(content["parts"])
	return strings.Contains(string(body), "image_asset_pointer") || strings.Contains(string(body), "asset_pointer")
}

func isUserMessageEvent(event map[string]any) bool {
	message := messageFromEvent(event)
	if message == nil {
		return false
	}
	author, _ := message["author"].(map[string]any)
	return strings.EqualFold(stringValue(author["role"], ""), "user")
}

func messageFromEvent(event map[string]any) map[string]any {
	if message, ok := event["message"].(map[string]any); ok {
		return message
	}
	if value, ok := event["v"].(map[string]any); ok {
		if message, ok := value["message"].(map[string]any); ok {
			return message
		}
	}
	return nil
}

func assistantTextFromEvent(event map[string]any) string {
	message := messageFromEvent(event)
	if message == nil {
		return ""
	}
	author, _ := message["author"].(map[string]any)
	if stringValue(author["role"], "") != "assistant" {
		return ""
	}
	content, _ := message["content"].(map[string]any)
	if parts, ok := content["parts"].([]any); ok {
		var out strings.Builder
		for _, part := range parts {
			if s, ok := part.(string); ok {
				out.WriteString(s)
			}
		}
		if out.Len() > 0 {
			return out.String()
		}
	}
	return stringValue(content["text"], "")
}

func addUniqueStrings(values *[]string, candidates []string) {
	for _, candidate := range candidates {
		if candidate != "" && !containsString(*values, candidate) {
			*values = append(*values, candidate)
		}
	}
}

func findSubmatchValues(re *regexp.Regexp, value string) []string {
	matches := re.FindAllStringSubmatch(value, -1)
	out := make([]string, 0, len(matches))
	for _, match := range matches {
		if len(match) > 1 {
			out = append(out, match[1])
		}
	}
	return out
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func truncateLogValue(value string, maxLen int) string {
	value = strings.TrimSpace(value)
	if maxLen <= 0 || len(value) <= maxLen {
		return value
	}
	return value[:maxLen] + "..."
}

func sleepContext(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
