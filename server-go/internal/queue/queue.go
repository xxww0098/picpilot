// Package queue implements a global concurrency semaphore with a FIFO wait queue,
// ported from server/concurrencyQueue.ts. Cancellation uses context.Context in place
// of the TS AbortSignal.
//
// Abstraction boundary: callers only use Acquire / Release. This is a single-process,
// in-memory implementation; a future multi-replica deployment can swap the internals
// for a shared counter (e.g. Redis) without changing callers. The actual waiting must
// stay in the process holding the socket, so the wait queue is inherently per-process.
package queue

import (
	"context"
	"errors"
	"sync"
	"time"
)

var (
	ErrQueueFull   = errors.New("proxy queue is full")
	ErrWaitTimeout = errors.New("timed out waiting in proxy queue")
	ErrClientAbort = errors.New("client aborted while queued")
	ErrUserLimit   = errors.New("per-user request limit reached")
)

type waiter struct {
	userID   string
	provider string
	granted  chan struct{}
	settled  bool
}

// Options configures a Queue.
type Options struct {
	MaxConcurrent    int // global simultaneous in-flight limit
	MaxQueue         int // wait-queue length limit; Acquire returns ErrQueueFull when full
	MaxWaitMs        int // default queue wait limit (ms); <=0 means no limit
	PerUserSoftLimit int // per-user in-flight soft limit; 0 disables
	PerUserHardLimit int // per-user total (in-flight + queued) hard cap; AcquireUser rejects past it; 0 disables
	// ProviderLimits caps in-flight requests per upstream provider key (e.g. "reverse").
	// A request whose provider is at its cap is never dispatched until a slot frees, so one
	// slow/fragile upstream cannot occupy every global slot. Empty/0 disables. Startup-only.
	ProviderLimits map[string]int
}

// Stats is a snapshot of queue depth, optionally scoped to a user.
type Stats struct {
	Inflight       int  `json:"inflight"`
	Queued         int  `json:"queued"`
	MyInflight     int  `json:"myInflight"`
	MyQueued       int  `json:"myQueued"`
	MyNextPosition *int `json:"myNextPosition"`
}

// Limits reports the currently effective limits.
type Limits struct {
	MaxConcurrent    int            `json:"maxConcurrent"`
	MaxQueue         int            `json:"maxQueue"`
	PerUserSoftLimit int            `json:"perUserSoftLimit"`
	PerUserHardLimit int            `json:"perUserHardLimit"`
	ProviderLimits   map[string]int `json:"providerLimits,omitempty"`
}

// Queue is a concurrency-safe global semaphore with a FIFO wait queue.
type Queue struct {
	mu                 sync.Mutex
	maxConcurrent      int
	maxQueue           int
	perUserSoftLimit   int
	perUserHardLimit   int
	defaultWaitMs      int
	inflight           int
	waiters            []*waiter
	inflightByUser     map[string]int
	inflightByProvider map[string]int
	providerLimits     map[string]int
}

// New creates a Queue from the given options.
func New(opts Options) *Queue {
	providerLimits := make(map[string]int)
	for k, v := range opts.ProviderLimits {
		if k != "" && v > 0 {
			providerLimits[k] = v
		}
	}
	return &Queue{
		maxConcurrent:      max(1, opts.MaxConcurrent),
		maxQueue:           max(0, opts.MaxQueue),
		perUserSoftLimit:   max(0, opts.PerUserSoftLimit),
		perUserHardLimit:   max(0, opts.PerUserHardLimit),
		defaultWaitMs:      max(0, opts.MaxWaitMs),
		inflightByUser:     make(map[string]int),
		inflightByProvider: make(map[string]int),
		providerLimits:     providerLimits,
	}
}

func (q *Queue) incUser(userID string) {
	if userID == "" {
		return
	}
	q.inflightByUser[userID]++
}

func (q *Queue) decUser(userID string) {
	if userID == "" {
		return
	}
	if n := q.inflightByUser[userID] - 1; n > 0 {
		q.inflightByUser[userID] = n
	} else {
		delete(q.inflightByUser, userID)
	}
}

func (q *Queue) isUserOverSoftLimit(userID string) bool {
	return userID != "" && q.perUserSoftLimit > 0 && q.inflightByUser[userID] >= q.perUserSoftLimit
}

func (q *Queue) incProvider(provider string) {
	if provider == "" {
		return
	}
	q.inflightByProvider[provider]++
}

