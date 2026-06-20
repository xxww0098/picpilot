// Package proxy ports the authenticated API proxy (/api-proxy/*) from server/index.ts.
//
// It forwards OpenAI-compatible requests to the active upstream selected by
// UPSTREAM_MODE, injecting the upstream key behind the global concurrency queue.
// Unlike the Bun/Hono version it needs NO SSE heartbeat hack: Go's http.Server has no
// write/idle deadline here, and ReverseProxy with FlushInterval=-1 streams chunks
// immediately, so long silent streams stay alive.
package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/picpilot/server-go/internal/auth"
	"github.com/xxww0098/picpilot/server-go/internal/chatgptreverse"
	"github.com/xxww0098/picpilot/server-go/internal/config"
	"github.com/xxww0098/picpilot/server-go/internal/httpx"
	"github.com/xxww0098/picpilot/server-go/internal/outboundproxy"
	"github.com/xxww0098/picpilot/server-go/internal/queue"
	"github.com/xxww0098/picpilot/server-go/internal/settings"
	"github.com/xxww0098/picpilot/server-go/internal/upstream"
	"github.com/xxww0098/picpilot/server-go/internal/upstreamcooldown"
)

// hop-by-hop headers stripped on both request and response (mirrors HOP_BY_HOP_HEADERS).
var hopByHop = []string{
	"Connection", "Content-Length", "Keep-Alive", "Proxy-Authenticate",
	"Proxy-Authorization", "Te", "Trailer", "Transfer-Encoding", "Upgrade",
}

var imagesGenRe = regexp.MustCompile(`(?i)/images/generations/?$`)

// Proxy holds dependencies for the API proxy.
type Proxy struct {
	cfg       *config.Config
	q         *queue.Queue
	settings  *settings.Provider
	auth      *auth.Auth
	logger    *slog.Logger
	transport http.RoundTripper
	reverse   *chatgptreverse.Service
}

// New constructs the proxy module with a long-request-friendly transport (60s dial,
// no response-header timeout, since image generation can take minutes before responding).
func New(cfg *config.Config, q *queue.Queue, sp *settings.Provider, a *auth.Auth, logger *slog.Logger) *Proxy {
	return NewWithCooldownGate(cfg, q, sp, a, logger, upstreamcooldown.NewGate())
}

