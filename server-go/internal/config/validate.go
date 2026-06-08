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
	"math"
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

// ----- JSON patch-value parsers (ok=false when out of range/invalid) -----

func parsePatchClamped(v any, lo, hi float64) (int, bool) {
	if f, ok := looseNumber(v); ok && f >= lo && f <= hi {
		return int(math.Trunc(f)), true
	}
	return 0, false
}

func ParseBatchImageLimitPatchValue(v any) (int, bool)       { return parsePatchClamped(v, 1, 100) }
func ParseConcurrencyPatchValue(v any) (int, bool)           { return parsePatchClamped(v, 1, 100) }
func ParseQueuePatchValue(v any) (int, bool)                 { return parsePatchClamped(v, 0, 1000) }
func ParseProxyUserSoftLimitPatchValue(v any) (int, bool)    { return parsePatchClamped(v, 0, 100) }
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
