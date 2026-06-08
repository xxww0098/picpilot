// Package proxy ports the authenticated API proxy (/api-proxy/*) from server/index.ts.
//
// It forwards OpenAI-compatible requests to API_PROXY_URL, injecting the upstream key,
// behind the global concurrency queue. Unlike the Bun/Hono version it needs NO SSE
// heartbeat hack: Go's http.Server has no write/idle deadline here, and ReverseProxy
// with FlushInterval=-1 streams chunks immediately, so long silent streams stay alive.
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
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/picpilot/server-go/internal/auth"
	"github.com/xxww0098/picpilot/server-go/internal/config"
	"github.com/xxww0098/picpilot/server-go/internal/httpx"
	"github.com/xxww0098/picpilot/server-go/internal/queue"
	"github.com/xxww0098/picpilot/server-go/internal/settings"
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
}

// New constructs the proxy module with a long-request-friendly transport (60s dial,
// no response-header timeout, since image generation can take minutes before responding).
func New(cfg *config.Config, q *queue.Queue, sp *settings.Provider, a *auth.Auth, logger *slog.Logger) *Proxy {
	base := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
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
		tr = &retryTransport{base: base, maxRetries: cfg.UpstreamMaxRetries, logger: logger}
	}
	return &Proxy{cfg: cfg, q: q, settings: sp, auth: a, logger: logger, transport: tr}
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
}

const maxRetryBodyBytes = 8 << 20 // 8 MiB

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

	backoff := 500 * time.Millisecond
	for attempt := 1; ; attempt++ {
		if replay != nil {
			req.Body = io.NopCloser(bytes.NewReader(replay))
			req.ContentLength = int64(len(replay))
		}
		resp, err := rt.base.RoundTrip(req)

		retryable := false
		switch {
		case req.Context().Err() != nil:
			retryable = false // client aborted / deadline: don't retry
		case err != nil:
			retryable = true // transport error (dial/reset/etc.)
		case resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500:
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
		select {
		case <-req.Context().Done():
			return nil, req.Context().Err()
		case <-time.After(backoff):
		}
		if backoff < 8*time.Second {
			backoff *= 2
		}
	}
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
		"myInflight":         st.MyInflight,
		"myQueued":           st.MyQueued,
		"myNextPosition":     st.MyNextPosition,
	})
}

func (p *Proxy) handle(w http.ResponseWriter, r *http.Request) {
	// Disable any write deadline for this (potentially minutes-long) streaming response.
	if rc := http.NewResponseController(w); rc != nil {
		_ = rc.SetWriteDeadline(time.Time{})
	}

	target, err := resolveTarget(p.cfg.APIProxyURL, r.URL.Path, r.URL.RawQuery)
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
	switch err := p.q.Acquire(r.Context(), 0, userID); {
	case err == nil:
		// acquired
	case errors.Is(err, queue.ErrClientAbort):
		w.WriteHeader(499) // client disconnected while queued; no body
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
	defer p.q.Release(userID)

	rp := &httputil.ReverseProxy{
		Transport:     p.transport,
		FlushInterval: -1, // flush each write immediately (SSE/streaming friendly)
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.Out.URL = target
			pr.Out.Host = target.Host
			pr.Out.Header = buildUpstreamHeaders(r.Header, p.cfg.APIProxyAPIKey)
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
			p.logger.Error("upstream api request failed", "scope", "proxy", "target", target.String(), "err", e.Error())
			httpx.Error(ew, http.StatusBadGateway, "上游 API 请求失败，请稍后重试。")
		},
	}
	rp.ServeHTTP(w, r)
}

// resolveTarget ports resolveApiProxyTarget: joins API_PROXY_URL with the /api-proxy/*
// suffix, tolerating a duplicated trailing /v1 (so /api-proxy/v1/models -> .../v1/models).
func resolveTarget(apiProxyURL, reqPath, rawQuery string) (*url.URL, error) {
	if apiProxyURL == "" {
		return nil, nil
	}
	const prefix = "/api-proxy/"
	if !strings.HasPrefix(reqPath, prefix) {
		return nil, nil
	}
	endpointPath := strings.TrimLeft(reqPath[len(prefix):], "/")
	if endpointPath == "" {
		return nil, nil
	}
	base := apiProxyURL
	if !strings.HasSuffix(base, "/") {
		base += "/"
	}
	target, err := url.Parse(base)
	if err != nil {
		return nil, err
	}
	if target.Scheme != "http" && target.Scheme != "https" {
		return nil, errors.New("API_PROXY_URL 只支持 http/https")
	}
	baseSeg := splitNonEmpty(target.Path)
	epSeg := splitNonEmpty(endpointPath)
	if len(baseSeg) > 0 && len(epSeg) > 0 && baseSeg[len(baseSeg)-1] == "v1" && epSeg[0] == "v1" {
		epSeg = epSeg[1:]
	}
	target.Path = "/" + strings.Join(append(baseSeg, epSeg...), "/")
	target.RawQuery = rawQuery
	return target, nil
}

func splitNonEmpty(p string) []string {
	parts := strings.Split(p, "/")
	out := parts[:0]
	for _, s := range parts {
		if s != "" {
			out = append(out, s)
		}
	}
	return out
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
