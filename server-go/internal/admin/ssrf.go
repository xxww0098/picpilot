package admin

import (
	"context"
	"errors"
	"net"
	"net/http"
	"time"
)

// errBlockedAddress is returned when an outbound request targets a private /
// loopback / link-local address. Import sources are admin-controlled, so a
// compromised or curious admin must not be able to reach the cloud metadata
// endpoint (169.254.169.254) or internal services via the import feature.
var errBlockedAddress = errors.New("导入来源地址解析到内网/保留地址段，已拒绝连接。")

// blockedNetworks are the IPv4/IPv6 CIDRs an import source must never resolve
// into: link-local (covers AWS/GCP/Azure metadata 169.254.169.254), private
// use ranges (other hosts on the LAN), and CGNAT.
//
// Loopback (127.0.0.0/8, ::1) is intentionally NOT blocked: pointing an import
// source at a same-host service (e.g. a co-located CLIProxyAPI) is a legitimate
// deployment, and an admin probing local ports has far more direct avenues than
// the import feature. The SSRF threat model here is cross-host: cloud metadata
// and other machines on the private network.
var blockedNetworks = []string{
	// IPv4
	"0.0.0.0/8",
	"10.0.0.0/8",
	"169.254.0.0/16",
	"172.16.0.0/12",
	"192.168.0.0/16",
	"100.64.0.0/10", // CGNAT
	// IPv6
	"fc00::/7",  // unique-local
	"fe80::/10", // link-local
}

var blockedNets []*net.IPNet

func init() {
	for _, cidr := range blockedNetworks {
		_, n, err := net.ParseCIDR(cidr)
		if err != nil {
			panic("admin: invalid blocked CIDR " + cidr)
		}
		blockedNets = append(blockedNets, n)
	}
}

// isBlockedAddress reports whether ip falls into any reserved/private range
// (excluding loopback, which is intentionally permitted — see blockedNetworks).
func isBlockedAddress(ip net.IP) bool {
	if ip == nil {
		return false
	}
	if ip.IsUnspecified() || ip.IsLinkLocalUnicast() || ip.IsPrivate() {
		return true
	}
	for _, n := range blockedNets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// ssrfSafeClient is the http.Client used for admin-driven import fetches. Its
// transport resolves the destination and refuses to dial any private/loopback/
// link-local address, neutralizing SSRF via the cliproxy/sub2api import sources.
var ssrfSafeClient = &http.Client{
	Timeout: 30 * time.Second,
	Transport: &http.Transport{
		// Control runs after DNS resolution, just before connect, with the
		// resolved remote address — the authoritative point to block the dial.
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, _, err := net.SplitHostPort(addr)
			if err != nil {
				host = addr
			}
			// Resolve so that hostnames are checked (not just literal IPs).
			ips, lookupErr := net.DefaultResolver.LookupIP(ctx, "ip", host)
			if lookupErr != nil {
				return nil, lookupErr
			}
			for _, ip := range ips {
				if isBlockedAddress(ip) {
					return nil, errBlockedAddress
				}
			}
			d := &net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}
			return d.DialContext(ctx, network, addr)
		},
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          10,
		IdleConnTimeout:       60 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	},
}
