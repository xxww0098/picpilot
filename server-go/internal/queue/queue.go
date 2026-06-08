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
)

type waiter struct {
	userID  string
	granted chan struct{}
	settled bool
}

// Options configures a Queue.
type Options struct {
	MaxConcurrent    int // global simultaneous in-flight limit
	MaxQueue         int // wait-queue length limit; Acquire returns ErrQueueFull when full
	MaxWaitMs        int // default queue wait limit (ms); <=0 means no limit
	PerUserSoftLimit int // per-user in-flight soft limit; 0 disables
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
	MaxConcurrent    int `json:"maxConcurrent"`
	MaxQueue         int `json:"maxQueue"`
	PerUserSoftLimit int `json:"perUserSoftLimit"`
}

// Queue is a concurrency-safe global semaphore with a FIFO wait queue.
type Queue struct {
	mu               sync.Mutex
	maxConcurrent    int
	maxQueue         int
	perUserSoftLimit int
	defaultWaitMs    int
	inflight         int
	waiters          []*waiter
	inflightByUser   map[string]int
}

// New creates a Queue from the given options.
func New(opts Options) *Queue {
	return &Queue{
		maxConcurrent:    max(1, opts.MaxConcurrent),
		maxQueue:         max(0, opts.MaxQueue),
		perUserSoftLimit: max(0, opts.PerUserSoftLimit),
		defaultWaitMs:    max(0, opts.MaxWaitMs),
		inflightByUser:   make(map[string]int),
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

// findDispatchIndex returns the index of the next waiter to dispatch. When the soft
// limit is on and the head waiter's user is already saturated, it skips ahead to the
// first non-saturated user. Caller holds mu.
func (q *Queue) findDispatchIndex() int {
	if len(q.waiters) == 0 {
		return -1
	}
	if q.perUserSoftLimit <= 0 || !q.isUserOverSoftLimit(q.waiters[0].userID) {
		return 0
	}
	for i, w := range q.waiters {
		if !q.isUserOverSoftLimit(w.userID) {
			return i
		}
	}
	return 0
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
		close(w.granted)
	}
}

// Acquire obtains a concurrency slot. It returns nil immediately when a slot is free
// and nobody is queued; otherwise it joins the FIFO queue. It returns ErrQueueFull
// when the queue is full, ErrWaitTimeout on wait timeout, and ErrClientAbort when ctx
// is cancelled. On success the caller must call Release exactly once.
func (q *Queue) Acquire(ctx context.Context, maxWaitMs int, userID string) error {
	if maxWaitMs <= 0 {
		maxWaitMs = q.defaultWaitMs
	}

	q.mu.Lock()
	if q.inflight < q.maxConcurrent && len(q.waiters) == 0 {
		q.inflight++
		q.incUser(userID)
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
	w := &waiter{userID: userID, granted: make(chan struct{})}
	q.waiters = append(q.waiters, w)
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

// Release frees one slot and wakes the next eligible waiter. A defensive guard keeps
// inflight from going negative if Release is somehow called more than once.
func (q *Queue) Release(userID string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.inflight <= 0 {
		return
	}
	q.inflight--
	q.decUser(userID)
	q.pump()
}

// SetLimits adjusts limits at runtime (admin "team settings"). Only non-nil fields are
// updated. Raising MaxConcurrent immediately wakes dispatchable waiters; lowering only
// affects subsequent dispatch decisions and never interrupts in-flight requests.
func (q *Queue) SetLimits(maxConcurrent, maxQueue, perUserSoftLimit *int) {
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
	q.pump()
}

// Limits returns the currently effective limits.
func (q *Queue) Limits() Limits {
	q.mu.Lock()
	defer q.mu.Unlock()
	return Limits{MaxConcurrent: q.maxConcurrent, MaxQueue: q.maxQueue, PerUserSoftLimit: q.perUserSoftLimit}
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
