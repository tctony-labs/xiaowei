package db

import (
	"context"
	"testing"
	"time"
)

func TestAuthCleanupRetentionBoundaries(t *testing.T) {
	pool, options := testDatabase(t)
	ctx := context.Background()
	store, err := Open(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	user := createSessionIdentity(t, store)

	// October 31 minus six calendar months is April 30, not May 1.
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	sessionCutoff := time.Date(2026, 4, 30, 12, 0, 0, 0, time.UTC)
	tokenCutoff := now.Add(-7 * 24 * time.Hour)

	cases := []struct {
		name          string
		refreshExpiry time.Time
		revokedAt     time.Time
		accessExpiry  time.Time
		keepSession   bool
		keepAccess    bool
	}{
		{"active", now.Add(time.Hour), time.Time{}, now.Add(time.Hour), true, true},
		{"revoked boundary", now.Add(time.Hour), sessionCutoff, now.Add(-time.Hour), false, false},
		{"revoked recent", now.Add(time.Hour), sessionCutoff.Add(time.Second), now.Add(-time.Hour), true, true},
		{"expired boundary", sessionCutoff, time.Time{}, now.Add(-time.Hour), false, false},
		{"expired recent", sessionCutoff.Add(time.Second), time.Time{}, now.Add(-time.Hour), true, true},
		{"expired before revocation", sessionCutoff, now.Add(-time.Hour), now.Add(-time.Hour), false, false},
		{"token boundary", now.Add(time.Hour), time.Time{}, tokenCutoff, true, false},
		{"token recent", now.Add(time.Hour), time.Time{}, tokenCutoff.Add(time.Second), true, true},
	}
	ids := make([]string, len(cases))
	var activeTokens SessionTokens
	for i, tc := range cases {
		id := testSessionID(t)
		ids[i] = id
		tokens := testSessionTokens(tc.name, now.AddDate(-1, 0, 0))
		tokens.RefreshExpiresAt = tc.refreshExpiry
		tokens.AccessExpiresAt = tc.accessExpiry
		if err := store.CreateSession(ctx, user.ID, id, Device{ID: testDeviceID()}, tokens,
			now.AddDate(-1, 0, 0)); err != nil {
			t.Fatal(err)
		}
		if !tc.revokedAt.IsZero() {
			if err := store.RevokeSession(ctx, id, tc.revokedAt); err != nil {
				t.Fatal(err)
			}
		}
		if tc.name == "active" {
			activeTokens = tokens
		}
	}

	recentlyExpired := testSessionTokens("active expired access", now)
	_, err = pool.Exec(ctx, `
        INSERT INTO session_access_tokens (token_hash, session_id, expires_at, created_at)
        VALUES ($1, $2, $3, $4)
    `, recentlyExpired.AccessHash, ids[0], now.Add(-time.Hour), now.Add(-3*time.Hour))
	if err != nil {
		t.Fatal(err)
	}

	result, err := store.CleanupAuthRecords(ctx, now)
	if err != nil || result != (AuthCleanupResult{Sessions: 3, AccessTokens: 1}) {
		t.Fatalf("cleanup = %+v, error = %v", result, err)
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var sessionExists, accessExists bool
			err := pool.QueryRow(ctx, `
                SELECT EXISTS (SELECT 1 FROM auth_sessions WHERE session_id = $1),
                       EXISTS (SELECT 1 FROM session_access_tokens WHERE session_id = $1)
            `, ids[i]).Scan(&sessionExists, &accessExists)
			if err != nil || sessionExists != tc.keepSession || accessExists != tc.keepAccess {
				t.Fatalf("session = %v, access = %v, error = %v", sessionExists, accessExists, err)
			}
		})
	}
	var devices int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM user_devices").Scan(&devices); err != nil ||
		devices != len(cases) {
		t.Fatal("cleanup deleted devices")
	}
	if _, err := store.FindSessionByAccessHash(ctx, activeTokens.AccessHash, now); err != nil {
		t.Fatal("cleanup invalidated a valid access token")
	}
	rotated := testSessionTokens("rotated", now)
	if _, err := store.RotateSession(ctx, activeTokens.RefreshHash, rotated, now); err != nil {
		t.Fatal("cleanup invalidated a valid refresh token")
	}
	var retained bool
	if err := pool.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM session_access_tokens WHERE token_hash = $1)",
		recentlyExpired.AccessHash).Scan(&retained); err != nil || !retained {
		t.Fatal("refresh deleted an access token before its seven-day retention elapsed")
	}
	if result, err := store.CleanupAuthRecords(ctx, now); err != nil || result != (AuthCleanupResult{}) {
		t.Fatal("repeated cleanup was not idempotent")
	}
}

func TestAuthCleanupFailureRollsBackTokenDeletion(t *testing.T) {
	pool, options := testDatabase(t)
	ctx := context.Background()
	store, err := Open(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	user := createSessionIdentity(t, store)
	now := time.Now().UTC()
	created := now.AddDate(-1, 0, 0)
	id := testSessionID(t)
	if err := store.CreateSession(ctx, user.ID, id, Device{ID: testDeviceID()},
		testSessionTokens("rollback", created), created); err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `
        CREATE FUNCTION reject_session_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'test cleanup failure';
        END
        $$;
        CREATE TRIGGER reject_session_cleanup BEFORE DELETE ON auth_sessions
            FOR EACH ROW EXECUTE FUNCTION reject_session_cleanup();
    `)
	if err != nil {
		t.Fatal(err)
	}
	if result, err := store.CleanupAuthRecords(ctx, now); err == nil || result != (AuthCleanupResult{}) {
		t.Fatal("failed cleanup did not return an error with zero committed deletions")
	}
	var sessions, tokens int
	err = pool.QueryRow(ctx, `
        SELECT (SELECT count(*) FROM auth_sessions), (SELECT count(*) FROM session_access_tokens)
    `).Scan(&sessions, &tokens)
	if err != nil || sessions != 1 || tokens != 1 {
		t.Fatal("failed cleanup left partial deletions")
	}
}