func NewWithCooldownGate(cfg *config.Config, q *queue.Queue, sp *settings.Provider, a *auth.Auth, logger *slog.Logger, gate *upstreamcooldown.Gate, reverse ...*chatgptreverse.Service) *Proxy {
	base := &http.Transport{
		Proxy:                 outboundproxy.ProxyFunc(sp),
		DialContext:           (&net.Dialer{Timeout: 60 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          100,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}
	var tr http.RoundTripper = base
	if cfg.UpstreamMaxRetries > 0 {
		// Retry transient upstream failures before the response reaches the client.
		// Only error responses (429/5xx) and transport errors are retried; 2xx
		// responses (which may stream SSE/partial images) pass through untouched.
		tr = &retryTransport{base: base, maxRetries: cfg.UpstreamMaxRetries, logger: logger, cooldowns: gate}
	}
	var reverseService *chatgptreverse.Service
	if len(reverse) > 0 {
		reverseService = reverse[0]
	}
	return &Proxy{cfg: cfg, q: q, settings: sp, auth: a, logger: logger, transport: tr, reverse: reverseService}
}

// retryTransport retries transient upstream failures (transport errors, HTTP 429, HTTP
// 5xx) with exponential backoff bounded by the request context. Successful (2xx)
// responses are returned immediately so streaming is never interrupted. The request body
// is buffered for replay only when small enough; large payloads (e.g. image edits) are
// sent once without retry to bound memory.
type retryTransport struct {
	base       http.RoundTripper
	maxRetries int
	logger     *slog.Logger
	cooldowns  *upstreamcooldown.Gate
}

const maxRetryBodyBytes = 8 << 20 // 8 MiB
const preflightTimeout = 12 * time.Second
const preflightRecentCFWindow = 10 * time.Minute

func (rt *retryTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	var replay []byte
	replayable := true
	if req.Body != nil && req.Body != http.NoBody {
		if req.ContentLength < 0 || req.ContentLength > maxRetryBodyBytes {
			replayable = false // unknown/large body: send once, no retry
		} else {
			b, err := io.ReadAll(req.Body)
			_ = req.Body.Close()
			if err != nil {
				replayable = false
			}
			replay = b
			req.Body = io.NopCloser(bytes.NewReader(b))
		}
	}

	model := upstreamcooldown.ExtractRequestModel(req.Header.Get("Content-Type"), replay)
	backoff := 500 * time.Millisecond
	for attempt := 1; ; attempt++ {
		if waited, err := rt.cooldowns.Wait(req.Context(), model); err != nil {
			return nil, err
		} else if waited > 0 {
			rt.logger.Info("waited for upstream model cooldown", "scope", "proxy",
				"model", model, "waitMs", waited.Milliseconds())
		}
		if replay != nil {
			req.Body = io.NopCloser(bytes.NewReader(replay))
			req.ContentLength = int64(len(replay))
		}
		resp, err := rt.base.RoundTrip(req)
		cooldownDelay, cooldownModel := inspectCooldown(resp)
		if cooldownModel != "" {
			model = cooldownModel
		}
		if cooldownDelay > 0 {
			rt.cooldowns.Set(model, cooldownDelay)
			if resp != nil && resp.Header.Get("Retry-After") == "" {
				resp.Header.Set("Retry-After", upstreamcooldown.RetryAfterSeconds(cooldownDelay))
			}
		}

		retryable := false
		switch {
		case req.Context().Err() != nil:
			retryable = false // client aborted / deadline: don't retry
		case err != nil:
			retryable = true // transport error (dial/reset/etc.)
		case isRetryableProxyResponse(resp):
			retryable = true
		}
		if !replayable || !retryable || attempt > rt.maxRetries {
			return resp, err
		}
		if resp != nil {
			_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
			_ = resp.Body.Close()
		}
		rt.logger.Warn("upstream proxy attempt failed; retrying", "scope", "proxy",
			"attempt", attempt, "maxRetries", rt.maxRetries, "status", statusOf(resp), "err", errStr(err))
		sleep := backoff
		if cooldownDelay > sleep {
			sleep = cooldownDelay
		}
		select {
		case <-req.Context().Done():
			return nil, req.Context().Err()
		case <-time.After(sleep):
		}
		if backoff < 8*time.Second {
			backoff *= 2
		}
	}
}

func inspectCooldown(resp *http.Response) (time.Duration, string) {
	if resp == nil || resp.StatusCode != http.StatusTooManyRequests || resp.Body == nil {
		if resp != nil {
			return upstreamcooldown.RetryAfterDelay(resp.Header), ""
		}
		return 0, ""
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 256<<10))
	_ = resp.Body.Close()
	resp.Body = io.NopCloser(bytes.NewReader(body))
	if err != nil {
		return upstreamcooldown.RetryAfterDelay(resp.Header), ""
	}
	info := upstreamcooldown.ParseBody(body)
	if info == nil {
		return upstreamcooldown.RetryAfterDelay(resp.Header), ""
	}
	delay := info.Delay
	if headerDelay := upstreamcooldown.RetryAfterDelay(resp.Header); headerDelay > delay {
		delay = headerDelay
	}
	return delay, info.Model
}

func isRetryableProxyResponse(resp *http.Response) bool {
	if resp == nil {
		return false
	}
	if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
		return true
	}
	if resp.StatusCode != http.StatusForbidden {
		return false
	}
	// Direct-passthrough CF challenges (internal reverse / no JSON wrapping) keep
	// Cloudflare's own response headers, which are the most reliable signal.
	if hasCloudflareChallengeHeader(resp.Header) {
		return true
	}
	if resp.Body == nil {
		return false
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 256<<10))
	_ = resp.Body.Close()
	resp.Body = io.NopCloser(bytes.NewReader(body))
	if err != nil {
		return false
	}
	return isCloudflareManagedChallenge(string(body))
}