func (q *Queue) decProvider(provider string) {
	if provider == "" {
		return
	}
	if n := q.inflightByProvider[provider] - 1; n > 0 {
		q.inflightByProvider[provider] = n
	} else {
		delete(q.inflightByProvider, provider)
	}
}

// isProviderOverLimit reports whether a provider is at/over its configured in-flight cap.
// Unlike the soft limit, this is a hard gate: a capped provider's waiters are never
// dispatched until a slot frees. Caller holds mu.
func (q *Queue) isProviderOverLimit(provider string) bool {
	if provider == "" {
		return false
	}
	limit, ok := q.providerLimits[provider]
	return ok && limit > 0 && q.inflightByProvider[provider] >= limit
}

// userTotalLocked counts a user's total footprint (in-flight + queued). Caller holds mu.
// The wait queue is bounded (maxQueue), so the linear scan is cheap.
func (q *Queue) userTotalLocked(userID string) int {
	if userID == "" {
		return 0
	}
	total := q.inflightByUser[userID]
	for _, w := range q.waiters {
		if w.userID == userID {
			total++
		}
	}
	return total
}

// findDispatchIndex returns the index of the next waiter to dispatch, or -1 when none is
// eligible. A waiter whose provider is at its cap is never chosen (hard gate). Among the
// rest, FIFO order is preserved, but a waiter whose user is over the soft limit is only
// chosen as a fallback when no provider-eligible, under-soft-limit waiter exists — so the
// soft limit reorders without ever idling a free slot. Caller holds mu.
func (q *Queue) findDispatchIndex() int {
	fallback := -1
	for i, w := range q.waiters {
		if q.isProviderOverLimit(w.provider) {
			continue // hard gate: this provider is at capacity
		}
		if !q.isUserOverSoftLimit(w.userID) {
			return i // ideal: provider has room AND user is under the soft limit
		}
		if fallback < 0 {
			fallback = i // provider has room but user is soft-saturated; use only if nothing better
		}
	}
	return fallback
}

// pump dispatches eligible waiters while slots are free. Caller holds mu.
func (q *Queue) pump() {
	for len(q.waiters) > 0 && q.inflight < q.maxConcurrent {
		idx := q.findDispatchIndex()
		if idx < 0 {
			return
		}
		w := q.waiters[idx]
		q.waiters = append(q.waiters[:idx], q.waiters[idx+1:]...)
		if w.settled {
			continue
		}
		w.settled = true
		q.inflight++
		q.incUser(w.userID)
		q.incProvider(w.provider)
		close(w.granted)
	}
}

// Acquire obtains a concurrency slot without enforcing the per-user hard cap and without a
// provider tag. Kept for callers/tests that don't classify by provider.
func (q *Queue) Acquire(ctx context.Context, maxWaitMs int, userID string) error {
	return q.acquire(ctx, maxWaitMs, userID, "", false)
}

// AcquireUser is like Acquire but enforces the per-user hard cap (returns ErrUserLimit when
// the user already has perUserHardLimit requests in the system) and tags the request with
// its upstream provider for per-provider limiting. Used by the synchronous proxy path.
func (q *Queue) AcquireUser(ctx context.Context, maxWaitMs int, userID, provider string) error {
	return q.acquire(ctx, maxWaitMs, userID, provider, true)
}

// AcquireTask tags a request with its provider (for per-provider limiting) but does not
// enforce the per-user hard cap. Used by the async task executor, whose persisted tasks
// must wait (and retry) rather than be rejected.
func (q *Queue) AcquireTask(ctx context.Context, maxWaitMs int, userID, provider string) error {
	return q.acquire(ctx, maxWaitMs, userID, provider, false)
}

