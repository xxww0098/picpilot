// Package auth ports the authentication layer from server/index.ts: JWT issuance and
// verification, bcrypt password checks, sliding sessions with an absolute cap, invite
// code redemption, IP-based login rate limiting, and admin/user seeding.
package auth

import (
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"golang.org/x/crypto/bcrypt"

	"github.com/xxww0098/picpilot/server-go/internal/config"
	"github.com/xxww0098/picpilot/server-go/internal/db"
	"github.com/xxww0098/picpilot/server-go/internal/httpx"
	"github.com/xxww0098/picpilot/server-go/internal/idutil"
	"github.com/xxww0098/picpilot/server-go/internal/queue"
	"github.com/xxww0098/picpilot/server-go/internal/settings"
)

const (
	accountDisabledMessage = "账号已被禁用，请联系管理员。"
	rateLimit              = 5
	rateWindow             = 60 * time.Second
	bcryptCost             = 10 // matches the Node bcrypt cost; verifies $2a/$2b/$2y
)

type ctxKey int

const claimsKey ctxKey = 0

// Auth holds dependencies for the authentication module.
type Auth struct {
	db       *db.DB
	cfg      *config.Config
	q        *queue.Queue
	settings *settings.Provider
	logger   *slog.Logger

	mu            sync.Mutex
	loginAttempts map[string]rateEntry
}

type rateEntry struct {
	count   int
	resetAt time.Time
}

// New constructs the auth module.
func New(database *db.DB, cfg *config.Config, q *queue.Queue, sp *settings.Provider, logger *slog.Logger) *Auth {
	return &Auth{
		db: database, cfg: cfg, q: q, settings: sp, logger: logger,
		loginAttempts: make(map[string]rateEntry),
	}
}

// ----- password helpers (bcrypt, cross-compatible with existing $2b$ hashes) -----

func hashPassword(pw string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(pw), bcryptCost)
	return string(b), err
}

// HashPassword exposes bcrypt hashing for other modules (e.g. admin password reset).
func HashPassword(pw string) (string, error) { return hashPassword(pw) }

func verifyPassword(hash, pw string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(pw)) == nil
}

// ----- rate limiting & client IP -----

func (a *Auth) isRateLimited(ip string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := time.Now()
	e, ok := a.loginAttempts[ip]
	if !ok || e.resetAt.Before(now) {
		a.loginAttempts[ip] = rateEntry{count: 1, resetAt: now.Add(rateWindow)}
		return false
	}
	e.count++
	a.loginAttempts[ip] = e
	return e.count > rateLimit
}

func clientIP(r *http.Request) string {
	if ip := r.Header.Get("X-Real-IP"); ip != "" {
		return ip
	}
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return strings.TrimSpace(strings.Split(xff, ",")[0])
	}
	return "unknown"
}

// ClientIP returns the best-effort client IP (X-Real-IP / X-Forwarded-For), for reuse
// by other modules (e.g. telemetry event recording).
func ClientIP(r *http.Request) string { return clientIP(r) }

// ----- middleware & session validation -----

// Middleware verifies the JWT from headerName ("Authorization" for /api/*,
// "X-PicPilot-Authorization" for /api-proxy/*) and stores the claims in the context.
func (a *Auth) Middleware(headerName string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			tok := stripBearer(r.Header.Get(headerName))
			if tok == "" {
				httpx.Error(w, http.StatusUnauthorized, "未授权，请重新登录。")
				return
			}
			claims, err := parseToken(a.cfg.JWTSecret, tok)
			if err != nil {
				httpx.Error(w, http.StatusUnauthorized, "登录状态已失效，请重新登录。")
				return
			}
			ctx := context.WithValue(r.Context(), claimsKey, claims)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func stripBearer(h string) string {
	h = strings.TrimSpace(h)
	if len(h) >= 7 && strings.EqualFold(h[:7], "Bearer ") {
		return strings.TrimSpace(h[7:])
	}
	return h
}

// ClaimsFrom returns the verified claims stored by Middleware, or nil.
func ClaimsFrom(ctx context.Context) *Claims {
	c, _ := ctx.Value(claimsKey).(*Claims)
	return c
}

// RequireUser validates the session against live DB state (user exists, not disabled,
// token_version current). Must be chained after Middleware. Used by /api-proxy/*.
func (a *Auth) RequireUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		row, status, msg := a.validateSession(ClaimsFrom(r.Context()))
		if row == nil {
			httpx.Error(w, status, msg)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RequireAdmin validates the session and requires is_admin. Must be chained after Middleware.
func (a *Auth) RequireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		row, status, msg := a.validateSession(ClaimsFrom(r.Context()))
		if row == nil {
			httpx.Error(w, status, msg)
			return
		}
		if row.IsAdmin != 1 {
			httpx.Error(w, http.StatusForbidden, "需要管理员权限。请使用管理员账号登录后再操作。")
			return
		}
		next.ServeHTTP(w, r)
	})
}