// hasCloudflareChallenge looks for Cloudflare's `cf-mitigated` marker header, which CF
// sets to "challenge" on interstitial/managed-challenge responses. cliproxy wraps upstream
// errors into JSON and drops these headers, so this only fires on direct passthrough, but
// when present it is unambiguous.
func hasCloudflareChallengeHeader(h http.Header) bool {
	if h == nil {
		return false
	}
	return strings.Contains(strings.ToLower(h.Get("Cf-Mitigated")), "challenge")
}

// isCloudflareManagedChallenge recognizes a Cloudflare challenge/block page, whether served
// raw or wrapped (cliproxy embeds the upstream HTML inside a JSON error message). These are
// transient, IP/account-correlated blocks: a retry round-robins cliproxy onto another
// credential and usually clears. OpenAI's own 403s (content policy, quota) lack these
// markers and are left to fail fast.
func isCloudflareManagedChallenge(body string) bool {
	lower := strings.ToLower(body)
	markers := []string{
		"cf_chl",                     // _cf_chl_opt challenge script
		"challenge-error-text",       // challenge page error element
		"cdn-cgi/challenge-platform", // challenge platform asset path
		"just a moment",              // interstitial page title
		"enable javascript and cookies to continue",
		"attention required",    // CF block page heading
		"you have been blocked", // CF block page body
	}
	for _, m := range markers {
		if strings.Contains(lower, m) {
			return true
		}
	}
	return false
}

func isCloudflareChallengeArtifact(text string) bool {
	lower := strings.ToLower(text)
	return isCloudflareManagedChallenge(lower) ||
		(strings.Contains(lower, "cf-mitigated") && strings.Contains(lower, "challenge"))
}

func recentCloudflareChallengeLog(logDir string, window time.Duration) (string, bool) {
	if strings.TrimSpace(logDir) == "" {
		return "", false
	}
	entries, err := os.ReadDir(logDir)
	if err != nil {
		return "", false
	}
	cutoff := time.Now().Add(-window)
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasPrefix(entry.Name(), "error-") {
			continue
		}
		info, err := entry.Info()
		if err != nil || info.ModTime().Before(cutoff) {
			continue
		}
		body, err := os.ReadFile(filepath.Join(logDir, entry.Name()))
		if err != nil {
			continue
		}
		if isCloudflareChallengeArtifact(string(body)) {
			return entry.Name(), true
		}
	}
	return "", false
}

