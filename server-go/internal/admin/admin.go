// Package admin ports the admin backend from server/index.ts (all routes behind
// JWT + RequireAdmin): runtime team settings, user management, invite codes, usage
// events + CSV export, overview, and shared-gallery moderation (feature/revoke).
package admin

import (
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/picpilot/server-go/internal/auth"
	"github.com/xxww0098/picpilot/server-go/internal/chatgptreverse"
	"github.com/xxww0098/picpilot/server-go/internal/config"
	"github.com/xxww0098/picpilot/server-go/internal/db"
	"github.com/xxww0098/picpilot/server-go/internal/gallery"
	"github.com/xxww0098/picpilot/server-go/internal/httpx"
	"github.com/xxww0098/picpilot/server-go/internal/queue"
	"github.com/xxww0098/picpilot/server-go/internal/settings"
)

// Module wires the admin routes.
type Module struct {
	db           *db.DB
	cfg          *config.Config
	q            *queue.Queue
	settings     *settings.Provider
	auth         *auth.Auth
	logger       *slog.Logger
	reverse      reverseAuthChecker
	reverseStore *chatgptreverse.Store
	reverseJobs  *reverseAuthCheckJobManager
}

type reverseAuthChecker interface {
	CheckAuthAccounts(context.Context) ([]chatgptreverse.AuthCheckResult, error)
}

type reverseAuthProgressChecker interface {
	CountAuthAccounts(context.Context) (int, error)
	CheckAuthAccountsWithProgress(context.Context, func(chatgptreverse.AuthCheckResult)) ([]chatgptreverse.AuthCheckResult, error)
}

type reverseAuthSelectiveProgressChecker interface {
	CheckAuthAccountsByNameWithProgress(context.Context, []string, func(chatgptreverse.AuthCheckResult)) ([]chatgptreverse.AuthCheckResult, error)
}

func New(d *db.DB, cfg *config.Config, q *queue.Queue, sp *settings.Provider, a *auth.Auth, logger *slog.Logger, reverse ...reverseAuthChecker) *Module {
	var checker reverseAuthChecker
	if len(reverse) > 0 {
		checker = reverse[0]
	}
	return &Module{
		db: d, cfg: cfg, q: q, settings: sp, auth: a, logger: logger,
		reverse: checker, reverseStore: chatgptreverse.NewStore(d), reverseJobs: newReverseAuthCheckJobManager(),
	}
}

// Register mounts admin routes behind JWT + RequireAdmin.
func (m *Module) Register(r chi.Router) {
	r.Group(func(pr chi.Router) {
		pr.Use(m.auth.Middleware("Authorization"))
		pr.Use(m.auth.RequireAdmin)

		pr.Get("/api/admin/team-settings", m.getTeamSettings)
		pr.Patch("/api/admin/team-settings", m.patchTeamSettings)
		pr.Get("/api/admin/users", m.listUsers)
		pr.Patch("/api/admin/users/{id}", m.patchUser)
		pr.Delete("/api/admin/users/{id}", m.deleteUser)
		pr.Get("/api/admin/invites", m.listInvites)
		pr.Post("/api/admin/invites", m.createInvites)
		pr.Delete("/api/admin/invites/{code}", m.deleteInvite)
		pr.Get("/api/admin/events", m.listEvents)
		pr.Get("/api/admin/events/export", m.exportEvents)
		pr.Get("/api/admin/overview", m.overview)
		pr.Get("/api/admin/reverse-auth", m.getReverseAuth)
		pr.Post("/api/admin/reverse-auth/check", m.checkReverseAuth)
		pr.Post("/api/admin/reverse-auth/check-jobs", m.startReverseAuthCheckJob)
		pr.Get("/api/admin/reverse-auth/check-jobs/{id}", m.getReverseAuthCheckJob)
		pr.Get("/api/admin/reverse-auth/sources", m.listReverseAuthImportSources)
		pr.Put("/api/admin/reverse-auth/sources", m.saveReverseAuthImportSources)
		pr.Post("/api/admin/reverse-auth/accounts", m.uploadReverseAuthAccount)
		pr.Post("/api/admin/reverse-auth/accounts/access-token", m.importReverseAuthAccessToken)
		pr.Get("/api/admin/reverse-auth/accounts/export", m.exportReverseAuthAccounts)
		pr.Post("/api/admin/reverse-auth/accounts/bulk-delete", m.bulkDeleteReverseAuthAccounts)
		pr.Get("/api/admin/reverse-auth/cliproxy/accounts", m.listCLIProxyReverseAuthAccounts)
		pr.Post("/api/admin/reverse-auth/cliproxy/import", m.importCLIProxyReverseAuthAccounts)
		pr.Post("/api/admin/reverse-auth/sub2api/import", m.importSub2APIReverseAuthAccounts)
		pr.Get("/api/admin/reverse-auth/accounts/{name}", m.getReverseAuthAccount)
		pr.Patch("/api/admin/reverse-auth/accounts/{name}", m.updateReverseAuthAccount)
		pr.Delete("/api/admin/reverse-auth/accounts/{name}", m.deleteReverseAuthAccount)
		pr.Post("/api/admin/gallery/{id}/revoke", m.revokeImage)
		pr.Post("/api/admin/gallery/{id}/feature", m.featureImage)
	})
}

