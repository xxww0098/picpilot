package task

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/xxww0098/picpilot/server-go/internal/config"
	"github.com/xxww0098/picpilot/server-go/internal/queue"
	"github.com/xxww0098/picpilot/server-go/internal/settings"
)

const dispatchBuffer = 4096

// pubsub coalesces "task changed" signals to per-task subscribers (for SSE).
type pubsub struct {
	mu   sync.Mutex
	subs map[string]map[chan struct{}]bool
}

func newPubsub() *pubsub { return &pubsub{subs: make(map[string]map[chan struct{}]bool)} }

func (p *pubsub) subscribe(id string) chan struct{} {
	ch := make(chan struct{}, 1)
	p.mu.Lock()
	if p.subs[id] == nil {
		p.subs[id] = make(map[chan struct{}]bool)
	}
	p.subs[id][ch] = true
	p.mu.Unlock()
	return ch
}

func (p *pubsub) unsubscribe(id string, ch chan struct{}) {
	p.mu.Lock()
	if m := p.subs[id]; m != nil {
		delete(m, ch)
		if len(m) == 0 {
			delete(p.subs, id)
		}
	}
	p.mu.Unlock()
}

func (p *pubsub) publish(id string) {
	p.mu.Lock()
	for ch := range p.subs[id] {
		select {
		case ch <- struct{}{}:
		default: // coalesce: subscriber already has a pending signal
		}
	}
	p.mu.Unlock()
}

// Executor runs queued tasks with a bounded worker pool that shares the global queue.
type Executor struct {
	store    *Store
	q        *queue.Queue
	settings *settings.Provider
	cfg      *config.Config
	logger   *slog.Logger
	client   *http.Client
	pending  chan string
	workers  int
	ps       *pubsub

	cancelMu sync.Mutex
	cancels  map[string]context.CancelFunc
}

// NewExecutor sizes the worker pool to the queue's MaxConcurrent so total upstream
// concurrency (sync proxy + async tasks) stays bounded by the shared global limit.
func NewExecutor(store *Store, q *queue.Queue, sp *settings.Provider, cfg *config.Config, logger *slog.Logger) *Executor {
	workers := q.Limits().MaxConcurrent
	if workers < 1 {
		workers = 1
	}
	return &Executor{
		store: store, q: q, settings: sp, cfg: cfg, logger: logger,
		pending: make(chan string, dispatchBuffer),
		workers: workers,
		ps:      newPubsub(),
		cancels: make(map[string]context.CancelFunc),
		client: &http.Client{Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			DialContext:           (&net.Dialer{Timeout: 60 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
			ForceAttemptHTTP2:     true,
			MaxIdleConns:          100,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   10 * time.Second,
			ExpectContinueTimeout: 1 * time.Second,
			// No overall/response-header timeout: per-task context handles deadlines.
		}},
	}
}

// Start launches workers and re-dispatches tasks left over from a previous run.
func (e *Executor) Start() {
	for i := 0; i < e.workers; i++ {
		go e.worker()
	}
	ids, err := e.store.RecoverPending()
	if err != nil {
		e.logger.Error("task recovery failed", "scope", "task", "err", err.Error())
		return
	}
	for _, id := range ids {
		e.dispatch(id)
	}
	if len(ids) > 0 {
		e.logger.Info("recovered pending tasks", "scope", "task", "count", len(ids))
	}
}

// dispatch enqueues a task id for a worker (non-blocking; the recovery scan is the
// backstop if the buffer is ever full).
func (e *Executor) dispatch(id string) {
	select {
	case e.pending <- id:
	default:
		e.logger.Warn("task dispatch buffer full; will recover later", "scope", "task", "id", id)
	}
}

func (e *Executor) worker() {
	for id := range e.pending {
		e.run(id)
	}
}

func (e *Executor) setCancel(id string, c context.CancelFunc) {
	e.cancelMu.Lock()
	e.cancels[id] = c
	e.cancelMu.Unlock()
}

func (e *Executor) clearCancel(id string) {
	e.cancelMu.Lock()
	delete(e.cancels, id)
	e.cancelMu.Unlock()
}

// CancelRunning cancels the context of a running task, if present.
func (e *Executor) CancelRunning(id string) {
	e.cancelMu.Lock()
	c := e.cancels[id]
	e.cancelMu.Unlock()
	if c != nil {
		c()
	}
}

// Pub exposes the pub/sub for the SSE route.
func (e *Executor) Pub() *pubsub { return e.ps }

func (e *Executor) run(id string) {
	t, err := e.store.Get(id)
	if err != nil || t.Status != StatusQueued {
		return // already claimed/canceled/gone
	}

	timeout := time.Duration(e.settings.Payload().RequestTimeoutSeconds) * time.Second
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	e.setCancel(id, cancel)
	defer func() {
		e.clearCancel(id)
		cancel()
	}()

	// Acquire a global slot (shared with the sync proxy). Persisted tasks can wait
	// indefinitely, so re-try on a transiently full queue instead of failing.
	for {
		switch err := e.q.Acquire(ctx, 0, t.UserID); {
		case err == nil:
			goto acquired
		case errors.Is(err, queue.ErrClientAbort):
			e.finishInterrupted(id, ctx)
			return
		default: // ErrQueueFull / ErrWaitTimeout: wait and retry
			select {
			case <-ctx.Done():
				e.finishInterrupted(id, ctx)
				return
			case <-time.After(2 * time.Second):
			}
		}
	}
acquired:
	defer e.q.Release(t.UserID)

	won, err := e.store.Claim(id)
	if err != nil || !won {
		return // canceled or claimed elsewhere between dispatch and now
	}
	e.ps.publish(id)

	status, result, errType, errMsg := e.doUpstream(ctx, t)
	if err := e.store.Finish(id, status, result, errType, errMsg); err != nil {
		e.logger.Error("task finish write failed", "scope", "task", "id", id, "err", err.Error())
	}
	e.ps.publish(id)
}

// finishInterrupted records a deadline as a timeout failure and a cancel as canceled.
func (e *Executor) finishInterrupted(id string, ctx context.Context) {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		_ = e.store.Finish(id, StatusFailed, "", "timeout", "请求超时：超过配置时长仍未完成。")
	} else {
		_ = e.store.Finish(id, StatusCanceled, "", "cancelled", "任务已取消。")
	}
	e.ps.publish(id)
}

