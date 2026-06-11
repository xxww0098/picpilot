// Package config holds runtime configuration plus the pure validation/normalization
// helpers ported from server/utils/validation.ts.
//
// The Normalize* helpers accept `any` and clamp into range (falling back on invalid
// input), mirroring the TS normalize*(value: unknown, fallback) functions used for
// BOTH env strings and team-settings JSON values. The Parse*PatchValue helpers return
// ok=false when out of range (used for strict admin PATCH validation).
package config

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"math"
	"net/url"
	"strconv"
	"strings"
)

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// parseLooseFloat mirrors TS Number(value) for strings: empty/whitespace or
// unparseable input yields (0, false) so callers fall back to their default.
func parseLooseFloat(s string) (float64, bool) {
	t := strings.TrimSpace(s)
	if t == "" {
		return 0, false
	}
	f, err := strconv.ParseFloat(t, 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, false
	}
	return f, true
}

// looseNumber mirrors TS `typeof v === 'number' ? v : Number(v)`, accepting both env
// strings and JSON-decoded values (float64, json.Number, string).
func looseNumber(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		if math.IsNaN(n) || math.IsInf(n, 0) {
			return 0, false
		}
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case json.Number:
		f, err := n.Float64()
		if err != nil {
			return 0, false
		}
		return f, true
	case string:
		return parseLooseFloat(n)
	default:
		return 0, false
	}
}

func normalizeClamped(v any, lo, hi, fallback int) int {
	if f, ok := looseNumber(v); ok {
		return clampInt(int(math.Trunc(f)), lo, hi)
	}
	return fallback
}

// ----- normalizers (accept any; clamp into range; fallback on invalid) -----

func NormalizeBatchImageLimit(v any, fallback int) int  { return normalizeClamped(v, 1, 100, fallback) }
func NormalizeConcurrencyLimit(v any, fallback int) int { return normalizeClamped(v, 1, 100, fallback) }
func NormalizeQueueLimit(v any, fallback int) int       { return normalizeClamped(v, 0, 1000, fallback) }
func NormalizeProxyUserSoftLimit(v any, fallback int) int {
	return normalizeClamped(v, 0, 100, fallback)
}
func NormalizeReverseAccountConcurrency(v any, fallback int) int {
	return normalizeClamped(v, 1, 5, clampInt(fallback, 1, 5))
}
func NormalizeGalleryAutoRetryCount(v any, fallback int) int {
	return normalizeClamped(v, 0, 5, fallback)
}
func NormalizeRequestTimeoutSeconds(v any, fallback int) int {
	return normalizeClamped(v, 30, 3600, fallback)
}

func NormalizeBooleanSetting(v any, fallback bool) bool {
	switch b := v.(type) {
	case bool:
		return b
	case float64:
		if b == 1 {
			return true
		}
		if b == 0 {
			return false
		}
	case int:
		if b == 1 {
			return true
		}
		if b == 0 {
			return false
		}
	case string:
		switch strings.ToLower(strings.TrimSpace(b)) {
		case "1", "true", "yes", "on":
			return true
		case "0", "false", "no", "off":
			return false
		}
	}
	return fallback
}

const (
	UpstreamModeAPI     = "api"
	UpstreamModeReverse = "reverse"
)

const (
	OutboundProxyModeEnv     = "env"
	OutboundProxyModeNone    = "none"
	OutboundProxyModeHTTP    = "http"
	OutboundProxyModeHTTPS   = "https"
	OutboundProxyModeSOCKS5  = "socks5"
	OutboundProxyModeSOCKS5H = "socks5h"
)

var DefaultAllowedOutputFormats = []string{"jpeg", "png", "webp"}

func cloneStringSlice(values []string) []string {
	if len(values) == 0 {
		return []string{}
	}
	out := make([]string, len(values))
	copy(out, values)
	return out
}

func normalizeOutputFormat(v any) (string, bool) {
	s, ok := v.(string)
	if !ok {
		return "", false
	}
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "png":
		return "png", true
	case "jpeg", "jpg":
		return "jpeg", true
	case "webp":
		return "webp", true
	default:
		return "", false
	}
}

