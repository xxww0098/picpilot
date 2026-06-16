package chatgptreverse

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/xxww0098/picpilot/server-go/internal/config"
)

func TestIsWebImageTextReply(t *testing.T) {
	t.Parallel()
	cases := []struct {
		message string
		want    bool
	}{
		{"", false},
		{"Here is your image.", false},
		{`{"referenced_image_ids":["img_1"]}`, true},
		{`Use size {"size":"1024x1024","n":1} for output`, true},
	}
	for _, tc := range cases {
		if got := isWebImageTextReply(tc.message); got != tc.want {
			t.Fatalf("isWebImageTextReply(%q)=%v want %v", tc.message, got, tc.want)
		}
	}
}

func TestWebImageGenerationRetriesTextReplyOnNextAccount(t *testing.T) {
	oldPollDelay := webImagePollInitialDelay
	oldPollInterval := webImagePollInterval
	oldTextReplyPollTimeout := webImageTextReplyPollTimeout
	oldTextReplyPollMaxAttempts := webImageTextReplyPollMaxAttempts
	oldTextReplyPollBackoff := webImageTextReplyPollBackoffBase
	webImagePollInitialDelay = 0
	webImagePollInterval = time.Millisecond
	webImageTextReplyPollTimeout = 20 * time.Millisecond
	webImageTextReplyPollMaxAttempts = 1
	webImageTextReplyPollBackoffBase = time.Millisecond
	defer func() {
		webImagePollInitialDelay = oldPollDelay
		webImagePollInterval = oldPollInterval
		webImageTextReplyPollTimeout = oldTextReplyPollTimeout
		webImageTextReplyPollMaxAttempts = oldTextReplyPollMaxAttempts
		webImageTextReplyPollBackoffBase = oldTextReplyPollBackoff
	}()

	store := testStore(t)
	now := time.Now().UnixMilli()
	if err := store.SaveAuthAccount(t.Context(), StoredAuthAccount{Name: "good.json", RawJSON: `{"access_token":"good-token"}`, Size: 29, CreatedAt: now - 1000, UpdatedAt: now - 1000}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveAuthAccount(t.Context(), StoredAuthAccount{Name: "bad.json", RawJSON: `{"access_token":"bad-token"}`, Size: 28, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}

	fileID := "file_00000000abcdefabcdefabcdefabcdef"
	attempts := []string{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		switch r.URL.Path {
		case chatRequirementsPath:
			attempts = append(attempts, auth)
			writeJSON(w, http.StatusOK, map[string]any{
				"token":       "requirements-token",
				"proofofwork": map[string]any{"required": false},
				"turnstile":   map[string]any{"required": false},
			})
		case conversationPreparePath:
			writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "conduit_token": "conduit-token"})
		case conversationPath:
			if auth == "Bearer bad-token" {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = io.WriteString(w, `data: {"conversation_id":"conv_bad","message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":["tool params {\"size\":\"1024x1024\",\"n\":1}"]}}}`+"\n\n")
				_, _ = io.WriteString(w, "data: [DONE]\n\n")
				return
			}
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, `data: {"conversation_id":"conv_1","message":{"author":{"role":"tool"},"metadata":{"async_task_type":"image_gen"},"content":{"content_type":"multimodal_text","parts":[{"content_type":"image_asset_pointer","asset_pointer":"file-service://`+fileID+`"}]}}}`+"\n\n")
			_, _ = io.WriteString(w, "data: [DONE]\n\n")
		case conversationGetPrefix + "conv_bad":
			writeJSON(w, http.StatusOK, map[string]any{"mapping": map[string]any{}})
		case filesPathPrefix + fileID + "/download":
			writeJSON(w, http.StatusOK, map[string]any{"download_url": upstreamURL(r) + "/image.png"})
		case "/image.png":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write([]byte("img"))
		default:
			t.Fatalf("unexpected path=%q auth=%q", r.URL.Path, auth)
		}
	}))
	defer upstream.Close()

	svc := New(&config.Config{ChatGPTReverseBaseURL: upstream.URL}, store, testLogger())
	status, _, body := svc.DoJSON(t.Context(), "images/generations", `{"model":"gpt-image-2","prompt":"cat"}`)
	if status != http.StatusOK {
		t.Fatalf("status=%d body=%s", status, body)
	}
	if !strings.Contains(body, `"b64_json":"aW1n"`) {
		t.Fatalf("body=%s", body)
	}
	if len(attempts) < 2 || attempts[0] != "Bearer bad-token" {
		t.Fatalf("want bad account tried first, attempts=%v", attempts)
	}
}

func TestWebImageGenerationDoesNotRetryBlockedResponse(t *testing.T) {
	oldPollDelay := webImagePollInitialDelay
	webImagePollInitialDelay = 0
	defer func() { webImagePollInitialDelay = oldPollDelay }()

	store := testStore(t)
	now := time.Now().UnixMilli()
	if err := store.SaveAuthAccount(t.Context(), StoredAuthAccount{Name: "good.json", RawJSON: `{"access_token":"good-token"}`, Size: 29, CreatedAt: now - 1000, UpdatedAt: now - 1000}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveAuthAccount(t.Context(), StoredAuthAccount{Name: "backup.json", RawJSON: `{"access_token":"backup-token"}`, Size: 32, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}

	attempts := []string{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		switch r.URL.Path {
		case chatRequirementsPath:
			attempts = append(attempts, auth)
			writeJSON(w, http.StatusOK, map[string]any{
				"token":       "requirements-token",
				"proofofwork": map[string]any{"required": false},
				"turnstile":   map[string]any{"required": false},
			})
		case conversationPreparePath:
			writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "conduit_token": "conduit-token"})
		case conversationPath:
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, `data: {"type":"moderation","moderation_response":{"blocked":true},"conversation_id":"conv_blocked","message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":["policy blocked"]}}}`+"\n\n")
			_, _ = io.WriteString(w, "data: [DONE]\n\n")
		default:
			t.Fatalf("unexpected path=%q", r.URL.Path)
		}
	}))
	defer upstream.Close()

	svc := New(&config.Config{ChatGPTReverseBaseURL: upstream.URL}, store, testLogger())
	status, _, body := svc.DoJSON(t.Context(), "images/generations", `{"model":"gpt-image-2","prompt":"cat"}`)
	if status == http.StatusOK {
		t.Fatalf("expected blocked request to fail, body=%s", body)
	}
	if len(attempts) != 1 {
		t.Fatalf("blocked response should not rotate accounts, attempts=%v", attempts)
	}
}