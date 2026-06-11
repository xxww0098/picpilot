package chatgptreverse

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type httpStatusError struct {
	Status int
	Body   string
}

func (e *httpStatusError) Error() string {
	if e.Body == "" {
		return fmt.Sprintf("upstream HTTP %d", e.Status)
	}
	return fmt.Sprintf("upstream HTTP %d: %s", e.Status, e.Body)
}

func cleanEndpoint(endpoint string) string {
	endpoint = strings.Trim(strings.TrimSpace(endpoint), "/")
	endpoint = strings.TrimPrefix(endpoint, "v1/")
	return endpoint
}

func modelList() map[string]any {
	now := time.Now().Unix()
	models := []string{defaultResponsesModel, defaultImageModel, "codex-gpt-image-2"}
	data := make([]map[string]any, 0, len(models))
	for _, id := range models {
		data = append(data, map[string]any{
			"id":         id,
			"object":     "model",
			"created":    now,
			"owned_by":   "chatgpt",
			"permission": []any{},
			"root":       id,
			"parent":     nil,
		})
	}
	return map[string]any{"object": "list", "data": data}
}

func readJSONBody(r io.Reader) (map[string]any, error) {
	body, err := io.ReadAll(io.LimitReader(r, maxJSONBodyBytes+1))
	if err != nil {
		return nil, errors.New("请求体读取失败。")
	}
	if int64(len(body)) > maxJSONBodyBytes {
		return nil, errors.New("请求体过大。")
	}
	var payload map[string]any
	if json.Unmarshal(body, &payload) != nil {
		return nil, errors.New("请求 JSON 无法解析。")
	}
	return payload, nil
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func marshalJSONResponse(payload any) (int, string, string) {
	body, err := json.Marshal(payload)
	if err != nil {
		return http.StatusInternalServerError, "application/json", jsonError("internal_error", err.Error())
	}
	return http.StatusOK, "application/json", string(body)
}

func writeServiceError(w http.ResponseWriter, err error) {
	status, contentType, body := errorResponse(err)
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body))
}

func errorResponse(err error) (int, string, string) {
	var statusErr *httpStatusError
	if errors.As(err, &statusErr) {
		return statusErr.Status, "application/json", normalizeErrorBody(statusErr.Body)
	}
	return http.StatusBadGateway, "application/json", jsonError("upstream_error", err.Error())
}

func jsonError(code, message string) string {
	body, _ := json.Marshal(map[string]any{
		"error": map[string]any{
			"code":    code,
			"message": message,
			"type":    code,
		},
	})
	return string(body)
}

func normalizeErrorBody(body string) string {
	body = strings.TrimSpace(body)
	if body == "" {
		return jsonError("upstream_error", "上游请求失败。")
	}
	var js any
	if json.Unmarshal([]byte(body), &js) == nil {
		return body
	}
	return jsonError("upstream_error", body)
}

func upstreamHTTPError(resp *http.Response) error {
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 32<<10))
	return &httpStatusError{Status: resp.StatusCode, Body: strings.TrimSpace(string(body))}
}

// isCloudflareChallengeResponse reports whether a 403 is a Cloudflare interstitial/managed
// challenge rather than a genuine upstream permission denial. These blocks are transient and
// correlated with the egress IP and the account's session cookies, so rotating to another
// account usually clears them. CF's `cf-mitigated: challenge` header is the unambiguous
// signal; the body markers cover cases where chatgpt.com serves the raw challenge HTML.
// The response body is buffered and rewound so a non-CF 403 can still be reported verbatim.
func isCloudflareChallengeResponse(resp *http.Response) bool {
	if resp == nil {
		return false
	}
	if strings.Contains(strings.ToLower(resp.Header.Get("Cf-Mitigated")), "challenge") {
		return true
	}
	if resp.Body == nil {
		return false
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 256<<10))
	resp.Body = io.NopCloser(bytes.NewReader(body))
	if err != nil {
		return false
	}
	lower := strings.ToLower(string(body))
	for _, m := range []string{
		"cf_chl",
		"challenge-error-text",
		"cdn-cgi/challenge-platform",
		"just a moment",
		"enable javascript and cookies to continue",
		"attention required",
		"you have been blocked",
	} {
		if strings.Contains(lower, m) {
			return true
		}
	}
	return false
}

