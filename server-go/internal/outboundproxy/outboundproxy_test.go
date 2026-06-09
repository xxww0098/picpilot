package outboundproxy

import (
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/xxww0098/picpilot/server-go/internal/config"
	"github.com/xxww0098/picpilot/server-go/internal/db"
	"github.com/xxww0098/picpilot/server-go/internal/settings"
)

func testProvider(t *testing.T, cfg *config.Config) *settings.Provider {
	t.Helper()
	d, err := db.Open(filepath.Join(t.TempDir(), "proxy.db"), 10)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	return settings.NewProvider(d, cfg)
}

func TestProxyFuncUsesStoredProxyURL(t *testing.T) {
	sp := testProvider(t, &config.Config{
		OutboundProxyType: "none",
	})
	if err := sp.Save(map[string]any{
		"outboundProxyType": "socks5h",
		"outboundProxyUrl":  "127.0.0.1:1080",
	}, "admin"); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest("GET", "https://chatgpt.com/backend-api/me", nil)
	proxyURL, err := ProxyFunc(sp)(req)
	if err != nil {
		t.Fatal(err)
	}
	if proxyURL == nil || proxyURL.String() != "socks5h://127.0.0.1:1080" {
		t.Fatalf("proxyURL=%v", proxyURL)
	}
}

func TestProxyFuncNoneDisablesEnvironmentProxy(t *testing.T) {
	t.Setenv("HTTPS_PROXY", "http://env-proxy.example:8080")
	t.Setenv("NO_PROXY", "")
	sp := testProvider(t, &config.Config{
		OutboundProxyType: "env",
	})
	if err := sp.Save(map[string]any{
		"outboundProxyType": "none",
	}, "admin"); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest("GET", "https://example.com/v1/models", nil)
	proxyURL, err := ProxyFunc(sp)(req)
	if err != nil {
		t.Fatal(err)
	}
	if proxyURL != nil {
		t.Fatalf("proxyURL=%v, want nil when proxy type is none", proxyURL)
	}
}