func truncateText(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

func statusOf(resp *http.Response) int {
	if resp == nil {
		return 0
	}
	return resp.StatusCode
}

func errStr(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// Register mounts /api-proxy/* (JWT via X-PicPilot-Authorization + RequireUser) and the
// JWT-gated /api/queue/stats. OPTIONS preflight is public (no auth header on preflight).
func (p *Proxy) Register(r chi.Router) {
	r.Options("/api-proxy/*", p.handleOptions)

	r.Group(func(pr chi.Router) {
		pr.Use(p.auth.Middleware("Authorization"))
		pr.Get("/api/queue/stats", p.handleQueueStats)
	})

	r.Group(func(pr chi.Router) {
		pr.Use(p.auth.Middleware("Authorization"))
		pr.Use(p.auth.RequireUser)
		pr.Get("/api/upstream/preflight", p.handleUpstreamPreflight)
	})

	r.Group(func(pr chi.Router) {
		pr.Use(p.auth.Middleware("X-PicPilot-Authorization"))
		pr.Use(p.auth.RequireUser)
		pr.Get("/api-proxy/*", p.handle)
		pr.Post("/api-proxy/*", p.handle)
	})
}

func (p *Proxy) handleOptions(w http.ResponseWriter, _ *http.Request) {
	h := w.Header()
	h.Set("Allow", "GET, POST, OPTIONS")
	h.Set("Access-Control-Allow-Headers", "authorization, content-type, x-picpilot-authorization")
	h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.WriteHeader(http.StatusNoContent)
}

func (p *Proxy) handleQueueStats(w http.ResponseWriter, r *http.Request) {
	claims := auth.ClaimsFrom(r.Context())
	sub := ""
	if claims != nil {
		sub = claims.Subject
	}
	st := p.q.Stats(sub)
	lim := p.q.Limits()
	httpx.JSON(w, http.StatusOK, map[string]any{
		"inflight":           st.Inflight,
		"queued":             st.Queued,
		"maxConcurrent":      lim.MaxConcurrent,
		"maxQueue":           lim.MaxQueue,
		"proxyUserSoftLimit": lim.PerUserSoftLimit,
		"proxyUserHardLimit": lim.PerUserHardLimit,
		"providerLimits":     lim.ProviderLimits,
		"myInflight":         st.MyInflight,
		"myQueued":           st.MyQueued,
		"myNextPosition":     st.MyNextPosition,
	})
}

func (p *Proxy) handleUpstreamPreflight(w http.ResponseWriter, r *http.Request) {
	activeUpstream := upstream.FromConfigForMode(p.cfg, r.URL.Query().Get("mode"))
	if activeUpstream.Mode != config.UpstreamModeAPI {
		httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "mode": activeUpstream.Mode, "skipped": true})
		return
	}
	if name, ok := recentCloudflareChallengeLog(p.cfg.CLIProxyLogDir, preflightRecentCFWindow); ok {
		httpx.Error(w, http.StatusServiceUnavailable, "发现上游最近出现 Cloudflare 拦截，已暂停本次出图。请稍后重试或检查 CLIProxy 账号状态。日志："+name)
		return
	}
	target, err := activeUpstream.ResolveProxy("/api-proxy/v1/models", "")
	if err != nil {
		p.logger.Warn("upstream preflight resolve failed", "scope", "proxy", "err", err.Error())
		httpx.Error(w, http.StatusInternalServerError, "上游 API 配置异常，请联系管理员。")
		return
	}
	if target == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "上游 API 地址未配置，请联系管理员。")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), preflightTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		p.logger.Warn("upstream preflight request build failed", "scope", "proxy", "err", err.Error())
		httpx.Error(w, http.StatusInternalServerError, "上游 API 预检请求构造失败。")
		return
	}
	req.Header = buildUpstreamHeaders(r.Header, activeUpstream.APIKey)
	resp, err := (&http.Client{Transport: p.transport}).Do(req)
	if err != nil {
		p.logger.Warn("upstream preflight request failed", "scope", "proxy", "err", err.Error())
		httpx.Error(w, http.StatusBadGateway, "上游 API 预检失败，请稍后重试。")
		return
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 256<<10))
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "mode": activeUpstream.Mode, "status": resp.StatusCode})
		return
	}
	if hasCloudflareChallengeHeader(resp.Header) || isCloudflareChallengeArtifact(string(body)) {
		httpx.Error(w, http.StatusServiceUnavailable, "上游 API 被 Cloudflare 拦截，已暂停本次出图。请稍后重试或检查 CLIProxy 账号状态。")
		return
	}
	p.logger.Warn("upstream preflight non-2xx", "scope", "proxy", "status", resp.StatusCode, "body", truncateText(string(body), 300))
	httpx.Error(w, http.StatusServiceUnavailable, "上游 API 预检失败（HTTP "+strconv.Itoa(resp.StatusCode)+"），请稍后重试或检查上游配置。")
}

