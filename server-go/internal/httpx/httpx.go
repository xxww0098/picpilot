// Package httpx holds small HTTP response helpers shared across route modules.
package httpx

import (
	"encoding/json"
	"net/http"
)

// JSON writes v as a JSON response with the given status code.
func JSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// Error writes {"error": msg} with the given status code (matches the TS API shape).
func Error(w http.ResponseWriter, status int, msg string) {
	JSON(w, status, map[string]string{"error": msg})
}

// SecurityHeaders is a middleware that attaches a baseline set of browser
// security response headers to every response. The CSP is tuned for this SPA:
// all scripts/styles are external (under ./assets), images render as data:
// URLs and same-origin fetches, so script-src can be restricted to 'self'.
// style-src allows 'unsafe-inline' because Tailwind/React emit inline style
// attributes (inline styles are not an XSS vector).
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		h.Set("Content-Security-Policy",
			"default-src 'self'; "+
				"script-src 'self'; "+
				"style-src 'self' 'unsafe-inline'; "+
				"img-src 'self' data: blob:; "+
				"font-src 'self' data:; "+
				"connect-src 'self'; "+
				"media-src 'self' data: blob:; "+
				"object-src 'none'; "+
				"base-uri 'self'; "+
				"frame-ancestors 'none'; "+
				"form-action 'self'")
		next.ServeHTTP(w, r)
	})
}
