package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const validYAML = `database:
  host: "localhost"
  name: "xiaowei"
  user: "xiaowei"
  password: "  private-password  "
`

func configFile(t *testing.T, value string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(value), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func cleanOverrides(t *testing.T) {
	t.Helper()
	names := []string{
		"XIAOWEI_LISTEN_ADDR", "XIAOWEI_DATABASE_HOST", "XIAOWEI_DATABASE_PORT",
		"XIAOWEI_DATABASE_NAME", "XIAOWEI_DATABASE_USER", "XIAOWEI_DATABASE_PASSWORD",
		"XIAOWEI_DATABASE_SSL_MODE",
		"XIAOWEI_AUTH_ACCESS_TOKEN_TTL", "XIAOWEI_AUTH_REFRESH_TOKEN_TTL",
	}
	for _, prefix := range []string{
		"SERVER_RATE_LIMIT_IP", "AUTH_RATE_LIMIT_LOGIN_IP",
		"AUTH_RATE_LIMIT_LOGIN_EMAIL_IP", "AUTH_RATE_LIMIT_REFRESH_IP",
	} {
		names = append(names, "XIAOWEI_"+prefix+"_LIMIT", "XIAOWEI_"+prefix+"_WINDOW")
	}
	for _, name := range names {
		old, existed := os.LookupEnv(name)
		if err := os.Unsetenv(name); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			if existed {
				_ = os.Setenv(name, old)
			} else {
				_ = os.Unsetenv(name)
			}
		})
	}
}

func TestAuthLifetimes(t *testing.T) {
	cleanOverrides(t)
	path := configFile(t, validYAML)
	cfg, err := Load(path)
	if err != nil || cfg.Auth.AccessTokenTTL != 2*time.Hour || cfg.Auth.RefreshTokenTTL != 720*time.Hour {
		t.Fatal("authentication lifetime defaults failed")
	}
	path = configFile(t, validYAML+"auth:\n  access_token_ttl: 1h\n  refresh_token_ttl: 24h\n")
	dotenv := "XIAOWEI_AUTH_ACCESS_TOKEN_TTL=2h\nXIAOWEI_AUTH_REFRESH_TOKEN_TTL=48h\n"
	if err := os.WriteFile(filepath.Join(filepath.Dir(path), ".env"), []byte(dotenv), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err = Load(path)
	if err != nil || cfg.Auth.AccessTokenTTL != 2*time.Hour || cfg.Auth.RefreshTokenTTL != 48*time.Hour {
		t.Fatal("dotenv lifetime overrides failed")
	}
	t.Setenv("XIAOWEI_AUTH_ACCESS_TOKEN_TTL", "3h")
	cfg, err = Load(path)
	if err != nil || cfg.Auth.AccessTokenTTL != 3*time.Hour {
		t.Fatal("process lifetime override failed")
	}
	for _, value := range []string{"", "private-secret", "0", "-1h", "49h"} {
		t.Setenv("XIAOWEI_AUTH_ACCESS_TOKEN_TTL", value)
		if _, err := Load(path); err == nil || strings.Contains(err.Error(), "private-secret") {
			t.Fatal("invalid lifetime accepted or leaked")
		}
	}
}

func TestInvalidAuthYAML(t *testing.T) {
	cleanOverrides(t)
	for _, fields := range []string{
		"  access_token_ttl: private-secret\n",
		"  access_token_ttl: 123\n",
		"  refresh_token_ttl: 0h\n",
		"  access_token_ttl: 48h\n  refresh_token_ttl: 24h\n",
	} {
		if _, err := Load(configFile(t, validYAML+"auth:\n"+fields)); err == nil ||
			strings.Contains(err.Error(), "private-secret") {
			t.Fatal("invalid authentication YAML accepted or leaked")
		}
	}
}

func TestDefaultsAndOverrides(t *testing.T) {
	cleanOverrides(t)
	path := configFile(t, validYAML)
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Server.ListenAddr != "127.0.0.1:10001" || cfg.Database.Port != 5432 ||
		cfg.Database.SSLMode != "verify-full" || cfg.Database.Password != "  private-password  " {
		t.Fatal("defaults or password preservation failed")
	}
	t.Setenv("XIAOWEI_DATABASE_HOST", "db")
	t.Setenv("XIAOWEI_DATABASE_PASSWORD", "override-password")
	t.Setenv("XIAOWEI_DATABASE_PORT", "15432")
	t.Setenv("XIAOWEI_LISTEN_ADDR", "0.0.0.0:10001")
	cfg, err = Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Database.Host != "db" || cfg.Database.Port != 15432 ||
		cfg.Database.Password != "override-password" || cfg.Server.ListenAddr != "0.0.0.0:10001" {
		t.Fatal("env did not override YAML")
	}
	t.Setenv("XIAOWEI_DATABASE_PASSWORD", "")
	if _, err := Load(path); err == nil {
		t.Fatal("empty env must override YAML and fail required validation")
	}
}

func TestInvalidYAML(t *testing.T) {
	cleanOverrides(t)
	for _, tc := range []struct {
		name  string
		value string
	}{
		{"empty", ""},
		{"multiple documents", validYAML + "---\nserver: {}\n"},
		{"unknown", validYAML + "private-password: unknown\n"},
		{"duplicate", strings.Replace(validYAML, "  host:", "  host: db\n  host:", 1)},
		{"type", strings.Replace(validYAML, "\"localhost\"", "[private-password]", 1)},
		{"syntax", validYAML + "server: [private-password\n"},
		{"null", validYAML + "server:\n  listen_addr: null\n"},
		{"empty field", validYAML + "server:\n  listen_addr: \"\"\n"},
		{"invalid port", validYAML + "server:\n  listen_addr: localhost:99999\n"},
		{"invalid db port", validYAML + "  port: 0\n"},
		{"integer overflow", validYAML + "  port: 9999999999999999999999999999\n"},
		{"invalid ssl", validYAML + "  ssl_mode: require\n"},
		{"alias", validYAML + "server: &a {listen_addr: *a}\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Load(configFile(t, tc.value))
			if err == nil || strings.Contains(err.Error(), "private-password") {
				t.Fatalf("expected safe validation error, got %v", err)
			}
		})
	}
}

