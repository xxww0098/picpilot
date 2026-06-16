package admin

import (
	"errors"
	"strings"
	"testing"
)

func TestHumanizeCLIProxyConnectErrorCliproxyHostname(t *testing.T) {
	err := humanizeCLIProxyConnectError(errors.New(`dial tcp: lookup cliproxy on 127.0.0.11:53: no such host`), "http://cliproxy:8317")
	if err == nil || !strings.Contains(err.Error(), "cliproxyapi") {
		t.Fatalf("expected cliproxyapi hint, got %v", err)
	}
}

func TestHumanizeCLIProxyConnectErrorTimeout(t *testing.T) {
	err := humanizeCLIProxyConnectError(errors.New("context deadline exceeded"), "http://cliproxyapi:8317")
	if err == nil || !strings.Contains(err.Error(), "超时") {
		t.Fatalf("expected timeout hint, got %v", err)
	}
}

func TestHumanizeCLIProxyHTTPErrorManagementKey(t *testing.T) {
	err := humanizeCLIProxyHTTPError(401, `{"error":"invalid management key"}`)
	if err == nil || !strings.Contains(err.Error(), "secret-key") || strings.Contains(err.Error(), "401") {
		t.Fatalf("expected management key hint without raw 401, got %v", err)
	}
}

func TestHumanizeCLIProxyHTTPErrorNotFound(t *testing.T) {
	err := humanizeCLIProxyHTTPError(404, "")
	if err == nil || !strings.Contains(err.Error(), "管理接口不存在") {
		t.Fatalf("expected not-found hint, got %v", err)
	}
}