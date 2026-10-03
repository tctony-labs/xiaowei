package db

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

var ErrUserNotFound = errors.New("user not found")

type User struct {
	ID        int64     `json:"-"`
	PublicID  string    `json:"user_id"`
	CreatedAt time.Time `json:"created_at"`
}

func newPublicID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", errors.New("generate public user ID failed")
	}
	return "u_" + base64.RawURLEncoding.EncodeToString(value[:]), nil
}

func (s *Store) CreateUser(ctx context.Context) (User, error) {
	return s.createUser(ctx, newPublicID)
}

func (s *Store) createUser(ctx context.Context, generateID func() (string, error)) (User, error) {
	for attempt := 0; attempt < 3; attempt++ {
		publicID, err := generateID()
		if err != nil {
			return User{}, err
		}
		var user User
		err = s.pool.QueryRow(ctx, `
            INSERT INTO users (user_id) VALUES ($1)
            RETURNING id, user_id, created_at
        `, publicID).Scan(&user.ID, &user.PublicID, &user.CreatedAt)
		if err == nil {
			return user, nil
		}
		var postgresError *pgconn.PgError
		if errors.As(err, &postgresError) && postgresError.Code == "23505" &&
			postgresError.ConstraintName == "users_public_id_unique" {
			continue
		}
		return User{}, safeError("create user", err)
	}
	return User{}, errors.New("public user ID collision limit exceeded")
}

func (s *Store) FindUserByPublicID(ctx context.Context, publicID string) (User, error) {
	var user User
	err := s.pool.QueryRow(ctx, `
        SELECT id, user_id, created_at FROM users WHERE user_id = $1
    `, publicID).Scan(&user.ID, &user.PublicID, &user.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrUserNotFound
	}
	if err != nil {
		return User{}, safeError("find user", err)
	}
	return user, nil
}
