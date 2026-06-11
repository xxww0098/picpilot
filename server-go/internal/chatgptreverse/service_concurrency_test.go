package chatgptreverse

import (
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/xxww0098/picpilot/server-go/internal/config"
	"github.com/xxww0098/picpilot/server-go/internal/db"
	"github.com/xxww0098/picpilot/server-go/internal/settings"
)

func TestPostCodexSerializesRequestsPerAccount(t *testing.T) {
	store := testStore(t)
	saveTestAuth(t, store, "one.json", `{"access_token":"one-token"}`)

	requestStarted := make(chan struct{}, 2)
	releaseFirst := make(chan struct{})
	var releaseOnce sync.Once
	release := func() {
		releaseOnce.Do(func() {
			close(releaseFirst)
		})
	}
	t.Cleanup(release)

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != codexResponsesPath {
			t.Fatalf("unexpected path=%q", r.URL.Path)
		}
		if auth := r.Header.Get("Authorization"); auth != "Bearer one-token" {
			t.Fatalf("unexpected auth=%q", auth)
		}
		requestStarted <- struct{}{}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		<-releaseFirst
		_, _ = io.WriteString(w, "data: {\"type\":\"response.completed\"}\n\n")
	}))
	defer upstream.Close()
	svc := New(&config.Config{ChatGPTReverseBaseURL: upstream.URL}, store, testLogger())

	firstRespCh := make(chan *http.Response, 1)
	firstErrCh := make(chan error, 1)
	go func() {
		resp, err := svc.postCodex(t.Context(), []byte(`{"stream":true}`))
		if err != nil {
			firstErrCh <- err
			return
		}
		firstRespCh <- resp
	}()
	select {
	case <-requestStarted:
	case err := <-firstErrCh:
		t.Fatalf("first postCodex failed: %v", err)
	case <-time.After(time.Second):
		t.Fatal("first request did not reach upstream")
	}
	var firstResp *http.Response
	t.Cleanup(func() {
		if firstResp != nil {
			_ = firstResp.Body.Close()
		}
	})
	select {
	case firstResp = <-firstRespCh:
	case err := <-firstErrCh:
		t.Fatalf("first postCodex failed: %v", err)
	case <-time.After(time.Second):
		t.Fatal("first postCodex did not return response headers")
	}

	secondDone := make(chan error, 1)
	go func() {
		resp, err := svc.postCodex(t.Context(), []byte(`{"stream":true}`))
		if resp != nil {
			_ = resp.Body.Close()
		}
		secondDone <- err
	}()
	select {
	case <-requestStarted:
		release()
		_ = firstResp.Body.Close()
		t.Fatal("second request reached the same account while first stream body was still open")
	case err := <-secondDone:
		t.Fatalf("second request finished before the first account slot was released: %v", err)
	case <-time.After(50 * time.Millisecond):
	}

	_ = firstResp.Body.Close()
	release()
	select {
	case err := <-secondDone:
		if err != nil {
			t.Fatalf("second postCodex failed after slot release: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("second request did not finish after first slot release")
	}
}

func TestPostCodexAllowsConfiguredConcurrentRequestsPerAccount(t *testing.T) {
	cfg := &config.Config{ReverseAccountConcurrency: 1}
	d, err := db.Open(filepath.Join(t.TempDir(), "reverse.db"), 10)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	store := NewStore(d)
	sp := settings.NewProvider(d, cfg)
	if err := sp.Save(map[string]any{"reverseAccountConcurrency": 2}, "admin"); err != nil {
		t.Fatal(err)
	}
	saveTestAuth(t, store, "one.json", `{"access_token":"one-token"}`)

	requestStarted := make(chan struct{}, 3)
	releaseAll := make(chan struct{})
	var releaseOnce sync.Once
	release := func() {
		releaseOnce.Do(func() {
			close(releaseAll)
		})
	}
	t.Cleanup(release)

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != codexResponsesPath {
			t.Fatalf("unexpected path=%q", r.URL.Path)
		}
		if auth := r.Header.Get("Authorization"); auth != "Bearer one-token" {
			t.Fatalf("unexpected auth=%q", auth)
		}
		requestStarted <- struct{}{}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		<-releaseAll
		_, _ = io.WriteString(w, "data: {\"type\":\"response.completed\"}\n\n")
	}))
	defer upstream.Close()
	cfg.ChatGPTReverseBaseURL = upstream.URL
	svc := New(cfg, store, testLogger(), sp)

	startPost := func() (<-chan *http.Response, <-chan error) {
		respCh := make(chan *http.Response, 1)
		errCh := make(chan error, 1)
		go func() {
			resp, err := svc.postCodex(t.Context(), []byte(`{"stream":true}`))
			if err != nil {
				errCh <- err
				return
			}
			respCh <- resp
		}()
		return respCh, errCh
	}

	firstRespCh, firstErrCh := startPost()
	secondRespCh, secondErrCh := startPost()
	for i := 0; i < 2; i++ {
		select {
		case <-requestStarted:
		case err := <-firstErrCh:
			t.Fatalf("first postCodex failed: %v", err)
		case err := <-secondErrCh:
			t.Fatalf("second postCodex failed: %v", err)
		case <-time.After(time.Second):
			t.Fatalf("request %d did not reach upstream", i+1)
		}
	}
	var firstResp, secondResp *http.Response
	t.Cleanup(func() {
		if firstResp != nil {
			_ = firstResp.Body.Close()
		}
		if secondResp != nil {
			_ = secondResp.Body.Close()
		}
	})
	select {
	case firstResp = <-firstRespCh:
	case err := <-firstErrCh:
		t.Fatalf("first postCodex failed: %v", err)
	case <-time.After(time.Second):
		t.Fatal("first postCodex did not return response headers")
	}
	select {
	case secondResp = <-secondRespCh:
	case err := <-secondErrCh:
		t.Fatalf("second postCodex failed: %v", err)
	case <-time.After(time.Second):
		t.Fatal("second postCodex did not return response headers")
	}

	thirdDone := make(chan error, 1)
	go func() {
		resp, err := svc.postCodex(t.Context(), []byte(`{"stream":true}`))
		if resp != nil {
			_ = resp.Body.Close()
		}
		thirdDone <- err
	}()
	select {
	case <-requestStarted:
		release()
		t.Fatal("third request exceeded configured per-account concurrency")
	case err := <-thirdDone:
		t.Fatalf("third request finished before a configured account slot was released: %v", err)
	case <-time.After(50 * time.Millisecond):
	}

	_ = firstResp.Body.Close()
	release()
	select {
	case err := <-thirdDone:
		if err != nil {
			t.Fatalf("third postCodex failed after slot release: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("third request did not finish after a slot release")
	}
	_ = secondResp.Body.Close()
}

func TestCollectOneWebImageSerializesRequestsPerAccount(t *testing.T) {
	store := testStore(t)
	saveTestAuth(t, store, "one.json", `{"access_token":"one-token"}`)

	fileID := "file_00000000abcdefabcdefabcdefabcdef"
	conversationStarted := make(chan struct{})
	secondRequirementsStarted := make(chan struct{}, 1)
	releaseFirst := make(chan struct{})
	var releaseOnce sync.Once
	release := func() {
		releaseOnce.Do(func() {
			close(releaseFirst)
		})
	}
	t.Cleanup(release)

	var mu sync.Mutex
	requirementsCount := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if auth := r.Header.Get("Authorization"); auth != "Bearer one-token" {
			t.Fatalf("unexpected auth=%q", auth)
		}
		switch r.URL.Path {
		case chatRequirementsPath:
			mu.Lock()
			requirementsCount++
			if requirementsCount == 2 {
				secondRequirementsStarted <- struct{}{}
			}
			mu.Unlock()
			writeJSON(w, http.StatusOK, map[string]any{
				"token":       "requirements-token",
				"proofofwork": map[string]any{"required": false},
				"turnstile":   map[string]any{"required": false},
			})
		case conversationPreparePath:
			writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "conduit_token": "conduit-token"})
		case conversationPath:
			select {
			case conversationStarted <- struct{}{}:
			default:
			}
			<-releaseFirst
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, `data: {"conversation_id":"conv_1","message":{"author":{"role":"tool"},"metadata":{"async_task_type":"image_gen"},"content":{"content_type":"multimodal_text","parts":[{"content_type":"image_asset_pointer","asset_pointer":"file-service://`+fileID+`"}]}}}`+"\n\n")
			_, _ = io.WriteString(w, "data: [DONE]\n\n")
		case filesPathPrefix + fileID + "/download":
			writeJSON(w, http.StatusOK, map[string]any{"download_url": upstreamURL(r) + "/image.png"})
		case "/image.png":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write([]byte("img"))
		default:
			t.Fatalf("unexpected path=%q", r.URL.Path)
		}
	}))
	defer upstream.Close()
	svc := New(&config.Config{ChatGPTReverseBaseURL: upstream.URL}, store, testLogger())
	body := map[string]any{"model": "gpt-image-2", "prompt": "cat"}

	firstDone := make(chan error, 1)
	go func() {
		_, err := svc.collectOneWebImage(t.Context(), cloneMap(body))
		firstDone <- err
	}()
	select {
	case <-conversationStarted:
	case err := <-firstDone:
		t.Fatalf("first web image request failed early: %v", err)
	case <-time.After(time.Second):
		t.Fatal("first web image request did not reach conversation stream")
	}

	secondDone := make(chan error, 1)
	go func() {
		_, err := svc.collectOneWebImage(t.Context(), cloneMap(body))
		secondDone <- err
	}()
	select {
	case <-secondRequirementsStarted:
		release()
		t.Fatal("second web image request reached the same account while first request was still running")
	case err := <-secondDone:
		t.Fatalf("second web image request finished before the first account slot was released: %v", err)
	case <-time.After(50 * time.Millisecond):
	}

	release()
	select {
	case err := <-firstDone:
		if err != nil {
			t.Fatalf("first web image request failed after release: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("first web image request did not finish after release")
	}
	select {
	case err := <-secondDone:
		if err != nil {
			t.Fatalf("second web image request failed after slot release: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("second web image request did not finish after first slot release")
	}
}
