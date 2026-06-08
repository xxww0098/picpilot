// Package db owns the SQLite connection and schema. It uses the pure-Go
// modernc.org/sqlite driver (no cgo) so the server stays a single static binary.
// The schema mirrors server/index.ts and adds a `tasks` table for the async task model.
package db

import (
	"database/sql"
	"fmt"

	_ "modernc.org/sqlite"
)

// DB wraps *sql.DB with schema management.
type DB struct {
	*sql.DB
}

// Open opens (creating if needed) the SQLite database at path, applies the standard
// PRAGMAs via the DSN (so every connection inherits them), and runs migrations.
// defaultMaxBatch seeds the users.max_batch_images column default.
func Open(path string, defaultMaxBatch int) (*DB, error) {
	dsn := fmt.Sprintf(
		"file:%s?_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=foreign_keys(ON)&_pragma=busy_timeout(5000)",
		path,
	)
	sqldb, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// Serialize access on a single connection, matching the Node service's synchronous SQLite model,
	// to avoid "database is locked" under concurrent writers; the metadata DB is not the
	// hot path (the proxy is), so the throughput tradeoff is acceptable.
	sqldb.SetMaxOpenConns(1)
	if err := sqldb.Ping(); err != nil {
		_ = sqldb.Close()
		return nil, err
	}
	d := &DB{sqldb}
	if err := d.migrate(defaultMaxBatch); err != nil {
		_ = sqldb.Close()
		return nil, err
	}
	return d, nil
}

