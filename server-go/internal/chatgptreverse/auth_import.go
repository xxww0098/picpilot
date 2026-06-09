package chatgptreverse

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const maxAuthImportFileBytes int64 = 2 << 20

type AuthDirSyncResult struct {
	Imported  int
	Updated   int
	Unchanged int
	Skipped   int
}

func SyncAuthAccountsFromDir(ctx context.Context, store *Store, dir string) (AuthDirSyncResult, error) {
	var result AuthDirSyncResult
	if store == nil || strings.TrimSpace(dir) == "" {
		return result, nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return result, nil
		}
		return result, err
	}
	existingRecords, err := store.ListAuthAccounts(ctx)
	if err != nil {
		return result, err
	}
	existing := make(map[string]StoredAuthAccount, len(existingRecords))
	for _, record := range existingRecords {
		existing[record.Name] = record
	}

	for _, entry := range entries {
		name := filepath.Base(entry.Name())
		if entry.IsDir() || strings.HasPrefix(name, ".") || !strings.HasSuffix(strings.ToLower(name), ".json") {
			result.Skipped++
			continue
		}
		path := filepath.Join(dir, name)
		raw, err := os.ReadFile(path)
		if err != nil || int64(len(raw)) > maxAuthImportFileBytes {
			result.Skipped++
			continue
		}
		account, ok := parseImportableAuthJSON(raw)
		if !ok {
			result.Skipped++
			continue
		}
		if prev, ok := existing[name]; ok && prev.RawJSON == string(raw) {
			result.Unchanged++
			continue
		}
		now := time.Now().UnixMilli()
		if err := store.SaveAuthAccount(ctx, StoredAuthAccount{
			Name:      name,
			Email:     account.Email,
			RawJSON:   string(raw),
			Disabled:  account.Disabled,
			Size:      int64(len(raw)),
			CreatedAt: now,
			UpdatedAt: now,
		}); err != nil {
			return result, err
		}
		if _, ok := existing[name]; ok {
			result.Updated++
		} else {
			result.Imported++
		}
	}
	return result, nil
}

type importableAuthJSON struct {
	Email    string
	Disabled bool
}

func parseImportableAuthJSON(raw []byte) (importableAuthJSON, bool) {
	var record map[string]any
	if err := json.Unmarshal(raw, &record); err != nil {
		return importableAuthJSON{}, false
	}
	if strings.TrimSpace(stringValue(record["access_token"], "")) == "" {
		return importableAuthJSON{}, false
	}
	accountType := strings.ToLower(strings.TrimSpace(stringValue(record["type"], "")))
	if accountType == "xai" {
		return importableAuthJSON{}, false
	}
	return importableAuthJSON{
		Email:    stringValue(record["email"], ""),
		Disabled: truthy(record["disabled"]),
	}, true
}
