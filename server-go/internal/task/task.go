package task

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/picpilot/server-go/internal/auth"
	"github.com/xxww0098/picpilot/server-go/internal/config"
	"github.com/xxww0098/picpilot/server-go/internal/db"
	"github.com/xxww0098/picpilot/server-go/internal/httpx"
	"github.com/xxww0098/picpilot/server-go/internal/queue"
	"github.com/xxww0098/picpilot/server-go/internal/settings"
)

// Module wires the task store, executor, and HTTP routes.
type Module struct {
	store  *Store
	exec   *Executor
	auth   *auth.Auth
	logger *slog.Logger
}

// New constructs the task module. Call Start to launch the executor.
func New(d *db.DB, q *queue.Queue, sp *settings.Provider, cfg *config.Config, a *auth.Auth, logger *slog.Logger) *Module {
	store := NewStore(d)
	return &Module{
		store:  store,
		exec:   NewExecutor(store, q, sp, cfg, logger),
		auth:   a,
		logger: logger,
	}
}

// Start launches the executor workers and recovers pending tasks.
func (m *Module) Start() { m.exec.Start() }

// Register mounts the task routes behind JWT + RequireUser.
func (m *Module) Register(r chi.Router) {
	r.Group(func(pr chi.Router) {
		pr.Use(m.auth.Middleware("Authorization"))
		pr.Use(m.auth.RequireUser)
		pr.Post("/api/tasks", m.handleSubmit)
		pr.Get("/api/tasks/{id}", m.handleGet)
		pr.Get("/api/tasks/{id}/events", m.handleEvents)
		pr.Post("/api/tasks/{id}/cancel", m.handleCancel)
	})
}

func (m *Module) userID(r *http.Request) string {
	if c := auth.ClaimsFrom(r.Context()); c != nil {
		return c.Subject
	}
	return ""
}

type submitBody struct {
	Endpoint       string          `json:"endpoint"`
	Payload        json.RawMessage `json:"payload"`
	IdempotencyKey string          `json:"idempotencyKey"`
	Type           string          `json:"type"`
}

func (m *Module) handleSubmit(w http.ResponseWriter, r *http.Request) {
	var body submitBody
	_ = json.NewDecoder(r.Body).Decode(&body)
	endpoint := strings.TrimSpace(body.Endpoint)
	if endpoint == "" {
		httpx.Error(w, http.StatusBadRequest, "请提供上游 endpoint（如 images/generations）。")
		return
	}
	if len(body.Payload) == 0 {
		httpx.Error(w, http.StatusBadRequest, "请提供请求体 payload。")
		return
	}
	typ := strings.TrimSpace(body.Type)
	if typ == "" {
		typ = "image"
	}
	t, created, err := m.store.Create(m.userID(r), strings.TrimSpace(body.IdempotencyKey), typ, endpoint, string(body.Payload))
	if err != nil {
		m.logger.Error("task create failed", "scope", "task", "err", err.Error())
		httpx.Error(w, http.StatusInternalServerError, "提交任务失败，请稍后重试。")
		return
	}
	if created {
		m.exec.dispatch(t.ID)
		m.logger.Info("task submitted", "scope", "task", "id", t.ID, "endpoint", endpoint)
	}
	httpx.JSON(w, http.StatusOK, t.View())
}

// load fetches a task and enforces ownership (404 when missing or not owned, to avoid
// leaking task existence across users).
func (m *Module) load(w http.ResponseWriter, r *http.Request) (*Task, bool) {
	id := chi.URLParam(r, "id")
	t, err := m.store.Get(id)
	if err != nil || t.UserID != m.userID(r) {
		httpx.Error(w, http.StatusNotFound, "任务不存在。")
		return nil, false
	}
	return t, true
}

func (m *Module) handleGet(w http.ResponseWriter, r *http.Request) {
	if t, ok := m.load(w, r); ok {
		httpx.JSON(w, http.StatusOK, t.View())
	}
}

func (m *Module) handleCancel(w http.ResponseWriter, r *http.Request) {
	t, ok := m.load(w, r)
	if !ok {
		return
	}
	m.exec.CancelRunning(t.ID)            // abort in-flight upstream request, if running
	canceled, err := m.store.Cancel(t.ID) // mark canceled if queued/running
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "取消任务失败，请稍后重试。")
		return
	}
	if canceled {
		m.exec.Pub().publish(t.ID)
	}
	cur, _ := m.store.Get(t.ID)
	httpx.JSON(w, http.StatusOK, cur.View())
}

func (m *Module) handleEvents(w http.ResponseWriter, r *http.Request) {
	t, ok := m.load(w, r)
	if !ok {
		return
	}

	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("Connection", "keep-alive")
	if rc := http.NewResponseController(w); rc != nil {
		_ = rc.SetWriteDeadline(time.Time{})
	}
	flusher, _ := w.(http.Flusher)

	// Subscribe before re-reading so no update between read and subscribe is missed.
	ch := m.exec.Pub().subscribe(t.ID)
	defer m.exec.Pub().unsubscribe(t.ID, ch)

	send := func() bool {
		cur, err := m.store.Get(t.ID)
		if err != nil {
			return false
		}
		data, _ := json.Marshal(cur.View())
		if _, err := io.WriteString(w, "data: "+string(data)+"\n\n"); err != nil {
			return false
		}
		if flusher != nil {
			flusher.Flush()
		}
		return !cur.Status.terminal()
	}

	if !send() { // initial state; stop if already terminal
		return
	}
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ch:
			if !send() {
				return
			}
		case <-time.After(15 * time.Second):
			if _, err := io.WriteString(w, ": ping\n\n"); err != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
	}
}
