package db

import (
	"path/filepath"
	"testing"
	"time"
)

// seedUser inserts a minimal user row so foreign-key references resolve.
func seedUser(t *testing.T, d *DB, id string) {
	t.Helper()
	if _, err := d.Exec(
		`INSERT INTO users (id, username, password_hash, created_at) VALUES (?,?,?,?)`,
		id, "user_"+id, "x", time.Now().UnixMilli(),
	); err != nil {
		t.Fatalf("seed user %s: %v", id, err)
	}
}

func TestOpenCreatesSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "t.db")
	d, err := Open(path, 10)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	want := []string{
		"users", "invite_codes", "invite_redemptions", "user_stats",
		"request_events", "public_images", "public_image_originals",
		"team_config", "notifications", "tasks",
	}
	for _, tbl := range want {
		var name string
		err := d.QueryRow("SELECT name FROM sqlite_master WHERE type='table' AND name=?", tbl).Scan(&name)
		if err != nil {
			t.Fatalf("expected table %q to exist: %v", tbl, err)
		}
	}
	_ = d.Close()

	// Re-open must be idempotent (CREATE TABLE IF NOT EXISTS + ensureColumn).
	d2, err := Open(path, 10)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer d2.Close()
}

func TestFeaturedColumnPresent(t *testing.T) {
	d, err := Open(filepath.Join(t.TempDir(), "t.db"), 10)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	seedUser(t, d, "u1")

	var n int
	// Inserting with the featured column proves the migration applied.
	if _, err := d.Exec(
		`INSERT INTO public_images (id, user_id, prompt, created_at, featured) VALUES (?,?,?,?,1)`,
		"img1", "u1", "p", time.Now().UnixMilli(),
	); err != nil {
		t.Fatalf("insert with featured failed: %v", err)
	}
	if err := d.QueryRow(`SELECT featured FROM public_images WHERE id='img1'`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("featured=%d err=%v", n, err)
	}
}

func TestTaskIdempotencyUnique(t *testing.T) {
	d, err := Open(filepath.Join(t.TempDir(), "t.db"), 10)
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	seedUser(t, d, "u1")

	now := time.Now().UnixMilli()
	insKey := func(id, key string) error {
		_, err := d.Exec(
			`INSERT INTO tasks (id, user_id, idempotency_key, type, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
			id, "u1", key, "image", "queued", now, now,
		)
		return err
	}
	insNull := func(id string) error {
		_, err := d.Exec(
			`INSERT INTO tasks (id, user_id, type, status, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
			id, "u1", "image", "queued", now, now,
		)
		return err
	}

	if err := insKey("t1", "key-A"); err != nil {
		t.Fatalf("first insert: %v", err)
	}
	if err := insKey("t2", "key-A"); err == nil {
		t.Fatal("expected unique-constraint violation on duplicate idempotency_key for same user")
	}
	// NULL idempotency keys are exempt from the partial unique index: multiple allowed.
	if err := insNull("t4"); err != nil {
		t.Fatalf("first null-key insert: %v", err)
	}
	if err := insNull("t5"); err != nil {
		t.Fatalf("second null-key insert should be allowed: %v", err)
	}
}
