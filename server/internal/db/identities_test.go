package db

import (
	"context"
	"errors"
	"testing"
)

func TestEmailIdentityConstraints(t *testing.T) {
	pool, options := testDatabase(t)
	ctx := context.Background()
	store, err := Open(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	first, err := store.CreateUser(ctx)
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.CreateUser(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.FindEmailIdentity(ctx, "a@example.com"); !errors.Is(err, ErrUserNotFound) {
		t.Fatal("missing identity was not distinguished")
	}
	if _, err := pool.Exec(ctx,
		"INSERT INTO email_identities (user_pk, email, password_hash) VALUES ($1, $2, $3)",
		first.ID, "a@example.com", "test-hash"); err != nil {
		t.Fatal(err)
	}
	identity, err := store.FindEmailIdentity(ctx, "a@example.com")
	if err != nil || identity.User.PublicID != first.PublicID || identity.PasswordHash != "test-hash" {
		t.Fatal("identity did not resolve its user")
	}
	for _, tc := range []struct {
		id    int64
		email string
	}{
		{second.ID, "a@example.com"}, {first.ID, "b@example.com"},
		{second.ID, "A@example.com"}, {second.ID, " a@example.com"}, {999999, "b@example.com"},
	} {
		if _, err := pool.Exec(ctx,
			"INSERT INTO email_identities (user_pk, email, password_hash) VALUES ($1, $2, $3)",
			tc.id, tc.email, "test-hash"); err == nil {
			t.Fatal("identity constraint accepted invalid data")
		}
	}
	if _, err := store.FindUserByPublicID(ctx, second.PublicID); err != nil {
		t.Fatal("user without email cannot be read")
	}
}