func streamSSE(w http.ResponseWriter, r io.Reader) {
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	buf := make([]byte, 32<<10)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			_, _ = w.Write(buf[:n])
			if flusher != nil {
				flusher.Flush()
			}
		}
		if err != nil {
			return
		}
	}
}

func writeImageSSE(w http.ResponseWriter, payload map[string]any) {
	event := cloneMap(payload)
	event["type"] = "image_generation.completed"
	event["object"] = "image.generation.result"
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	encoded, _ := json.Marshal(event)
	_, _ = w.Write([]byte("data: "))
	_, _ = w.Write(encoded)
	_, _ = w.Write([]byte("\n\ndata: [DONE]\n\n"))
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
}

func readSSEEvents(r io.Reader) ([]map[string]any, error) {
	reader := bufio.NewReader(r)
	var events []map[string]any
	var data bytes.Buffer
	for {
		line, err := reader.ReadString('\n')
		if len(line) > 0 {
			trimmed := strings.TrimRight(line, "\r\n")
			if strings.HasPrefix(trimmed, "data:") {
				part := strings.TrimSpace(strings.TrimPrefix(trimmed, "data:"))
				if part == "[DONE]" {
					break
				}
				if data.Len() > 0 {
					data.WriteByte('\n')
				}
				data.WriteString(part)
			} else if trimmed == "" && data.Len() > 0 {
				var event map[string]any
				if json.Unmarshal(data.Bytes(), &event) == nil {
					events = append(events, event)
				}
				data.Reset()
			}
		}
		if err != nil {
			if err == io.EOF {
				if data.Len() > 0 {
					var event map[string]any
					if json.Unmarshal(data.Bytes(), &event) == nil {
						events = append(events, event)
					}
				}
				return events, nil
			}
			return events, err
		}
	}
	if data.Len() > 0 {
		var event map[string]any
		if json.Unmarshal(data.Bytes(), &event) == nil {
			events = append(events, event)
		}
	}
	return events, nil
}

func completedResponse(events []map[string]any) map[string]any {
	for i := len(events) - 1; i >= 0; i-- {
		event := events[i]
		if stringValue(event["type"], "") == "response.completed" {
			if response, ok := event["response"].(map[string]any); ok {
				return response
			}
		}
	}
	for i := len(events) - 1; i >= 0; i-- {
		if _, ok := events[i]["output"]; ok {
			return events[i]
		}
	}
	return nil
}

func extractImageItems(value any) []imageItem {
	var out []imageItem
	walkImageItems(value, &out)
	return out
}

func walkImageItems(value any, out *[]imageItem) {
	switch v := value.(type) {
	case []any:
		for _, item := range v {
			walkImageItems(item, out)
		}
	case map[string]any:
		if stringValue(v["type"], "") == "image_generation_call" {
			for _, b64 := range collectImageStrings(v["result"]) {
				*out = append(*out, imageItem{B64: b64, RevisedPrompt: stringValue(v["revised_prompt"], "")})
			}
		}
		for _, key := range []string{"response", "output", "item", "result", "data"} {
			if child, ok := v[key]; ok {
				walkImageItems(child, out)
			}
		}
	}
}

func collectImageStrings(value any) []string {
	switch v := value.(type) {
	case string:
		if strings.TrimSpace(v) == "" {
			return nil
		}
		return []string{stripDataURL(v)}
	case []any:
		var out []string
		for _, item := range v {
			out = append(out, collectImageStrings(item)...)
		}
		return out
	case map[string]any:
		for _, key := range []string{"b64_json", "base64", "image"} {
			if s := stringValue(v[key], ""); s != "" {
				return []string{stripDataURL(s)}
			}
		}
		if data, ok := v["data"]; ok {
			return collectImageStrings(data)
		}
	}
	return nil
}

func stripDataURL(value string) string {
	if strings.HasPrefix(value, "data:") {
		if _, rest, ok := strings.Cut(value, ","); ok {
			return rest
		}
	}
	return value
}

func formValue(r *http.Request, key, fallback string) string {
	if r.MultipartForm == nil || r.MultipartForm.Value == nil {
		return fallback
	}
	values := r.MultipartForm.Value[key]
	if len(values) == 0 || strings.TrimSpace(values[0]) == "" {
		return fallback
	}
	return values[0]
}

