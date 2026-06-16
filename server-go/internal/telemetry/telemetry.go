// Package telemetry ports the telemetry event recorder, the notifications API, and the
// background event-retention purge from server/index.ts.
package telemetry

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/picpilot/server-go/internal/auth"
	"github.com/xxww0098/picpilot/server-go/internal/db"
	"github.com/xxww0098/picpilot/server-go/internal/httpx"
)

// Module wires telemetry + notification routes and the retention purge.
type Module struct {
	db            *db.DB
	auth          *auth.Auth
	logger        *slog.Logger
	retentionDays int
}

func New(d *db.DB, a *auth.Auth, logger *slog.Logger, retentionDays int) *Module {
	return &Module{db: d, auth: a, logger: logger, retentionDays: retentionDays}
}

// Register mounts /api/telemetry/* and /api/notifications/* behind JWT.
func (m *Module) Register(r chi.Router) {
	r.Group(func(pr chi.Router) {
		pr.Use(m.auth.Middleware("Authorization"))
		pr.Post("/api/telemetry/event", m.handleEvent)
		pr.Get("/api/notifications", m.listNotifications)
		pr.Get("/api/notifications/unread-count", m.unreadCount)
		pr.Post("/api/notifications/read", m.markRead)
	})
}

// StartPurge runs an immediate purge and then every 24h (matches the TS interval).
// StartPurge runs an immediate purge and then every 24h (matches the TS
// interval). The loop exits when ctx is cancelled so it does not leak when the
// server shuts down (or if StartPurge is ever called more than once).
func (m *Module) StartPurge(ctx context.Context) {
	m.purge()
	go func() {
		t := time.NewTicker(24 * time.Hour)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				m.purge()
			}
		}
	}()
}

func (m *Module) purge() {
	cutoff := time.Now().UnixMilli() - int64(m.retentionDays)*24*60*60*1000
	res, err := m.db.Exec("DELETE FROM request_events WHERE created_at < ?", cutoff)
	if err != nil {
		m.logger.Error("event purge failed", "scope", "telemetry", "err", err.Error())
		return
	}
	if n, _ := res.RowsAffected(); n > 0 {
		m.logger.Info("purged old events", "scope", "telemetry", "deleted", n, "retentionDays", m.retentionDays)
	}
}

// ----- telemetry event -----

func clip(v any, max int) any {
	if v == nil {
		return nil
	}
	s, ok := v.(string)
	if !ok {
		s = toString(v)
	}
	if len([]rune(s)) > max {
		return string([]rune(s)[:max])
	}
	return s
}

func numOrNil(v any) any {
	if f, ok := v.(float64); ok {
		return f
	}
	return nil
}

func boolInt(v any) int {
	if b, ok := v.(bool); ok && b {
		return 1
	}
	if f, ok := v.(float64); ok && f != 0 {
		return 1
	}
	return 0
}

