package chatgptreverse

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/xxww0098/picpilot/server-go/internal/config"
)

func TestCheckAuthAccountsClassifiesCloudflareChallengeAsError(t *testing.T) {
	store := testStore(t)
	saveTestAuth(t, store, "cf.json", `{"email":"cf@example.com","access_token":"cf-token"}`)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != webConversationInitPath {
			t.Fatalf("unexpected path=%q", r.URL.Path)
		}
		w.Header().Set("Cf-Mitigated", "challenge")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`<html><span id="challenge-error-text">Enable JavaScript and cookies to continue</span></html>`))
	}))
	defer upstream.Close()

	svc := New(&config.Config{ChatGPTReverseBaseURL: upstream.URL}, store, testLogger())
	results, err := svc.CheckAuthAccounts(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 {
		t.Fatalf("results=%v", results)
	}
	if results[0].Status != AuthCheckStatusError {
		t.Fatalf("cloudflare challenge status=%q want error; result=%+v", results[0].Status, results[0])
	}
	if !strings.Contains(results[0].Reason, "Cloudflare") {
		t.Fatalf("cloudflare challenge reason should mention Cloudflare: %+v", results[0])
	}
	record, found, err := store.GetAuthAccount(t.Context(), "cf.json")
	if err != nil || !found {
		t.Fatalf("load stored account: found=%v err=%v", found, err)
	}
	if record.Status != AuthCheckStatusError {
		t.Fatalf("stored cloudflare challenge status=%q want error; record=%+v", record.Status, record)
	}
}

func TestCheckAuthAccountsRunsWithBoundedConcurrency(t *testing.T) {
	store := testStore(t)
	for i := 0; i < 8; i++ {
		name := fmt.Sprintf("acct-%02d.json", i)
		token := fmt.Sprintf("token-%02d", i)
		saveTestAuth(t, store, name, fmt.Sprintf(`{"email":"acct-%02d@example.com","access_token":"%s"}`, i, token))
	}

	var inFlight int32
	var maxInFlight int32
	var started int32
	release := make(chan struct{})
	reachedFour := make(chan struct{})
	var closeReachedFour sync.Once

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case webConversationInitPath:
			current := atomic.AddInt32(&inFlight, 1)
			recordMaxInt32(&maxInFlight, current)
			if atomic.AddInt32(&started, 1) == 4 {
				closeReachedFour.Do(func() { close(reachedFour) })
			}
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
			atomic.AddInt32(&inFlight, -1)
			writeJSON(w, http.StatusOK, map[string]any{
				"default_model_slug": "gpt-5-3",
				"limits_progress": []any{map[string]any{
					"feature_name": "image_gen",
					"remaining":    3,
				}},
			})
		case webMePath:
			writeJSON(w, http.StatusOK, map[string]any{"email": "remote@example.com", "id": "user-remote"})
		case webAccountCheckRoutePath:
			writeJSON(w, http.StatusOK, map[string]any{
				"accounts": map[string]any{
					"default": map[string]any{"account": map[string]any{"plan_type": "plus"}},
				},
			})
		default:
			t.Fatalf("unexpected path=%q", r.URL.Path)
		}
	}))
	defer upstream.Close()

	svc := New(&config.Config{ChatGPTReverseBaseURL: upstream.URL}, store, testLogger())
	expectedRecords, err := store.ListAuthAccounts(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct {
		results []AuthCheckResult
		err     error
	}, 1)
	go func() {
		results, err := svc.CheckAuthAccounts(t.Context())
		done <- struct {
			results []AuthCheckResult
			err     error
		}{results: results, err: err}
	}()

	select {
	case <-reachedFour:
		time.Sleep(50 * time.Millisecond)
		close(release)
	case <-time.After(300 * time.Millisecond):
		close(release)
		result := <-done
		t.Fatalf("expected four concurrent quota checks before release; started=%d max=%d results=%d err=%v", atomic.LoadInt32(&started), atomic.LoadInt32(&maxInFlight), len(result.results), result.err)
	}

	result := <-done
	if result.err != nil {
		t.Fatal(result.err)
	}
	if len(result.results) != 8 {
		t.Fatalf("results=%d want 8", len(result.results))
	}
	if got := atomic.LoadInt32(&maxInFlight); got < 2 || got > 4 {
		t.Fatalf("max concurrent checks=%d want between 2 and 4", got)
	}
	for i, result := range result.results {
		want := expectedRecords[i].Name
		if result.Name != want {
			t.Fatalf("results should keep account order at index %d: got %q want %q", i, result.Name, want)
		}
	}
}

func recordMaxInt32(max *int32, value int32) {
	for {
		current := atomic.LoadInt32(max)
		if value <= current || atomic.CompareAndSwapInt32(max, current, value) {
			return
		}
	}
}