type sessionRow struct {
	ID       string
	Username string
	IsAdmin  int
	Disabled int
	TV       int
}

// validateSession checks claims against live DB state: user exists, not disabled, and
// token_version matches (revocation). Returns (row, 0, "") on success, else (nil, status, msg).
func (a *Auth) validateSession(claims *Claims) (*sessionRow, int, string) {
	if claims == nil {
		return nil, http.StatusUnauthorized, "登录状态已失效，请重新登录。"
	}
	var row sessionRow
	err := a.db.QueryRow(
		"SELECT id, username, is_admin, disabled, token_version FROM users WHERE id = ?",
		claims.Subject,
	).Scan(&row.ID, &row.Username, &row.IsAdmin, &row.Disabled, &row.TV)
	if err != nil {
		return nil, http.StatusUnauthorized, "登录状态已失效，请重新登录。"
	}
	if row.Disabled == 1 {
		return nil, http.StatusForbidden, accountDisabledMessage
	}
	if claims.TV != row.TV {
		return nil, http.StatusUnauthorized, "登录状态已失效，请重新登录。"
	}
	return &row, 0, ""
}

// authUserPayload builds the /api/auth/me profile (nil,false if missing or disabled).
func (a *Auth) authUserPayload(userID string) (map[string]any, bool) {
	var (
		id, username       string
		displayName        sql.NullString
		isAdmin, disabled  int
		avatarUpdatedAt    sql.NullInt64
		publicStorageBytes int64
		galleryCount       int
	)
	err := a.db.QueryRow(`
		SELECT u.id, u.username, u.display_name, u.is_admin, u.disabled,
		       u.avatar_updated_at, u.public_storage_bytes,
		       (SELECT COUNT(*) FROM public_images pi WHERE pi.user_id = u.id)
		FROM users u WHERE u.id = ?`, userID,
	).Scan(&id, &username, &displayName, &isAdmin, &disabled, &avatarUpdatedAt, &publicStorageBytes, &galleryCount)
	if err != nil || disabled == 1 {
		return nil, false
	}
	sp := a.settings.Payload()
	lim := a.q.Limits()
	dn := username
	if displayName.Valid && displayName.String != "" {
		dn = displayName.String
	}
	var avatar any
	if avatarUpdatedAt.Valid {
		avatar = avatarUpdatedAt.Int64
	}
	if publicStorageBytes < 0 {
		publicStorageBytes = 0
	}
	return map[string]any{
		"userId":                  id,
		"username":                username,
		"displayName":             dn,
		"isAdmin":                 isAdmin == 1,
		"avatarUpdatedAt":         avatar,
		"maxBatchImages":          sp.DefaultMaxBatchImages,
		"galleryAutoRetryCount":   sp.GalleryAutoRetryCount,
		"maxConcurrent":           lim.MaxConcurrent,
		"maxQueue":                lim.MaxQueue,
		"proxyUserSoftLimit":      lim.PerUserSoftLimit,
		"streamFallbackEnabled":   sp.StreamFallbackEnabled,
		"requestTimeoutSeconds":   sp.RequestTimeoutSeconds,
		"allowedOutputFormats":    sp.AllowedOutputFormats,
		"publicGalleryCount":      galleryCount,
		"publicStorageBytes":      publicStorageBytes,
		"publicStorageQuotaBytes": a.cfg.PerUserPublicQuotaBytes,
	}, true
}

func (a *Auth) makeToken(userID, username string, isAdmin bool, tv int, sessionStart int64) (string, error) {
	return signToken(a.cfg.JWTSecret, a.cfg.JWTExpiresInSeconds, userID, username, isAdmin, tv, sessionStart)
}