func (m *Module) actor(r *http.Request) string {
	if c := auth.ClaimsFrom(r.Context()); c != nil {
		return c.Subject
	}
	return ""
}

// queryMaps runs a query and returns rows as JSON-friendly maps (SELECT * support).
func (m *Module) queryMaps(q string, args ...any) ([]map[string]any, error) {
	rows, err := m.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	out := []map[string]any{}
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		rec := make(map[string]any, len(cols))
		for i, c := range cols {
			if b, ok := vals[i].([]byte); ok {
				rec[c] = string(b)
			} else {
				rec[c] = vals[i]
			}
		}
		out = append(out, rec)
	}
	return out, rows.Err()
}

// ----- team settings -----

func (m *Module) getTeamSettings(w http.ResponseWriter, _ *http.Request) {
	httpx.JSON(w, http.StatusOK, m.settings.Payload())
}

func (m *Module) patchTeamSettings(w http.ResponseWriter, r *http.Request) {
	var record map[string]any
	_ = json.NewDecoder(r.Body).Decode(&record)
	if record == nil {
		record = map[string]any{}
	}
	settingsRec := m.settings.Record()
	hasUpdates := false

	type intField struct {
		key, errMsg string
		parse       func(any) (int, bool)
	}
	intFields := []intField{
		{"defaultMaxBatchImages", "默认批量上限必须是 1 到 100 之间的数字。", config.ParseBatchImageLimitPatchValue},
		{"maxConcurrent", "团队并发必须是 1 到 100 之间的数字。", config.ParseConcurrencyPatchValue},
		{"maxQueue", "排队上限必须是 0 到 1000 之间的数字。", config.ParseQueuePatchValue},
		{"proxyUserSoftLimit", "单用户软上限必须是 0 到 100 之间的数字。", config.ParseProxyUserSoftLimitPatchValue},
		{"reverseAccountConcurrency", "逆向单账号并发必须是 1 到 5 之间的数字。", config.ParseReverseAccountConcurrencyPatchValue},
		{"galleryAutoRetryCount", "失败自动重试次数必须是 0 到 5 之间的数字。", config.ParseGalleryAutoRetryCountPatchValue},
		{"requestTimeoutSeconds", "请求超时必须是 30 到 3600 秒之间的数字。", config.ParseRequestTimeoutSecondsPatchValue},
	}
	for _, f := range intFields {
		if raw, ok := record[f.key]; ok {
			v, valid := f.parse(raw)
			if !valid {
				httpx.Error(w, http.StatusBadRequest, f.errMsg)
				return
			}
			settingsRec[f.key] = v
			hasUpdates = true
		}
	}
	if raw, ok := record["streamFallbackEnabled"]; ok {
		v, valid := config.ParseBooleanPatchValue(raw)
		if !valid {
			httpx.Error(w, http.StatusBadRequest, "流式失败回退开关必须是布尔值。")
			return
		}
		settingsRec["streamFallbackEnabled"] = v
		hasUpdates = true
	}
	if raw, ok := record["allowedOutputFormats"]; ok {
		v, valid := config.ParseAllowedOutputFormatsPatchValue(raw)
		if !valid {
			httpx.Error(w, http.StatusBadRequest, "可选出图格式至少保留一种，且只能包含 PNG、JPEG 或 WebP。")
			return
		}
		settingsRec["allowedOutputFormats"] = v
		hasUpdates = true
	}
	if raw, ok := record["outboundProxyType"]; ok {
		v, valid := config.ParseOutboundProxyTypePatchValue(raw)
		if !valid {
			httpx.Error(w, http.StatusBadRequest, "出站代理类型必须是 env、none、http、https、socks5 或 socks5h。")
			return
		}
		settingsRec["outboundProxyType"] = v
		hasUpdates = true
	}
	if raw, ok := record["outboundProxyUrl"]; ok {
		v, valid := config.ParseOutboundProxyURLPatchValue(raw)
		if !valid {
			httpx.Error(w, http.StatusBadRequest, "出站代理地址必须是 2048 字以内的单行文本。")
			return
		}
		settingsRec["outboundProxyUrl"] = v
		hasUpdates = true
	}
	if raw, ok := record["cliproxyApiUrl"]; ok {
		v, valid := config.ParseCLIProxyAPIURLPatchValue(raw)
		if !valid {
			httpx.Error(w, http.StatusBadRequest, "CLIProxyAPI 地址必须是 2048 字以内的 http/https URL。")
			return
		}
		settingsRec["cliproxyApiUrl"] = v
		hasUpdates = true
	}
	if raw, ok := record["cliproxyManagementKey"]; ok {
		v, valid := config.ParseCLIProxyManagementKeyPatchValue(raw)
		if !valid {
			httpx.Error(w, http.StatusBadRequest, "CLIProxyAPI 管理密钥必须是 4096 字以内的单行文本。")
			return
		}
		settingsRec["cliproxyManagementKey"] = v
		hasUpdates = true
	}
	if !hasUpdates {
		httpx.Error(w, http.StatusBadRequest, "没有可更新的字段。")
		return
	}
	nextProxyType := config.NormalizeOutboundProxyType(settingsRec["outboundProxyType"], m.cfg.OutboundProxyType)
	nextProxyURL := config.NormalizeOutboundProxyURL(settingsRec["outboundProxyUrl"])
	if nextProxyURL == "" {
		nextProxyURL = m.cfg.OutboundProxyURL
	}
	if config.OutboundProxyTypeRequiresURL(nextProxyType) {
		if _, err := config.BuildOutboundProxyURL(nextProxyType, nextProxyURL); err != nil {
			httpx.Error(w, http.StatusBadRequest, "出站代理地址无效，请填写 host:port 或完整代理 URL。")
			return
		}
	}

	if err := m.settings.Save(settingsRec, m.actor(r)); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "保存失败，请稍后重试。")
		return
	}
	// Apply new limits to the live queue immediately (no restart needed).
	eff := m.settings.Payload()
	m.q.SetLimits(&eff.MaxConcurrent, &eff.MaxQueue, &eff.ProxyUserSoftLimit)
	m.logger.Info("team service limits updated", "scope", "admin", "updatedBy", m.actor(r),
		"maxConcurrent", eff.MaxConcurrent, "maxQueue", eff.MaxQueue,
		"proxyUserSoftLimit", eff.ProxyUserSoftLimit,
		"reverseAccountConcurrency", eff.ReverseAccountConcurrency)
	httpx.JSON(w, http.StatusOK, eff)
}

