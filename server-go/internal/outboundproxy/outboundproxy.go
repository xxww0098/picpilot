package outboundproxy

import (
	"net/http"
	"net/url"

	"github.com/xxww0098/picpilot/server-go/internal/config"
	"github.com/xxww0098/picpilot/server-go/internal/settings"
)

// ProxyFunc resolves the effective outbound proxy for each request. It preserves
// Go's standard environment proxy behavior until an admin explicitly overrides it.
func ProxyFunc(sp *settings.Provider) func(*http.Request) (*url.URL, error) {
	return func(req *http.Request) (*url.URL, error) {
		if sp == nil {
			return http.ProxyFromEnvironment(req)
		}
		payload := sp.Payload()
		switch payload.OutboundProxyType {
		case config.OutboundProxyModeEnv:
			return http.ProxyFromEnvironment(req)
		case config.OutboundProxyModeNone:
			return nil, nil
		default:
			return config.BuildOutboundProxyURL(payload.OutboundProxyType, payload.OutboundProxyURL)
		}
	}
}