func (p *Proxy) handle(w http.ResponseWriter, r *http.Request) {
	// Disable any write deadline for this (potentially minutes-long) streaming response.
	if rc := http.NewResponseController(w); rc != nil {
		_ = rc.SetWriteDeadline(time.Time{})
	}

	activeUpstream := upstream.FromConfigForMode(p.cfg, r.Header.Get("X-PicPilot-Upstream-Mode"))
	endpoint := proxyEndpoint(r.URL.Path)
	if activeUpstream.Internal {
		if p.reverse == nil || !p.reverse.Configured() {
			httpx.Error(w, http.StatusServiceUnavailable, "内置 reverse 未配置 ChatGPT 凭据，请联系管理员。")
			return
		}
		if endpoint == "" {
			httpx.Error(w, http.StatusNotFound, "接口不存在。")
			return
		}
		p.handleInternalReverse(w, r, endpoint)
		return
	}
	target, err := activeUpstream.ResolveProxy(r.URL.Path, r.URL.RawQuery)
	if err != nil {
		p.logger.Error("api proxy target resolution failed", "scope", "proxy", "err", err.Error())
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	if target == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "上游 API 地址未配置，请联系管理员。")
		return
	}

	claims := auth.ClaimsFrom(r.Context())
	userID := ""
	if claims != nil {
		userID = claims.Subject
	}

	maxBatch := p.settings.DefaultMaxBatchImages()
	if r.Method == http.MethodPost {
		if n := estimateRequestedImageCount(r, target.Path); n > maxBatch {
			httpx.JSON(w, http.StatusTooManyRequests, map[string]any{
				"error":          "单次批量生成数量上限为 " + itoa(maxBatch) + " 张，本次请求 " + itoa(n) + " 张。请减少数量后重试。",
				"maxBatchImages": maxBatch,
				"requested":      n,
			})
			return
		}
	}

	// Concurrency control: acquire a slot (FIFO queue when full), honoring client cancel.
	// AcquireUser enforces the per-user hard cap so one user's fan-out cannot fill the queue,
	// and tags the request with its upstream provider for per-provider limiting.
	switch err := p.q.AcquireUser(r.Context(), 0, userID, activeUpstream.Mode); {
	case err == nil:
		// acquired
	case errors.Is(err, queue.ErrClientAbort):
		w.WriteHeader(499) // client disconnected while queued; no body
		return
	case errors.Is(err, queue.ErrUserLimit):
		httpx.Error(w, http.StatusTooManyRequests, "你当前并行的请求过多，请等待已有请求完成后再试。")
		return
	case errors.Is(err, queue.ErrQueueFull):
		httpx.Error(w, http.StatusTooManyRequests, "服务繁忙，排队人数过多，请稍后重试。")
		return
	default: // ErrWaitTimeout or other
		httpx.Error(w, http.StatusTooManyRequests, "服务繁忙，排队等待超时，请稍后重试。")
		return
	}
	// Hold the slot until the full response body has been streamed (ReverseProxy.ServeHTTP
	// blocks until the copy finishes or the connection breaks), then release.
	defer p.q.Release(userID, activeUpstream.Mode)

	rp := &httputil.ReverseProxy{
		Transport:     p.transport,
		FlushInterval: -1, // flush each write immediately (SSE/streaming friendly)
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.Out.URL = target
			pr.Out.Host = target.Host
			pr.Out.Header = buildUpstreamHeaders(r.Header, activeUpstream.APIKey)
		},
		ModifyResponse: func(resp *http.Response) error {
			for _, h := range hopByHop {
				resp.Header.Del(h)
			}
			resp.Header.Set("Cache-Control", "no-store")
			return nil
		},
		ErrorHandler: func(ew http.ResponseWriter, er *http.Request, e error) {
			// Client aborted (queued slot already returned 499 above; here it's mid-flight).
			if er.Context().Err() != nil || errors.Is(e, context.Canceled) {
				p.logger.Info("api proxy request aborted", "scope", "proxy", "err", e.Error())
				return
			}
			p.logger.Error("upstream api request failed", "scope", "proxy", "mode", activeUpstream.Mode, "target", target.String(), "err", e.Error())
			httpx.Error(ew, http.StatusBadGateway, "上游 API 请求失败，请稍后重试。")
		},
	}
	rp.ServeHTTP(w, r)
}

