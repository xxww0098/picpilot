// Package gallery ports the shared gallery and avatar features from server/index.ts:
// publishing images (resized webp main + thumbnail + referenced originals) under a
// per-user storage quota enforced inside a serialized transaction, listing, deletion,
// authenticated image serving, and user avatars. Image processing is pure-Go (imageproc).
package gallery

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/picpilot/server-go/internal/auth"
	"github.com/xxww0098/picpilot/server-go/internal/config"
	"github.com/xxww0098/picpilot/server-go/internal/db"
	"github.com/xxww0098/picpilot/server-go/internal/httpx"
	"github.com/xxww0098/picpilot/server-go/internal/idutil"
	"github.com/xxww0098/picpilot/server-go/internal/imageproc"
)

const (
	maxPublicOriginals  = 9
	maxPublicInputBytes = 50 * 1024 * 1024
)

// Module wires gallery + avatar routes.
type Module struct {
	db     *db.DB
	cfg    *config.Config
	auth   *auth.Auth
	logger *slog.Logger
}

func New(d *db.DB, cfg *config.Config, a *auth.Auth, logger *slog.Logger) *Module {
	return &Module{db: d, cfg: cfg, auth: a, logger: logger}
}

// Register mounts gallery + avatar routes behind JWT (Authorization header).
func (m *Module) Register(r chi.Router) {
	r.Group(func(pr chi.Router) {
		pr.Use(m.auth.Middleware("Authorization"))
		pr.Post("/api/gallery", m.handlePublish)
		pr.Get("/api/gallery", m.handleList)
		pr.Delete("/api/gallery/{id}", m.handleDelete)
		pr.Get("/api/gallery/image/{id}", m.handleServeImage)
		pr.Post("/api/auth/avatar", m.handleAvatarUpload)
		pr.Delete("/api/auth/avatar", m.handleAvatarDelete)
		pr.Get("/api/avatars/{userId}", m.handleAvatarGet)
	})
}

func (m *Module) userID(r *http.Request) string {
	if c := auth.ClaimsFrom(r.Context()); c != nil {
		return c.Subject
	}
	return ""
}

type processed struct {
	id     string
	final  []byte
	thumb  []byte
	width  int
	height int
}

func (m *Module) process(b64 string) (*processed, int, string) {
	raw, err := imageproc.DecodeBase64(b64)
	if err != nil || len(raw) == 0 {
		return nil, http.StatusBadRequest, "上传的图片为空，请重新选择。"
	}
	if len(raw) > maxPublicInputBytes {
		return nil, http.StatusRequestEntityTooLarge, "图片过大，请上传 50MB 以内的图片。"
	}
	p, err := imageproc.ProcessPublic(raw, config.MaxImageLongEdge, config.ThumbLongEdge)
	if err != nil {
		if errors.Is(err, imageproc.ErrImageTooLarge) {
			return nil, http.StatusBadRequest, "图片尺寸过大（宽×高超过 4096×4096），请缩小后重试。"
		}
		return nil, http.StatusBadRequest, "无法处理这张图片，请换一张试试。"
	}
	return &processed{id: idutil.UUIDv4(), final: p.Final, thumb: p.Thumb, width: p.Width, height: p.Height}, 0, ""
}

func (m *Module) writeImageFiles(p *processed) error {
	if err := os.WriteFile(m.publicPath(p.id), p.final, 0o644); err != nil {
		return err
	}
	return os.WriteFile(m.thumbPath(p.id), p.thumb, 0o644)
}

func (m *Module) publicPath(id string) string { return m.cfg.PublicDir + "/" + id + ".webp" }
func (m *Module) thumbPath(id string) string  { return m.cfg.ThumbsDir + "/" + id + ".webp" }

func (m *Module) cleanupFiles(ids ...string) {
	for _, id := range ids {
		_ = os.Remove(m.publicPath(id))
		_ = os.Remove(m.thumbPath(id))
	}
}

