package db

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Options struct {
	Host     string
	Port     int
	Database string
	User     string
	Password string
	SSLMode  string
}

type Store struct {
	pool *pgxpool.Pool
}

func Open(ctx context.Context, options Options) (*Store, error) {
	poolConfig, err := connectionConfig(options)
	if err != nil {
		return nil, err
	}
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return nil, errors.New("create PostgreSQL pool failed")
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, safeError("connect PostgreSQL", err)
	}
	if err := migrate(ctx, pool, migrations); err != nil {
		pool.Close()
		return nil, err
	}
	return &Store{pool: pool}, nil
}

func connectionConfig(options Options) (*pgxpool.Config, error) {
	address := net.JoinHostPort(options.Host, strconv.Itoa(options.Port))
	uri := url.URL{Scheme: "postgres", Host: address, Path: "/" + options.Database}
	uri.User = url.UserPassword(options.User, options.Password)
	query := url.Values{
		"sslmode":         {"disable"},
		"passfile":        {""},
		"connect_timeout": {"5"},
	}
	uri.RawQuery = query.Encode()
	cfg, err := pgxpool.ParseConfig(uri.String())
	if err != nil {
		return nil, errors.New("invalid PostgreSQL connection configuration")
	}
	// Explicit config controls connection behavior, never ambient libpq credentials or TLS options.
	cfg.ConnConfig.Host = options.Host
	cfg.ConnConfig.Port = uint16(options.Port)
	cfg.ConnConfig.Database = options.Database
	cfg.ConnConfig.User = options.User
	cfg.ConnConfig.Password = options.Password
	cfg.ConnConfig.RuntimeParams = map[string]string{"application_name": "xiaowei-server"}
	cfg.ConnConfig.Fallbacks = nil
	cfg.ConnConfig.TLSConfig = nil
	switch options.SSLMode {
	case "verify-full":
		cfg.ConnConfig.TLSConfig = &tls.Config{ServerName: options.Host, MinVersion: tls.VersionTLS12}
	case "disable":
	default:
		return nil, errors.New("unsupported PostgreSQL TLS mode")
	}
	cfg.ConnConfig.ConnectTimeout = 5 * time.Second
	cfg.MaxConns = 10
	cfg.MinConns = 0
	return cfg, nil
}

func (s *Store) Close() {
	s.pool.Close()
}

func (s *Store) Ping(ctx context.Context) error {
	return s.pool.Ping(ctx)
}

// Driver errors can contain connection strings or SQL details. Expose only safe diagnostics.
func safeError(operation string, err error) error {
	if errors.Is(err, context.Canceled) {
		return fmt.Errorf("%s: %w", operation, context.Canceled)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("%s: %w", operation, context.DeadlineExceeded)
	}
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) {
		return fmt.Errorf("%s failed (SQLSTATE %s)", operation, postgresError.Code)
	}
	return fmt.Errorf("%s failed", operation)
}