// ----- routes -----

// Register mounts the auth routes on the shared router.
func (a *Auth) Register(r chi.Router) {
	r.Post("/api/auth/login", a.handleLogin)
	r.Post("/api/auth/register", a.handleRegister)
	r.Group(func(pr chi.Router) {
		pr.Use(a.Middleware("Authorization"))
		pr.Get("/api/auth/me", a.handleMe)
		pr.Post("/api/auth/refresh", a.handleRefresh)
		pr.Patch("/api/auth/profile", a.handleProfile)
	})
}

// maxAuthJSONBytes caps request body size for auth endpoints. Auth payloads are
// tiny (username/password/invite/displayName); capping them prevents an
// unauthenticated attacker from exhausting memory via oversized POSTs to the
// public /api/auth/login and /api/auth/register routes.
const maxAuthJSONBytes int64 = 1 << 20 // 1 MiB

// decodeJSON decodes a size-capped JSON request body into dst. It returns an
// error when the body is missing, malformed, or exceeds maxAuthJSONBytes.
func decodeJSON(r *http.Request, dst any) error {
	reader := http.MaxBytesReader(nil, r.Body, maxAuthJSONBytes)
	return json.NewDecoder(reader).Decode(dst)
}

func (a *Auth) handleLogin(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if a.isRateLimited(ip) {
		a.logger.Warn("login rate limited", "scope", "auth", "ip", ip)
		httpx.Error(w, http.StatusTooManyRequests, "登录失败次数过多，请稍后再试。")
		return
	}
	var body struct{ Username, Password string }
	if err := decodeJSON(r, &body); err != nil {
		httpx.Error(w, http.StatusRequestEntityTooLarge, "请求体过大或格式错误。")
		return
	}
	if body.Username == "" || body.Password == "" {
		httpx.Error(w, http.StatusBadRequest, "请输入用户名和密码。")
		return
	}
	var (
		id, username, hash    string
		isAdmin, disabled, tv int
	)
	err := a.db.QueryRow(
		"SELECT id, username, password_hash, is_admin, disabled, token_version FROM users WHERE username = ?",
		body.Username,
	).Scan(&id, &username, &hash, &isAdmin, &disabled, &tv)
	if err != nil || !verifyPassword(hash, body.Password) {
		a.logger.Warn("login failed: invalid credentials", "scope", "auth", "username", body.Username)
		httpx.Error(w, http.StatusUnauthorized, "用户名或密码错误，请重新输入。")
		return
	}
	if disabled == 1 {
		httpx.Error(w, http.StatusForbidden, accountDisabledMessage)
		return
	}
	_, _ = a.db.Exec("UPDATE users SET last_login_at = ? WHERE id = ?", time.Now().UnixMilli(), id)
	token, err := a.makeToken(id, username, isAdmin == 1, tv, 0)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "登录失败，请稍后重试。")
		return
	}
	profile, ok := a.authUserPayload(id)
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "登录状态已失效，请重新登录。")
		return
	}
	a.logger.Info("login success", "scope", "auth", "username", username, "userId", id)
	httpx.JSON(w, http.StatusOK, withToken(token, profile))
}

