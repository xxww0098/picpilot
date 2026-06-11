package chatgptreverse

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/xxww0098/picpilot/server-go/internal/config"
)

func TestDoJSONImagesGenerationsRetriesCodexStreamServerError(t *testing.T) {
	var attempts int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != codexResponsesPath {
			t.Fatalf("unexpected path=%q", r.URL.Path)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		if atomic.AddInt32(&attempts, 1) == 1 {
			_, _ = io.WriteString(w, `data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}`+"\n\n")
			_, _ = io.WriteString(w, `data: {"type":"response.output_item.added","item":{"id":"ig_1","type":"image_generation_call","status":"in_progress"},"output_index":0}`+"\n\n")
			_, _ = io.WriteString(w, `data: {"type":"error","error":{"type":"server_error","code":"server_error","message":"An error occurred while processing your request. You can retry your request."}}`+"\n\n")
			_, _ = io.WriteString(w, `data: {"type":"response.failed","response":{"id":"resp_1","status":"failed"}}`+"\n\n")
			_, _ = io.WriteString(w, "data: [DONE]\n\n")
			return
		}
		_, _ = io.WriteString(w, `data: {"type":"response.completed","response":{"output":[{"type":"image_generation_call","result":"aW1n","revised_prompt":"cat"}]}}`+"\n\n")
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	}))
	defer upstream.Close()

	store := testStore(t)
	saveTestAuth(t, store, "test.json", `{"access_token":"test-token"}`)
	svc := New(&config.Config{ChatGPTReverseBaseURL: upstream.URL, UpstreamMaxRetries: 1}, store, testLogger())

	status, _, body := svc.DoJSON(t.Context(), "images/generations", `{"model":"codex-gpt-image-2","prompt":"cat"}`)
	if status != http.StatusOK {
		t.Fatalf("status=%d body=%s", status, body)
	}
	if got := atomic.LoadInt32(&attempts); got != 2 {
		t.Fatalf("attempts=%d want 2", got)
	}
	if !strings.Contains(body, `"b64_json":"aW1n"`) {
		t.Fatalf("body=%s", body)
	}
}
