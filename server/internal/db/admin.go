package db

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

var ErrAdminEmailExists = errors.New("administrator initialization email is already registered")

func (s *Store) AdminInitialized(ctx context.Context) (bool, error) {
	var initialized bool
	err := s.pool.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM admin_bootstrap)").Scan(&initialized)
	if err != nil {
		return false, safeError("check administrator initialization", err)
	}
	return initialized, nil
}

func (s *Store) InitializeAdmin(ctx context.Context, email, passwordHash string) (User, bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return User{}, false, safeError("begin administrator initialization", err)
	}
	defer rollbackSession(tx)

	// Serialize initializers across processes; migration locking uses a different key.
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(1000102)"); err != nil {
		return User{}, false, safeError("lock administrator initialization", err)
	}
	var initialized bool
	err = tx.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM admin_bootstrap)").Scan(&initialized)
	if err != nil {
		return User{}, false, safeError("check administrator initialization", err)
	}
	if initialized {
		return User{}, false, nil
	}

	var user User
	for attempt := 0; attempt < 3; attempt++ {
		publicID, err := newPublicID()
		if err != nil {
			return User{}, false, err
		}
		err = tx.QueryRow(ctx, `
            INSERT INTO users (user_id, role) VALUES ($1, 'admin')
            ON CONFLICT ON CONSTRAINT users_public_id_unique DO NOTHING
            RETURNING id, user_id, created_at
        `, publicID).Scan(&user.ID, &user.PublicID, &user.CreatedAt)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return User{}, false, safeError("create administrator user", err)
		}
		break
	}
	if user.ID == 0 {
		return User{}, false, errors.New("public user ID collision limit exceeded")
	}

	_, err = tx.Exec(ctx, `
        INSERT INTO email_identities (user_pk, email, password_hash) VALUES ($1, $2, $3)
    `, user.ID, email, passwordHash)
	if err != nil {
		var postgresError *pgconn.PgError
		if errors.As(err, &postgresError) && postgresError.Code == "23505" &&
			postgresError.ConstraintName == "email_identities_email_key" {
			return User{}, false, ErrAdminEmailExists
		}
		return User{}, false, safeError("create administrator email identity", err)
	}
	if _, err := tx.Exec(ctx, "INSERT INTO admin_bootstrap (user_pk) VALUES ($1)", user.ID); err != nil {
		return User{}, false, safeError("record administrator initialization", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return User{}, false, safeError("commit administrator initialization", err)
	}
	return user, true, nil
}
