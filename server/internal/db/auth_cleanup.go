package db

import (
	"context"
	"time"
)

type AuthCleanupResult struct {
	Sessions     int64
	AccessTokens int64
}

// CleanupAuthRecords preserves devices and valid credentials. Session retention starts
// at the earlier of revocation and refresh expiry; access retention starts at expiry.
func (s *Store) CleanupAuthRecords(ctx context.Context, now time.Time) (AuthCleanupResult, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AuthCleanupResult{}, safeError("begin authentication cleanup", err)
	}
	defer rollbackSession(tx)

	var result AuthCleanupResult
	deleted, err := tx.Exec(ctx, `
        DELETE FROM session_access_tokens
        WHERE expires_at <= $1::timestamptz - INTERVAL '168 hours'
    `, now.UTC())
	if err != nil {
		return AuthCleanupResult{}, safeError("clean expired access tokens", err)
	}
	result.AccessTokens = deleted.RowsAffected()

	// Subtract calendar months in UTC, including month-end clamping in PostgreSQL.
	deleted, err = tx.Exec(ctx, `
        DELETE FROM auth_sessions
        WHERE LEAST(revoked_at, refresh_expires_at) <=
            (($1::timestamptz AT TIME ZONE 'UTC') - INTERVAL '6 months') AT TIME ZONE 'UTC'
    `, now.UTC())
	if err != nil {
		return AuthCleanupResult{}, safeError("clean expired authentication sessions", err)
	}
	result.Sessions = deleted.RowsAffected()

	if err := tx.Commit(ctx); err != nil {
		return AuthCleanupResult{}, safeError("commit authentication cleanup", err)
	}
	return result, nil
}