// ----- users -----

func (m *Module) listUsers(w http.ResponseWriter, _ *http.Request) {
	users, err := m.queryMaps(`
		SELECT u.id, u.username, u.is_admin, u.disabled, u.max_batch_images, u.created_at, u.last_login_at,
		       u.avatar_updated_at, s.total_requests, s.success_count, s.failure_count, s.last_request_at,
		       s.total_duration_ms, s.total_output_bytes
		FROM users u LEFT JOIN user_stats s ON s.user_id = u.id
		ORDER BY u.created_at DESC`)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "加载用户失败。")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"users": users})
}

func (m *Module) patchUser(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	self := m.actor(r)
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)

	isAdmin, hasIsAdmin := body["isAdmin"].(bool)
	disabled, hasDisabled := body["disabled"].(bool)
	password, hasPassword := body["password"].(string)

	if hasIsAdmin && !isAdmin {
		if id == self {
			httpx.Error(w, http.StatusBadRequest, "不能取消自己的管理员身份，请改用其他管理员账号操作。")
			return
		}
		if m.targetIsAdmin(id) && m.countAdmins("") <= 1 {
			httpx.Error(w, http.StatusBadRequest, "至少需要保留一个管理员，无法降级最后一个管理员。")
			return
		}
	}
	if hasDisabled && disabled {
		if id == self {
			httpx.Error(w, http.StatusBadRequest, "不能禁用当前登录的账号。")
			return
		}
		if m.targetIsAdmin(id) && m.countAdmins("AND disabled = 0") <= 1 {
			httpx.Error(w, http.StatusBadRequest, "至少需要保留一个启用的管理员，无法禁用最后一个管理员。")
			return
		}
	}

	updates := []string{}
	args := []any{}
	if hasIsAdmin {
		updates = append(updates, "is_admin = ?")
		args = append(args, boolToInt(isAdmin))
	}
	if hasDisabled {
		updates = append(updates, "disabled = ?")
		args = append(args, boolToInt(disabled))
	}
	if hasPassword && len(password) >= 6 {
		hash, err := auth.HashPassword(password)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "重置密码失败，请稍后重试。")
			return
		}
		updates = append(updates, "password_hash = ?", "token_version = token_version + 1")
		args = append(args, hash)
	}
	if len(updates) == 0 {
		httpx.Error(w, http.StatusBadRequest, "没有可更新的字段。")
		return
	}
	args = append(args, id)
	res, err := m.db.Exec("UPDATE users SET "+strings.Join(updates, ", ")+" WHERE id = ?", args...)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "更新失败，请稍后重试。")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		httpx.Error(w, http.StatusNotFound, "用户不存在，可能已被删除。")
		return
	}
	m.logger.Info("admin updated user", "scope", "admin", "actor", self, "targetUserId", id)
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (m *Module) deleteUser(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if id == m.actor(r) {
		httpx.Error(w, http.StatusBadRequest, "不能删除当前登录的管理员账号。")
		return
	}
	// delete the user's public image files before the FK cascade removes their rows
	imgs, _ := m.queryMaps("SELECT id FROM public_images WHERE user_id = ?", id)
	for _, img := range imgs {
		if iid, ok := img["id"].(string); ok {
			gallery.DeletePublicImageFiles(m.db, m.cfg.PublicDir, m.cfg.ThumbsDir, iid)
		}
	}
	res, err := m.db.Exec("DELETE FROM users WHERE id = ?", id)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "删除失败，请稍后重试。")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		httpx.Error(w, http.StatusNotFound, "用户不存在，可能已被删除。")
		return
	}
	m.logger.Warn("admin deleted user", "scope", "admin", "actor", m.actor(r), "targetUserId", id)
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (m *Module) targetIsAdmin(id string) bool {
	var v int
	_ = m.db.QueryRow("SELECT is_admin FROM users WHERE id = ?", id).Scan(&v)
	return v == 1
}

