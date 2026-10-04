package db

import (
	"cmp"
	"context"
	"crypto/sha256"
	_ "embed"
	"fmt"
	"log/slog"
	"slices"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/20260925000000_users.sql
var usersSQL string

//go:embed migrations/20261003143154_auth.sql
var authSQL string

type migration struct {
	version int64
	sql     string
}

var migrations = []migration{
	{version: 20260925000000, sql: usersSQL},
	{version: 20261003143154, sql: authSQL},
}

func migrate(ctx context.Context, pool *pgxpool.Pool, steps []migration) error {
	steps = slices.Clone(steps)
	slices.SortFunc(steps, func(a, b migration) int {
		return cmp.Compare(a.version, b.version)
	})
	checksums := make(map[int64]string, len(steps))
	for _, step := range steps {
		if _, err := time.Parse("20060102150405", strconv.FormatInt(step.version, 10)); err != nil {
			return fmt.Errorf("migration version %d must be a UTC YYYYMMDDHHMMSS timestamp", step.version)
		}
		if _, exists := checksums[step.version]; exists {
			return fmt.Errorf("migration version %d is registered more than once", step.version)
		}
		checksums[step.version] = fmt.Sprintf("%x", sha256.Sum256([]byte(step.sql)))
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return safeError("begin database migration", err)
	}
	defer func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanupCtx)
	}()

	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(1000101)"); err != nil {
		return safeError("lock database migration", err)
	}
	_, err = tx.Exec(ctx, `
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version bigint PRIMARY KEY,
            checksum text NOT NULL,
            applied_at timestamptz NOT NULL DEFAULT now()
        )
    `)
	if err != nil {
		return safeError("initialize migration versions", err)
	}

	rows, err := tx.Query(ctx, "SELECT version, checksum FROM schema_migrations ORDER BY version")
	if err != nil {
		return safeError("read migration versions", err)
	}
	applied := make(map[int64]bool)
	var unknown []int64
	for rows.Next() {
		var version int64
		var checksum string
		if err := rows.Scan(&version, &checksum); err != nil {
			rows.Close()
			return safeError("decode migration version", err)
		}
		expected, known := checksums[version]
		if known && checksum != expected {
			rows.Close()
			return fmt.Errorf("database migration version %d checksum mismatch", version)
		}
		if !known {
			unknown = append(unknown, version)
		}
		applied[version] = true
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return safeError("read migration versions", err)
	}

	appliedCount := 0
	for _, step := range steps {
		if applied[step.version] {
			continue
		}
		if _, err := tx.Exec(ctx, step.sql); err != nil {
			return safeError(fmt.Sprintf("apply database migration %d", step.version), err)
		}
		_, err := tx.Exec(ctx, "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
			step.version, checksums[step.version])
		if err != nil {
			return safeError("record migration version", err)
		}
		appliedCount++
	}
	if err := tx.Commit(ctx); err != nil {
		return safeError("commit database migrations", err)
	}
	if len(unknown) > 0 {
		slog.Warn("database contains migrations absent from this build; keeping existing schema", "versions", unknown)
	}
	slog.Info("database migrations ready", "known", len(steps), "applied", appliedCount, "unrecognized", len(unknown))
	return nil
}
