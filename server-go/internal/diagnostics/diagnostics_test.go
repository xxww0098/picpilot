package diagnostics

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/xxww0098/picpilot/server-go/internal/db"
)

func TestUpstreamHealthParsesLog(t *testing.T) {
	dir := t.TempDir()
	logContent := `[2026-06-04 12:58:00] [req-1] Use OAuth provider=gemini auth_file=/root/.cli-proxy-api/acct1.json for model gemini-2.5-flash
[2026-06-04 12:58:01] [req-2] Use OAuth provider=gemini auth_file=/root/.cli-proxy-api/acct1.json for model gemini-2.5-flash
[2026-06-04 12:59:00] [req-1] [GIN] 200 | 5m40s | 1.2.3.4 | POST "/v1/images/generations"
[2026-06-04 12:59:10] [req-2] [GIN] 500 | 3s | 1.2.3.4 | POST "/v1/images/generations"
`
	if err := os.WriteFile(filepath.Join(dir, "main.log"), []byte(logContent), 0o644); err != nil {
		t.Fatal(err)
	}
	rep := getUpstreamHealthReport(dir)
	if rep["available"] != true {
		t.Fatalf("expected available, got %v", rep)
	}
	accts, ok := rep["accounts"].([]accountHealth)
	if !ok || len(accts) != 1 {
		t.Fatalf("expected 1 account, got %#v", rep["accounts"])
	}
	a := accts[0]
	if a.Total != 2 || a.Success != 1 || a.Failure != 1 {
		t.Fatalf("counts wrong: %+v", a)
	}
	if a.Status != "healthy" {
		t.Fatalf("status=%s want healthy (1 failure)", a.Status)
	}
	if len(a.Routes) != 1 || a.Routes[0].Total != 2 || a.Routes[0].Failure != 1 {
		t.Fatalf("routes wrong: %+v", a.Routes)
	}
	if len(a.Models) != 1 || a.Models[0] != "gemini-2.5-flash" {
		t.Fatalf("models wrong: %v", a.Models)
	}
	if a.AvgDurationMs == nil || *a.AvgDurationMs != 171500 {
		t.Fatalf("avg duration = %v want 171500", a.AvgDurationMs)
	}
}

func TestUpstreamHealthNoLogDir(t *testing.T) {
	rep := getUpstreamHealthReport("")
	if rep["available"] != false {
		t.Fatal("empty log dir should be unavailable")
	}
}

func TestNormalizeFailureReason(t *testing.T) {
	st := func(n int64) *int64 { return &n }
	cases := []struct {
		errType, msg string
		status       *int64
		want         string
	}{
		{"", "request timed out", nil, "timeout"},
		{"", "", st(429), "rate_or_quota"},
		{"", "", st(401), "auth_invalid"},
		{"", "", st(403), "auth_forbidden"},
		{"", "empty_stream: closed before first payload", nil, "stream_empty"},
		{"", "Failed to fetch", nil, "network"},
		{"", "", st(500), "upstream_5xx"},
		{"custom_thing", "weird", nil, "custom_thing"},
	}
	for _, c := range cases {
		if got := normalizeFailureReason(c.errType, c.msg, c.status); got != c.want {
			t.Errorf("normalizeFailureReason(%q,%q,%v)=%q want %q", c.errType, c.msg, c.status, got, c.want)
		}
	}
}

func TestMaskAuthFileStable(t *testing.T) {
	k1, l1 := maskAuthFile("gemini", "/root/.cli-proxy-api/acct1.json")
	k2, _ := maskAuthFile("gemini", "/root/.cli-proxy-api/acct1.json")
	if k1 != k2 {
		t.Fatal("masking should be deterministic")
	}
	if k1[:7] != "gemini:" || len(k1) != 7+8 {
		t.Fatalf("key format wrong: %q", k1)
	}
	if l1 != k1 {
		t.Fatalf("label %q should equal key %q (hash is 8 chars)", l1, k1)
	}
	if k3, _ := maskAuthFile("gemini", "/root/.cli-proxy-api/acct2.json"); k3 == k1 {
		t.Fatal("different auth files should mask to different keys")
	}
}

func TestBuildFailureSummary(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "t.db"), 10)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	now := time.Now().UnixMilli()
	_, _ = d.Exec("INSERT INTO users (id, username, password_hash, created_at) VALUES ('u1','bob','x',?)", now)
	insert := func(eventType, errType string, status int64) {
		_, err := d.Exec(
			"INSERT INTO request_events (user_id, username, event_type, error_type, http_status, created_at) VALUES (?,?,?,?,?,?)",
			"u1", "bob", eventType, errType, status, now)
		if err != nil {
			t.Fatal(err)
		}
	}
	insert("success", "", 200)
	insert("failure", "rate_limit", 429)
	insert("failure", "rate_limit", 429)

	m := &Module{db: d}
	sum := m.buildFailureSummary([2]int64{now - 1000, now + 1000}, "")
	reasons, _ := sum["reasons"].([]map[string]any)
	if len(reasons) == 0 {
		t.Fatalf("expected failure reasons, got %v", sum["reasons"])
	}
	top := reasons[0]
	if top["reason"] != "rate_or_quota" || top["count"].(int) != 2 {
		t.Fatalf("top reason = %v want rate_or_quota x2", top)
	}
}