func (m *Module) countAdmins(extra string) int {
	var n int
	_ = m.db.QueryRow("SELECT COUNT(*) FROM users WHERE is_admin = 1 " + extra).Scan(&n)
	return n
}

// ----- invites -----

func (m *Module) listInvites(w http.ResponseWriter, _ *http.Request) {
	invites, err := m.queryMaps(`
		SELECT c.code, c.created_by, c.created_at, c.expires_at, c.max_uses, c.used_count, c.note,
		       u.username AS creator_username
		FROM invite_codes c LEFT JOIN users u ON u.id = c.created_by
		ORDER BY c.created_at DESC`)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "加载邀请码失败。")
		return
	}
	redemptions, _ := m.queryMaps(`
		SELECT r.code, r.user_id, r.redeemed_at, u.username
		FROM invite_redemptions r LEFT JOIN users u ON u.id = r.user_id
		ORDER BY r.redeemed_at DESC`)
	byCode := map[string][]map[string]any{}
	for _, red := range redemptions {
		code, _ := red["code"].(string)
		byCode[code] = append(byCode[code], map[string]any{
			"user_id": red["user_id"], "username": red["username"], "redeemed_at": red["redeemed_at"],
		})
	}
	for _, inv := range invites {
		code, _ := inv["code"].(string)
		if r := byCode[code]; r != nil {
			inv["redemptions"] = r
		} else {
			inv["redemptions"] = []any{}
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"invites": invites})
}

