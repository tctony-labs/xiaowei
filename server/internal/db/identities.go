package db

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

type EmailIdentity struct {
	User         User
	Email        string
	PasswordHash string `json:"-"`
}

func (s *Store) FindEmailIdentity(ctx context.Context, email string) (EmailIdentity, error) {
	var identity EmailIdentity
	err := s.pool.QueryRow(ctx, `
        SELECT u.id, u.user_id, u.created_at, e.email, e.password_hash
        FROM email_identities e JOIN users u ON u.id = e.user_pk
        WHERE e.email = $1
    `, email).Scan(&identity.User.ID, &identity.User.PublicID, &identity.User.CreatedAt,
		&identity.Email, &identity.PasswordHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return EmailIdentity{}, ErrUserNotFound
	}
	if err != nil {
		return EmailIdentity{}, safeError("find email identity", err)
	}
	return identity, nil
}
