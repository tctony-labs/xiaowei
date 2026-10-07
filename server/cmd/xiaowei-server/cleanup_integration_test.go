package main

import (
	"context"
	"crypto/sha256"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func TestStartupRunsAuthenticationCleanup(t *testing.T) {
	fixture := newAuthFixture(t)
	ctx := context.Background()
	var userID int64
	if err := fixture.pool.QueryRow(ctx, "SELECT id FROM users WHERE user_id = $1", fixture.userID).
		Scan(&userID); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	cases := []struct {
		deviceID      string
		sessionID     string
		revokedAt     any
		accessExpiry  time.Time
		refreshExpiry time.Time
	}{
		{
			"550e8400-e29b-41d4-a716-446655440000", "s_AAAAAAAAAAAAAAAAAAAAAA", now.AddDate(0, -7, 0),
			now.Add(-8 * 24 * time.Hour), now.Add(time.Hour),
		},
		{
			"550e8400-e29b-41d4-a716-446655440001", "s_BBBBBBBBBBBBBBBBBBBBBB", now.Add(-24 * time.Hour),
			now.Add(-24 * time.Hour), now.Add(time.Hour),
		},
		{
			"550e8400-e29b-41d4-a716-446655440002", "s_CCCCCCCCCCCCCCCCCCCCCC", nil,
			now.Add(time.Hour), now.Add(24 * time.Hour),
		},
	}
	for _, tc := range cases {
		_, err := fixture.pool.Exec(ctx, `
            INSERT INTO user_devices (user_pk, device_id, device_name, created_at, updated_at)
            VALUES ($1, $2, 'cleanup fixture', $3, $3)
        `, userID, tc.deviceID, now.AddDate(-1, 0, 0))
		if err != nil {
			t.Fatal(err)
		}
		refreshHash := sha256.Sum256([]byte("refresh:" + tc.sessionID))
		_, err = fixture.pool.Exec(ctx, `
            INSERT INTO auth_sessions
                (session_id, user_pk, device_id, refresh_token_hash, refresh_expires_at,
                 revoked_at, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
        `, tc.sessionID, userID, tc.deviceID, refreshHash[:], tc.refreshExpiry,
			tc.revokedAt, now.AddDate(-1, 0, 0))
		if err != nil {
			t.Fatal(err)
		}
		accessHash := sha256.Sum256([]byte("access:" + tc.sessionID))
		_, err = fixture.pool.Exec(ctx, `
            INSERT INTO session_access_tokens (token_hash, session_id, expires_at, created_at)
            VALUES ($1, $2, $3, $4)
        `, accessHash[:], tc.sessionID, tc.accessExpiry, now.AddDate(-1, 0, 0))
		if err != nil {
			t.Fatal(err)
		}
	}

	stop := startAuthServer(t, fixture)
	defer stop()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var devices, sessions, tokens int
		err := fixture.pool.QueryRow(ctx, `
            SELECT (SELECT count(*) FROM user_devices), (SELECT count(*) FROM auth_sessions),
                   (SELECT count(*) FROM session_access_tokens)
        `).Scan(&devices, &sessions, &tokens)
		if err != nil {
			t.Fatal(err)
		}
		if devices == 3 && sessions == 2 && tokens == 2 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("startup cleanup: devices=%d, sessions=%d, tokens=%d", devices, sessions, tokens)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestCleanupFailureDoesNotPreventHTTPStartup(t *testing.T) {
	fixture := newAuthFixture(t)
	_, err := fixture.pool.Exec(context.Background(), `
        CREATE FUNCTION reject_token_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'test cleanup failure';
        END
        $$;
        CREATE TRIGGER reject_token_cleanup BEFORE DELETE ON session_access_tokens
            FOR EACH STATEMENT EXECUTE FUNCTION reject_token_cleanup();
    `)
	if err != nil {
		t.Fatal(err)
	}
	logs := new(authLogs)
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })

	// This helper waits for readiness through the real HTTP listener.
	stop := startAuthServer(t, fixture)
	defer stop()
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(logs.String(), "scheduled task failed") {
		if time.Now().After(deadline) {
			t.Fatal("failed cleanup was not logged")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