func (m *Module) createInvites(w http.ResponseWriter, r *http.Request) {
	var body struct {
		MaxUses   *float64 `json:"maxUses"`
		Count     *float64 `json:"count"`
		Note      string   `json:"note"`
		ExpiresAt *float64 `json:"expiresAt"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	maxUses := clamp(intFromPtr(body.MaxUses, 1), 1, config.InviteMaxUses)
	count := clamp(intFromPtr(body.Count, 1), 1, config.InviteMaxBatchCount)
	var note any
	if body.Note != "" {
		note = truncateRunes(body.Note, config.InviteNoteMaxLen)
	}
	var expiresAt any
	if body.ExpiresAt != nil {
		expiresAt = int64(*body.ExpiresAt)
	}
	now := time.Now().UnixMilli()

	tx, err := m.db.Begin()
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "生成邀请码失败，请稍后重试。")
		return
	}
	codes := make([]string, 0, count)
	for i := 0; i < count; i++ {
		code := config.GenerateInviteCode()
		if _, err := tx.Exec(
			"INSERT INTO invite_codes (code, created_by, created_at, expires_at, max_uses, used_count, note) VALUES (?,?,?,?,?,0,?)",
			code, m.actor(r), now, expiresAt, maxUses, note,
		); err != nil {
			_ = tx.Rollback()
			httpx.Error(w, http.StatusInternalServerError, "生成邀请码失败，请稍后重试。")
			return
		}
		codes = append(codes, code)
	}
	if err := tx.Commit(); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "生成邀请码失败，请稍后重试。")
		return
	}
	m.logger.Info("admin created invite codes", "scope", "admin", "actor", m.actor(r), "count", len(codes), "maxUses", maxUses)
	httpx.JSON(w, http.StatusOK, map[string]any{"code": codes[0], "codes": codes})
}

func (m *Module) deleteInvite(w http.ResponseWriter, r *http.Request) {
	code := chi.URLParam(r, "code")
	res, err := m.db.Exec("DELETE FROM invite_codes WHERE code = ?", code)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "吊销失败，请稍后重试。")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		httpx.Error(w, http.StatusNotFound, "邀请码不存在，可能已被吊销。")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ----- events + export + overview -----

func eventFilters(r *http.Request) (string, []any) {
	where := []string{}
	args := []any{}
	if v := r.URL.Query().Get("user_id"); v != "" {
		where = append(where, "user_id = ?")
		args = append(args, v)
	}
	if v := r.URL.Query().Get("event_type"); v != "" {
		where = append(where, "event_type = ?")
		args = append(args, v)
	}
	if v := r.URL.Query().Get("app_mode"); v != "" {
		if v == "gallery" {
			where = append(where, "(app_mode = ? OR app_mode IS NULL)")
		} else {
			where = append(where, "app_mode = ?")
		}
		args = append(args, v)
	}
	if v := r.URL.Query().Get("error_type"); v != "" {
		where = append(where, "error_type = ?")
		args = append(args, v)
	}
	if len(where) == 0 {
		return "", args
	}
	return "WHERE " + strings.Join(where, " AND "), args
}

func (m *Module) listEvents(w http.ResponseWriter, r *http.Request) {
	whereSql, args := eventFilters(r)
	// optional since/until on top of eventFilters
	extra := []string{}
	if v := queryInt64(r, "since"); v != nil {
		extra = append(extra, "created_at >= ?")
		args = append(args, *v)
	}
	if v := queryInt64(r, "until"); v != nil {
		extra = append(extra, "created_at <= ?")
		args = append(args, *v)
	}
	if len(extra) > 0 {
		if whereSql == "" {
			whereSql = "WHERE " + strings.Join(extra, " AND ")
		} else {
			whereSql += " AND " + strings.Join(extra, " AND ")
		}
	}
	limit := clampQuery(r, "limit", 50, 1, 200)
	offset := clampQuery(r, "offset", 0, 0, 1<<31)

	events, err := m.queryMaps("SELECT * FROM request_events "+whereSql+" ORDER BY created_at DESC LIMIT ? OFFSET ?", append(args, limit, offset)...)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "加载事件失败。")
		return
	}
	var total int
	_ = m.db.QueryRow("SELECT COUNT(*) FROM request_events "+whereSql, args...).Scan(&total)
	httpx.JSON(w, http.StatusOK, map[string]any{"events": events, "total": total})
}

var exportColumns = []struct{ Key, Label string }{
	{"created_at", "时间"}, {"id", "ID"}, {"username", "用户名"}, {"user_id", "用户ID"},
	{"event_type", "结果"}, {"app_mode", "模式"}, {"provider", "服务商"}, {"api_mode", "接口模式"},
	{"model", "模型"}, {"size", "尺寸"}, {"quality", "质量"}, {"n_images", "请求张数"},
	{"has_input_image", "参考图数"}, {"has_mask", "遮罩"}, {"prompt", "提示词"}, {"duration_ms", "耗时ms"},
	{"http_status", "HTTP状态"}, {"error_type", "错误类型"}, {"error_message", "错误信息"},
	{"output_count", "输出张数"}, {"output_bytes", "输出字节"}, {"action_type", "操作类型"},
	{"task_id", "任务ID"}, {"image_index", "图片序号"}, {"user_agent", "浏览器"}, {"ip", "IP"},
	{"client_version", "客户端版本"},
}

func (m *Module) exportEvents(w http.ResponseWriter, r *http.Request) {
	sinceP, untilP := queryInt64(r, "since"), queryInt64(r, "until")
	if sinceP == nil || untilP == nil {
		httpx.Error(w, http.StatusBadRequest, "请指定导出的起止日期")
		return
	}
	since, until := *sinceP, *untilP
	if since > until {
		httpx.Error(w, http.StatusBadRequest, "起止日期无效")
		return
	}
	if until-since > 31*24*60*60*1000 {
		httpx.Error(w, http.StatusBadRequest, "导出范围不能超过 31 天")
		return
	}
	whereSql, args := eventFilters(r)
	if whereSql == "" {
		whereSql = "WHERE created_at >= ? AND created_at <= ?"
	} else {
		whereSql += " AND created_at >= ? AND created_at <= ?"
	}
	args = append(args, since, until)

	rows, err := m.queryMaps("SELECT * FROM request_events "+whereSql+" ORDER BY created_at ASC", args...)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "导出失败。")
		return
	}

	var b strings.Builder
	b.WriteString("\ufeff") // UTF-8 BOM for Excel
	labels := make([]string, len(exportColumns))
	for i, c := range exportColumns {
		labels[i] = csvEscape(c.Label)
	}
	b.WriteString(strings.Join(labels, ","))
	for _, row := range rows {
		b.WriteString("\r\n")
		cells := make([]string, len(exportColumns))
		for i, col := range exportColumns {
			cells[i] = csvEscape(formatCell(col.Key, row[col.Key]))
		}
		b.WriteString(strings.Join(cells, ","))
	}

	startDate := time.UnixMilli(since).UTC().Format("2006-01-02")
	endDate := time.UnixMilli(until).UTC().Format("2006-01-02")
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="picpilot-events-`+startDate+"_"+endDate+`.csv"`)
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte(b.String()))
}