func normalizeOutputFormatList(v any, fallback []string, strict bool) ([]string, bool) {
	var items []any
	switch raw := v.(type) {
	case []any:
		items = raw
	case []string:
		items = make([]any, len(raw))
		for i, item := range raw {
			items[i] = item
		}
	default:
		if strict {
			return nil, false
		}
		return cloneStringSlice(fallback), true
	}
	out := make([]string, 0, len(items))
	seen := map[string]bool{}
	for _, item := range items {
		format, ok := normalizeOutputFormat(item)
		if !ok {
			if strict {
				return nil, false
			}
			continue
		}
		if seen[format] {
			continue
		}
		seen[format] = true
		out = append(out, format)
	}
	if len(out) == 0 {
		if strict {
			return nil, false
		}
		return cloneStringSlice(fallback), true
	}
	return out, true
}

func NormalizeAllowedOutputFormats(v any, fallback []string) []string {
	if len(fallback) == 0 {
		fallback = DefaultAllowedOutputFormats
	}
	out, _ := normalizeOutputFormatList(v, fallback, false)
	return out
}

func NormalizeUpstreamMode(v any) string {
	switch s := strings.ToLower(strings.TrimSpace(toString(v))); s {
	case "reverse", "rev", "chatgpt2api":
		return UpstreamModeReverse
	default:
		return UpstreamModeAPI
	}
}

func NormalizeOutboundProxyType(v any, fallback string) string {
	switch s := strings.ToLower(strings.TrimSpace(toString(v))); s {
	case "":
		return fallbackOutboundProxyType(fallback)
	case OutboundProxyModeEnv, OutboundProxyModeNone, OutboundProxyModeHTTP, OutboundProxyModeHTTPS, OutboundProxyModeSOCKS5, OutboundProxyModeSOCKS5H:
		return s
	default:
		return fallbackOutboundProxyType(fallback)
	}
}

func fallbackOutboundProxyType(fallback string) string {
	switch s := strings.ToLower(strings.TrimSpace(fallback)); s {
	case OutboundProxyModeEnv, OutboundProxyModeNone, OutboundProxyModeHTTP, OutboundProxyModeHTTPS, OutboundProxyModeSOCKS5, OutboundProxyModeSOCKS5H:
		return s
	default:
		return OutboundProxyModeEnv
	}
}

func NormalizeOutboundProxyURL(v any) string {
	return strings.TrimSpace(toString(v))
}

func NormalizeCLIProxyAPIURL(v any) string {
	return strings.TrimRight(strings.TrimSpace(toString(v)), "/")
}

func NormalizeCLIProxyManagementKey(v any) string {
	return strings.TrimSpace(toString(v))
}

func ValidateHTTPBaseURL(raw string) error {
	if raw == "" {
		return nil
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return err
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return errors.New("URL scheme must be http or https")
	}
	if parsed.Host == "" {
		return errors.New("URL must include host")
	}
	return nil
}

func OutboundProxyTypeRequiresURL(proxyType string) bool {
	switch NormalizeOutboundProxyType(proxyType, OutboundProxyModeEnv) {
	case OutboundProxyModeHTTP, OutboundProxyModeHTTPS, OutboundProxyModeSOCKS5, OutboundProxyModeSOCKS5H:
		return true
	default:
		return false
	}
}

