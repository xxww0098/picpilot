// Package diagnostics ports server/diagnostics.ts plus the admin failure-summary and
// diagnostics-bundle endpoints. It parses the CLIProxyAPI main.log to attribute request
// outcomes to masked upstream accounts, summarizes recent failures from request_events,
// and audits reverse-proxy log redaction. All routes are admin-only.
package diagnostics

import (
	"encoding/json"
	"hash/fnv"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/xxww0098/picpilot/server-go/internal/auth"
	"github.com/xxww0098/picpilot/server-go/internal/config"
	"github.com/xxww0098/picpilot/server-go/internal/db"
	"github.com/xxww0098/picpilot/server-go/internal/httpx"
	"github.com/xxww0098/picpilot/server-go/internal/queue"
	"github.com/xxww0098/picpilot/server-go/internal/settings"
	"github.com/xxww0098/picpilot/server-go/internal/upstream"
)

const maxLogTailBytes = 2 * 1024 * 1024

var (
	routeLineRe  = regexp.MustCompile(`^\[([^\]]+)\]\s+\[([^\]]+)\].*Use OAuth provider=(\S+)\s+auth_file=(\S+)\s+for model\s+(.+)$`)
	statusLineRe = regexp.MustCompile(`^\[([^\]]+)\]\s+\[([^\]]+)\].*?\]\s+(\d{3})\s+\|\s*([^|]+?)\s*\|\s*[^|]*\|\s*([A-Z]+)\s+"([^"]+)"`)
	durationRe   = regexp.MustCompile(`(?i)(\d+(?:\.\d+)?)\s*(us|µs|ms|s|m)`)
)

// Module wires the admin diagnostics endpoints.
type Module struct {
	db       *db.DB
	cfg      *config.Config
	q        *queue.Queue
	settings *settings.Provider
	auth     *auth.Auth
	logger   *slog.Logger
}

func New(d *db.DB, cfg *config.Config, q *queue.Queue, sp *settings.Provider, a *auth.Auth, logger *slog.Logger) *Module {
	return &Module{db: d, cfg: cfg, q: q, settings: sp, auth: a, logger: logger}
}

// Register mounts the diagnostics endpoints behind JWT + RequireAdmin.
func (m *Module) Register(r chi.Router) {
	r.Group(func(pr chi.Router) {
		pr.Use(m.auth.Middleware("Authorization"))
		pr.Use(m.auth.RequireAdmin)
		pr.Get("/api/admin/failure-summary", m.handleFailureSummary)
		pr.Get("/api/admin/upstream-health", m.handleUpstreamHealth)
		pr.Get("/api/admin/diagnostics", m.handleDiagnostics)
		pr.Get("/api/admin/diagnostics/export", m.handleDiagnosticsExport)
	})
}

// ----- routes -----

func (m *Module) handleFailureSummary(w http.ResponseWriter, r *http.Request) {
	rng := parseRange(r, 7)
	appMode := r.URL.Query().Get("app_mode")
	httpx.JSON(w, http.StatusOK, m.buildFailureSummary(rng, appMode))
}

func (m *Module) handleUpstreamHealth(w http.ResponseWriter, _ *http.Request) {
	httpx.JSON(w, http.StatusOK, getUpstreamHealthReport(m.cfg.CLIProxyLogDir))
}

func (m *Module) handleDiagnostics(w http.ResponseWriter, _ *http.Request) {
	httpx.JSON(w, http.StatusOK, m.buildDiagnosticsBundle())
}

