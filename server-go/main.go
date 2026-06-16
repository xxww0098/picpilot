// Command server-go is the Go rewrite of the picpilot auth/proxy backend (originally
// server/index.ts on Bun/Hono). It is built CGO-free (pure-Go SQLite + image handling)
// and runs alongside the TS server during migration.
//
// Routing uses go-chi/chi/v5, which is built on net/http: handlers stay plain
// http.HandlerFunc so the streaming proxy can use httputil.ReverseProxy and
// http.ResponseController without interference.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/xxww0098/picpilot/server-go/internal/admin"
	"github.com/xxww0098/picpilot/server-go/internal/auth"
	"github.com/xxww0098/picpilot/server-go/internal/chatgptreverse"
	"github.com/xxww0098/picpilot/server-go/internal/config"
	"github.com/xxww0098/picpilot/server-go/internal/db"
	"github.com/xxww0098/picpilot/server-go/internal/diagnostics"
	"github.com/xxww0098/picpilot/server-go/internal/gallery"
	"github.com/xxww0098/picpilot/server-go/internal/httpx"
	"github.com/xxww0098/picpilot/server-go/internal/proxy"
	"github.com/xxww0098/picpilot/server-go/internal/queue"
	"github.com/xxww0098/picpilot/server-go/internal/settings"
	"github.com/xxww0098/picpilot/server-go/internal/static"
	"github.com/xxww0098/picpilot/server-go/internal/task"
	"github.com/xxww0098/picpilot/server-go/internal/telemetry"
	"github.com/xxww0098/picpilot/server-go/internal/upstream"
	"github.com/xxww0098/picpilot/server-go/internal/upstreamcooldown"
)

// AppVersion is overridable at build time via -ldflags "-X main.AppVersion=...".
var AppVersion = "dev"

func newLogger() *slog.Logger {
	level := slog.LevelInfo
	switch os.Getenv("LOG_LEVEL") {
	case "trace", "debug":
		level = slog.LevelDebug
	case "warn":
		level = slog.LevelWarn
	case "error", "fatal":
		level = slog.LevelError
	}
	opts := &slog.HandlerOptions{Level: level}
	var h slog.Handler
	if os.Getenv("LOG_PRETTY") == "1" {
		h = slog.NewTextHandler(os.Stdout, opts)
	} else {
		h = slog.NewJSONHandler(os.Stdout, opts)
	}
	return slog.New(h).With("app", "picpilot", "component", "go-server")
}

// statusWriter captures the response status while staying transparent: Unwrap and Flush
// pass through so http.ResponseController (write deadlines) and streaming/SSE still work.
type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) { w.status = code; w.ResponseWriter.WriteHeader(code) }
func (w *statusWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(b)
}
func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// requestLogger logs every /api/* request (method/path/status/elapsed/ip). It does not
// wrap /api-proxy/* (which has its own logging) or non-API paths (static/SPA).
func requestLogger(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !strings.HasPrefix(r.URL.Path, "/api/") {
				next.ServeHTTP(w, r)
				return
			}
			sw := &statusWriter{ResponseWriter: w}
			start := time.Now()
			next.ServeHTTP(sw, r)
			status := sw.status
			if status == 0 {
				status = http.StatusOK
			}
			level := slog.LevelDebug
			if status >= 500 {
				level = slog.LevelError
			} else if status >= 400 {
				level = slog.LevelWarn
			}
			logger.Log(r.Context(), level, "http request",
				"scope", "http", "method", r.Method, "path", r.URL.Path,
				"status", status, "elapsedMs", time.Since(start).Milliseconds(), "ip", auth.ClientIP(r))
		})
	}
}