func TestFileAndEnvironmentErrors(t *testing.T) {
	cleanOverrides(t)
	if _, err := Load(filepath.Join(t.TempDir(), "missing.yaml")); err == nil {
		t.Fatal("missing file accepted")
	}
	path := configFile(t, validYAML)
	t.Setenv("PGHOST", "unwanted-host")
	t.Setenv("PGPASSWORD", "unwanted-password")
	cfg, err := Load(path)
	if err != nil || cfg.Database.Host != "localhost" || cfg.Database.Password != "  private-password  " {
		t.Fatal("ambient PG env affected config")
	}
	for _, value := range []string{"", "bad-secret", "0", "65536"} {
		t.Setenv("XIAOWEI_DATABASE_PORT", value)
		if _, err := Load(path); err == nil || strings.Contains(err.Error(), "bad-secret") {
			t.Fatalf("invalid env port accepted or leaked: %v", err)
		}
	}
}

func TestDotenvPrecedenceAndIsolation(t *testing.T) {
	cleanOverrides(t)
	path := configFile(t, validYAML)
	dotenv := `XIAOWEI_LISTEN_ADDR=127.0.0.1:10002
XIAOWEI_DATABASE_HOST=dotenv-host
XIAOWEI_DATABASE_PORT=15432
XIAOWEI_DATABASE_NAME=dotenv-name
XIAOWEI_DATABASE_USER=dotenv-user
XIAOWEI_DATABASE_PASSWORD='  literal-$value#password  '
XIAOWEI_DATABASE_SSL_MODE=disable
PGHOST=ignored-host
`
	if err := os.WriteFile(filepath.Join(filepath.Dir(path), ".env"), []byte(dotenv), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Server.ListenAddr != "127.0.0.1:10002" || cfg.Database.Host != "dotenv-host" ||
		cfg.Database.Port != 15432 || cfg.Database.Name != "dotenv-name" ||
		cfg.Database.User != "dotenv-user" || cfg.Database.Password != "  literal-$value#password  " ||
		cfg.Database.SSLMode != "disable" {
		t.Fatal("dotenv did not override YAML or preserve the quoted password")
	}
	if _, ok := os.LookupEnv("XIAOWEI_DATABASE_PASSWORD"); ok {
		t.Fatal("dotenv modified process environment")
	}

	t.Setenv("XIAOWEI_DATABASE_PASSWORD", "external-password")
	t.Setenv("XIAOWEI_DATABASE_PORT", "25432")
	cfg, err = Load(path)
	if err != nil || cfg.Database.Password != "external-password" || cfg.Database.Port != 25432 {
		t.Fatal("process env did not override dotenv")
	}
	t.Setenv("XIAOWEI_DATABASE_PASSWORD", "")
	if _, err := Load(path); err == nil {
		t.Fatal("empty process env must override dotenv and fail validation")
	}
}

func TestDotenvUsesConfigDirectory(t *testing.T) {
	cleanOverrides(t)
	t.Chdir(t.TempDir())
	if err := os.WriteFile(".env", []byte("XIAOWEI_DATABASE_PASSWORD=''\n"), 0600); err != nil {
		t.Fatal(err)
	}
	path := configFile(t, validYAML)
	if _, err := Load(path); err != nil {
		t.Fatal("dotenv in cwd affected a config in another directory")
	}
	if err := os.WriteFile(filepath.Join(filepath.Dir(path), ".env"),
		[]byte("XIAOWEI_DATABASE_PASSWORD='adjacent-password'\n"), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil || cfg.Database.Password != "adjacent-password" {
		t.Fatal("dotenv next to selected YAML was not loaded")
	}
}

func TestDotenvErrorsAreSafe(t *testing.T) {
	cleanOverrides(t)
	for _, value := range []string{
		"XIAOWEI_DATABASE_PASSWORD='private-password\n",
		"XIAOWEI_DATABASE_PASSWORD=''\n",
		"XIAOWEI_DATABASE_NAME=''\n",
		"XIAOWEI_DATABASE_PORT=private-password\n",
	} {
		path := configFile(t, validYAML)
		if err := os.WriteFile(filepath.Join(filepath.Dir(path), ".env"), []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := Load(path); err == nil || strings.Contains(err.Error(), "private-password") {
			t.Fatal("invalid dotenv was accepted or exposed its contents")
		}
	}
	path := configFile(t, validYAML)
	if err := os.Mkdir(filepath.Join(filepath.Dir(path), ".env"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("unreadable dotenv was accepted")
	}
}

func TestRateLimitConfig(t *testing.T) {
	cleanOverrides(t)
	cfg, err := Load(configFile(t, validYAML))
	if err != nil || cfg.Server.RateLimit != DefaultServerRateLimit() || cfg.Auth.RateLimit != DefaultAuthRateLimit() {
		t.Fatalf("rate limit defaults: %+v, %v", cfg, err)
	}
	for _, field := range cfg.rateLimits() {
		t.Run(field.path, func(t *testing.T) {
			parts := strings.Split(field.path, ".")
			path := configFile(t, validYAML+parts[0]+":\n  rate_limit:\n    "+parts[2]+":\n      limit: 7\n")
			loaded, err := Load(path)
			if err != nil {
				t.Fatal(err)
			}
			get := func(c *Config) RateLimit {
				for _, f := range c.rateLimits() {
					if f.path == field.path {
						return *f.target
					}
				}
				t.Fatal("missing quota")
				return RateLimit{}
			}
			if get(&loaded).Limit != 7 || get(&loaded).Window != field.target.Window {
				t.Fatal("partial YAML failed")
			}
			prefix := "XIAOWEI_" + strings.ToUpper(strings.ReplaceAll(field.path, ".", "_"))
			dotenv := []byte(prefix + "_LIMIT=8\n" + prefix + "_WINDOW=2m\n")
			if err := os.WriteFile(filepath.Join(filepath.Dir(path), ".env"), dotenv, 0600); err != nil {
				t.Fatal(err)
			}
			loaded, err = Load(path)
			if err != nil || get(&loaded) != (RateLimit{Limit: 8, Window: 2 * time.Minute}) {
				t.Fatal("dotenv override failed")
			}
			t.Setenv(prefix+"_LIMIT", "9")
			t.Setenv(prefix+"_WINDOW", "3m")
			loaded, err = Load(path)
			if err != nil || get(&loaded) != (RateLimit{Limit: 9, Window: 3 * time.Minute}) {
				t.Fatal("env override failed")
			}
			for _, suffix := range []string{"_LIMIT", "_WINDOW"} {
				for _, value := range []string{"0", "-1", "private-secret", ""} {
					t.Run(suffix+value, func(t *testing.T) {
						t.Setenv(prefix+suffix, value)
						if _, err := Load(path); err == nil || strings.Contains(err.Error(), "private-secret") {
							t.Fatal("invalid quota accepted or leaked")
						}
					})
				}
			}
		})
	}
}
