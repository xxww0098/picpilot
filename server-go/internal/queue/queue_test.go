package queue

import (
	"context"
	"testing"
	"testing/synctest" // Go 1.25+: deterministic concurrency testing with a fake clock
)

func bg() context.Context { return context.Background() }

// --- simple, non-concurrent cases: plain tests ---

func TestAcquireImmediateWhenFree(t *testing.T) {
	q := New(Options{MaxConcurrent: 2, MaxQueue: 10})
	if err := q.Acquire(bg(), 0, "u1"); err != nil {
		t.Fatalf("expected immediate grant, got %v", err)
	}
	if s := q.Stats("u1"); s.Inflight != 1 || s.MyInflight != 1 {
		t.Fatalf("unexpected stats %+v", s)
	}
}

func TestQueueFullReturnsImmediately(t *testing.T) {
	q := New(Options{MaxConcurrent: 1, MaxQueue: 0})
	if err := q.Acquire(bg(), 0, "u1"); err != nil {
		t.Fatal(err)
	}
	if err := q.Acquire(bg(), 0, "u2"); err != ErrQueueFull {
		t.Fatalf("expected ErrQueueFull, got %v", err)
	}
}

// --- concurrent cases: deterministic via testing/synctest, no time.Sleep ---
// synctest.Wait() blocks until every goroutine in the bubble is durably blocked,
// giving us exact control over enqueue/dispatch ordering. The fake clock also
// auto-advances when all goroutines block, so wait timeouts resolve instantly.

func TestReleaseDispatchesFIFO(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		q := New(Options{MaxConcurrent: 1, MaxQueue: 10})
		if err := q.Acquire(bg(), 0, "u1"); err != nil {
			t.Fatal(err)
		}
		order := make(chan string, 2)
		go func() {
			if q.Acquire(bg(), 0, "a") == nil {
				order <- "a"
			}
		}()
		synctest.Wait() // 'a' is durably queued
		go func() {
			if q.Acquire(bg(), 0, "b") == nil {
				order <- "b"
			}
		}()
		synctest.Wait() // 'b' is durably queued

		q.Release("u1") // dispatch 'a'
		synctest.Wait()
		if got := <-order; got != "a" {
			t.Fatalf("expected 'a' first, got %s", got)
		}
		q.Release("a") // dispatch 'b'
		synctest.Wait()
		if got := <-order; got != "b" {
			t.Fatalf("expected 'b' second, got %s", got)
		}
		q.Release("b") // drain
	})
}

func TestWaitTimeout(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		q := New(Options{MaxConcurrent: 1, MaxQueue: 10})
		_ = q.Acquire(bg(), 0, "u1")
		// Fake clock auto-advances while the caller is durably blocked, so the 50ms
		// wait resolves instantly and deterministically.
		if err := q.Acquire(bg(), 50, "u2"); err != ErrWaitTimeout {
			t.Fatalf("expected ErrWaitTimeout, got %v", err)
		}
		if s := q.Stats(""); s.Queued != 0 {
			t.Fatalf("timed-out waiter should be removed, queued=%d", s.Queued)
		}
		q.Release("u1")
	})
}

func TestClientAbort(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		q := New(Options{MaxConcurrent: 1, MaxQueue: 10})
		_ = q.Acquire(bg(), 0, "u1")
		ctx, cancel := context.WithCancel(context.Background())
		res := make(chan error, 1)
		go func() { res <- q.Acquire(ctx, 0, "u2") }()
		synctest.Wait() // u2 durably queued
		cancel()
		synctest.Wait()
		if err := <-res; err != ErrClientAbort {
			t.Fatalf("expected ErrClientAbort, got %v", err)
		}
		q.Release("u1")
	})
}

// With a per-user soft limit, when the head waiter's user is saturated and a slot
// frees, the queue skips ahead to a non-saturated user.
func TestPerUserSoftLimitSkipsBusyUser(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		q := New(Options{MaxConcurrent: 2, MaxQueue: 10, PerUserSoftLimit: 1})
		_ = q.Acquire(bg(), 0, "u1")
		_ = q.Acquire(bg(), 0, "u1") // both slots held by u1
		granted := make(chan string, 2)
		go func() {
			if q.Acquire(bg(), 0, "u1") == nil {
				granted <- "u1"
			}
		}()
		synctest.Wait() // u1 queued at head (saturated)
		go func() {
			if q.Acquire(bg(), 0, "u2") == nil {
				granted <- "u2"
			}
		}()
		synctest.Wait() // u2 queued behind (eligible)

		q.Release("u1") // head u1 still at soft limit -> skip to u2
		synctest.Wait()
		if got := <-granted; got != "u2" {
			t.Fatalf("expected soft-limit skip to dispatch u2, got %s", got)
		}
		q.Release("u1") // u1 no longer saturated -> dispatch leftover u1
		synctest.Wait()
		if got := <-granted; got != "u1" {
			t.Fatalf("expected leftover u1 dispatched, got %s", got)
		}
		q.Release("u1")
		q.Release("u2")
	})
}

func TestSetLimitsRaiseWakesWaiter(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		q := New(Options{MaxConcurrent: 1, MaxQueue: 10})
		_ = q.Acquire(bg(), 0, "u1")
		res := make(chan error, 1)
		go func() { res <- q.Acquire(bg(), 0, "u2") }()
		synctest.Wait() // u2 queued

		two := 2
		q.SetLimits(&two, nil, nil) // raise concurrency -> dispatch waiter
		synctest.Wait()
		if err := <-res; err != nil {
			t.Fatalf("expected grant after raising limit, got %v", err)
		}
		q.Release("u1")
		q.Release("u2")
	})
}

func TestStatsMyNextPosition(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		q := New(Options{MaxConcurrent: 1, MaxQueue: 10})
		_ = q.Acquire(bg(), 0, "holder")
		ctx, cancel := context.WithCancel(context.Background())
		for _, u := range []string{"a", "b", "target"} {
			go func() { _ = q.Acquire(ctx, 0, u) }()
			synctest.Wait() // deterministic enqueue order: a, b, target
		}
		s := q.Stats("target")
		if s.MyQueued != 1 || s.MyNextPosition == nil || *s.MyNextPosition != 3 {
			t.Fatalf("expected target at position 3, got %+v", s)
		}
		cancel() // drain queued goroutines so the bubble doesn't deadlock
		synctest.Wait()
		q.Release("holder")
	})
}
