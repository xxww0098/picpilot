package admin

import (
	"net"
	"net/http"
	"testing"
)

func TestIsBlockedAddress(t *testing.T) {
	blocked := []string{
		"169.254.169.254", // cloud metadata (link-local)
		"10.0.0.5",        // RFC1918 10/8
		"172.16.1.1",      // RFC1918 172.16/12
		"192.168.1.1",     // RFC1918 192.168/16
		"100.64.0.1",      // CGNAT 100.64/10
		"0.0.0.0",         // unspecified
		"fe80::1",         // IPv6 link-local
		"fd00::1",         // IPv6 unique-local
	}
	for _, ip := range blocked {
		t.Run("blocked/"+ip, func(t *testing.T) {
			if !isBlockedAddress(net.ParseIP(ip)) {
				t.Errorf("isBlockedAddress(%s) = false, want true", ip)
			}
		})
	}

	allowed := []string{
		"127.0.0.1", // loopback — co-located services permitted
		"::1",       // IPv6 loopback
		"8.8.8.8",   // public address
		"1.1.1.1",   // public address
	}
	for _, ip := range allowed {
		t.Run("allowed/"+ip, func(t *testing.T) {
			if isBlockedAddress(net.ParseIP(ip)) {
				t.Errorf("isBlockedAddress(%s) = true, want false", ip)
			}
		})
	}
}

// TestSSRFSafeClientRejectsMetadataEndpoint verifies the client refuses to
// dial a link-local (cloud-metadata) address end-to-end. The dial itself must
// be blocked before any connection is established.
func TestSSRFSafeClientRejectsMetadataEndpoint(t *testing.T) {
	// 169.254.169.254 is the canonical AWS/GCP/Azure metadata endpoint.
	req, err := http.NewRequest(http.MethodGet, "http://169.254.169.254/latest/meta-data/", nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	if _, err = ssrfSafeClient.Do(req); err == nil {
		t.Fatal("expected ssrfSafeClient to block 169.254.169.254, but request succeeded")
	}
}
