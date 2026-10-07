package config

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/joho/godotenv"
	"go.yaml.in/yaml/v3"
)

type Config struct {
	Server   Server   `yaml:"server"`
	Database Database `yaml:"database"`
	Auth     Auth     `yaml:"auth"`

	// Bootstrap credentials are environment-only and never part of the persistent YAML schema.
	BootstrapAdmin BootstrapAdmin `yaml:"-"`
}

type BootstrapAdmin struct {
	Email    string
	Password string
}

type RateLimit struct {
	Limit  int           `yaml:"limit"`
	Window time.Duration `yaml:"window"`
}

type ServerRateLimit struct {
	IP RateLimit `yaml:"ip"`
}

type AuthRateLimit struct {
	LoginIP      RateLimit `yaml:"login_ip"`
	LoginEmailIP RateLimit `yaml:"login_email_ip"`
	RefreshIP    RateLimit `yaml:"refresh_ip"`
}

func DefaultServerRateLimit() ServerRateLimit {
	return ServerRateLimit{IP: RateLimit{Limit: 300, Window: time.Minute}}
}

func DefaultAuthRateLimit() AuthRateLimit {
	return AuthRateLimit{
		LoginIP:      RateLimit{Limit: 30, Window: time.Minute},
		LoginEmailIP: RateLimit{Limit: 5, Window: 15 * time.Minute},
		RefreshIP:    RateLimit{Limit: 60, Window: time.Minute},
	}
}

type Auth struct {
	RateLimit       AuthRateLimit `yaml:"rate_limit"`
	AccessTokenTTL  time.Duration `yaml:"access_token_ttl"`
	RefreshTokenTTL time.Duration `yaml:"refresh_token_ttl"`
}

type Server struct {
	RateLimit  ServerRateLimit `yaml:"rate_limit"`
	ListenAddr string          `yaml:"listen_addr"`
}

type Database struct {
	Host     string `yaml:"host"`
	Port     int    `yaml:"port"`
	Name     string `yaml:"name"`
	User     string `yaml:"user"`
	Password string `yaml:"password"`
	SSLMode  string `yaml:"ssl_mode"`
}

