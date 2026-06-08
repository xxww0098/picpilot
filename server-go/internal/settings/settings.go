// Package settings provides the runtime team configuration, ported from the
// team_config / getTeamSettingsPayload logic in server/index.ts. Values are stored as
// a JSON blob in team_config(id=1), cached in memory, and normalized with env defaults.
package settings

import (
	"encoding/json"
	"sync"
	"time"

	"github.com/xxww0098/picpilot/server-go/internal/config"
	"github.com/xxww0098/picpilot/server-go/internal/db"
)

// Payload is the normalized, effective team settings exposed to clients.
type Payload struct {
	DefaultMaxBatchImages int  `json:"defaultMaxBatchImages"`
	GalleryAutoRetryCount int  `json:"galleryAutoRetryCount"`
	MaxConcurrent         int  `json:"maxConcurrent"`
	MaxQueue              int  `json:"maxQueue"`
	ProxyUserSoftLimit    int  `json:"proxyUserSoftLimit"`
	StreamFallbackEnabled bool `json:"streamFallbackEnabled"`
	RequestTimeoutSeconds int  `json:"requestTimeoutSeconds"`
}

// Provider loads/caches team settings and resolves them against env defaults.
type Provider struct {
	db  *db.DB
	cfg *config.Config

	mu     sync.Mutex
	cached map[string]any
	loaded bool
}

func NewProvider(database *db.DB, cfg *config.Config) *Provider {
	return &Provider{db: database, cfg: cfg}
}

func cloneMap(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// record returns a shallow copy of the cached settings, loading from the DB on first use.
func (p *Provider) record() map[string]any {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.loaded {
		return cloneMap(p.cached)
	}
	var js string
	if err := p.db.QueryRow("SELECT settings_json FROM team_config WHERE id = 1").Scan(&js); err != nil {
		p.cached = map[string]any{}
		p.loaded = true
		return map[string]any{}
	}
	var parsed map[string]any
	if json.Unmarshal([]byte(js), &parsed) == nil && parsed != nil {
		p.cached = parsed
	} else {
		p.cached = map[string]any{}
	}
	p.loaded = true
	return cloneMap(p.cached)
}

// Payload resolves the effective settings (admin overrides clamped, else env defaults).
func (p *Provider) Payload() Payload {
	s := p.record()
	return Payload{
		DefaultMaxBatchImages: config.NormalizeBatchImageLimit(s["defaultMaxBatchImages"], p.cfg.DefaultMaxBatchImages),
		GalleryAutoRetryCount: config.NormalizeGalleryAutoRetryCount(s["galleryAutoRetryCount"], p.cfg.DefaultGalleryAutoRetryCount),
		MaxConcurrent:         config.NormalizeConcurrencyLimit(s["maxConcurrent"], p.cfg.MaxConcurrent),
		MaxQueue:              config.NormalizeQueueLimit(s["maxQueue"], p.cfg.ProxyQueueMax),
		ProxyUserSoftLimit:    config.NormalizeProxyUserSoftLimit(s["proxyUserSoftLimit"], p.cfg.ProxyUserSoftLimit),
		StreamFallbackEnabled: config.NormalizeBooleanSetting(s["streamFallbackEnabled"], p.cfg.DefaultStreamFallbackEnabled),
		RequestTimeoutSeconds: config.NormalizeRequestTimeoutSeconds(s["requestTimeoutSeconds"], p.cfg.DefaultRequestTimeoutSeconds),
	}
}

// DefaultMaxBatchImages is the effective per-batch limit for new users.
func (p *Provider) DefaultMaxBatchImages() int { return p.Payload().DefaultMaxBatchImages }

// Record returns a copy of the raw stored settings (for admin PATCH merge).
func (p *Provider) Record() map[string]any { return p.record() }

// Save persists the full settings record and refreshes the cache (admin use, task 9).
func (p *Provider) Save(settings map[string]any, updatedBy string) error {
	raw, err := json.Marshal(settings)
	if err != nil {
		return err
	}
	var ub any
	if updatedBy != "" {
		ub = updatedBy
	}
	_, err = p.db.Exec(
		`INSERT INTO team_config (id, settings_json, updated_at, updated_by) VALUES (1, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET settings_json=excluded.settings_json, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
		string(raw), time.Now().UnixMilli(), ub,
	)
	if err != nil {
		return err
	}
	p.mu.Lock()
	p.cached = cloneMap(settings)
	p.loaded = true
	p.mu.Unlock()
	return nil
}