func BuildOutboundProxyURL(proxyType, proxyURL string) (*url.URL, error) {
	mode := NormalizeOutboundProxyType(proxyType, OutboundProxyModeEnv)
	if mode == OutboundProxyModeEnv || mode == OutboundProxyModeNone {
		return nil, nil
	}
	raw := NormalizeOutboundProxyURL(proxyURL)
	if raw == "" {
		return nil, errors.New("proxy URL is required")
	}
	if !strings.Contains(raw, "://") {
		raw = mode + "://" + raw
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	if parsed.Host == "" {
		return nil, errors.New("proxy URL must include host")
	}
	if NormalizeOutboundProxyType(parsed.Scheme, "") != mode {
		return nil, errors.New("proxy URL scheme does not match proxy type")
	}
	return parsed, nil
}

func toString(v any) string {
	switch s := v.(type) {
	case string:
		return s
	default:
		return ""
	}
}

// ----- JSON patch-value parsers (ok=false when out of range/invalid) -----

func parsePatchClamped(v any, lo, hi float64) (int, bool) {
	if f, ok := looseNumber(v); ok && f >= lo && f <= hi {
		return int(math.Trunc(f)), true
	}
	return 0, false
}

func ParseBatchImageLimitPatchValue(v any) (int, bool)    { return parsePatchClamped(v, 1, 100) }
func ParseConcurrencyPatchValue(v any) (int, bool)        { return parsePatchClamped(v, 1, 100) }
func ParseQueuePatchValue(v any) (int, bool)              { return parsePatchClamped(v, 0, 1000) }
func ParseProxyUserSoftLimitPatchValue(v any) (int, bool) { return parsePatchClamped(v, 0, 100) }
func ParseReverseAccountConcurrencyPatchValue(v any) (int, bool) {
	return parsePatchClamped(v, 1, 5)
}
func ParseGalleryAutoRetryCountPatchValue(v any) (int, bool) { return parsePatchClamped(v, 0, 5) }
func ParseRequestTimeoutSecondsPatchValue(v any) (int, bool) { return parsePatchClamped(v, 30, 3600) }

func ParseBooleanPatchValue(v any) (bool, bool) {
	switch b := v.(type) {
	case bool:
		return b, true
	case float64:
		if b == 1 {
			return true, true
		}
		if b == 0 {
			return false, true
		}
	case string:
		switch strings.ToLower(strings.TrimSpace(b)) {
		case "1", "true", "yes", "on":
			return true, true
		case "0", "false", "no", "off":
			return false, true
		}
	}
	return false, false
}

func ParseOutboundProxyTypePatchValue(v any) (string, bool) {
	s, ok := v.(string)
	if !ok {
		return "", false
	}
	trimmed := strings.ToLower(strings.TrimSpace(s))
	normalized := NormalizeOutboundProxyType(trimmed, "")
	if trimmed != "" && normalized == OutboundProxyModeEnv && trimmed != OutboundProxyModeEnv {
		return "", false
	}
	return normalized, true
}

func ParseOutboundProxyURLPatchValue(v any) (string, bool) {
	s, ok := v.(string)
	if !ok {
		return "", false
	}
	s = strings.TrimSpace(s)
	if len(s) > 2048 || strings.ContainsAny(s, "\r\n\t") {
		return "", false
	}
	return s, true
}

func ParseCLIProxyAPIURLPatchValue(v any) (string, bool) {
	s, ok := v.(string)
	if !ok {
		return "", false
	}
	s = NormalizeCLIProxyAPIURL(s)
	if len(s) > 2048 || strings.ContainsAny(s, "\r\n\t") {
		return "", false
	}
	if err := ValidateHTTPBaseURL(s); err != nil {
		return "", false
	}
	return s, true
}

func ParseCLIProxyManagementKeyPatchValue(v any) (string, bool) {
	s, ok := v.(string)
	if !ok {
		return "", false
	}
	s = NormalizeCLIProxyManagementKey(s)
	if len(s) > 4096 || strings.ContainsAny(s, "\r\n\t") {
		return "", false
	}
	return s, true
}

func ParseAllowedOutputFormatsPatchValue(v any) ([]string, bool) {
	return normalizeOutputFormatList(v, DefaultAllowedOutputFormats, true)
}

func GetPositiveIntegerValue(v any) (int, bool) {
	if f, ok := looseNumber(v); ok {
		return clampInt(int(math.Trunc(f)), 1, 1000), true
	}
	return 0, false
}

// inviteAlphabet length (32) divides 256 evenly, so modulo reduction is unbiased.
const inviteAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

// GenerateInviteCode returns a 12-char invite code using crypto/rand.
func GenerateInviteCode() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		panic("invite code generation failed: " + err.Error())
	}
	out := make([]byte, 12)
	for i := range out {
		out[i] = inviteAlphabet[int(b[i])%len(inviteAlphabet)]
	}
	return string(out)
}
