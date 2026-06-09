package upstreamcooldown

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Info describes an upstream model cooldown response from CLIProxyAPI.
type Info struct {
	Model        string
	Provider     string
	Code         string
	Message      string
	ResetSeconds float64
	Delay        time.Duration
}

// Gate tracks per-model upstream cooldowns so local retries and queued requests do
// not keep hammering CLIProxyAPI while it has already told us every credential is cooling down.
type Gate struct {
	mu      sync.Mutex
	byModel map[string]time.Time
}

func NewGate() *Gate {
	return &Gate{byModel: make(map[string]time.Time)}
}

func normalizeModel(model string) string {
	return strings.ToLower(strings.TrimSpace(model))
}

// Set records a cooldown and returns the stored deadline. Short/empty cooldowns are ignored.
func (g *Gate) Set(model string, delay time.Duration) time.Time {
	if g == nil || delay <= 0 {
		return time.Time{}
	}
	model = normalizeModel(model)
	if model == "" {
		return time.Time{}
	}
	deadline := time.Now().Add(delay)
	g.mu.Lock()
	if cur := g.byModel[model]; cur.Before(deadline) {
		g.byModel[model] = deadline
	} else {
		deadline = cur
	}
	g.mu.Unlock()
	return deadline
}

// Wait blocks until the currently recorded cooldown for model expires.
func (g *Gate) Wait(ctx context.Context, model string) (time.Duration, error) {
	if g == nil {
		return 0, nil
	}
	model = normalizeModel(model)
	if model == "" {
		return 0, nil
	}
	g.mu.Lock()
	deadline := g.byModel[model]
	g.mu.Unlock()
	if deadline.IsZero() {
		return 0, nil
	}
	wait := time.Until(deadline)
	if wait <= 0 {
		g.mu.Lock()
		if !g.byModel[model].After(time.Now()) {
			delete(g.byModel, model)
		}
		g.mu.Unlock()
		return 0, nil
	}
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return wait, ctx.Err()
	case <-timer.C:
		return wait, nil
	}
}

// ExtractRequestModel reads the model field from a buffered JSON or multipart request body.
func ExtractRequestModel(contentType string, body []byte) string {
	if len(body) == 0 {
		return ""
	}
	mediaType, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		mediaType = strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	}
	switch {
	case strings.EqualFold(mediaType, "application/json") || strings.HasSuffix(strings.ToLower(mediaType), "+json"):
		var payload map[string]any
		if json.Unmarshal(body, &payload) == nil {
			if model, ok := payload["model"].(string); ok {
				return strings.TrimSpace(model)
			}
		}
	case strings.EqualFold(mediaType, "multipart/form-data"):
		boundary := params["boundary"]
		if boundary == "" {
			return ""
		}
		r := multipart.NewReader(bytes.NewReader(body), boundary)
		for {
			part, err := r.NextPart()
			if err != nil {
				return ""
			}
			if part.FormName() != "model" {
				_ = part.Close()
				continue
			}
			value, _ := io.ReadAll(io.LimitReader(part, 4096))
			_ = part.Close()
			return strings.TrimSpace(string(value))
		}
	}
	return ""
}

type cooldownEnvelope struct {
	Error cooldownPayload `json:"error"`
}

type cooldownPayload struct {
	Code         string `json:"code"`
	Message      string `json:"message"`
	Model        string `json:"model"`
	Provider     string `json:"provider"`
	ResetSeconds any    `json:"reset_seconds"`
	ResetTime    string `json:"reset_time"`
}

// ParseBody extracts model cooldown metadata from a JSON upstream error body.
func ParseBody(body []byte) *Info {
	if len(body) == 0 {
		return nil
	}
	var env cooldownEnvelope
	if json.Unmarshal(body, &env) != nil {
		return nil
	}
	errPayload := env.Error
	code := strings.TrimSpace(errPayload.Code)
	msg := strings.TrimSpace(errPayload.Message)
	if !strings.EqualFold(code, "model_cooldown") && !strings.Contains(strings.ToLower(msg), "cooling down") {
		return nil
	}
	delay := parseSeconds(errPayload.ResetSeconds)
	if delay <= 0 && errPayload.ResetTime != "" {
		if parsed, err := time.ParseDuration(strings.TrimSpace(errPayload.ResetTime)); err == nil {
			delay = parsed
		}
	}
	return &Info{
		Model:        strings.TrimSpace(errPayload.Model),
		Provider:     strings.TrimSpace(errPayload.Provider),
		Code:         code,
		Message:      msg,
		ResetSeconds: delay.Seconds(),
		Delay:        delay,
	}
}

func parseSeconds(v any) time.Duration {
	switch x := v.(type) {
	case float64:
		if x > 0 {
			return time.Duration(x * float64(time.Second))
		}
	case string:
		if f, err := strconv.ParseFloat(strings.TrimSpace(x), 64); err == nil && f > 0 {
			return time.Duration(f * float64(time.Second))
		}
	}
	return 0
}

// RetryAfterDelay parses Retry-After if an upstream sets it.
func RetryAfterDelay(h http.Header) time.Duration {
	value := strings.TrimSpace(h.Get("Retry-After"))
	if value == "" {
		return 0
	}
	if seconds, err := strconv.ParseFloat(value, 64); err == nil && seconds > 0 {
		return time.Duration(seconds * float64(time.Second))
	}
	if t, err := http.ParseTime(value); err == nil {
		if d := time.Until(t); d > 0 {
			return d
		}
	}
	return 0
}

func RetryAfterSeconds(delay time.Duration) string {
	if delay <= 0 {
		return ""
	}
	seconds := int(delay.Round(time.Second).Seconds())
	if seconds < 1 {
		seconds = 1
	}
	return strconv.Itoa(seconds)
}