func (a *Auth) handleRegister(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if a.isRateLimited(ip) {
		httpx.Error(w, http.StatusTooManyRequests, "请求过于频繁，请稍后再试。")
		return
	}
	var raw struct{ Invite, Username, Password string }
	if err := decodeJSON(r, &raw); err != nil {
		httpx.Error(w, http.StatusRequestEntityTooLarge, "请求体过大或格式错误。")
		return
	}
	invite := strings.TrimSpace(raw.Invite)
	username := strings.TrimSpace(raw.Username)
	password := raw.Password
	if invite == "" || username == "" || password == "" {
		httpx.Error(w, http.StatusBadRequest, "请输入邀请码、用户名和密码。")
		return
	}
	if n := utf8.RuneCountInString(username); n < 2 || n > 32 {
		httpx.Error(w, http.StatusBadRequest, "用户名需要 2-32 个字符。")
		return
	}
	if strings.IndexFunc(username, unicode.IsSpace) != -1 {
		httpx.Error(w, http.StatusBadRequest, "用户名不能包含空格或换行。")
		return
	}
	if len(password) < 6 {
		httpx.Error(w, http.StatusBadRequest, "密码至少需要 6 位。")
		return
	}

	var (
		code      string
		expiresAt sql.NullInt64
		maxUses   int
		usedCount int
	)
	err := a.db.QueryRow("SELECT code, expires_at, max_uses, used_count FROM invite_codes WHERE code = ?", invite).
		Scan(&code, &expiresAt, &maxUses, &usedCount)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "邀请码无效，请检查是否输入完整。")
		return
	}
	now := time.Now().UnixMilli()
	if expiresAt.Valid && expiresAt.Int64 < now {
		httpx.Error(w, http.StatusBadRequest, "邀请码已过期，请联系管理员重新获取。")
		return
	}
	if usedCount >= maxUses {
		httpx.Error(w, http.StatusBadRequest, "邀请码已用完，请联系管理员重新获取。")
		return
	}
	var dup int
	if a.db.QueryRow("SELECT 1 FROM users WHERE LOWER(username) = LOWER(?)", username).Scan(&dup) == nil {
		httpx.Error(w, http.StatusConflict, "用户名已被占用，请换一个用户名。")
		return
	}

	userID := idutil.UUIDv4()
	hash, err := hashPassword(password)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "注册失败，请稍后重试。")
		return
	}
	defaultMaxBatch := a.settings.DefaultMaxBatchImages()

	tx, err := a.db.Begin()
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "注册失败，请稍后重试。")
		return
	}
	res, err := tx.Exec(
		"UPDATE invite_codes SET used_count = used_count + 1 WHERE code = ? AND used_count < max_uses AND (expires_at IS NULL OR expires_at >= ?)",
		invite, now,
	)
	if err != nil {
		_ = tx.Rollback()
		httpx.Error(w, http.StatusInternalServerError, "注册失败，请稍后重试。")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		_ = tx.Rollback()
		httpx.Error(w, http.StatusBadRequest, "邀请码已用完，请联系管理员重新获取。")
		return
	}
	if _, err := tx.Exec(
		"INSERT INTO users (id, username, password_hash, is_admin, max_batch_images, created_at, last_login_at) VALUES (?, ?, ?, 0, ?, ?, ?)",
		userID, username, hash, defaultMaxBatch, now, now,
	); err != nil {
		_ = tx.Rollback()
		httpx.Error(w, http.StatusInternalServerError, "注册失败，请稍后重试。")
		return
	}
	if _, err := tx.Exec(
		"INSERT INTO invite_redemptions (code, user_id, redeemed_at) VALUES (?, ?, ?)",
		invite, userID, now,
	); err != nil {
		_ = tx.Rollback()
		httpx.Error(w, http.StatusInternalServerError, "注册失败，请稍后重试。")
		return
	}
	if err := tx.Commit(); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "注册失败，请稍后重试。")
		return
	}

	token, err := a.makeToken(userID, username, false, 0, 0)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "注册失败，请稍后重试。")
		return
	}
	profile, ok := a.authUserPayload(userID)
	if !ok {
		httpx.Error(w, http.StatusInternalServerError, "注册失败，请稍后重试。")
		return
	}
	a.logger.Info("register success", "scope", "auth", "username", username, "userId", userID)
	httpx.JSON(w, http.StatusOK, withToken(token, profile))
}

func (a *Auth) handleMe(w http.ResponseWriter, r *http.Request) {
	row, status, msg := a.validateSession(ClaimsFrom(r.Context()))
	if row == nil {
		httpx.Error(w, status, msg)
		return
	}
	profile, ok := a.authUserPayload(row.ID)
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "登录状态已失效，请重新登录。")
		return
	}
	httpx.JSON(w, http.StatusOK, profile)
}

func (a *Auth) handleRefresh(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r.Context())
	row, status, msg := a.validateSession(claims)
	if row == nil {
		httpx.Error(w, status, msg)
		return
	}
	now := time.Now().Unix()
	sst := claims.SST
	if sst == 0 {
		sst = now
	}
	if now-sst > int64(a.cfg.JWTSessionMaxSeconds) {
		httpx.Error(w, http.StatusUnauthorized, "登录会话已达上限，请重新登录。")
		return
	}
	token, err := a.makeToken(row.ID, row.Username, row.IsAdmin == 1, row.TV, sst)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "刷新失败，请稍后重试。")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"token": token})
}

