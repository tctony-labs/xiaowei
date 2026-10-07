package db

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
)

func TestAdminInitializationConcurrentAndDurable(t *testing.T) {
	pool, options := testDatabase(t)
	ctx := context.Background()
	store, err := Open(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	var created atomic.Int32
	failures := make(chan error, 8)
	var workers sync.WaitGroup
	for i := range 8 {
		workers.Go(func() {
			_, didCreate, err := store.InitializeAdmin(ctx, fmt.Sprintf("admin%d@example.com", i), "test-hash")
			if didCreate {
				created.Add(1)
			}
			failures <- err
		})
	}
	workers.Wait()
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	if created.Load() != 1 {
		t.Fatal("concurrent startup created multiple administrators")
	}
	var users, identities, markers int
	err = pool.QueryRow(ctx, `
  SELECT (SELECT count(*) FROM users WHERE role = 'admin'),
         (SELECT count(*) FROM email_identities), (SELECT count(*) FROM admin_bootstrap)
 `).Scan(&users, &identities, &markers)
	if err != nil || users != 1 || identities != 1 || markers != 1 {
		t.Fatal("partial administrator initialization")
	}

	// Persistent initialization, rather than the current role, controls whether bootstrap can run.
	if _, err := pool.Exec(ctx, "UPDATE users SET role = 'user'"); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	initialized, err := reopened.AdminInitialized(ctx)
	if err != nil || !initialized {
		t.Fatal("initialization did not persist")
	}
	if _, didCreate, err := reopened.InitializeAdmin(ctx, "new@example.com", "changed-hash"); err != nil || didCreate {
		t.Fatal("reopening or demoting retriggered initialization")
	}
	var hash string
	err = pool.QueryRow(ctx, "SELECT password_hash FROM email_identities").Scan(&hash)
	if err != nil || hash != "test-hash" {
		t.Fatal("repeated initialization changed password")
	}
}

func TestAdminInitializationConflictRollback(t *testing.T) {
	pool, options := testDatabase(t)
	ctx := context.Background()
	store, err := Open(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	user, err := store.CreateUser(ctx)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, "INSERT INTO email_identities (user_pk, email, password_hash) VALUES ($1, $2, $3)",
		user.ID, "existing@example.com", "original-hash")
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = store.InitializeAdmin(ctx, "existing@example.com", "changed-hash")
	if !errors.Is(err, ErrAdminEmailExists) {
		t.Fatal("existing account was not rejected")
	}
	var role, hash string
	err = pool.QueryRow(ctx, `
  SELECT role, password_hash FROM users JOIN email_identities ON users.id = user_pk WHERE users.id = $1
 `, user.ID).Scan(&role, &hash)
	if err != nil || role != "user" || hash != "original-hash" {
		t.Fatal("existing account was changed")
	}
	var count int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM users").Scan(&count); err != nil || count != 1 {
		t.Fatal("failed initialization left a user")
	}
	initialized, err := store.AdminInitialized(ctx)
	if err != nil || initialized {
		t.Fatal("failed initialization consumed bootstrap")
	}

	// A failure at the final write must also roll back the user and its password identity.
	_, err = pool.Exec(ctx, "ALTER TABLE admin_bootstrap ADD CONSTRAINT reject_bootstrap CHECK (false)")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.InitializeAdmin(ctx, "admin@example.com", "test-hash"); err == nil {
		t.Fatal("forced initialization failure succeeded")
	}
	var identities int
	err = pool.QueryRow(ctx, "SELECT (SELECT count(*) FROM users), (SELECT count(*) FROM email_identities)").
		Scan(&count, &identities)
	if err != nil || count != 1 || identities != 1 {
		t.Fatal("final-write failure left partial state")
	}
	if _, err := pool.Exec(ctx, "ALTER TABLE admin_bootstrap DROP CONSTRAINT reject_bootstrap"); err != nil {
		t.Fatal(err)
	}
	if _, didCreate, err := store.InitializeAdmin(ctx, "admin@example.com", "test-hash"); err != nil || !didCreate {
		t.Fatal("initialization could not retry after rollback")
	}
	if _, err := pool.Exec(ctx, "UPDATE users SET role = 'invalid'"); err == nil {
		t.Fatal("invalid role accepted")
	}
}
