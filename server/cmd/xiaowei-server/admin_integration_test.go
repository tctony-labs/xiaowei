package main

import (
	"context"
	"log/slog"
	"strings"
	"testing"

	pb "github.com/tctony-labs/xiaowei/contracts/go/gen/xiaowei/server"
)

func TestBootstrapAdminHTTPAndRestart(t *testing.T) {
	fixture := newAuthFixture(t)
	ctx := context.Background()
	// Start from an empty user database while reusing the isolated HTTP fixture's configuration.
	if _, err := fixture.pool.Exec(ctx, "DELETE FROM email_identities; DELETE FROM users"); err != nil {
		t.Fatal(err)
	}
	logs := new(authLogs)
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	password := "  p$ss#word  "
	t.Setenv("XIAOWEI_BOOTSTRAP_ADMIN_EMAIL", " Admin@Example.com ")
	t.Setenv("XIAOWEI_BOOTSTRAP_ADMIN_PASSWORD", password)
	stop := startAuthServer(t, fixture)

	var role, hash string
	err := fixture.pool.QueryRow(ctx, `
  SELECT u.role, e.password_hash FROM users u JOIN email_identities e ON e.user_pk = u.id
  WHERE e.email = 'admin@example.com'
 `).Scan(&role, &hash)
	if err != nil || role != "admin" || !strings.HasPrefix(hash, "$argon2id$") || hash == password {
		t.Fatal("administrator role or password storage is invalid")
	}
	login := new(pb.LoginResponse)
	requireAuthResponse(t, requestAuth(fixture.address, "POST", "/api/auth/login", "",
		passwordRequest("admin@example.com", password, testDeviceID(t))), 200, 0, login)
	authenticated := login.Data.GetAuthenticated()
	if authenticated == nil || authenticated.User.Email != "admin@example.com" {
		t.Fatal("initialized administrator cannot log in as a regular user")
	}
	stop()

	// Changed initialization settings must not create a second account or replace the original password.
	t.Setenv("XIAOWEI_BOOTSTRAP_ADMIN_EMAIL", "other@example.com")
	t.Setenv("XIAOWEI_BOOTSTRAP_ADMIN_PASSWORD", "changed-password")
	stop = startAuthServer(t, fixture)
	var count int
	if err := fixture.pool.QueryRow(ctx, "SELECT count(*) FROM users").Scan(&count); err != nil || count != 1 {
		t.Fatal("restart created a second account")
	}
	var storedHash string
	err = fixture.pool.QueryRow(ctx, "SELECT password_hash FROM email_identities").Scan(&storedHash)
	if err != nil || storedHash != hash {
		t.Fatal("restart replaced the initial password")
	}
	requireAuthResponse(t, requestAuth(fixture.address, "GET", "/api/auth/me", authenticated.Tokens.AccessToken, nil),
		200, 0, nil)
	requireAuthResponse(t, requestAuth(fixture.address, "POST", "/api/auth/login", "",
		passwordRequest("admin@example.com", "changed-password", testDeviceID(t))), 200, 10100, nil)
	stop()

	t.Setenv("XIAOWEI_BOOTSTRAP_ADMIN_EMAIL", "")
	t.Setenv("XIAOWEI_BOOTSTRAP_ADMIN_PASSWORD", "")
	stop = startAuthServer(t, fixture)
	defer stop()
	login = new(pb.LoginResponse)
	requireAuthResponse(t, requestAuth(fixture.address, "POST", "/api/auth/login", "",
		passwordRequest("admin@example.com", password, testDeviceID(t))), 200, 0, login)
	accessToken := login.Data.GetAuthenticated().Tokens.AccessToken
	requireAuthResponse(t, requestAuth(fixture.address, "POST", "/api/auth/logout", accessToken, nil), 200, 0, nil)
	for _, secret := range []string{password, hash, "Admin@Example.com", "changed-password"} {
		if strings.Contains(logs.String(), secret) {
			t.Fatal("administrator initialization logged a secret or email")
		}
	}
	if !strings.Contains(logs.String(), "administrator initialized") ||
		!strings.Contains(logs.String(), "administrator initialization skipped") {
		t.Fatal("administrator startup outcomes were not logged")
	}
}

func TestBootstrapAdminStartupRejectsInvalidCredentials(t *testing.T) {
	for _, tc := range []struct {
		name     string
		email    string
		password string
	}{
		{"invalid email", "private-secret", "valid-password"},
		{"short password", "admin@example.com", "short"},
		{"long password", "admin@example.com", strings.Repeat("a", 33)},
		{"non ASCII password", "admin@example.com", "密码private-secret"},
		{"existing ordinary email", "user@example.com", "valid-password"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fixture := newAuthFixture(t)
			t.Setenv("XIAOWEI_BOOTSTRAP_ADMIN_EMAIL", tc.email)
			t.Setenv("XIAOWEI_BOOTSTRAP_ADMIN_PASSWORD", tc.password)
			err := serve(context.Background(), fixture.configPath)
			if err == nil || strings.Contains(err.Error(), tc.email) || strings.Contains(err.Error(), tc.password) {
				t.Fatal("invalid initialization did not fail safely before serving HTTP")
			}
			var users, admins, markers int
			err = fixture.pool.QueryRow(context.Background(), `
    SELECT (SELECT count(*) FROM users), (SELECT count(*) FROM users WHERE role = 'admin'),
           (SELECT count(*) FROM admin_bootstrap)
   `).Scan(&users, &admins, &markers)
			if err != nil || users != 1 || admins != 0 || markers != 0 {
				t.Fatal("invalid initialization left partial state")
			}
		})
	}
}