func (m *Module) handlePublish(w http.ResponseWriter, r *http.Request) {
	userID := m.userID(r)

	// Pre-check quota for a fast fail before doing image work; the authoritative check
	// is the re-read inside the transaction below (serialization point).
	var used int64
	_ = m.db.QueryRow("SELECT public_storage_bytes FROM users WHERE id = ?", userID).Scan(&used)
	if used >= m.cfg.PerUserPublicQuotaBytes {
		httpx.Error(w, http.StatusRequestEntityTooLarge, "公开画廊空间已用完，请先删除一些公开图片后再上传。")
		return
	}

	var body struct {
		ImageBase64 string `json:"image_base64"`
		Prompt      string `json:"prompt"`
		Originals   []any  `json:"originals"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.ImageBase64 == "" {
		httpx.Error(w, http.StatusBadRequest, "请提供要公开的图片和提示词。")
		return
	}

	main, status, msg := m.process(body.ImageBase64)
	if main == nil {
		httpx.Error(w, status, msg)
		return
	}

	var originals []*processed
	for _, o := range body.Originals {
		if len(originals) >= maxPublicOriginals {
			break
		}
		s, ok := o.(string)
		if !ok || s == "" {
			continue
		}
		if p, _, _ := m.process(s); p != nil { // original failures are skipped silently
			originals = append(originals, p)
		}
	}

	// Write files first, then commit DB rows; clean up files on any failure.
	allIDs := []string{main.id}
	if err := m.writeImageFiles(main); err != nil {
		m.cleanupFiles(allIDs...)
		httpx.Error(w, http.StatusInternalServerError, "公开图片失败，请稍后重试。")
		return
	}
	for _, o := range originals {
		if err := m.writeImageFiles(o); err != nil {
			m.cleanupFiles(append(allIDs, o.id)...)
			httpx.Error(w, http.StatusInternalServerError, "公开图片失败，请稍后重试。")
			return
		}
		allIDs = append(allIDs, o.id)
	}

	totalBytes := int64(len(main.final))
	for _, o := range originals {
		totalBytes += int64(len(o.final))
	}
	prompt := truncateRunes(body.Prompt, 4000)
	now := time.Now().UnixMilli()

	quotaExceeded, err := m.commitPublish(userID, main, originals, prompt, totalBytes, now)
	if err != nil {
		m.cleanupFiles(allIDs...)
		if quotaExceeded {
			httpx.Error(w, http.StatusRequestEntityTooLarge, "公开画廊空间已用完，请先删除一些公开图片后再上传。")
			return
		}
		m.logger.Error("gallery publish transaction failed", "scope", "gallery", "userId", userID, "err", err.Error())
		httpx.Error(w, http.StatusInternalServerError, "公开图片失败，请稍后重试。")
		return
	}

	m.logger.Info("gallery image published", "scope", "gallery", "userId", userID, "imageId", main.id, "size", totalBytes, "originals", len(originals))
	httpx.JSON(w, http.StatusOK, map[string]any{
		"id": main.id, "width": main.width, "height": main.height, "size": totalBytes, "originals": len(originals),
	})
}

// commitPublish runs the quota re-check + inserts in one transaction (SQLite serializes
// writes, so the re-read of public_storage_bytes is the serialization point against
// concurrent publishes). Returns quotaExceeded=true when the re-check fails.
func (m *Module) commitPublish(userID string, main *processed, originals []*processed, prompt string, totalBytes, now int64) (bool, error) {
	tx, err := m.db.Begin()
	if err != nil {
		return false, err
	}
	var cur int64
	if err := tx.QueryRow("SELECT public_storage_bytes FROM users WHERE id = ?", userID).Scan(&cur); err != nil {
		_ = tx.Rollback()
		return false, err
	}
	if cur+totalBytes > m.cfg.PerUserPublicQuotaBytes {
		_ = tx.Rollback()
		return true, os.ErrInvalid // sentinel; caller only checks quotaExceeded
	}
	if _, err := tx.Exec(
		"INSERT INTO public_images (id, user_id, prompt, width, height, file_size, created_at) VALUES (?,?,?,?,?,?,?)",
		main.id, userID, prompt, main.width, main.height, totalBytes, now,
	); err != nil {
		_ = tx.Rollback()
		return false, err
	}
	for i, o := range originals {
		if _, err := tx.Exec(
			"INSERT INTO public_image_originals (id, image_id, position, width, height, file_size, created_at) VALUES (?,?,?,?,?,?,?)",
			o.id, main.id, i, o.width, o.height, int64(len(o.final)), now,
		); err != nil {
			_ = tx.Rollback()
			return false, err
		}
	}
	if _, err := tx.Exec("UPDATE users SET public_storage_bytes = public_storage_bytes + ? WHERE id = ?", totalBytes, userID); err != nil {
		_ = tx.Rollback()
		return false, err
	}
	return false, tx.Commit()
}

func (m *Module) handleList(w http.ResponseWriter, r *http.Request) {
	limit := clampQuery(r, "limit", 24, 1, 60)
	offset := clampQuery(r, "offset", 0, 0, 1<<31)
	userFilter := r.URL.Query().Get("user_id")

	where := ""
	args := []any{}
	if userFilter != "" {
		where = "WHERE p.user_id = ?"
		args = append(args, userFilter)
	}
	rows, err := m.db.Query(`
		SELECT p.id, p.user_id, u.username,
		       COALESCE(NULLIF(u.display_name, ''), u.username) AS display_name,
		       u.avatar_updated_at, p.prompt, p.width, p.height, p.file_size, p.created_at, p.featured
		FROM public_images p JOIN users u ON u.id = p.user_id
		`+where+`
		ORDER BY p.featured DESC, p.created_at DESC LIMIT ? OFFSET ?`,
		append(args, limit, offset)...)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "加载画廊失败。")
		return
	}
	defer rows.Close()

	type img struct {
		data map[string]any
		id   string
	}
	var list []img
	var ids []any
	for rows.Next() {
		var (
			id, userID, username, displayName, prompt string
			avatarUpdatedAt, width, height, fileSize  sql.NullInt64
			createdAt                                 int64
			featured                                  int
		)
		if err := rows.Scan(&id, &userID, &username, &displayName, &avatarUpdatedAt, &prompt, &width, &height, &fileSize, &createdAt, &featured); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "加载画廊失败。")
			return
		}
		list = append(list, img{id: id, data: map[string]any{
			"id": id, "user_id": userID, "username": username, "display_name": displayName,
			"avatar_updated_at": nullInt(avatarUpdatedAt), "prompt": prompt,
			"width": nullInt(width), "height": nullInt(height), "file_size": nullInt(fileSize),
			"created_at": createdAt, "featured": featured, "originals": []any{},
		}})
		ids = append(ids, id)
	}

	originalsByImage := m.fetchOriginals(ids)
	out := make([]map[string]any, 0, len(list))
	for _, it := range list {
		if o := originalsByImage[it.id]; o != nil {
			it.data["originals"] = o
		}
		out = append(out, it.data)
	}

	var total int
	_ = m.db.QueryRow("SELECT COUNT(*) FROM public_images p "+where, args...).Scan(&total)
	httpx.JSON(w, http.StatusOK, map[string]any{"images": out, "total": total})
}

func (m *Module) fetchOriginals(ids []any) map[string][]map[string]any {
	result := map[string][]map[string]any{}
	if len(ids) == 0 {
		return result
	}
	q := "SELECT id, image_id, width, height FROM public_image_originals WHERE image_id IN (?" + repeatComma(len(ids)-1) + ") ORDER BY position ASC"
	rows, err := m.db.Query(q, ids...)
	if err != nil {
		return result
	}
	defer rows.Close()
	for rows.Next() {
		var id, imageID string
		var width, height sql.NullInt64
		if err := rows.Scan(&id, &imageID, &width, &height); err != nil {
			return result
		}
		result[imageID] = append(result[imageID], map[string]any{"id": id, "width": nullInt(width), "height": nullInt(height)})
	}
	return result
}

func (m *Module) handleDelete(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var ownerID string
	var fileSize sql.NullInt64
	if err := m.db.QueryRow("SELECT user_id, file_size FROM public_images WHERE id = ?", id).Scan(&ownerID, &fileSize); err != nil {
		httpx.Error(w, http.StatusNotFound, "图片不存在，可能已被删除。")
		return
	}
	if ownerID != m.userID(r) {
		httpx.Error(w, http.StatusForbidden, "无权删除这张图片。")
		return
	}

	m.deletePublicImageFiles(id) // unlink main + originals before the cascade removes their rows
	tx, err := m.db.Begin()
	if err == nil {
		_, e1 := tx.Exec("DELETE FROM public_images WHERE id = ?", id)
		var e2 error
		if fileSize.Valid && fileSize.Int64 > 0 {
			_, e2 = tx.Exec("UPDATE users SET public_storage_bytes = MAX(0, public_storage_bytes - ?) WHERE id = ?", fileSize.Int64, ownerID)
		}
		if e1 != nil || e2 != nil {
			_ = tx.Rollback()
		} else {
			err = tx.Commit()
		}
	}
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "删除失败，请稍后重试。")
		return
	}

	var storageBytes int64
	var galleryCount int
	_ = m.db.QueryRow("SELECT public_storage_bytes FROM users WHERE id = ?", ownerID).Scan(&storageBytes)
	_ = m.db.QueryRow("SELECT COUNT(*) FROM public_images WHERE user_id = ?", ownerID).Scan(&galleryCount)
	m.logger.Info("gallery image deleted", "scope", "gallery", "userId", ownerID, "imageId", id)
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "storageBytes": storageBytes, "galleryCount": galleryCount})
}

func (m *Module) deletePublicImageFiles(id string) {
	DeletePublicImageFiles(m.db, m.cfg.PublicDir, m.cfg.ThumbsDir, id)
}

// DeletePublicImageFiles removes a public image's main + thumbnail files plus all of its
// originals' files. Call before the DB cascade removes the originals rows. Errors (e.g.
// already-missing files) are ignored. Shared with the admin module (user delete / revoke).
func DeletePublicImageFiles(d *db.DB, publicDir, thumbsDir, id string) {
	ids := []string{id}
	rows, err := d.Query("SELECT id FROM public_image_originals WHERE image_id = ?", id)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var oid string
			if rows.Scan(&oid) == nil {
				ids = append(ids, oid)
			}
		}
	}
	for _, x := range ids {
		_ = os.Remove(publicDir + "/" + x + ".webp")
		_ = os.Remove(thumbsDir + "/" + x + ".webp")
	}
}

func (m *Module) handleServeImage(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var exists int
	if err := m.db.QueryRow(
		"SELECT 1 FROM public_images WHERE id = ? UNION ALL SELECT 1 FROM public_image_originals WHERE id = ? LIMIT 1", id, id,
	).Scan(&exists); err != nil {
		httpx.Error(w, http.StatusNotFound, "图片不存在，可能已被删除。")
		return
	}
	dir := m.cfg.PublicDir
	if r.URL.Query().Get("thumb") == "1" {
		dir = m.cfg.ThumbsDir
	}
	if !serveWebP(w, dir, id) {
		httpx.Error(w, http.StatusNotFound, "图片文件丢失，请联系管理员检查服务器存储。")
	}
}

// ----- avatars -----

func (m *Module) handleAvatarUpload(w http.ResponseWriter, r *http.Request) {
	userID := m.userID(r)
	var body struct {
		ImageBase64 string `json:"image_base64"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.ImageBase64 == "" {
		httpx.Error(w, http.StatusBadRequest, "请提供要上传的头像图片。")
		return
	}
	raw, err := imageproc.DecodeBase64(body.ImageBase64)
	if err != nil || len(raw) == 0 {
		httpx.Error(w, http.StatusBadRequest, "上传的图片为空，请重新选择。")
		return
	}
	if len(raw) > config.MaxAvatarInputBytes {
		httpx.Error(w, http.StatusRequestEntityTooLarge, "头像过大，请上传 5MB 以内的图片。")
		return
	}
	out, err := imageproc.ProcessAvatar(raw, config.AvatarSize)
	if err != nil {
		if errors.Is(err, imageproc.ErrImageTooLarge) {
			httpx.Error(w, http.StatusBadRequest, "图片尺寸过大（宽×高超过 4096×4096），请缩小后重试。")
			return
		}
		httpx.Error(w, http.StatusBadRequest, "无法解析这张图片，请换一张试试。")
		return
	}
	if err := os.WriteFile(m.cfg.AvatarsDir+"/"+userID+".webp", out, 0o644); err != nil {
		m.logger.Error("failed to write avatar", "scope", "avatar", "userId", userID, "err", err.Error())
		httpx.Error(w, http.StatusInternalServerError, "保存头像失败，请稍后重试。")
		return
	}
	now := time.Now().UnixMilli()
	_, _ = m.db.Exec("UPDATE users SET avatar_updated_at = ? WHERE id = ?", now, userID)
	httpx.JSON(w, http.StatusOK, map[string]any{"avatarUpdatedAt": now})
}

func (m *Module) handleAvatarDelete(w http.ResponseWriter, r *http.Request) {
	userID := m.userID(r)
	_ = os.Remove(m.cfg.AvatarsDir + "/" + userID + ".webp")
	_, _ = m.db.Exec("UPDATE users SET avatar_updated_at = NULL WHERE id = ?", userID)
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (m *Module) handleAvatarGet(w http.ResponseWriter, r *http.Request) {
	userID := chi.URLParam(r, "userId")
	var updatedAt sql.NullInt64
	if err := m.db.QueryRow("SELECT avatar_updated_at FROM users WHERE id = ?", userID).Scan(&updatedAt); err != nil || !updatedAt.Valid {
		httpx.Error(w, http.StatusNotFound, "头像不存在。")
		return
	}
	if !serveWebP(w, m.cfg.AvatarsDir, userID) {
		httpx.Error(w, http.StatusNotFound, "头像文件丢失。")
	}
}

// ----- helpers -----

// serveWebP streams {dir}/{id}.webp using os.Root so a crafted id cannot escape dir.
func serveWebP(w http.ResponseWriter, dir, id string) bool {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return false
	}
	defer root.Close()
	f, err := root.Open(id + ".webp")
	if err != nil {
		return false
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		return false
	}
	w.Header().Set("Content-Type", "image/webp")
	w.Header().Set("Content-Length", strconv.FormatInt(st.Size(), 10))
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	_, _ = io.Copy(w, f)
	return true
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

func nullInt(n sql.NullInt64) any {
	if n.Valid {
		return n.Int64
	}
	return nil
}

func repeatComma(n int) string {
	if n <= 0 {
		return ""
	}
	out := make([]byte, 0, n*2)
	for i := 0; i < n; i++ {
		out = append(out, ',', '?')
	}
	return string(out)
}

func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}