func Load(path string) (Config, error) {
	file, err := os.Open(path)
	if err != nil {
		return Config{}, errors.New("cannot read config file")
	}
	defer file.Close()

	decoder := yaml.NewDecoder(file)
	var document yaml.Node
	if err := decoder.Decode(&document); err != nil {
		return Config{}, errors.New("config must contain valid YAML")
	}
	var extra yaml.Node
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return Config{}, errors.New("config must contain exactly one YAML document")
	}
	if len(document.Content) != 1 {
		return Config{}, errors.New("config must contain a mapping")
	}
	if err := validateNode(document.Content[0], ""); err != nil {
		return Config{}, err
	}

	cfg := Config{
		Server:   Server{ListenAddr: "127.0.0.1:10001", RateLimit: DefaultServerRateLimit()},
		Database: Database{Port: 5432, SSLMode: "verify-full"},
		Auth: Auth{
			AccessTokenTTL:  2 * time.Hour,
			RefreshTokenTTL: 30 * 24 * time.Hour,
			RateLimit:       DefaultAuthRateLimit(),
		},
	}
	if err := document.Decode(&cfg); err != nil {
		return Config{}, errors.New("config field has an invalid value")
	}

	fileEnv, err := godotenv.Read(filepath.Join(filepath.Dir(path), ".env"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return Config{}, errors.New("cannot read or parse config .env file")
	}
	lookup := func(name string) (string, bool) {
		if value, ok := os.LookupEnv(name); ok {
			return value, true
		}
		value, ok := fileEnv[name]
		return value, ok
	}

	overrides := []struct {
		name   string
		target *string
	}{
		{"XIAOWEI_LISTEN_ADDR", &cfg.Server.ListenAddr},
		{"XIAOWEI_DATABASE_HOST", &cfg.Database.Host},
		{"XIAOWEI_DATABASE_NAME", &cfg.Database.Name},
		{"XIAOWEI_DATABASE_USER", &cfg.Database.User},
		{"XIAOWEI_DATABASE_PASSWORD", &cfg.Database.Password},
		{"XIAOWEI_DATABASE_SSL_MODE", &cfg.Database.SSLMode},
		{"XIAOWEI_BOOTSTRAP_ADMIN_EMAIL", &cfg.BootstrapAdmin.Email},
		{"XIAOWEI_BOOTSTRAP_ADMIN_PASSWORD", &cfg.BootstrapAdmin.Password},
	}
	for _, override := range overrides {
		if value, ok := lookup(override.name); ok {
			*override.target = value
		}
	}
	if value, ok := lookup("XIAOWEI_DATABASE_PORT"); ok {
		port, err := strconv.Atoi(value)
		if err != nil {
			return Config{}, errors.New("XIAOWEI_DATABASE_PORT must be an integer")
		}
		cfg.Database.Port = port
	}
	for _, override := range []struct {
		name   string
		target *time.Duration
	}{
		{"XIAOWEI_AUTH_ACCESS_TOKEN_TTL", &cfg.Auth.AccessTokenTTL},
		{"XIAOWEI_AUTH_REFRESH_TOKEN_TTL", &cfg.Auth.RefreshTokenTTL},
	} {
		if value, ok := lookup(override.name); ok {
			duration, err := time.ParseDuration(value)
			if err != nil {
				return Config{}, fmt.Errorf("%s must be a duration", override.name)
			}
			*override.target = duration
		}
	}
	for _, field := range cfg.rateLimits() {
		prefix := "XIAOWEI_" + strings.ToUpper(strings.ReplaceAll(field.path, ".", "_"))
		if value, ok := lookup(prefix + "_LIMIT"); ok {
			limit, err := strconv.Atoi(value)
			if err != nil {
				return Config{}, fmt.Errorf("%s_LIMIT must be an integer", prefix)
			}
			field.target.Limit = limit
		}
		if value, ok := lookup(prefix + "_WINDOW"); ok {
			window, err := time.ParseDuration(value)
			if err != nil {
				return Config{}, fmt.Errorf("%s_WINDOW must be a duration", prefix)
			}
			field.target.Window = window
		}
	}
	if err := cfg.validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// Validate the small explicit schema without echoing scalar values in YAML errors.
func validateNode(node *yaml.Node, path string) error {
	switch path {
	case "", "server", "database", "auth", "server.rate_limit", "auth.rate_limit",
		"server.rate_limit.ip", "auth.rate_limit.login_ip",
		"auth.rate_limit.login_email_ip", "auth.rate_limit.refresh_ip":
		if node.Kind != yaml.MappingNode || node.Tag != "!!map" {
			return fmt.Errorf("config %s must be a mapping (line %d)", path, node.Line)
		}
		seen := make(map[string]bool)
		for i := 0; i < len(node.Content); i += 2 {
			key := node.Content[i]
			if key.Tag != "!!str" || seen[key.Value] {
				return fmt.Errorf("config has an invalid or duplicate key (line %d)", key.Line)
			}
			seen[key.Value] = true
			childPath := key.Value
			if path != "" {
				childPath = path + "." + key.Value
			}
			if err := validateNode(node.Content[i+1], childPath); err != nil {
				return err
			}
		}
	case "server.listen_addr", "database.host", "database.name", "database.user",
		"database.password", "database.ssl_mode", "auth.access_token_ttl", "auth.refresh_token_ttl",
		"server.rate_limit.ip.window", "auth.rate_limit.login_ip.window",
		"auth.rate_limit.login_email_ip.window", "auth.rate_limit.refresh_ip.window":
		if node.Kind != yaml.ScalarNode || node.Tag != "!!str" {
			return fmt.Errorf("config %s must be a string (line %d)", path, node.Line)
		}
	case "database.port", "server.rate_limit.ip.limit", "auth.rate_limit.login_ip.limit",
		"auth.rate_limit.login_email_ip.limit", "auth.rate_limit.refresh_ip.limit":
		if node.Kind != yaml.ScalarNode || node.Tag != "!!int" {
			return fmt.Errorf("config %s must be an integer (line %d)", path, node.Line)
		}
	default:
		return fmt.Errorf("config has an unknown field (line %d)", node.Line)
	}
	return nil
}

func (c *Config) rateLimits() []struct {
	path   string
	target *RateLimit
} {
	return []struct {
		path   string
		target *RateLimit
	}{
		{"server.rate_limit.ip", &c.Server.RateLimit.IP},
		{"auth.rate_limit.login_ip", &c.Auth.RateLimit.LoginIP},
		{"auth.rate_limit.login_email_ip", &c.Auth.RateLimit.LoginEmailIP},
		{"auth.rate_limit.refresh_ip", &c.Auth.RateLimit.RefreshIP},
	}
}

func (c Config) validate() error {
	if (c.BootstrapAdmin.Email == "") != (c.BootstrapAdmin.Password == "") {
		return errors.New("XIAOWEI_BOOTSTRAP_ADMIN_EMAIL and XIAOWEI_BOOTSTRAP_ADMIN_PASSWORD must be set together")
	}

	for _, field := range c.rateLimits() {
		if field.target.Limit <= 0 || field.target.Window <= 0 {
			return fmt.Errorf("%s limit and window must be positive", field.path)
		}
	}

	_, portText, err := net.SplitHostPort(c.Server.ListenAddr)
	if err != nil {
		return errors.New("server.listen_addr must be a host:port address")
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		return errors.New("server.listen_addr must have a port in 1..65535")
	}
	required := []struct {
		name  string
		value string
	}{
		{"host", c.Database.Host},
		{"name", c.Database.Name},
		{"user", c.Database.User},
		{"password", c.Database.Password},
	}
	for _, field := range required {
		if field.value == "" || (field.name != "password" && strings.TrimSpace(field.value) == "") {
			return fmt.Errorf("database.%s is required", field.name)
		}
	}
	if c.Database.Port < 1 || c.Database.Port > 65535 {
		return errors.New("database.port must be in 1..65535")
	}
	if c.Database.SSLMode != "verify-full" && c.Database.SSLMode != "disable" {
		return errors.New("database.ssl_mode must be verify-full or disable")
	}
	if c.Auth.AccessTokenTTL <= 0 || c.Auth.RefreshTokenTTL <= c.Auth.AccessTokenTTL {
		return errors.New("auth token lifetimes must be positive with refresh longer than access")
	}
	return nil
}