// doUpstream calls the upstream with automatic retry on transient failures
// (network errors, upstream 429, upstream 5xx) using exponential backoff bounded by
// the task context deadline. Retries are server-side and invisible to the polling
// client, so they cut the effective failure rate without adding client wait time.
func (e *Executor) doUpstream(ctx context.Context, t *Task) (status Status, result, errType, errMsg string) {
	maxAttempts := e.cfg.UpstreamMaxRetries + 1
	if maxAttempts < 1 {
		maxAttempts = 1
	}
	backoff := 500 * time.Millisecond
	for attempt := 1; ; attempt++ {
		status, result, errType, errMsg = e.attemptUpstream(ctx, t)
		if status == StatusSucceeded || !isRetryableErr(errType) || attempt >= maxAttempts {
			return status, result, errType, errMsg
		}
		e.logger.Warn("upstream attempt failed; retrying", "scope", "task", "id", t.ID,
			"attempt", attempt, "maxAttempts", maxAttempts, "errType", errType)
		select {
		case <-ctx.Done():
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return StatusFailed, "", "timeout", "请求超时：超过配置时长仍未完成。"
			}
			return StatusCanceled, "", "cancelled", "任务已取消。"
		case <-time.After(backoff):
		}
		if backoff < 8*time.Second {
			backoff *= 2
		}
	}
}

// isRetryableErr reports whether a failed attempt is worth retrying. Transient
// classes only: network errors, upstream 429 (rate/quota), and upstream 5xx.
// Client 4xx (bad request / auth / content policy) and cancellation are not retried.
func isRetryableErr(errType string) bool {
	return errType == "network" || errType == "upstream_429" || strings.HasPrefix(errType, "upstream_5")
}

// attemptUpstream performs a single upstream request.
func (e *Executor) attemptUpstream(ctx context.Context, t *Task) (status Status, result, errType, errMsg string) {
	target, err := joinUpstream(e.cfg.APIProxyURL, t.Endpoint)
	if err != nil {
		return StatusFailed, "", "config", err.Error()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, strings.NewReader(t.RequestJSON))
	if err != nil {
		return StatusFailed, "", "internal", err.Error()
	}
	req.Header.Set("Content-Type", "application/json")
	if e.cfg.APIProxyAPIKey != "" {
		req.Header.Set("Authorization", "Bearer "+e.cfg.APIProxyAPIKey)
	}
	resp, err := e.client.Do(req)
	if err != nil {
		switch {
		case errors.Is(ctx.Err(), context.Canceled):
			return StatusCanceled, "", "cancelled", "任务已取消。"
		case errors.Is(ctx.Err(), context.DeadlineExceeded):
			return StatusFailed, "", "timeout", "请求超时：超过配置时长仍未完成。"
		default:
			return StatusFailed, "", "network", err.Error()
		}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return StatusSucceeded, string(body), "", ""
	}
	return StatusFailed, "", "upstream_" + strconv.Itoa(resp.StatusCode), truncate(string(body), 2000)
}

// joinUpstream joins API_PROXY_URL with the task endpoint, tolerating a duplicated /v1.
func joinUpstream(base, endpoint string) (string, error) {
	if base == "" {
		return "", errors.New("上游 API 地址未配置")
	}
	endpoint = strings.TrimLeft(endpoint, "/")
	if endpoint == "" {
		return "", errors.New("endpoint 为空")
	}
	if !strings.HasSuffix(base, "/") {
		base += "/"
	}
	u, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	baseSeg := splitNonEmpty(u.Path)
	epSeg := splitNonEmpty(endpoint)
	if len(baseSeg) > 0 && len(epSeg) > 0 && baseSeg[len(baseSeg)-1] == "v1" && epSeg[0] == "v1" {
		epSeg = epSeg[1:]
	}
	u.Path = "/" + strings.Join(append(baseSeg, epSeg...), "/")
	return u.String(), nil
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

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