func (d *DB) migrate(defaultMaxBatch int) error {
	schema := fmt.Sprintf(`
CREATE TABLE IF NOT EXISTS users (
  id                   TEXT PRIMARY KEY,
  username             TEXT UNIQUE NOT NULL,
  display_name         TEXT,
  password_hash        TEXT NOT NULL,
  is_admin             INTEGER NOT NULL DEFAULT 0,
  max_batch_images     INTEGER NOT NULL DEFAULT %d,
  created_at           INTEGER NOT NULL,
  last_login_at        INTEGER,
  avatar_updated_at    INTEGER,
  public_storage_bytes INTEGER NOT NULL DEFAULT 0,
  disabled             INTEGER NOT NULL DEFAULT 0,
  token_version        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS invite_codes (
  code        TEXT PRIMARY KEY,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER,
  max_uses    INTEGER NOT NULL DEFAULT 1,
  used_count  INTEGER NOT NULL DEFAULT 0,
  note        TEXT
);

CREATE TABLE IF NOT EXISTS invite_redemptions (
  code        TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  redeemed_at INTEGER NOT NULL,
  PRIMARY KEY (code, user_id)
);

CREATE TABLE IF NOT EXISTS user_stats (
  user_id            TEXT PRIMARY KEY,
  total_requests     INTEGER NOT NULL DEFAULT 0,
  success_count      INTEGER NOT NULL DEFAULT 0,
  failure_count      INTEGER NOT NULL DEFAULT 0,
  last_request_at    INTEGER,
  total_duration_ms  INTEGER NOT NULL DEFAULT 0,
  total_output_bytes INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS request_events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           TEXT NOT NULL,
  username          TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  app_mode          TEXT,
  provider          TEXT,
  api_mode          TEXT,
  model             TEXT,
  size              TEXT,
  quality           TEXT,
  n_images          INTEGER,
  has_input_image   INTEGER,
  input_image_count INTEGER,
  has_mask          INTEGER,
  prompt            TEXT,
  duration_ms       INTEGER,
  http_status       INTEGER,
  error_type        TEXT,
  error_message     TEXT,
  error_stack       TEXT,
  output_count      INTEGER,
  output_bytes      INTEGER,
  action_type       TEXT,
  task_id           TEXT,
  image_index       INTEGER,
  user_agent        TEXT,
  ip                TEXT,
  client_version    TEXT,
  created_at        INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_events_user_time ON request_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_type_time ON request_events(event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS public_images (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  prompt     TEXT NOT NULL,
  width      INTEGER,
  height     INTEGER,
  file_size  INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_public_created ON public_images(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_public_user ON public_images(user_id);

CREATE TABLE IF NOT EXISTS public_image_originals (
  id         TEXT PRIMARY KEY,
  image_id   TEXT NOT NULL,
  position   INTEGER NOT NULL,
  width      INTEGER,
  height     INTEGER,
  file_size  INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (image_id) REFERENCES public_images(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_public_originals_image ON public_image_originals(image_id);

CREATE TABLE IF NOT EXISTS team_config (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  settings_json TEXT NOT NULL,
  updated_at    INTEGER NOT NULL,
  updated_by    TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  type       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  metadata   TEXT,
  read_at    INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_time ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_invite_codes_created_by ON invite_codes(created_by);

-- async task model (Go rewrite, Phase 1): decouples request duration from connection
-- duration. status: queued|running|succeeded|failed|canceled.
CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  idempotency_key TEXT,
  type            TEXT NOT NULL,
  status          TEXT NOT NULL,
  endpoint        TEXT,
  request_json    TEXT,
  result_json     TEXT,
  error_type      TEXT,
  error_message   TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  started_at      INTEGER,
  finished_at     INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tasks_user_time ON tasks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_idem ON tasks(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
`, defaultMaxBatch)

	if _, err := d.Exec(schema); err != nil {
		return fmt.Errorf("apply schema: %w", err)
	}

	// Idempotent column migrations for pre-existing databases (mirrors ensureColumn in
	// server/index.ts). Harmless on freshly created tables (columns already present).
	migrations := []struct{ table, column, def string }{
		{"users", "is_admin", "is_admin INTEGER NOT NULL DEFAULT 0"},
		{"users", "display_name", "display_name TEXT"},
		{"users", "max_batch_images", fmt.Sprintf("max_batch_images INTEGER NOT NULL DEFAULT %d", defaultMaxBatch)},
		{"users", "last_login_at", "last_login_at INTEGER"},
		{"users", "avatar_updated_at", "avatar_updated_at INTEGER"},
		{"users", "public_storage_bytes", "public_storage_bytes INTEGER NOT NULL DEFAULT 0"},
		{"users", "disabled", "disabled INTEGER NOT NULL DEFAULT 0"},
		{"users", "token_version", "token_version INTEGER NOT NULL DEFAULT 0"},
		{"request_events", "action_type", "action_type TEXT"},
		{"request_events", "task_id", "task_id TEXT"},
		{"request_events", "image_index", "image_index INTEGER"},
		{"request_events", "app_mode", "app_mode TEXT"},
		{"public_images", "featured", "featured INTEGER NOT NULL DEFAULT 0"},
	}
	for _, m := range migrations {
		if err := d.ensureColumn(m.table, m.column, m.def); err != nil {
			return fmt.Errorf("ensure %s.%s: %w", m.table, m.column, err)
		}
	}
	if _, err := d.Exec("CREATE INDEX IF NOT EXISTS idx_events_app_mode_time ON request_events(app_mode, created_at DESC)"); err != nil {
		return fmt.Errorf("create idx_events_app_mode_time: %w", err)
	}
	return nil
}

// ensureColumn adds a column if it does not already exist. table/column/definition are
// code constants (never user input), so the formatted SQL is injection-safe.
func (d *DB) ensureColumn(table, column, definition string) error {
	rows, err := d.Query(fmt.Sprintf("PRAGMA table_info(%s)", table))
	if err != nil {
		return err
	}
	defer rows.Close()
	found := false
	for rows.Next() {
		var (
			cid, notnull, pk int
			name, ctype      string
			dflt             sql.NullString
		)
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			return err
		}
		if name == column {
			found = true
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if !found {
		if _, err := d.Exec(fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s", table, definition)); err != nil {
			return err
		}
	}
	return nil
}