func (m *Module) handleEvent(w http.ResponseWriter, r *http.Request) {
	claims := auth.ClaimsFrom(r.Context())
	var e map[string]any
	if err := json.NewDecoder(r.Body).Decode(&e); err != nil || e == nil || e["event_type"] == nil {
		httpx.Error(w, http.StatusBadRequest, "请求记录上报格式无效。")
		return
	}
	now := time.Now().UnixMilli()
	isSuccess := e["event_type"] == "success"
	appMode := "gallery"
	switch e["app_mode"] {
	case "agent":
		appMode = "agent"
	case "video":
		appMode = "video"
	}
	var imageIndex any
	if f, ok := e["image_index"].(float64); ok && f == float64(int64(f)) {
		imageIndex = int64(f)
	}

	tx, err := m.db.Begin()
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "上报失败。")
		return
	}
	_, err1 := tx.Exec(`
		INSERT INTO request_events (
			user_id, username, event_type, app_mode, provider, api_mode, model, size, quality, n_images,
			has_input_image, input_image_count, has_mask, prompt, duration_ms, http_status,
			error_type, error_message, error_stack, output_count, output_bytes,
			action_type, task_id, image_index, user_agent, ip, client_version, created_at
		) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		claims.Subject, claims.Username, clip(e["event_type"], 32), appMode,
		clip(e["provider"], 64), clip(e["api_mode"], 32), clip(e["model"], 128), clip(e["size"], 32), clip(e["quality"], 32), numOrNil(e["n_images"]),
		boolInt(e["has_input_image"]), numOrNil(e["input_image_count"]), boolInt(e["has_mask"]),
		clip(e["prompt"], 4000), numOrNil(e["duration_ms"]), numOrNil(e["http_status"]),
		clip(e["error_type"], 64), clip(e["error_message"], 2000), clip(e["error_stack"], 8000),
		numOrNil(e["output_count"]), numOrNil(e["output_bytes"]),
		clip(e["action_type"], 64), clip(e["task_id"], 128), imageIndex,
		clip(r.Header.Get("User-Agent"), 512), auth.ClientIP(r), clip(e["client_version"], 64), now,
	)
	successCount, failureCount := 0, 1
	if isSuccess {
		successCount, failureCount = 1, 0
	}
	durationMs := 0.0
	if f, ok := e["duration_ms"].(float64); ok {
		durationMs = f
	}
	outputBytes := 0.0
	if f, ok := e["output_bytes"].(float64); ok {
		outputBytes = f
	}
	_, err2 := tx.Exec(`
		INSERT INTO user_stats (user_id, total_requests, success_count, failure_count, last_request_at, total_duration_ms, total_output_bytes)
		VALUES (?, 1, ?, ?, ?, ?, ?)
		ON CONFLICT(user_id) DO UPDATE SET
			total_requests = total_requests + 1,
			success_count = success_count + excluded.success_count,
			failure_count = failure_count + excluded.failure_count,
			last_request_at = excluded.last_request_at,
			total_duration_ms = total_duration_ms + excluded.total_duration_ms,
			total_output_bytes = total_output_bytes + excluded.total_output_bytes`,
		claims.Subject, successCount, failureCount, now, durationMs, outputBytes,
	)
	if err1 != nil || err2 != nil {
		_ = tx.Rollback()
		httpx.Error(w, http.StatusInternalServerError, "上报失败。")
		return
	}
	if err := tx.Commit(); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "上报失败。")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ----- notifications -----

func (m *Module) userID(r *http.Request) string {
	if c := auth.ClaimsFrom(r.Context()); c != nil {
		return c.Subject
	}
	return ""
}

func (m *Module) listNotifications(w http.ResponseWriter, r *http.Request) {
	userID := m.userID(r)
	limit := clampQuery(r, "limit", 30, 1, 100)
	offset := clampQuery(r, "offset", 0, 0, 1<<31)
	rows, err := m.db.Query(
		"SELECT id, type, title, body, metadata, read_at, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
		userID, limit, offset)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "加载通知失败。")
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var (
			id, createdAt    int64
			typ, title, body string
			metadata         *string
			readAt           *int64
		)
		if err := rows.Scan(&id, &typ, &title, &body, &metadata, &readAt, &createdAt); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "加载通知失败。")
			return
		}
		var meta any
		if metadata != nil {
			_ = json.Unmarshal([]byte(*metadata), &meta)
		}
		items = append(items, map[string]any{
			"id": id, "type": typ, "title": title, "body": body,
			"metadata": meta, "read_at": int64PtrOrNil(readAt), "created_at": createdAt,
		})
	}
	var total, unread int
	_ = m.db.QueryRow("SELECT COUNT(*) FROM notifications WHERE user_id = ?", userID).Scan(&total)
	_ = m.db.QueryRow("SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL", userID).Scan(&unread)
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items, "total": total, "unread": unread})
}

func (m *Module) unreadCount(w http.ResponseWriter, r *http.Request) {
	var unread int
	_ = m.db.QueryRow("SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL", m.userID(r)).Scan(&unread)
	httpx.JSON(w, http.StatusOK, map[string]any{"unread": unread})
}

func (m *Module) markRead(w http.ResponseWriter, r *http.Request) {
	userID := m.userID(r)
	var body struct {
		IDs []float64 `json:"ids"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	now := time.Now().UnixMilli()
	if len(body.IDs) > 0 {
		args := []any{now, userID}
		ph := make([]string, 0, len(body.IDs))
		for _, id := range body.IDs {
			ph = append(ph, "?")
			args = append(args, int64(id))
		}
		res, err := m.db.Exec(
			"UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN ("+strings.Join(ph, ",")+")", args...)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "操作失败。")
			return
		}
		n, _ := res.RowsAffected()
		httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "updated": n})
		return
	}
	res, err := m.db.Exec("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL", now, userID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "操作失败。")
		return
	}
	n, _ := res.RowsAffected()
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "updated": n})
}

// ----- helpers -----

func toString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		if t {
			return "true"
		}
		return "false"
	default:
		b, _ := json.Marshal(t)
		return string(b)
	}
}

func int64PtrOrNil(p *int64) any {
	if p == nil {
		return nil
	}
	return *p
}

func clampQuery(r *http.Request, key string, def, lo, hi int) int {
	v := r.URL.Query().Get(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	if n < lo {
		return lo
	}
	if n > hi {
		return hi
	}
	return n
}
