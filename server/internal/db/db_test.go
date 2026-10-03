package db

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func testDatabase(t *testing.T) (*pgxpool.Pool, Options) {
	t.Helper()
	uri := os.Getenv("XIAOWEI_TEST_DATABASE_URL")
	if uri == "" {
		t.Skip("set XIAOWEI_TEST_DATABASE_URL to run real PostgreSQL tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	admin, err := pgx.Connect(ctx, uri)
	if err != nil {
		t.Fatal(safeError("connect test database", err))
	}
	randomID, err := newPublicID()
	if err != nil {
		t.Fatal(err)
	}
	name := "xw_test_" + strings.ToLower(strings.ReplaceAll(randomID[2:], "-", "_"))
	quoted := pgx.Identifier{name}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+quoted); err != nil {
		_ = admin.Close(ctx)
		t.Fatal(err)
	}
	parsed, err := url.Parse(uri)
	if err != nil {
		t.Fatal("invalid test URI")
	}
	parsed.Path = "/" + name
	pool, err := pgxpool.New(ctx, parsed.String())
	if err != nil {
		t.Fatal("invalid isolated database URI")
	}
	t.Cleanup(func() {
		pool.Close()
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, err := admin.Exec(cleanupCtx, "DROP DATABASE "+quoted+" WITH (FORCE)")
		if err != nil {
			t.Errorf("cleanup isolated database: %v", err)
		}
		_ = admin.Close(cleanupCtx)
	})
	cfg := pool.Config().ConnConfig
	return pool, Options{
		Host: cfg.Host, Port: int(cfg.Port), Database: cfg.Database,
		User: cfg.User, Password: cfg.Password, SSLMode: "disable",
	}
}

func TestUsersPersistAndPublicIDs(t *testing.T) {
	pool, options := testDatabase(t)
	ctx := context.Background()
	store, err := Open(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	user, err := store.CreateUser(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if user.ID < 1 || len(user.PublicID) != 24 || user.CreatedAt.IsZero() {
		t.Fatal("invalid persisted user")
	}
	data, err := json.Marshal(user)
	if err != nil || strings.Contains(string(data), `"id":`) {
		t.Fatal("internal primary key leaked")
	}
	collisionCalls := 0
	second, err := store.createUser(ctx, func() (string, error) {
		collisionCalls++
		if collisionCalls == 1 {
			return user.PublicID, nil
		}
		return newPublicID()
	})
	if err != nil || second.ID == user.ID || collisionCalls != 2 {
		t.Fatalf("collision retry failed: %v", err)
	}
	if _, err := store.createUser(ctx, func() (string, error) { return user.PublicID, nil }); err == nil {
		t.Fatal("collision retry was unbounded")
	}
	if _, err := store.createUser(ctx, func() (string, error) { return "bad", nil }); err == nil {
		t.Fatal("format constraint did not reject malformed ID")
	}
	_, err = pool.Exec(ctx, "INSERT INTO users (user_id) VALUES ($1)", user.PublicID)
	if err == nil {
		t.Fatal("database accepted a duplicate public ID")
	}
	// Exact comparison is required: upper/lowercase IDs are different values.
	alternate := "u_" + strings.Repeat("A", 22)
	_, err = pool.Exec(ctx, "INSERT INTO users (user_id) VALUES ($1), ($2)", alternate, strings.ToLower(alternate))
	if err != nil {
		t.Fatal("public ID comparison is not case-sensitive")
	}
	if _, err := store.FindUserByPublicID(ctx, "missing"); !errors.Is(err, ErrUserNotFound) {
		t.Fatal("missing user not distinguished")
	}
	store.Close()
	reopened, err := Open(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	found, err := reopened.FindUserByPublicID(ctx, user.PublicID)
	if err != nil || found.ID != user.ID || !found.CreatedAt.Equal(user.CreatedAt) {
		t.Fatal("user did not survive reopening")
	}
}

func TestConcurrentMigrations(t *testing.T) {
	pool, _ := testDatabase(t)
	ctx := context.Background()
	var wg sync.WaitGroup
	failures := make(chan error, 4)
	for range 4 {
		wg.Go(func() { failures <- migrate(ctx, pool, migrations) })
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	var count int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM schema_migrations").Scan(&count); err != nil || count != 1 {
		t.Fatal("concurrent migration did not apply exactly once")
	}
}

func TestMigrationRollbackAndCompatibility(t *testing.T) {
	t.Run("rollback fresh initialization", func(t *testing.T) {
		pool, _ := testDatabase(t)
		ctx := context.Background()
		bad := append([]migration{}, migrations...)
		bad = append(bad, migration{version: 20261003100000, sql: "CREATE TABLE partial_change (id integer); INVALID SQL"})
		if err := migrate(ctx, pool, bad); err == nil {
			t.Fatal("broken migration succeeded")
		}
		var table *string
		err := pool.QueryRow(ctx, "SELECT to_regclass('public.users')::text").Scan(&table)
		if err != nil || table != nil {
			t.Fatal("failed initialization left partial tables")
		}
		if err := migrate(ctx, pool, migrations); err != nil {
			t.Fatal(err)
		}
		if err := migrate(ctx, pool, bad); err == nil {
			t.Fatal("broken upgrade succeeded")
		}
		var count int
		err = pool.QueryRow(ctx, "SELECT count(*) FROM schema_migrations").Scan(&count)
		if err != nil || count != 1 {
			t.Fatal("failed upgrade changed prior migration history")
		}
	})
	t.Run("known checksum mismatch", func(t *testing.T) {
		pool, options := testDatabase(t)
		store, err := Open(context.Background(), options)
		if err != nil {
			t.Fatal(err)
		}
		store.Close()
		if _, err := pool.Exec(context.Background(), "UPDATE schema_migrations SET checksum = 'changed'"); err != nil {
			t.Fatal(err)
		}
		if reopened, err := Open(context.Background(), options); err == nil {
			reopened.Close()
			t.Fatal("modified known migration accepted")
		}
	})
}

func TestOlderBranchRunsWithAdditionalTablesAndColumns(t *testing.T) {
	pool, options := testDatabase(t)
	ctx := context.Background()
	newBranch := append([]migration{}, migrations...)
	newBranch = append(newBranch,
		migration{version: 20261003100000, sql: "CREATE TABLE branch_sessions (id bigint PRIMARY KEY)"},
		migration{version: 20261003110000, sql: `
            ALTER TABLE users
                ADD COLUMN nickname text,
                ADD COLUMN preferred_theme text NOT NULL DEFAULT 'system'
        `},
	)
	if err := migrate(ctx, pool, newBranch); err != nil {
		t.Fatal(err)
	}

	oldBranch, err := Open(ctx, options)
	if err != nil {
		t.Fatalf("older branch could not start: %v", err)
	}
	defer oldBranch.Close()
	user, err := oldBranch.CreateUser(ctx)
	if err != nil {
		t.Fatalf("older branch could not insert with an additional column: %v", err)
	}
	found, err := oldBranch.FindUserByPublicID(ctx, user.PublicID)
	if err != nil || found.ID != user.ID {
		t.Fatalf("older branch could not read its user: %v", err)
	}
	var count int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM schema_migrations").Scan(&count); err != nil || count != 3 {
		t.Fatal("older branch modified migration history")
	}
	if _, err := pool.Exec(ctx, "INSERT INTO branch_sessions (id) VALUES (1)"); err != nil {
		t.Fatal("older branch removed the additional table")
	}
}

func TestMergeAppliesEarlierPendingMigration(t *testing.T) {
	pool, _ := testDatabase(t)
	ctx := context.Background()
	later := migration{version: 20261003110000, sql: "CREATE TABLE later_branch (id integer)"}
	branch := append([]migration{}, migrations...)
	branch = append(branch, later)
	if err := migrate(ctx, pool, branch); err != nil {
		t.Fatal(err)
	}

	earlier := migration{version: 20261003100000, sql: "CREATE TABLE earlier_branch (id integer)"}
	// The pending migration sorts before a version already present in this database.
	merged := append([]migration{later, earlier}, migrations...)
	if err := migrate(ctx, pool, merged); err != nil {
		t.Fatalf("earlier pending migration was rejected after merge: %v", err)
	}
	if merged[0].version != later.version {
		t.Fatal("migration execution changed the caller's list")
	}
	if err := migrate(ctx, pool, merged); err != nil {
		t.Fatalf("repeat migration failed: %v", err)
	}
	var count int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM schema_migrations").Scan(&count); err != nil || count != 3 {
		t.Fatal("merged migrations were not recorded exactly once")
	}
	for _, table := range []string{"earlier_branch", "later_branch"} {
		if _, err := pool.Exec(ctx, "INSERT INTO "+table+" (id) VALUES (1)"); err != nil {
			t.Fatalf("merged table is unavailable: %v", err)
		}
	}
}

func TestIncompatibleUnknownMigrationFailsAtRuntime(t *testing.T) {
	pool, options := testDatabase(t)
	ctx := context.Background()
	newBranch := append([]migration{}, migrations...)
	newBranch = append(newBranch, migration{version: 20261003100000, sql: "ALTER TABLE users DROP COLUMN created_at"})
	if err := migrate(ctx, pool, newBranch); err != nil {
		t.Fatal(err)
	}

	oldBranch, err := Open(ctx, options)
	if err != nil {
		t.Fatalf("unknown migration blocked startup: %v", err)
	}
	defer oldBranch.Close()
	if _, err := oldBranch.CreateUser(ctx); err == nil || !strings.Contains(err.Error(), "SQLSTATE 42703") {
		t.Fatalf("incompatible schema did not report its runtime SQL error: %v", err)
	}
}

func TestExplicitConnectionAndSafeErrors(t *testing.T) {
	t.Setenv("PGHOST", "ambient-host")
	t.Setenv("PGPASSWORD", "ambient-password")
	t.Setenv("PGSSLMODE", "require")
	cfg, err := connectionConfig(Options{
		Host: "db", Port: 5432, Database: "xiaowei", User: "user", Password: "secret", SSLMode: "disable",
	})
	if err != nil || cfg.ConnConfig.Host != "db" || cfg.ConnConfig.Password != "secret" ||
		cfg.ConnConfig.TLSConfig != nil || len(cfg.ConnConfig.Fallbacks) != 0 {
		t.Fatalf("explicit config was overridden: %v", err)
	}
	cfg, err = connectionConfig(Options{
		Host: "db", Port: 5432, Database: "xiaowei", User: "user", Password: "secret", SSLMode: "verify-full",
	})
	if err != nil || cfg.ConnConfig.TLSConfig == nil || cfg.ConnConfig.TLSConfig.InsecureSkipVerify {
		t.Fatal("verify-full did not verify certificates")
	}
	if strings.Contains(safeError("connect", errors.New("secret")).Error(), "secret") {
		t.Fatal("driver error leaked credentials")
	}
}
