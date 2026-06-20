package config

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
)

// Compile-time constants (mirror the non-tunable consts in config.ts).
const (
	MaxImageLongEdge    = 2048
	ThumbLongEdge       = 256
	AvatarSize          = 256
	MaxAvatarInputBytes = 5 * 1024 * 1024
	InviteMaxUses       = 1000
	InviteMaxBatchCount = 50
	InviteNoteMaxLen    = 200
)

// MimeTypes maps file extensions to Content-Type for static serving.
var MimeTypes = map[string]string{
	".css":  "text/css; charset=utf-8",
	".gif":  "image/gif",
	".html": "text/html; charset=utf-8",
	".ico":  "image/x-icon",
	".js":   "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map":  "application/json; charset=utf-8",
	".png":  "image/png",
	".svg":  "image/svg+xml",
	".txt":  "text/plain; charset=utf-8",
	".webp": "image/webp",
}

// Config holds the resolved runtime configuration.
type Config struct {
	Port                         int
	StaticDir                    string
	JWTSecret                    string
	JWTExpiresInSeconds          int
	JWTSessionMaxSeconds         int
	DataDir                      string
	DBPath                       string
	PublicDir                    string
	ThumbsDir                    string
	AvatarsDir                   string
	EventRetentionDays           int
	PerUserPublicQuotaBytes      int64
	UpstreamMode                 string
	APIProxyURL                  string
	APIProxyAPIKey               string
	ReverseProxyURL              string
	ReverseProxyAPIKey           string
	ReverseProxyInternal         bool
	ChatGPTReverseAuthDir        string
	ChatGPTReverseAccessTokens   string
	ChatGPTReverseBaseURL        string
	ReverseAccountConcurrency    int
	OutboundProxyType            string
	OutboundProxyURL             string
	MaxConcurrent                int
	ProxyQueueMaxWaitMs          int
	ProxyQueueMax                int
	ProxyUserSoftLimit           int
	ProxyUserHardLimit           int
	ProviderLimits               map[string]int
	DefaultMaxBatchImages        int
	DefaultGalleryAutoRetryCount int
	DefaultStreamFallbackEnabled bool
	DefaultRequestTimeoutSeconds int
	UpstreamMaxRetries           int
	CLIProxyAPIURL               string
	CLIProxyManagementKey        string
	CLIProxyLogDir               string
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func firstEnv(keys ...string) string {
	for _, key := range keys {
		if v := strings.TrimSpace(os.Getenv(key)); v != "" {
			return v
		}
	}
	return ""
}

func envInt(key string, def int) int {
	if f, ok := parseLooseFloat(os.Getenv(key)); ok {
		return int(f)
	}
	return def
}

func envInt64(key string, def int64) int64 {
	if f, ok := parseLooseFloat(os.Getenv(key)); ok {
		return int64(f)
	}
	return def
}

// Load reads configuration from the environment, validates required values, creates
// required directories, and returns the resolved Config. Like the TS server, it
// terminates the process when JWT_SECRET is missing or shorter than 32 chars.
func Load(logger *slog.Logger) *Config {
	wd, _ := os.Getwd()

	secret := os.Getenv("JWT_SECRET")
	if secret == "" {
		logger.Error("JWT_SECRET environment variable is required", "scope", "auth")
		os.Exit(1)
	}
	if len(secret) < 32 {
		logger.Error("JWT_SECRET must be at least 32 characters for security", "scope", "auth")
		os.Exit(1)
	}

	staticDir := filepath.Join(wd, "dist")
	if s := os.Getenv("STATIC_DIR"); s != "" {
		if abs, err := filepath.Abs(s); err == nil {
			staticDir = abs
		}
	}

	dataDir := env("DATA_DIR", filepath.Join(wd, "data"))

	cfg := &Config{
		Port:                         envInt("AUTH_PORT", 3001),
		StaticDir:                    staticDir,
		JWTSecret:                    secret,
		JWTExpiresInSeconds:          envInt("JWT_EXPIRES_IN_SECONDS", 2*60*60),
		JWTSessionMaxSeconds:         envInt("JWT_SESSION_MAX_SECONDS", 7*24*60*60),
		DataDir:                      dataDir,
		DBPath:                       env("DB_PATH", filepath.Join(dataDir, "auth.db")),
		PublicDir:                    filepath.Join(dataDir, "public"),
		ThumbsDir:                    filepath.Join(dataDir, "public", "thumbs"),
		AvatarsDir:                   filepath.Join(dataDir, "avatars"),
		EventRetentionDays:           envInt("EVENT_RETENTION_DAYS", 30),
		PerUserPublicQuotaBytes:      envInt64("PER_USER_PUBLIC_QUOTA_BYTES", 500*1024*1024),
		UpstreamMode:                 NormalizeUpstreamMode(firstEnv("UPSTREAM_MODE", "PICPILOT_UPSTREAM_MODE")),
		APIProxyURL:                  strings.TrimSpace(os.Getenv("API_PROXY_URL")),
		APIProxyAPIKey:               strings.TrimSpace(os.Getenv("API_PROXY_API_KEY")),
		ReverseProxyURL:              firstEnv("REVERSE_PROXY_URL", "CHATGPT2API_URL"),
		ReverseProxyAPIKey:           firstEnv("REVERSE_PROXY_API_KEY", "CHATGPT2API_AUTH_KEY"),
		ReverseProxyInternal:         NormalizeBooleanSetting(os.Getenv("CHATGPT_REVERSE_INTERNAL"), false),
		ChatGPTReverseAuthDir:        strings.TrimSpace(os.Getenv("CHATGPT_REVERSE_AUTH_DIR")),
		ChatGPTReverseAccessTokens:   strings.TrimSpace(os.Getenv("CHATGPT_REVERSE_ACCESS_TOKENS")),
		ChatGPTReverseBaseURL:        env("CHATGPT_REVERSE_BASE_URL", "https://chatgpt.com"),
		ReverseAccountConcurrency:    NormalizeReverseAccountConcurrency(os.Getenv("CHATGPT_REVERSE_ACCOUNT_CONCURRENCY"), 1),
		OutboundProxyType:            NormalizeOutboundProxyType(os.Getenv("OUTBOUND_PROXY_TYPE"), OutboundProxyModeEnv),
		OutboundProxyURL:             NormalizeOutboundProxyURL(os.Getenv("OUTBOUND_PROXY_URL")),
		MaxConcurrent:                max(1, envInt("MAX_CONCURRENT_PROXY_REQUESTS", 5)),
		ProxyQueueMaxWaitMs:          clampInt(envInt("PROXY_QUEUE_MAX_WAIT_MS", 240000), 0, 240000),
		ProxyQueueMax:                max(0, envInt("PROXY_QUEUE_MAX", 10)),
		ProxyUserSoftLimit:           NormalizeProxyUserSoftLimit(os.Getenv("PROXY_USER_SOFT_LIMIT"), 3),
		ProxyUserHardLimit:           NormalizeProxyUserHardLimit(os.Getenv("PROXY_USER_HARD_LIMIT"), 0),
		ProviderLimits:               parseProviderLimits(os.Getenv("PROXY_PROVIDER_LIMITS")),
		DefaultMaxBatchImages:        NormalizeBatchImageLimit(os.Getenv("DEFAULT_MAX_BATCH_IMAGES"), 10),
		DefaultGalleryAutoRetryCount: NormalizeGalleryAutoRetryCount(os.Getenv("DEFAULT_GALLERY_AUTO_RETRY_COUNT"), 1),
		DefaultStreamFallbackEnabled: NormalizeBooleanSetting(os.Getenv("STREAM_FALLBACK_ENABLED"), true),
		DefaultRequestTimeoutSeconds: NormalizeRequestTimeoutSeconds(os.Getenv("REQUEST_TIMEOUT_SECONDS"), 900),
		UpstreamMaxRetries:           clampInt(envInt("UPSTREAM_MAX_RETRIES", 2), 0, 5),
		CLIProxyAPIURL:               strings.TrimSpace(os.Getenv("CLIPROXY_API_URL")),
		CLIProxyManagementKey:        strings.TrimSpace(os.Getenv("CLIPROXY_MGMT_KEY")),
		CLIProxyLogDir:               strings.TrimSpace(os.Getenv("CLIPROXY_LOG_DIR")),
	}

	for _, dir := range []string{cfg.DataDir, cfg.PublicDir, cfg.ThumbsDir, cfg.AvatarsDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			logger.Error("failed to create data directory", "dir", dir, "err", err.Error())
			os.Exit(1)
		}
	}

	return cfg
}

// parseProviderLimits parses PROXY_PROVIDER_LIMITS — a JSON object mapping upstream provider
// keys (e.g. "api", "reverse") to a max in-flight count, like {"reverse":2}. Values are
// clamped to [1,100]; non-positive or unparseable entries are dropped. Returns nil when
// unset or invalid (per-provider limiting disabled).
func parseProviderLimits(raw string) map[string]int {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	var parsed map[string]int
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return nil
	}
	out := make(map[string]int)
	for k, v := range parsed {
		if k = strings.TrimSpace(k); k == "" || v <= 0 {
			continue
		}
		out[k] = clampInt(v, 1, 100)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}
