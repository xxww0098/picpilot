package chatgptreverse

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/xxww0098/picpilot/server-go/internal/config"
)

func TestDoJSONImagesGenerationsCodexExtractsDirectImageFields(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != codexResponsesPath {
			t.Fatalf("unexpected path=%q", r.URL.Path)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, `data: {"type":"response.completed","response":{"output":[{"type":"image_generation_call","base64":"aW1n","revised_prompt":"cat"}]}}`+"\n\n")
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	}))
	defer upstream.Close()

	store := testStore(t)
	saveTestAuth(t, store, "test.json", `{"access_token":"test-token"}`)
	svc := New(&config.Config{ChatGPTReverseBaseURL: upstream.URL}, store, testLogger())

	status, _, body := svc.DoJSON(t.Context(), "images/generations", `{"model":"codex-gpt-image-2","prompt":"cat"}`)
	if status != http.StatusOK {
		t.Fatalf("status=%d body=%s", status, body)
	}
	if !strings.Contains(body, `"b64_json":"aW1n"`) {
		t.Fatalf("body=%s", body)
	}
}

func TestDoJSONImagesGenerationsCodexExtractsCompletedImageCallEvent(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != codexResponsesPath {
			t.Fatalf("unexpected path=%q", r.URL.Path)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, `data: {"type":"response.output_item.added","item":{"id":"ig_1","type":"image_generation_call","status":"in_progress"},"output_index":0}`+"\n\n")
		_, _ = io.WriteString(w, `data: {"type":"response.image_generation_call.completed","item_id":"ig_1","result":"aW1n","revised_prompt":"cat","output_index":0}`+"\n\n")
		_, _ = io.WriteString(w, `data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[]}}`+"\n\n")
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	}))
	defer upstream.Close()

	store := testStore(t)
	saveTestAuth(t, store, "test.json", `{"access_token":"test-token"}`)
	svc := New(&config.Config{ChatGPTReverseBaseURL: upstream.URL}, store, testLogger())

	status, _, body := svc.DoJSON(t.Context(), "images/generations", `{"model":"codex-gpt-image-2","prompt":"cat"}`)
	if status != http.StatusOK {
		t.Fatalf("status=%d body=%s", status, body)
	}
	if !strings.Contains(body, `"b64_json":"aW1n"`) {
		t.Fatalf("body=%s", body)
	}
}
