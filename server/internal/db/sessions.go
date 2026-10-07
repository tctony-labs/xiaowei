package db

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
)

var ErrInvalidSession = errors.New("invalid session")

type SessionTokens struct {
	AccessHash       []byte
	RefreshHash      []byte
	AccessExpiresAt  time.Time
	RefreshExpiresAt time.Time
}

type Device struct {
	ID   string
	Name string
}

type SessionUser struct {
	User      User
	Email     string
	SessionID string
	Device    Device
}

func rollbackSession(tx pgx.Tx) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = tx.Rollback(ctx)
}

func (s *Store) CreateSession(
	ctx context.Context, userID int64, sessionID string, device Device, tokens SessionTokens, now time.Time,
) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return safeError("begin session creation", err)
	}
	defer rollbackSession(tx)

	// The device row serializes concurrent logins before replacing the active session.
	_, err = tx.Exec(ctx, `
        INSERT INTO user_devices (user_pk, device_id, device_name, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $4)
        ON CONFLICT (user_pk, device_id)
        DO UPDATE SET device_name = EXCLUDED.device_name, updated_at = EXCLUDED.updated_at
    `, userID, device.ID, device.Name, now)
	if err != nil {
		return safeError("register login device", err)
	}
	replaced, err := tx.Exec(ctx, `
        UPDATE auth_sessions SET revoked_at = $3, updated_at = $3
        WHERE user_pk = $1 AND device_id = $2 AND revoked_at IS NULL
    `, userID, device.ID, now)
	if err != nil {
		return safeError("replace device session", err)
	}

	_, err = tx.Exec(ctx, `
        INSERT INTO auth_sessions
            (session_id, user_pk, device_id, refresh_token_hash, refresh_expires_at, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $6)
    `, sessionID, userID, device.ID, tokens.RefreshHash, tokens.RefreshExpiresAt, now)
	if err != nil {
		return safeError("create session", err)
	}
	if err := insertAccessToken(ctx, tx, sessionID, tokens, now); err != nil {
		return err
	}
	if err := commitSession(ctx, tx); err != nil {
		return err
	}
	if replaced.RowsAffected() > 0 {
		slog.Info("device session replaced", "device_id", device.ID, "session_id", sessionID)
	}
	return nil
}

func insertAccessToken(
	ctx context.Context, tx pgx.Tx, sessionID string, tokens SessionTokens, now time.Time,
) error {
	_, err := tx.Exec(ctx, `
        INSERT INTO session_access_tokens (token_hash, session_id, expires_at, created_at)
        VALUES ($1, $2, $3, $4)
    `, tokens.AccessHash, sessionID, tokens.AccessExpiresAt, now)
	if err != nil {
		return safeError("create access token", err)
	}
	return nil
}

func commitSession(ctx context.Context, tx pgx.Tx) error {
	if err := tx.Commit(ctx); err != nil {
		return safeError("commit session transaction", err)
	}
	return nil
}

func (s *Store) FindSessionByAccessHash(ctx context.Context, hash []byte, now time.Time) (SessionUser, error) {
	var result SessionUser
	err := s.pool.QueryRow(ctx, `
        SELECT u.id, u.user_id, u.created_at, e.email, s.session_id, d.device_id, d.device_name
        FROM session_access_tokens a
        JOIN auth_sessions s ON s.session_id = a.session_id
        JOIN user_devices d ON d.user_pk = s.user_pk AND d.device_id = s.device_id
        JOIN users u ON u.id = s.user_pk
        JOIN email_identities e ON e.user_pk = u.id
        WHERE a.token_hash = $1 AND a.expires_at > $2 AND s.revoked_at IS NULL
    `, hash, now).Scan(&result.User.ID, &result.User.PublicID, &result.User.CreatedAt,
		&result.Email, &result.SessionID, &result.Device.ID, &result.Device.Name)
	if errors.Is(err, pgx.ErrNoRows) {
		return SessionUser{}, ErrInvalidSession
	}
	if err != nil {
		return SessionUser{}, safeError("authenticate session", err)
	}
	return result, nil
}

func (s *Store) RotateSession(
	ctx context.Context, oldHash []byte, tokens SessionTokens, now time.Time,
) (string, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", safeError("begin session refresh", err)
	}
	defer rollbackSession(tx)

	// UPDATE locks the row and rechecks the old hash after concurrent writers finish.
	var sessionID string
	err = tx.QueryRow(ctx, `
        UPDATE auth_sessions SET refresh_token_hash = $2, refresh_expires_at = $3, updated_at = $4
        WHERE refresh_token_hash = $1 AND refresh_expires_at > $4 AND revoked_at IS NULL
        RETURNING session_id
    `, oldHash, tokens.RefreshHash, tokens.RefreshExpiresAt, now).Scan(&sessionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrInvalidSession
	}
	if err != nil {
		return "", safeError("rotate refresh token", err)
	}

	if err := insertAccessToken(ctx, tx, sessionID, tokens, now); err != nil {
		return "", err
	}
	if err := commitSession(ctx, tx); err != nil {
		return "", err
	}
	return sessionID, nil
}

func (s *Store) RevokeSession(ctx context.Context, sessionID string, now time.Time) error {
	result, err := s.pool.Exec(ctx, `
        UPDATE auth_sessions SET revoked_at = $2, updated_at = $2
        WHERE session_id = $1 AND revoked_at IS NULL
    `, sessionID, now)
	if err != nil {
		return safeError("revoke session", err)
	}
	if result.RowsAffected() == 0 {
		return ErrInvalidSession
	}
	return nil
}
