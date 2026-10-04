package db

import (
	"context"
	"strings"
	"testing"
)

func TestInvalidMigrationVersions(t *testing.T) {
	for _, tc := range []struct {
		name  string
		steps []migration
		want  string
	}{
		{"sequence number", []migration{{version: 1}}, "timestamp"},
		{"invalid date", []migration{{version: 20261301000000}}, "timestamp"},
		{"duplicate timestamp", []migration{{version: 20261003100000}, {version: 20261003100000}}, "more than once"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Invalid registrations must fail before touching the database.
			err := migrate(context.Background(), nil, tc.steps)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("unexpected migration validation error: %v", err)
			}
		})
	}
}

func TestCombinedAuthMigration(t *testing.T) {
	pool, _ := testDatabase(t)
	ctx := context.Background()
	if err := migrate(ctx, pool, migrations[:1]); err != nil {
		t.Fatal(err)
	}
	store := &Store{pool: pool}
	user, err := store.CreateUser(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := migrate(ctx, pool, migrations); err != nil {
			t.Fatal(err)
		}
	}
	var versionCount, tableCount int
	err = pool.QueryRow(ctx, "SELECT count(*) FROM schema_migrations").Scan(&versionCount)
	if err != nil || versionCount != 2 {
		t.Fatal("combined migration was not registered once")
	}
	if err := pool.QueryRow(ctx, `
        SELECT count(*) FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name IN ('email_identities', 'user_devices', 'auth_sessions', 'session_access_tokens')
    `).Scan(&tableCount); err != nil || tableCount != 4 {
		t.Fatal("combined migration did not create all authentication tables")
	}
	var publicID, deviceType string
	var nullable string
	err = pool.QueryRow(ctx, "SELECT user_id FROM users WHERE id = $1", user.ID).Scan(&publicID)
	if err != nil || publicID != user.PublicID {
		t.Fatal("migration changed existing users")
	}
	if err := pool.QueryRow(ctx, `
        SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'auth_sessions' AND column_name = 'device_id'
    `).Scan(&deviceType, &nullable); err != nil || deviceType != "uuid" || nullable != "NO" {
		t.Fatal("session device identity is not a required UUID")
	}
	var nameCount int
	if err := pool.QueryRow(ctx, `
        SELECT count(*) FROM information_schema.columns
        WHERE table_name = 'auth_sessions' AND column_name = 'device_name'
    `).Scan(&nameCount); err != nil || nameCount != 0 {
		t.Fatal("session retained a legacy device-name column")
	}
}
