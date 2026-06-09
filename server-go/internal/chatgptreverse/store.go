package chatgptreverse

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"

	"github.com/xxww0098/picpilot/server-go/internal/db"
)

type Store struct {
	db *db.DB
}

type StoredAuthAccount struct {
	Name              string
	Email             string
	UserID            string
	RawJSON           string
	Disabled          bool
	Status            string
	StatusReason      string
	HTTPStatus        *int
	AccountType       string
	Quota             *int
	ImageQuotaUnknown bool
	RestoreAt         string
	DefaultModelSlug  string
	LastCheckedAt     int64
	LastUsedAt        int64
	SuccessCount      int
	FailCount         int
	Size              int64
	CreatedAt         int64
	UpdatedAt         int64
}

type AuthAccountMetadata struct {
	Email             string
	UserID            string
	Status            string
	StatusReason      string
	HTTPStatus        *int
	AccountType       string
	Quota             *int
	ImageQuotaUnknown bool
	RestoreAt         string
	DefaultModelSlug  string
	CheckedAt         int64
}

func NewStore(d *db.DB) *Store {
	if d == nil {
		return nil
	}
	return &Store{db: d}
}

func (s *Store) ListAuthAccounts(ctx context.Context) ([]StoredAuthAccount, error) {
	if s == nil || s.db == nil {
		return []StoredAuthAccount{}, nil
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT name, email, user_id, raw_json, disabled, status, status_reason, http_status,
       account_type, quota, image_quota_unknown, restore_at, default_model_slug,
       last_checked_at, last_used_at, success_count, fail_count, size, created_at, updated_at
FROM reverse_auth_accounts
ORDER BY updated_at DESC, name ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []StoredAuthAccount{}
	for rows.Next() {
		rec, err := scanStoredAuthAccount(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	return out, rows.Err()
}

func (s *Store) GetAuthAccount(ctx context.Context, name string) (StoredAuthAccount, bool, error) {
	if s == nil || s.db == nil || name == "" {
		return StoredAuthAccount{}, false, nil
	}
	row := s.db.QueryRowContext(ctx, `
SELECT name, email, user_id, raw_json, disabled, status, status_reason, http_status,
       account_type, quota, image_quota_unknown, restore_at, default_model_slug,
       last_checked_at, last_used_at, success_count, fail_count, size, created_at, updated_at
FROM reverse_auth_accounts
WHERE name = ?`, name)
	rec, err := scanStoredAuthAccount(row)
	if err == sql.ErrNoRows {
		return StoredAuthAccount{}, false, nil
	}
	if err != nil {
		return StoredAuthAccount{}, false, err
	}
	return rec, true, nil
}

type authAccountScanner interface {
	Scan(dest ...any) error
}

func scanStoredAuthAccount(scanner authAccountScanner) (StoredAuthAccount, error) {
	var (
		rec          StoredAuthAccount
		email        sql.NullString
		userID       sql.NullString
		status       sql.NullString
		statusReason sql.NullString
		httpStatus   sql.NullInt64
		accountType  sql.NullString
		quota        sql.NullInt64
		restoreAt    sql.NullString
		modelSlug    sql.NullString
		checkedAt    sql.NullInt64
		lastUsedAt   sql.NullInt64
		disabled     int
		unknown      int
	)
	if err := scanner.Scan(
		&rec.Name, &email, &userID, &rec.RawJSON, &disabled, &status, &statusReason, &httpStatus,
		&accountType, &quota, &unknown, &restoreAt, &modelSlug,
		&checkedAt, &lastUsedAt, &rec.SuccessCount, &rec.FailCount, &rec.Size, &rec.CreatedAt, &rec.UpdatedAt,
	); err != nil {
		return StoredAuthAccount{}, err
	}
	if email.Valid {
		rec.Email = email.String
	}
	if userID.Valid {
		rec.UserID = userID.String
	}
	if status.Valid {
		rec.Status = status.String
	}
	if statusReason.Valid {
		rec.StatusReason = statusReason.String
	}
	if httpStatus.Valid {
		v := int(httpStatus.Int64)
		rec.HTTPStatus = &v
	}
	if accountType.Valid {
		rec.AccountType = accountType.String
	}
	if quota.Valid {
		v := int(quota.Int64)
		rec.Quota = &v
	}
	rec.Disabled = disabled != 0
	rec.ImageQuotaUnknown = unknown != 0
	if restoreAt.Valid {
		rec.RestoreAt = restoreAt.String
	}
	if modelSlug.Valid {
		rec.DefaultModelSlug = modelSlug.String
	}
	if checkedAt.Valid {
		rec.LastCheckedAt = checkedAt.Int64
	}
	if lastUsedAt.Valid {
		rec.LastUsedAt = lastUsedAt.Int64
	}
	return rec, nil
}

func (s *Store) CountActiveAuthAccounts(ctx context.Context) (int, error) {
	if s == nil || s.db == nil {
		return 0, nil
	}
	var count int
	err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM reverse_auth_accounts WHERE disabled = 0").Scan(&count)
	return count, err
}

func (s *Store) SaveAuthAccount(ctx context.Context, rec StoredAuthAccount) error {
	if s == nil || s.db == nil {
		return nil
	}
	now := time.Now().UnixMilli()
	if rec.CreatedAt == 0 {
		rec.CreatedAt = now
	}
	if rec.UpdatedAt == 0 {
		rec.UpdatedAt = now
	}
	if rec.Size == 0 {
		rec.Size = int64(len(rec.RawJSON))
	}
	disabled := 0
	if rec.Disabled {
		disabled = 1
	}
	_, err := s.db.ExecContext(ctx, `
INSERT INTO reverse_auth_accounts (name, email, raw_json, disabled, size, created_at, updated_at)
VALUES (?, NULLIF(?, ''), ?, ?, ?, ?, ?)
ON CONFLICT(name) DO UPDATE SET
  email = excluded.email,
  raw_json = excluded.raw_json,
  disabled = excluded.disabled,
  size = excluded.size,
  user_id = NULL,
  status = NULL,
  status_reason = NULL,
  http_status = NULL,
  account_type = NULL,
  quota = NULL,
  image_quota_unknown = 0,
  restore_at = NULL,
  default_model_slug = NULL,
  last_checked_at = NULL,
  last_used_at = NULL,
  success_count = 0,
  fail_count = 0,
  updated_at = excluded.updated_at`,
		rec.Name, rec.Email, rec.RawJSON, disabled, rec.Size, rec.CreatedAt, rec.UpdatedAt)
	return err
}

func (s *Store) UpdateAuthAccountMetadata(ctx context.Context, name string, meta AuthAccountMetadata) error {
	if s == nil || s.db == nil || name == "" {
		return nil
	}
	checkedAt := meta.CheckedAt
	if checkedAt == 0 {
		checkedAt = time.Now().UnixMilli()
	}
	var httpStatus any
	if meta.HTTPStatus != nil {
		httpStatus = *meta.HTTPStatus
	}
	var quota any
	if meta.Quota != nil {
		quota = *meta.Quota
	}
	unknown := 0
	if meta.ImageQuotaUnknown {
		unknown = 1
	}
	_, err := s.db.ExecContext(ctx, `
UPDATE reverse_auth_accounts
SET disabled = CASE WHEN ? = ? THEN 0 ELSE disabled END,
    email = COALESCE(NULLIF(?, ''), email),
    user_id = COALESCE(NULLIF(?, ''), user_id),
    status = NULLIF(?, ''),
    status_reason = NULLIF(?, ''),
    http_status = ?,
    account_type = COALESCE(NULLIF(?, ''), account_type),
    quota = ?,
    image_quota_unknown = ?,
    restore_at = NULLIF(?, ''),
    default_model_slug = COALESCE(NULLIF(?, ''), default_model_slug),
    last_checked_at = ?,
    updated_at = ?
WHERE name = ?`,
		meta.Status, AuthCheckStatusOK, meta.Email, meta.UserID, meta.Status, meta.StatusReason, httpStatus,
		meta.AccountType, quota, unknown, meta.RestoreAt, meta.DefaultModelSlug,
		checkedAt, time.Now().UnixMilli(), name)
	return err
}

func (s *Store) MarkAuthAccountSuccess(ctx context.Context, name string) error {
	if s == nil || s.db == nil || name == "" {
		return nil
	}
	now := time.Now().UnixMilli()
	_, err := s.db.ExecContext(ctx, `
UPDATE reverse_auth_accounts
SET disabled = 0,
    status = ?,
    status_reason = NULL,
    http_status = NULL,
    last_used_at = ?,
    success_count = success_count + 1,
    updated_at = ?
WHERE name = ?`,
		AuthCheckStatusOK, now, now, name)
	return err
}

func (s *Store) MarkAuthAccountFailure(ctx context.Context, name string, status string, reason string, httpStatus *int, disable bool) error {
	if s == nil || s.db == nil || name == "" {
		return nil
	}
	now := time.Now().UnixMilli()
	var statusValue any
	if status != "" {
		statusValue = status
	}
	var reasonValue any
	if reason != "" {
		reasonValue = reason
	}
	var httpStatusValue any
	if httpStatus != nil {
		httpStatusValue = *httpStatus
	}
	disabled := 0
	if disable {
		disabled = 1
	}
	_, err := s.db.ExecContext(ctx, `
UPDATE reverse_auth_accounts
SET disabled = CASE WHEN ? = 1 THEN 1 ELSE disabled END,
    status = COALESCE(?, status),
    status_reason = COALESCE(?, status_reason),
    http_status = COALESCE(?, http_status),
    last_checked_at = ?,
    fail_count = fail_count + 1,
    updated_at = ?
WHERE name = ?`,
		disabled, statusValue, reasonValue, httpStatusValue, now, now, name)
	return err
}

func (s *Store) DeleteAuthAccount(ctx context.Context, name string) (bool, error) {
	if s == nil || s.db == nil {
		return false, nil
	}
	res, err := s.db.ExecContext(ctx, "DELETE FROM reverse_auth_accounts WHERE name = ?", name)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

func (s *Store) DeleteAuthAccounts(ctx context.Context, names []string) ([]string, []string, error) {
	if s == nil || s.db == nil {
		return []string{}, names, nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, nil, err
	}
	defer tx.Rollback()

	deleted := []string{}
	missing := []string{}
	for _, name := range names {
		res, err := tx.ExecContext(ctx, "DELETE FROM reverse_auth_accounts WHERE name = ?", name)
		if err != nil {
			return nil, nil, err
		}
		n, err := res.RowsAffected()
		if err != nil {
			return nil, nil, err
		}
		if n == 0 {
			missing = append(missing, name)
		} else {
			deleted = append(deleted, name)
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, nil, err
	}
	return deleted, missing, nil
}

func (s *Store) UpdateAuthAccountJSON(ctx context.Context, name string, raw map[string]any) error {
	if s == nil || s.db == nil || name == "" {
		return nil
	}
	payload, err := json.Marshal(raw)
	if err != nil {
		return err
	}
	email := stringValue(raw["email"], "")
	disabled := 0
	if truthy(raw["disabled"]) {
		disabled = 1
	}
	_, err = s.db.ExecContext(ctx, `
UPDATE reverse_auth_accounts
SET email = NULLIF(?, ''), raw_json = ?, disabled = ?, size = ?, updated_at = ?
WHERE name = ?`,
		email, string(payload), disabled, len(payload), time.Now().UnixMilli(), name)
	return err
}