func (a *Auth) handleProfile(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r.Context())
	if claims == nil {
		httpx.Error(w, http.StatusUnauthorized, "登录状态已失效，请重新登录。")
		return
	}
	var body struct {
		DisplayName any `json:"displayName"`
	}
	if err := decodeJSON(r, &body); err != nil {
		httpx.Error(w, http.StatusRequestEntityTooLarge, "请求体过大或格式错误。")
		return
	}
	name, errMsg := normalizeDisplayName(body.DisplayName)
	if errMsg != "" {
		httpx.Error(w, http.StatusBadRequest, errMsg)
		return
	}
	res, err := a.db.Exec("UPDATE users SET display_name = ? WHERE id = ?", name, claims.Subject)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "保存失败，请稍后重试。")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		httpx.Error(w, http.StatusUnauthorized, "登录状态已失效，请重新登录。")
		return
	}
	profile, ok := a.authUserPayload(claims.Subject)
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "登录状态已失效，请重新登录。")
		return
	}
	httpx.JSON(w, http.StatusOK, profile)
}

// normalizeDisplayName mirrors normalizeDisplayNameValue: collapse whitespace, trim,
// reject empty / >24 chars / control chars. Returns (value, "") or ("", errorMessage).
func normalizeDisplayName(v any) (string, string) {
	s, ok := v.(string)
	if !ok {
		return "", "请输入要显示的名字。"
	}
	s = strings.Join(strings.Fields(s), " ")
	if s == "" {
		return "", "显示名不能为空。"
	}
	if utf8.RuneCountInString(s) > 24 {
		return "", "显示名最多 24 个字符。"
	}
	for _, c := range s {
		if c < 0x20 || c == 0x7f {
			return "", "显示名不能包含控制字符。"
		}
	}
	return s, ""
}

func withToken(token string, profile map[string]any) map[string]any {
	out := make(map[string]any, len(profile)+1)
	out["token"] = token
	for k, v := range profile {
		out[k] = v
	}
	return out
}

// ----- seeding (ADMIN_USERS / AUTH_USERS) -----

// Seed creates admin/user accounts from "user:pass,user2:pass2" env strings. Existing
// admins get is_admin=1; existing users are left unchanged.
func (a *Auth) Seed(adminUsers, authUsers string) error {
	if err := a.seedGroup(adminUsers, true); err != nil {
		return err
	}
	if err := a.seedGroup(authUsers, false); err != nil {
		return err
	}
	var n int
	_ = a.db.QueryRow("SELECT COUNT(*) FROM users WHERE is_admin = 1").Scan(&n)
	if n == 0 {
		a.logger.Warn("no admin users configured", "scope", "auth", "hint", "set ADMIN_USERS=name:password")
	}
	return nil
}

func (a *Auth) seedGroup(env string, isAdmin bool) error {
	for _, pair := range strings.Split(env, ",") {
		idx := strings.Index(pair, ":")
		if idx <= 0 {
			continue
		}
		username := strings.TrimSpace(pair[:idx])
		password := strings.TrimSpace(pair[idx+1:])
		if username == "" || password == "" {
			continue
		}
		var existingID string
		if err := a.db.QueryRow("SELECT id FROM users WHERE username = ?", username).Scan(&existingID); err == nil {
			if isAdmin {
				_, _ = a.db.Exec("UPDATE users SET is_admin = 1 WHERE id = ?", existingID)
			}
			continue
		}
		hash, err := hashPassword(password)
		if err != nil {
			return err
		}
		adminInt := 0
		if isAdmin {
			adminInt = 1
		}
		if _, err := a.db.Exec(
			"INSERT INTO users (id, username, password_hash, is_admin, max_batch_images, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			idutil.UUIDv4(), username, hash, adminInt, a.settings.DefaultMaxBatchImages(), time.Now().UnixMilli(),
		); err != nil {
			return err
		}
		role := "user"
		if isAdmin {
			role = "admin"
		}
		a.logger.Info("seeded user", "scope", "auth", "username", username, "role", role)
	}
	return nil
}