func multipartImages(r *http.Request) ([]string, error) {
	if r.MultipartForm == nil || r.MultipartForm.File == nil {
		return nil, errors.New("请上传 image 文件。")
	}
	headers := append([]*multipart.FileHeader{}, r.MultipartForm.File["image"]...)
	headers = append(headers, r.MultipartForm.File["image[]"]...)
	if len(headers) == 0 {
		return nil, errors.New("请上传 image 文件。")
	}
	images := make([]string, 0, len(headers))
	for _, header := range headers {
		dataURL, err := fileHeaderToDataURL(header)
		if err != nil {
			return nil, err
		}
		images = append(images, dataURL)
	}
	return images, nil
}

func fileHeaderToDataURL(header *multipart.FileHeader) (string, error) {
	file, err := header.Open()
	if err != nil {
		return "", errors.New("图片文件读取失败。")
	}
	defer file.Close()
	const maxImageFileBytes = 32 << 20
	data, err := io.ReadAll(io.LimitReader(file, maxImageFileBytes+1))
	if err != nil {
		return "", errors.New("图片文件读取失败。")
	}
	if len(data) > maxImageFileBytes {
		return "", errors.New("图片文件过大。")
	}
	if len(data) == 0 {
		return "", errors.New("图片文件为空。")
	}
	contentType := header.Header.Get("Content-Type")
	if contentType == "" {
		contentType = http.DetectContentType(data)
	}
	if contentType == "" || contentType == "application/octet-stream" {
		if ext := strings.ToLower(filepath.Ext(header.Filename)); ext != "" {
			contentType = mime.TypeByExtension(ext)
		}
	}
	if contentType == "" {
		contentType = "image/png"
	}
	return "data:" + contentType + ";base64," + base64.StdEncoding.EncodeToString(data), nil
}

func setBrowserHeaders(h http.Header) {
	h.Set("Origin", defaultBaseURL)
	h.Set("Referer", defaultBaseURL+"/")
	h.Set("User-Agent", defaultUserAgent())
	h.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8,en-US;q=0.7")
	h.Set("Cache-Control", "no-cache")
	h.Set("Pragma", "no-cache")
	h.Set("OAI-Language", "zh-CN")
	h.Set("OAI-Client-Version", "prod-a194cd50d4416d3c0b47c740f206b12ce60f5887")
	h.Set("OAI-Client-Build-Number", "6708908")
	h.Set("OAI-Device-Id", randomID())
	h.Set("OAI-Session-Id", randomID())
}

func defaultUserAgent() string {
	return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0"
}

func randomID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func tokenExpiresSoon(token string, within time.Duration) bool {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		payload, err = base64.URLEncoding.DecodeString(parts[1])
	}
	if err != nil {
		return false
	}
	var body map[string]any
	if json.Unmarshal(payload, &body) != nil {
		return false
	}
	exp := int64(0)
	switch v := body["exp"].(type) {
	case float64:
		exp = int64(v)
	case json.Number:
		exp, _ = v.Int64()
	}
	return exp > 0 && time.Until(time.Unix(exp, 0)) <= within
}

func stringValue(value any, fallback string) string {
	switch v := value.(type) {
	case string:
		if strings.TrimSpace(v) == "" {
			return fallback
		}
		return v
	case fmt.Stringer:
		s := v.String()
		if strings.TrimSpace(s) == "" {
			return fallback
		}
		return s
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case int:
		return strconv.Itoa(v)
	case int64:
		return strconv.FormatInt(v, 10)
	case json.Number:
		return v.String()
	default:
		return fallback
	}
}

func positiveInt(value any, fallback int) int {
	switch v := value.(type) {
	case float64:
		if v > 0 {
			return int(v)
		}
	case int:
		if v > 0 {
			return v
		}
	case string:
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil && n > 0 {
			return n
		}
	case json.Number:
		if n, err := v.Int64(); err == nil && n > 0 {
			return int(n)
		}
	}
	return fallback
}

func truthy(value any) bool {
	switch v := value.(type) {
	case bool:
		return v
	case string:
		switch strings.ToLower(strings.TrimSpace(v)) {
		case "1", "true", "yes", "on":
			return true
		}
	case float64:
		return v != 0
	case int:
		return v != 0
	}
	return false
}

func cloneMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}