func (m *Module) handleDiagnosticsExport(w http.ResponseWriter, _ *http.Request) {
	bundle := m.buildDiagnosticsBundle()
	body, _ := json.MarshalIndent(bundle, "", "  ")
	date := strings.NewReplacer(":", "-", ".", "-").Replace(time.UnixMilli(bundle["generatedAt"].(int64)).UTC().Format("2006-01-02T15:04:05.000Z"))
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="picpilot-diagnostics-`+date+`.json"`)
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(body)
}

// ----- upstream health (main.log parsing) -----

type routeStat struct {
	Route   string `json:"route"`
	Total   int    `json:"total"`
	Failure int    `json:"failure"`
}

type accountHealth struct {
	AccountKey     string      `json:"accountKey"`
	Label          string      `json:"label"`
	Provider       string      `json:"provider"`
	Total          int         `json:"total"`
	Success        int         `json:"success"`
	Failure        int         `json:"failure"`
	FailureRate    float64     `json:"failureRate"`
	AvgDurationMs  *float64    `json:"avgDurationMs"`
	LastSeenAt     *int64      `json:"lastSeenAt"`
	Models         []string    `json:"models"`
	Routes         []routeStat `json:"routes"`
	Status         string      `json:"status"`
	Recommendation string      `json:"recommendation"`
}

type accumulator struct {
	accountKey, label, provider string
	total, success, failure     int
	durationMs                  float64
	durationSamples             int
	lastSeenAt                  *int64
	models                      map[string]bool
	routes                      map[string]*routeStat
}

func maskAuthFile(provider, authFile string) (key, label string) {
	base := strings.TrimSuffix(filepath.Base(authFile), filepath.Ext(authFile))
	h := fnv.New32a()
	_, _ = h.Write([]byte(base))
	hash := strconv.FormatUint(uint64(h.Sum32()), 16)
	for len(hash) < 8 {
		hash = "0" + hash
	}
	key = provider + ":" + hash
	label = provider + ":" + key[len(key)-8:]
	return key, label
}

func parseLogTimestamp(v string) *int64 {
	s := strings.Replace(strings.TrimSpace(v), " ", "T", 1)
	for _, layout := range []string{
		"2006-01-02T15:04:05.000Z07:00", time.RFC3339, "2006-01-02T15:04:05.000", "2006-01-02T15:04:05",
	} {
		if t, err := time.Parse(layout, s); err == nil {
			ms := t.UnixMilli()
			return &ms
		}
	}
	return nil
}

func parseDurationMs(raw string) *float64 {
	matches := durationRe.FindAllStringSubmatch(strings.TrimSpace(raw), -1)
	if len(matches) == 0 {
		return nil
	}
	total := 0.0
	for _, mt := range matches {
		amt, err := strconv.ParseFloat(mt[1], 64)
		if err != nil {
			continue
		}
		switch strings.ToLower(mt[2]) {
		case "m":
			total += amt * 60000
		case "s":
			total += amt * 1000
		case "ms":
			total += amt
		default: // us / µs
			total += amt / 1000
		}
	}
	if total < 0 {
		total = 0
	}
	return &total
}

func readTail(path string, maxBytes int64) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return "", 0, err
	}
	start := int64(0)
	if st.Size() > maxBytes {
		start = st.Size() - maxBytes
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return "", 0, err
	}
	b, err := io.ReadAll(f)
	if err != nil {
		return "", 0, err
	}
	return string(b), st.Size() - start, nil
}

func getUpstreamHealthReport(logDir string) map[string]any {
	logDir = strings.TrimSpace(logDir)
	if logDir == "" {
		return map[string]any{
			"available": false, "logDir": nil,
			"message":      "未配置 CLIPROXY_LOG_DIR，无法读取 CLIProxy 账号路由日志。",
			"scannedBytes": 0, "generatedAt": time.Now().UnixMilli(), "accounts": []any{},
		}
	}
	mainLog := filepath.Join(logDir, "main.log")
	text, scanned, err := readTail(mainLog, maxLogTailBytes)
	if err != nil {
		return map[string]any{
			"available": false, "logDir": logDir,
			"message":      "无法读取 " + mainLog + "：" + err.Error(),
			"scannedBytes": 0, "generatedAt": time.Now().UnixMilli(), "accounts": []any{},
		}
	}

	accounts := map[string]*accumulator{}
	routed := map[string]string{} // requestId -> accountKey
	getAccount := func(provider, authFile string) *accumulator {
		key, label := maskAuthFile(provider, authFile)
		if a := accounts[key]; a != nil {
			return a
		}
		a := &accumulator{accountKey: key, label: label, provider: provider, models: map[string]bool{}, routes: map[string]*routeStat{}}
		accounts[key] = a
		return a
	}

	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimRight(line, "\r")
		if mt := routeLineRe.FindStringSubmatch(line); mt != nil {
			provider, authFile, model := mt[3], mt[4], strings.TrimSpace(mt[5])
			a := getAccount(provider, authFile)
			if ts := parseLogTimestamp(mt[1]); ts != nil {
				if a.lastSeenAt == nil || *ts > *a.lastSeenAt {
					a.lastSeenAt = ts
				}
			}
			if model != "" {
				a.models[model] = true
			}
			routed[mt[2]] = a.accountKey
			continue
		}
		mt := statusLineRe.FindStringSubmatch(line)
		if mt == nil {
			continue
		}
		reqID := mt[2]
		key, ok := routed[reqID]
		if !ok {
			continue
		}
		a := accounts[key]
		if a == nil {
			continue
		}
		status, _ := strconv.Atoi(mt[3])
		failed := status >= 400
		if ts := parseLogTimestamp(mt[1]); ts != nil {
			if a.lastSeenAt == nil || *ts > *a.lastSeenAt {
				a.lastSeenAt = ts
			}
		}
		if d := parseDurationMs(mt[4]); d != nil {
			a.durationMs += *d
			a.durationSamples++
		}
		a.total++
		if failed {
			a.failure++
		} else {
			a.success++
		}
		routeKey := mt[5] + " " + mt[6]
		rs := a.routes[routeKey]
		if rs == nil {
			rs = &routeStat{Route: routeKey}
			a.routes[routeKey] = rs
		}
		rs.Total++
		if failed {
			rs.Failure++
		}
	}

	out := make([]accountHealth, 0, len(accounts))
	for _, a := range accounts {
		out = append(out, finalizeAccount(a))
	}
	statusRank := map[string]int{"isolate": 0, "watch": 1, "healthy": 2}
	sort.Slice(out, func(i, j int) bool {
		if statusRank[out[i].Status] != statusRank[out[j].Status] {
			return statusRank[out[i].Status] < statusRank[out[j].Status]
		}
		if out[i].Failure != out[j].Failure {
			return out[i].Failure > out[j].Failure
		}
		return out[i].Total > out[j].Total
	})
	return map[string]any{
		"available": true, "logDir": logDir, "scannedBytes": scanned,
		"generatedAt": time.Now().UnixMilli(), "accounts": out,
	}
}

func finalizeAccount(a *accumulator) accountHealth {
	failureRate := 0.0
	if a.total > 0 {
		failureRate = float64(a.failure) / float64(a.total)
	}
	status, rec := "healthy", "继续观察。"
	if a.failure >= 3 && failureRate >= 0.5 {
		status, rec = "isolate", "建议临时隔离该账号，检查 OAuth 登录态或上游额度后再恢复。"
	} else if a.failure >= 2 && failureRate >= 0.25 {
		status, rec = "watch", "建议降低该账号承载或重点观察最近错误。"
	}
	var avg *float64
	if a.durationSamples > 0 {
		v := a.durationMs / float64(a.durationSamples)
		avg = &v
	}
	models := make([]string, 0, len(a.models))
	for mdl := range a.models {
		models = append(models, mdl)
	}
	sort.Strings(models)
	routes := make([]routeStat, 0, len(a.routes))
	for _, rs := range a.routes {
		routes = append(routes, *rs)
	}
	sort.Slice(routes, func(i, j int) bool {
		if routes[i].Failure != routes[j].Failure {
			return routes[i].Failure > routes[j].Failure
		}
		if routes[i].Total != routes[j].Total {
			return routes[i].Total > routes[j].Total
		}
		return routes[i].Route < routes[j].Route
	})
	return accountHealth{
		AccountKey: a.accountKey, Label: a.label, Provider: a.provider,
		Total: a.total, Success: a.success, Failure: a.failure, FailureRate: failureRate,
		AvgDurationMs: avg, LastSeenAt: a.lastSeenAt, Models: models, Routes: routes,
		Status: status, Recommendation: rec,
	}
}

func readRecentLogNames(logDir string, limit int) []string {
	logDir = strings.TrimSpace(logDir)
	out := []string{}
	if logDir == "" {
		return out
	}
	entries, err := os.ReadDir(logDir)
	if err != nil {
		return out
	}
	re := regexp.MustCompile(`(?i)^error-.*\.log$`)
	for _, e := range entries {
		if !e.IsDir() && re.MatchString(e.Name()) {
			out = append(out, e.Name())
		}
	}
	sort.Strings(out)
	if len(out) > limit {
		out = out[len(out)-limit:]
	}
	return out
}

func readSmallTextFile(path string, maxBytes int) (string, bool) {
	st, err := os.Stat(path)
	if err != nil || st.IsDir() {
		return "", false
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	if len(b) > maxBytes {
		return string(b[:maxBytes]), true
	}
	return string(b), true
}

// ----- failure summary -----

func normalizeFailureReason(errorType, message string, httpStatus *int64) string {
	status := ""
	if httpStatus != nil {
		status = strconv.FormatInt(*httpStatus, 10)
	}
	msg := strings.ToLower(errorType + " " + status + " " + message)
	test := func(pat string) bool { return regexp.MustCompile(pat).MatchString(msg) }
	switch {
	case test(`empty_stream|before first payload`):
		return "stream_empty"
	case test(`stream disconnected|stream closed before response\.completed|closed before response|connection reset`):
		return "stream_disconnected"
	case test(`timeout|timed out|\b408\b`):
		return "timeout"
	case test(`rate|quota|limit|too many|429`):
		return "rate_or_quota"
	case test(`invalid.*token|token.*invalid|unauthori[sz]ed|\b401\b`):
		return "auth_invalid"
	case test(`forbidden|permission|\b403\b`):
		return "auth_forbidden"
	case test(`invalid_request|bad request|\b400\b`):
		return "invalid_request"
	case test(`\b422\b|unprocessable`):
		return "invalid_video_request"
	case test(`failed to fetch|network|cors|跨域|load failed`):
		return "network"
	case test(`internal_server_error|server_error|\b5\d\d\b`):
		return "upstream_5xx"
	}
	if errorType != "" {
		return errorType
	}
	return "unknown"
}

func (m *Module) buildFailureSummary(rng [2]int64, appMode string) map[string]any {
	where := []string{"created_at >= ?", "created_at <= ?"}
	args := []any{rng[0], rng[1]}
	if appMode != "" {
		if appMode == "gallery" {
			where = append(where, "(app_mode = ? OR app_mode IS NULL)")
		} else {
			where = append(where, "app_mode = ?")
		}
		args = append(args, appMode)
	}
	whereSql := "WHERE " + strings.Join(where, " AND ")

	totals := []map[string]any{}
	if rows, err := m.db.Query(`SELECT COALESCE(app_mode,'gallery') AS app_mode, COUNT(*) AS total,
		SUM(CASE WHEN event_type='success' THEN 1 ELSE 0 END) AS success,
		SUM(CASE WHEN event_type!='success' THEN 1 ELSE 0 END) AS failure,
		AVG(duration_ms) AS avg_duration
		FROM request_events `+whereSql+` GROUP BY COALESCE(app_mode,'gallery') ORDER BY total DESC`, args...); err == nil {
		defer rows.Close()
		for rows.Next() {
			var appM string
			var total, success, failure int64
			var avg *float64
			_ = rows.Scan(&appM, &total, &success, &failure, &avg)
			totals = append(totals, map[string]any{"app_mode": appM, "total": total, "success": success, "failure": failure, "avg_duration": avg})
		}
	}

	type reasonAgg struct {
		Reason, AppMode, ErrorType string
		HTTPStatus                 *int64
		Count                      int
		LatestAt                   int64
		SampleMessage              string
	}
	reasonMap := map[string]*reasonAgg{}
	statusMap := map[string]map[string]any{}
	userMap := map[string]map[string]any{}

	rows, err := m.db.Query(`SELECT COALESCE(app_mode,'gallery') AS app_mode, username, error_type, http_status, error_message, created_at
		FROM request_events `+whereSql+` AND event_type != 'success' ORDER BY created_at DESC LIMIT 5000`, args...)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var appM, username string
			var errType, errMsg *string
			var httpStatus *int64
			var createdAt int64
			_ = rows.Scan(&appM, &username, &errType, &httpStatus, &errMsg, &createdAt)
			et, em := strVal(errType), strVal(errMsg)
			reason := normalizeFailureReason(et, em, httpStatus)
			statusStr := "none"
			if httpStatus != nil {
				statusStr = strconv.FormatInt(*httpStatus, 10)
			}
			key := appM + "\n" + reason + "\n" + et + "\n" + statusStr
			cur := reasonMap[key]
			if cur == nil {
				cur = &reasonAgg{Reason: reason, AppMode: appM, ErrorType: et, HTTPStatus: httpStatus, LatestAt: createdAt, SampleMessage: em}
				reasonMap[key] = cur
			}
			cur.Count++
			if createdAt > cur.LatestAt {
				cur.LatestAt = createdAt
				cur.SampleMessage = em
			}
			if statusMap[statusStr] == nil {
				statusMap[statusStr] = map[string]any{"http_status": httpStatus, "count": 0}
			}
			statusMap[statusStr]["count"] = statusMap[statusStr]["count"].(int) + 1
			if userMap[username] == nil {
				userMap[username] = map[string]any{"username": username, "failures": 0, "latest_at": createdAt}
			}
			userMap[username]["failures"] = userMap[username]["failures"].(int) + 1
			if createdAt > userMap[username]["latest_at"].(int64) {
				userMap[username]["latest_at"] = createdAt
			}
		}
	}

	reasons := make([]map[string]any, 0, len(reasonMap))
	for _, v := range reasonMap {
		reasons = append(reasons, map[string]any{
			"reason": v.Reason, "app_mode": v.AppMode, "error_type": nilIfEmpty(v.ErrorType),
			"http_status": v.HTTPStatus, "count": v.Count, "latest_at": v.LatestAt, "sample_message": nilIfEmpty(v.SampleMessage),
		})
	}
	sort.Slice(reasons, func(i, j int) bool {
		if reasons[i]["count"].(int) != reasons[j]["count"].(int) {
			return reasons[i]["count"].(int) > reasons[j]["count"].(int)
		}
		return reasons[i]["latest_at"].(int64) > reasons[j]["latest_at"].(int64)
	})
	if len(reasons) > 30 {
		reasons = reasons[:30]
	}
	statuses := make([]map[string]any, 0, len(statusMap))
	for _, v := range statusMap {
		statuses = append(statuses, v)
	}
	sort.Slice(statuses, func(i, j int) bool { return statuses[i]["count"].(int) > statuses[j]["count"].(int) })
	users := make([]map[string]any, 0, len(userMap))
	for _, v := range userMap {
		users = append(users, v)
	}
	sort.Slice(users, func(i, j int) bool {
		if users[i]["failures"].(int) != users[j]["failures"].(int) {
			return users[i]["failures"].(int) > users[j]["failures"].(int)
		}
		return users[i]["latest_at"].(int64) > users[j]["latest_at"].(int64)
	})
	if len(users) > 20 {
		users = users[:20]
	}

	return map[string]any{
		"range":    map[string]any{"since": rng[0], "until": rng[1]},
		"totals":   totals,
		"reasons":  reasons,
		"statuses": statuses,
		"users":    users,
	}
}

func (m *Module) getRecentSanitizedEvents(limit int) []map[string]any {
	out := []map[string]any{}
	rows, err := m.db.Query(`SELECT id, username, event_type, COALESCE(app_mode,'gallery') AS app_mode,
		provider, api_mode, model, duration_ms, http_status, error_type, error_message,
		output_count, output_bytes, action_type, created_at
		FROM request_events ORDER BY created_at DESC LIMIT ?`, limit)
	if err != nil {
		return out
	}
	defer rows.Close()
	cols, _ := rows.Columns()
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if rows.Scan(ptrs...) != nil {
			return out
		}
		rec := map[string]any{}
		for i, c := range cols {
			if b, ok := vals[i].([]byte); ok {
				rec[c] = string(b)
			} else {
				rec[c] = vals[i]
			}
		}
		out = append(out, rec)
	}
	return out
}

func (m *Module) getCaddyPrivacyAudit() map[string]any {
	candidates := []string{}
	if p := os.Getenv("CADDYFILE_PATH"); p != "" {
		candidates = append(candidates, p)
	}
	cwd, _ := os.Getwd()
	candidates = append(candidates, filepath.Join(cwd, "Caddyfile"), filepath.Join(cwd, "..", "Caddyfile"), "/etc/caddy/Caddyfile")
	required := []string{
		"request>headers>Authorization", "request>headers>Proxy-Authorization",
		"request>headers>X-Picpilot-Authorization", "request>headers>X-PicPilot-Authorization",
		"request>headers>Cookie",
	}
	for _, p := range candidates {
		text, ok := readSmallTextFile(p, 128*1024)
		if !ok {
			continue
		}
		missing := []string{}
		for _, field := range required {
			if !strings.Contains(text, field) {
				missing = append(missing, field)
			}
		}
		return map[string]any{"checked": true, "path": p, "redactsAuthHeaders": len(missing) == 0, "missing": missing}
	}
	return map[string]any{"checked": false, "path": nil, "redactsAuthHeaders": nil, "missing": []any{},
		"message": "运行环境未暴露 Caddyfile，无法自动确认反代日志脱敏配置。"}
}

func (m *Module) buildDiagnosticsBundle() map[string]any {
	now := time.Now().UnixMilli()
	rng := [2]int64{now - 7*24*60*60*1000, now}
	st := m.q.Stats("")
	lim := m.q.Limits()
	activeUpstream := upstream.FromConfig(m.cfg)
	upstreamConfigured := activeUpstream.Configured()
	if activeUpstream.Internal {
		var activeReverseAccounts int
		upstreamConfigured = m.db.QueryRow("SELECT COUNT(*) FROM reverse_auth_accounts WHERE disabled = 0").Scan(&activeReverseAccounts) == nil && activeReverseAccounts > 0
	}
	return map[string]any{
		"generatedAt": now,
		"runtime": map[string]any{
			"dataDir": m.cfg.DataDir, "dbPath": m.cfg.DBPath,
			"upstreamMode": activeUpstream.Mode, "upstreamConfigured": upstreamConfigured,
			"apiProxyConfigured": m.cfg.APIProxyURL != "", "reverseProxyConfigured": m.cfg.ReverseProxyURL != "",
			"cliproxyLogDirConfigured": m.cfg.CLIProxyLogDir != "",
			"eventRetentionDays":       m.cfg.EventRetentionDays,
		},
		"teamSettings": m.settings.Payload(),
		"queue": map[string]any{
			"inflight": st.Inflight, "queued": st.Queued,
			"maxConcurrent": lim.MaxConcurrent, "maxQueue": lim.MaxQueue, "perUserSoftLimit": lim.PerUserSoftLimit,
			"maxQueueWaitMs": m.cfg.ProxyQueueMaxWaitMs,
		},
		"failureSummary":       m.buildFailureSummary(rng, ""),
		"upstreamHealth":       getUpstreamHealthReport(m.cfg.CLIProxyLogDir),
		"recentCliproxyErrors": readRecentLogNames(m.cfg.CLIProxyLogDir, 20),
		"recentEvents":         m.getRecentSanitizedEvents(40),
		"privacy": map[string]any{
			"diagnosticsExcludesPrompt": true, "diagnosticsExcludesIpAndUserAgent": true,
			"caddy": m.getCaddyPrivacyAudit(),
		},
	}
}

// ----- helpers -----

func parseRange(r *http.Request, fallbackDays int64) [2]int64 {
	now := time.Now().UnixMilli()
	until := now
	if v := r.URL.Query().Get("until"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			until = n
		}
	}
	since := until - fallbackDays*24*60*60*1000
	if v := r.URL.Query().Get("since"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			since = n
		}
	}
	return [2]int64{since, until}
}

func strVal(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}
