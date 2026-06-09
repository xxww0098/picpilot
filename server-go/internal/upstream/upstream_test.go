package upstream

import (
	"testing"

	"github.com/xxww0098/picpilot/server-go/internal/config"
)

func TestFromConfigSelectsAPIByDefault(t *testing.T) {
	target := FromConfig(&config.Config{
		APIProxyURL:        "http://api.example/v1",
		APIProxyAPIKey:     "api-key",
		ReverseProxyURL:    "http://reverse.example/v1",
		ReverseProxyAPIKey: "reverse-key",
	})
	if target.Mode != config.UpstreamModeAPI {
		t.Fatalf("mode=%q want api", target.Mode)
	}
	if target.URL != "http://api.example/v1" || target.APIKey != "api-key" {
		t.Fatalf("target=%+v want API upstream", target)
	}
}

func TestFromConfigSelectsReverseMode(t *testing.T) {
	target := FromConfig(&config.Config{
		UpstreamMode:       config.UpstreamModeReverse,
		APIProxyURL:        "http://api.example/v1",
		APIProxyAPIKey:     "api-key",
		ReverseProxyURL:    "http://reverse.example/v1",
		ReverseProxyAPIKey: "reverse-key",
	})
	if target.Mode != config.UpstreamModeReverse {
		t.Fatalf("mode=%q want reverse", target.Mode)
	}
	if target.URL != "http://reverse.example/v1" || target.APIKey != "reverse-key" {
		t.Fatalf("target=%+v want reverse upstream", target)
	}
}

func TestFromConfigForModeOverridesConfiguredDefault(t *testing.T) {
	target := FromConfigForMode(&config.Config{
		UpstreamMode:       config.UpstreamModeAPI,
		APIProxyURL:        "http://api.example/v1",
		APIProxyAPIKey:     "api-key",
		ReverseProxyURL:    "http://reverse.example/v1",
		ReverseProxyAPIKey: "reverse-key",
	}, "reverse")
	if target.Mode != config.UpstreamModeReverse {
		t.Fatalf("mode=%q want reverse", target.Mode)
	}
	if target.URL != "http://reverse.example/v1" || target.APIKey != "reverse-key" {
		t.Fatalf("target=%+v want reverse upstream", target)
	}
}

func TestFromConfigForModeSelectsInternalReverse(t *testing.T) {
	target := FromConfigForMode(&config.Config{
		UpstreamMode:    config.UpstreamModeAPI,
		ReverseProxyURL: "internal",
	}, "reverse")
	if target.Mode != config.UpstreamModeReverse || !target.Internal {
		t.Fatalf("target=%+v want internal reverse", target)
	}
	if !target.Configured() {
		t.Fatal("internal reverse should be treated as configured")
	}
	if u, err := target.ResolveProxy("/api-proxy/v1/models", ""); err != nil || u != nil {
		t.Fatalf("internal ResolveProxy=%v err=%v, want nil nil", u, err)
	}
}

func TestFromConfigForModeFallsBackOnInvalidMode(t *testing.T) {
	target := FromConfigForMode(&config.Config{
		UpstreamMode:       config.UpstreamModeReverse,
		APIProxyURL:        "http://api.example/v1",
		APIProxyAPIKey:     "api-key",
		ReverseProxyURL:    "http://reverse.example/v1",
		ReverseProxyAPIKey: "reverse-key",
	}, "not-a-mode")
	if target.Mode != config.UpstreamModeReverse {
		t.Fatalf("mode=%q want configured reverse fallback", target.Mode)
	}
}

func TestResolveProxyDeduplicatesV1(t *testing.T) {
	target := Target{URL: "http://upstream/v1", URLVar: "TEST_UPSTREAM_URL"}
	u, err := target.ResolveProxy("/api-proxy/v1/images/generations", "a=1")
	if err != nil {
		t.Fatal(err)
	}
	if u.Path != "/v1/images/generations" || u.RawQuery != "a=1" {
		t.Fatalf("resolved=%s?%s want /v1/images/generations?a=1", u.Path, u.RawQuery)
	}
}

func TestJoinEndpointRejectsUnsupportedScheme(t *testing.T) {
	_, err := (Target{URL: "ftp://upstream/v1", URLVar: "TEST_UPSTREAM_URL"}).JoinEndpoint("models")
	if err == nil {
		t.Fatal("expected unsupported scheme error")
	}
}
