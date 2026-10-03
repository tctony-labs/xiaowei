package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
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