func (p *Proxy) handleInternalReverse(w http.ResponseWriter, r *http.Request, endpoint string) {
	claims := auth.ClaimsFrom(r.Context())
	userID := ""
	if claims != nil {
		userID = claims.Subject
	}

	maxBatch := p.settings.DefaultMaxBatchImages()
	if r.Method == http.MethodPost {
		if n := estimateRequestedImageCount(r, "/v1/"+endpoint); n > maxBatch {
			httpx.JSON(w, http.StatusTooManyRequests, map[string]any{
				"error":          "单次批量生成数量上限为 " + itoa(maxBatch) + " 张，本次请求 " + itoa(n) + " 张。请减少数量后重试。",
				"maxBatchImages": maxBatch,
				"requested":      n,
			})
			return
		}
	}

	// This path is always the built-in ChatGPT reverse upstream → provider "reverse".
	switch err := p.q.AcquireUser(r.Context(), 0, userID, "reverse"); {
	case err == nil:
	case errors.Is(err, queue.ErrClientAbort):
		w.WriteHeader(499)
		return
	case errors.Is(err, queue.ErrUserLimit):
		httpx.Error(w, http.StatusTooManyRequests, "你当前并行的请求过多，请等待已有请求完成后再试。")
		return
	case errors.Is(err, queue.ErrQueueFull):
		httpx.Error(w, http.StatusTooManyRequests, "服务繁忙，排队人数过多，请稍后重试。")
		return
	default:
		httpx.Error(w, http.StatusTooManyRequests, "服务繁忙，排队等待超时，请稍后重试。")
		return
	}
	defer p.q.Release(userID, "reverse")

	p.reverse.ServeProxy(w, r, endpoint)
}

func proxyEndpoint(path string) string {
	const prefix = "/api-proxy/"
	if !strings.HasPrefix(path, prefix) {
		return ""
	}
	return strings.TrimLeft(path[len(prefix):], "/")
}

// buildUpstreamHeaders clones inbound headers, strips hop-by-hop + host + client auth,
// and injects the upstream Bearer key (mirrors createApiProxyRequestHeaders).
func buildUpstreamHeaders(in http.Header, apiKey string) http.Header {
	out := in.Clone()
	if out == nil {
		out = http.Header{}
	}
	for _, h := range hopByHop {
		out.Del(h)
	}
	out.Del("Host")
	out.Del("Authorization")
	out.Del("X-Picpilot-Authorization")
	out.Del("X-Picpilot-Upstream-Mode")
	if apiKey != "" {
		out.Set("Authorization", "Bearer "+apiKey)
	}
	return out
}

// estimateRequestedImageCount is a best-effort batch-limit guard for /images/generations
// JSON requests. It buffers and rewinds the body so it can still be forwarded.
func estimateRequestedImageCount(r *http.Request, targetPath string) int {
	if !imagesGenRe.MatchString(targetPath) {
		return 1
	}
	if r.ContentLength > 2*1024*1024 {
		return 1
	}
	if !strings.Contains(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
		return 1
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return 1
	}
	r.Body = io.NopCloser(bytes.NewReader(body)) // rewind for forwarding
	var payload map[string]any
	if json.Unmarshal(body, &payload) != nil {
		return 1
	}
	if n, ok := config.GetPositiveIntegerValue(payload["n"]); ok {
		return n
	}
	if n, ok := config.GetPositiveIntegerValue(payload["num_images"]); ok {
		return n
	}
	return 1
}

func itoa(n int) string {
	return strconv.Itoa(n)
}
