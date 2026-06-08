package auth

import (
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Claims matches the TS token payload: { sub, username, isAdmin, tv, sst, exp }.
// sub and exp come from RegisteredClaims; the rest are custom.
type Claims struct {
	Username string `json:"username"`
	IsAdmin  bool   `json:"isAdmin"`
	TV       int    `json:"tv"`  // token_version (revocation)
	SST      int64  `json:"sst"` // session start (unix seconds) for absolute session cap
	jwt.RegisteredClaims
}

// signToken issues a short-lived HS256 token. sessionStart preserves the original
// session start across refreshes; pass 0 to start a new session at now.
func signToken(secret string, expiresInSec int, userID, username string, isAdmin bool, tv int, sessionStart int64) (string, error) {
	now := time.Now().Unix()
	if sessionStart == 0 {
		sessionStart = now
	}
	claims := Claims{
		Username: username,
		IsAdmin:  isAdmin,
		TV:       tv,
		SST:      sessionStart,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   userID,
			ExpiresAt: jwt.NewNumericDate(time.Unix(now+int64(expiresInSec), 0)),
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(secret))
}

// parseToken verifies the HS256 signature and standard claims (incl. exp).
func parseToken(secret, tokenStr string) (*Claims, error) {
	claims := &Claims{}
	_, err := jwt.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return []byte(secret), nil
	})
	if err != nil {
		return nil, err
	}
	return claims, nil
}