// acquire obtains a concurrency slot. It returns nil immediately when a slot is free,
// nobody is queued, and the request's provider is below its cap; otherwise it joins the
// FIFO queue. It returns ErrUserLimit when enforceHardLimit is set and the user is at the
// per-user hard cap, ErrQueueFull when the queue is full, ErrWaitTimeout on wait timeout,
// and ErrClientAbort when ctx is cancelled. On success the caller must call Release once
// with the SAME userID and provider.
func (q *Queue) acquire(ctx context.Context, maxWaitMs int, userID, provider string, enforceHardLimit bool) error {
	if maxWaitMs <= 0 {
		maxWaitMs = q.defaultWaitMs
	}

	q.mu.Lock()
	if enforceHardLimit && q.perUserHardLimit > 0 && q.userTotalLocked(userID) >= q.perUserHardLimit {
		q.mu.Unlock()
		return ErrUserLimit
	}
	if q.inflight < q.maxConcurrent && len(q.waiters) == 0 && !q.isProviderOverLimit(provider) {
		q.inflight++
		q.incUser(userID)
		q.incProvider(provider)
		q.mu.Unlock()
		return nil
	}
	if len(q.waiters) >= q.maxQueue {
		q.mu.Unlock()
		return ErrQueueFull
	}
	if ctx.Err() != nil {
		q.mu.Unlock()
		return ErrClientAbort
	}
	w := &waiter{userID: userID, provider: provider, granted: make(chan struct{})}
	q.waiters = append(q.waiters, w)
	// A free global slot can coexist with a non-empty queue when earlier waiters are gated
	// by their provider cap. Pump now so a freshly-enqueued, dispatchable request isn't
	// stalled until the next Release. (No-op in the common case where inflight == max.)
	q.pump()
	q.mu.Unlock()

	var timeoutCh <-chan time.Time
	if maxWaitMs > 0 {
		t := time.NewTimer(time.Duration(maxWaitMs) * time.Millisecond)
		defer t.Stop()
		timeoutCh = t.C
	}

	select {
	case <-w.granted:
		return nil
	case <-timeoutCh:
		return q.abandon(w, ErrWaitTimeout)
	case <-ctx.Done():
		return q.abandon(w, ErrClientAbort)
	}
}

// abandon removes a waiter that timed out or was cancelled. If pump granted the slot
// concurrently (settled), the grant is honored and nil is returned.
func (q *Queue) abandon(w *waiter, err error) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if w.settled {
		return nil
	}
	w.settled = true
	for i, x := range q.waiters {
		if x == w {
			q.waiters = append(q.waiters[:i], q.waiters[i+1:]...)
			break
		}
	}
	return err
}

// Release frees one slot and wakes the next eligible waiter. userID and provider must
// match the values passed to the corresponding Acquire call. A defensive guard keeps
// inflight from going negative if Release is somehow called more than once.
func (q *Queue) Release(userID, provider string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.inflight <= 0 {
		return
	}
	q.inflight--
	q.decUser(userID)
	q.decProvider(provider)
	q.pump()
}

// SetLimits adjusts limits at runtime (admin "team settings"). Only non-nil fields are
// updated. Raising MaxConcurrent immediately wakes dispatchable waiters; lowering only
// affects subsequent dispatch decisions and never interrupts in-flight requests.
func (q *Queue) SetLimits(maxConcurrent, maxQueue, perUserSoftLimit, perUserHardLimit *int) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if maxConcurrent != nil {
		q.maxConcurrent = max(1, *maxConcurrent)
	}
	if maxQueue != nil {
		q.maxQueue = max(0, *maxQueue)
	}
	if perUserSoftLimit != nil {
		q.perUserSoftLimit = max(0, *perUserSoftLimit)
	}
	if perUserHardLimit != nil {
		q.perUserHardLimit = max(0, *perUserHardLimit)
	}
	q.pump()
}

// Limits returns the currently effective limits.
func (q *Queue) Limits() Limits {
	q.mu.Lock()
	defer q.mu.Unlock()
	var providerLimits map[string]int
	if len(q.providerLimits) > 0 {
		providerLimits = make(map[string]int, len(q.providerLimits))
		for k, v := range q.providerLimits {
			providerLimits[k] = v
		}
	}
	return Limits{
		MaxConcurrent:    q.maxConcurrent,
		MaxQueue:         q.maxQueue,
		PerUserSoftLimit: q.perUserSoftLimit,
		PerUserHardLimit: q.perUserHardLimit,
		ProviderLimits:   providerLimits,
	}
}

// Stats returns current depth. When userID is non-empty, per-user fields are filled:
// MyInflight, MyQueued, and MyNextPosition (1-based index of the user's first waiter).
func (q *Queue) Stats(userID string) Stats {
	q.mu.Lock()
	defer q.mu.Unlock()
	s := Stats{Inflight: q.inflight, Queued: len(q.waiters)}
	if userID == "" {
		return s
	}
	s.MyInflight = q.inflightByUser[userID]
	for i, w := range q.waiters {
		if w.userID != userID {
			continue
		}
		s.MyQueued++
		if s.MyNextPosition == nil {
			pos := i + 1
			s.MyNextPosition = &pos
		}
	}
	return s
}