func main() {
	logger := newLogger()
	cfg := config.Load(logger)
	appCtx, stopBackground := context.WithCancel(context.Background())
	defer stopBackground()

	database, err := db.Open(cfg.DBPath, cfg.DefaultMaxBatchImages)
	if err != nil {
		logger.Error("failed to open database", "path", cfg.DBPath, "err", err.Error())
		os.Exit(1)
	}
	defer database.Close()

	settingsProvider := settings.NewProvider(database, cfg)
	// Initialize queue limits from the effective team settings (admin overrides, else env).
	sp := settingsProvider.Payload()
	proxyQueue := queue.New(queue.Options{
		MaxConcurrent:    sp.MaxConcurrent,
		MaxQueue:         sp.MaxQueue,
		MaxWaitMs:        cfg.ProxyQueueMaxWaitMs,
		PerUserSoftLimit: sp.ProxyUserSoftLimit,
	})

	authMod := auth.New(database, cfg, proxyQueue, settingsProvider, logger)
	if err := authMod.Seed(os.Getenv("ADMIN_USERS"), os.Getenv("AUTH_USERS")); err != nil {
		logger.Error("user seeding failed", "err", err.Error())
	}
	cooldownGate := upstreamcooldown.NewGate()
	activeUpstream := upstream.FromConfig(cfg)
	reverseStore := chatgptreverse.NewStore(database)
	if result, err := chatgptreverse.SyncAuthAccountsFromDir(context.Background(), reverseStore, cfg.ChatGPTReverseAuthDir); err != nil {
		logger.Warn("chatgpt reverse auth dir sync failed", "scope", "reverse", "dir", cfg.ChatGPTReverseAuthDir, "err", err.Error())
	} else if result.Imported > 0 || result.Updated > 0 || result.Unchanged > 0 {
		logger.Info("chatgpt reverse auth dir synced", "scope", "reverse", "dir", cfg.ChatGPTReverseAuthDir, "imported", result.Imported, "updated", result.Updated, "unchanged", result.Unchanged, "skipped", result.Skipped)
	}
	reverseService := chatgptreverse.New(cfg, reverseStore, logger, settingsProvider)
	reverseService.StartQuotaLimitedRefreshLoop(appCtx, 0)
	upstreamConfigured := currentUpstreamConfigured(activeUpstream, reverseService)

	r := chi.NewRouter()
	r.Use(httpx.SecurityHeaders) // baseline CSP/nosniff/frame-ancestors on every response
	r.Use(middleware.RealIP)     // real client IP from X-Real-IP (behind Caddy) for rate limiting
	r.Use(middleware.Recoverer)  // panic -> 500, never crash the server
	r.Use(requestLogger(logger)) // structured access log for /api/* (transparent to streaming)

	r.Get("/api/health", func(w http.ResponseWriter, _ *http.Request) {
		httpx.JSON(w, http.StatusOK, map[string]any{
			"status":             "ok",
			"version":            AppVersion,
			"upstreamMode":       activeUpstream.Mode,
			"upstreamConfigured": currentUpstreamConfigured(activeUpstream, reverseService),
		})
	})

	authMod.Register(r)
	// proxy module owns /api-proxy/* (JWT + RequireUser + queue) and JWT-gated /api/queue/stats.
	proxy.NewWithCooldownGate(cfg, proxyQueue, settingsProvider, authMod, logger, cooldownGate, reverseService).Register(r)
	// async task model: submit/status/SSE/cancel, executor shares the global queue.
	taskMod := task.NewWithCooldownGate(database, proxyQueue, settingsProvider, cfg, authMod, logger, cooldownGate, reverseService)
	taskMod.Start()
	taskMod.Register(r)
	// gallery + avatars (publish/list/delete/serve + avatar upload/get/delete).
	gallery.New(database, cfg, authMod, logger).Register(r)
	// admin backend (team settings runtime, users, invites, events/export, overview, moderation).
	admin.New(database, cfg, proxyQueue, settingsProvider, authMod, logger, reverseService).Register(r)
	// telemetry event recorder + notifications; also runs the event-retention purge.
	telemetryMod := telemetry.New(database, authMod, logger, cfg.EventRetentionDays)
	telemetryMod.Register(r)
	telemetryMod.StartPurge(appCtx)
	// admin diagnostics: failure-summary, upstream-health (CLIProxy log), diagnostics bundle.
	diagnostics.New(database, cfg, proxyQueue, settingsProvider, authMod, logger).Register(r)

	// Static frontend (dist/) with SPA fallback for any non-API path. Unmatched /api*
	// paths return a JSON 404 instead of the SPA shell.
	staticHandler := static.New(cfg.StaticDir, config.MimeTypes)
	r.NotFound(func(w http.ResponseWriter, rq *http.Request) {
		if strings.HasPrefix(rq.URL.Path, "/api/") || strings.HasPrefix(rq.URL.Path, "/api-proxy/") {
			httpx.Error(w, http.StatusNotFound, "接口不存在。")
			return
		}
		staticHandler.ServeHTTP(w, rq)
	})

	srv := &http.Server{
		Addr:              fmt.Sprintf(":%d", cfg.Port),
		Handler:           r,
		ReadHeaderTimeout: 30 * time.Second,
		// Intentionally NO WriteTimeout/IdleTimeout: long-lived streaming proxy responses
		// must not be killed by a global deadline (escapes the Bun idleTimeout=255s cap).
		// Per-request deadlines are managed with http.ResponseController in the proxy handler.
	}

	go func() {
		logger.Info("server starting", "addr", srv.Addr, "version", AppVersion,
			"upstreamMode", activeUpstream.Mode, "upstreamConfigured", upstreamConfigured,
			"maxConcurrent", sp.MaxConcurrent, "maxQueue", sp.MaxQueue)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server error", "err", err.Error())
			os.Exit(1)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	logger.Info("server shutting down")
	stopBackground()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		logger.Error("graceful shutdown failed", "err", err.Error())
	}
}

func currentUpstreamConfigured(active upstream.Target, reverseService *chatgptreverse.Service) bool {
	if active.Internal {
		return reverseService.Configured()
	}
	return active.Configured()
}
