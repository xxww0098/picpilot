package upstream

import (
	"errors"
	"net/url"
	"strings"

	"github.com/xxww0098/picpilot/server-go/internal/config"
)

// Target is the active OpenAI-compatible upstream selected by UPSTREAM_MODE.
type Target struct {
	Mode     string
	URL      string
	APIKey   string
	URLVar   string
	KeyVar   string
	Internal bool
}

// FromConfig returns the upstream selected by cfg.UpstreamMode. API mode keeps the
// existing API_PROXY_* variables; reverse mode targets chatgpt2api-compatible backends.
func FromConfig(cfg *config.Config) Target {
	return FromConfigForMode(cfg, "")
}

// FromConfigForMode returns the upstream selected by an optional per-request mode.
// Empty or invalid values fall back to cfg.UpstreamMode so stale clients cannot
// accidentally force a different route.
func FromConfigForMode(cfg *config.Config, requestedMode string) Target {
	mode := selectMode(cfg, requestedMode)
	if cfg != nil && mode == config.UpstreamModeReverse {
		if cfg.ReverseProxyInternal || isInternalURL(cfg.ReverseProxyURL) {
			return Target{
				Mode:     config.UpstreamModeReverse,
				URLVar:   "reverse_auth_accounts",
				KeyVar:   "",
				Internal: true,
			}
		}
		return Target{
			Mode:   config.UpstreamModeReverse,
			URL:    strings.TrimSpace(cfg.ReverseProxyURL),
			APIKey: strings.TrimSpace(cfg.ReverseProxyAPIKey),
			URLVar: "REVERSE_PROXY_URL",
			KeyVar: "REVERSE_PROXY_API_KEY",
		}
	}
	if cfg == nil {
		return Target{Mode: config.UpstreamModeAPI, URLVar: "API_PROXY_URL", KeyVar: "API_PROXY_API_KEY"}
	}
	return Target{
		Mode:   config.UpstreamModeAPI,
		URL:    strings.TrimSpace(cfg.APIProxyURL),
		APIKey: strings.TrimSpace(cfg.APIProxyAPIKey),
		URLVar: "API_PROXY_URL",
		KeyVar: "API_PROXY_API_KEY",
	}
}

func isInternalURL(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "internal", "builtin", "go", "go-builtin":
		return true
	default:
		return false
	}
}

func selectMode(cfg *config.Config, requestedMode string) string {
	fallback := config.UpstreamModeAPI
	if cfg != nil && cfg.UpstreamMode == config.UpstreamModeReverse {
		fallback = config.UpstreamModeReverse
	}
	switch strings.ToLower(strings.TrimSpace(requestedMode)) {
	case "":
		return fallback
	case config.UpstreamModeAPI:
		return config.UpstreamModeAPI
	case config.UpstreamModeReverse, "rev", "chatgpt2api":
		return config.UpstreamModeReverse
	default:
		return fallback
	}
}

func (t Target) Configured() bool { return t.Internal || t.URL != "" }

// ResolveProxy joins the active upstream with a public /api-proxy/* request path,
// tolerating a duplicated trailing /v1.
func (t Target) ResolveProxy(reqPath, rawQuery string) (*url.URL, error) {
	if t.Internal {
		return nil, nil
	}
	if t.URL == "" {
		return nil, nil
	}
	const prefix = "/api-proxy/"
	if !strings.HasPrefix(reqPath, prefix) {
		return nil, nil
	}
	endpointPath := strings.TrimLeft(reqPath[len(prefix):], "/")
	if endpointPath == "" {
		return nil, nil
	}
	return t.join(endpointPath, rawQuery)
}

// JoinEndpoint joins the active upstream with an async task endpoint.
func (t Target) JoinEndpoint(endpoint string) (string, error) {
	if t.Internal {
		return "", errors.New("内置 reverse 上游不能解析为外部 URL")
	}
	if t.URL == "" {
		return "", errors.New("上游 API 地址未配置")
	}
	endpoint = strings.TrimLeft(endpoint, "/")
	if endpoint == "" {
		return "", errors.New("endpoint 为空")
	}
	u, err := t.join(endpoint, "")
	if err != nil {
		return "", err
	}
	return u.String(), nil
}

func (t Target) join(endpointPath, rawQuery string) (*url.URL, error) {
	base := t.URL
	if !strings.HasSuffix(base, "/") {
		base += "/"
	}
	target, err := url.Parse(base)
	if err != nil {
		return nil, err
	}
	if target.Scheme != "http" && target.Scheme != "https" {
		return nil, errors.New(t.URLVar + " 只支持 http/https")
	}
	baseSeg := splitNonEmpty(target.Path)
	epSeg := splitNonEmpty(endpointPath)
	if len(baseSeg) > 0 && len(epSeg) > 0 && baseSeg[len(baseSeg)-1] == "v1" && epSeg[0] == "v1" {
		epSeg = epSeg[1:]
	}
	target.Path = "/" + strings.Join(append(baseSeg, epSeg...), "/")
	target.RawQuery = rawQuery
	return target, nil
}

func splitNonEmpty(p string) []string {
	parts := strings.Split(p, "/")
	out := parts[:0]
	for _, s := range parts {
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}