func (m *Module) overview(w http.ResponseWriter, _ *http.Request) {
	since := time.Now().Add(-7 * 24 * time.Hour).UnixMilli()
	totals, _ := m.queryMaps(`
		SELECT COUNT(*) AS total,
		       SUM(CASE WHEN event_type = 'success' THEN 1 ELSE 0 END) AS success,
		       SUM(CASE WHEN event_type != 'success' THEN 1 ELSE 0 END) AS failure,
		       AVG(duration_ms) AS avg_duration, SUM(output_bytes) AS total_output
		FROM request_events WHERE created_at >= ?`, since)
	errors, _ := m.queryMaps("SELECT error_type, COUNT(*) AS n FROM request_events WHERE created_at >= ? AND error_type IS NOT NULL GROUP BY error_type ORDER BY n DESC", since)
	providers, _ := m.queryMaps("SELECT provider, COUNT(*) AS n FROM request_events WHERE created_at >= ? AND provider IS NOT NULL GROUP BY provider ORDER BY n DESC", since)
	var totalsObj any = map[string]any{}
	if len(totals) > 0 {
		totalsObj = totals[0]
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"totals": totalsObj, "errors": errors, "providers": providers})
}

// ----- gallery moderation -----

func (m *Module) revokeImage(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var ownerID, prompt string
	var fileSize sql.NullInt64
	if err := m.db.QueryRow("SELECT user_id, prompt, file_size FROM public_images WHERE id = ?", id).Scan(&ownerID, &prompt, &fileSize); err != nil {
		httpx.Error(w, http.StatusNotFound, "图片不存在，可能已被删除。")
		return
	}
	var body struct {
		Reason string `json:"reason"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	reason := truncateRunes(strings.TrimSpace(body.Reason), 500)

	gallery.DeletePublicImageFiles(m.db, m.cfg.PublicDir, m.cfg.ThumbsDir, id)

	excerpt := truncateRunes(prompt, 80)
	if len([]rune(prompt)) > 80 {
		excerpt += "…"
	}
	notifBody := "你的公开图「" + excerpt + "」已被管理员撤下。"
	if reason != "" {
		notifBody += "\n理由：" + reason
	}
	meta, _ := json.Marshal(map[string]any{"image_id": id, "prompt_excerpt": excerpt, "reason": nullableStr(reason)})
	shouldNotify := ownerID != m.actor(r)
	now := time.Now().UnixMilli()

	tx, err := m.db.Begin()
	if err == nil {
		_, e1 := tx.Exec("DELETE FROM public_images WHERE id = ?", id)
		var e2, e3 error
		if fileSize.Valid && fileSize.Int64 > 0 {
			_, e2 = tx.Exec("UPDATE users SET public_storage_bytes = MAX(0, public_storage_bytes - ?) WHERE id = ?", fileSize.Int64, ownerID)
		}
		if shouldNotify {
			_, e3 = tx.Exec("INSERT INTO notifications (user_id, type, title, body, metadata, created_at) VALUES (?,'gallery_revoked',?,?,?,?)",
				ownerID, "公开图已被撤下", notifBody, string(meta), now)
		}
		if e1 != nil || e2 != nil || e3 != nil {
			_ = tx.Rollback()
			err = e1
		} else {
			err = tx.Commit()
		}
	}
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "撤下失败，请稍后重试。")
		return
	}
	m.logger.Info("gallery image revoked", "scope", "admin", "actor", m.actor(r), "owner", ownerID, "imageId", id, "hasReason", reason != "")
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (m *Module) featureImage(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var exists int
	if err := m.db.QueryRow("SELECT 1 FROM public_images WHERE id = ?", id).Scan(&exists); err != nil {
		httpx.Error(w, http.StatusNotFound, "图片不存在，可能已被删除。")
		return
	}
	var body struct {
		Featured any `json:"featured"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	featured := 0
	if b, ok := body.Featured.(bool); ok && b {
		featured = 1
	} else if n, ok := body.Featured.(float64); ok && n == 1 {
		featured = 1
	}
	if _, err := m.db.Exec("UPDATE public_images SET featured = ? WHERE id = ?", featured, id); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "操作失败，请稍后重试。")
		return
	}
	m.logger.Info("gallery image featured toggled", "scope", "admin", "actor", m.actor(r), "imageId", id, "featured", featured == 1)
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "featured": featured == 1})
}

// ----- helpers -----

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func intFromPtr(p *float64, def int) int {
	if p == nil {
		return def
	}
	return int(*p)
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
	return clamp(n, lo, hi)
}

func queryInt64(r *http.Request, key string) *int64 {
	v := r.URL.Query().Get(key)
	if v == "" {
		return nil
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return nil
	}
	return &n
}

func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

func nullableStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func csvEscape(v any) string {
	if v == nil {
		return ""
	}
	s := toString(v)
	if strings.ContainsAny(s, "\",\n\r") {
		return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
	}
	return s
}

func toString(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case []byte:
		return string(t)
	case int64:
		return strconv.FormatInt(t, 10)
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

func formatCell(key string, v any) any {
	switch key {
	case "created_at":
		if n, ok := v.(int64); ok {
			return time.UnixMilli(n).UTC().Format("2006-01-02T15:04:05.000Z")
		}
	case "image_index":
		if n, ok := v.(int64); ok {
			return n + 1
		}
	case "has_mask":
		if v == nil {
			return "否"
		}
		if n, ok := v.(int64); ok && n == 0 {
			return "否"
		}
		return "是"
	}
	return v
}
