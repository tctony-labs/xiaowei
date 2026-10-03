package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/tctony-labs/xiaowei/server/internal/config"
	"github.com/tctony-labs/xiaowei/server/internal/db"
	"github.com/tctony-labs/xiaowei/server/internal/httpapi"
)

func main() {
	configPath := flag.String("config", "config/server.yaml", "path to the server YAML configuration")
	flag.Parse()
	if flag.NArg() != 0 {
		slog.Error("unexpected positional arguments")
		os.Exit(1)
	}
	if err := run(*configPath); err != nil {
		slog.Error("server failed", "error", err)
		os.Exit(1)
	}
}

func run(configPath string) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return serve(ctx, configPath)
}

func serve(ctx context.Context, configPath string) error {
	cfg, err := config.Load(configPath)
	if err != nil {
		return err
	}
	slog.Info("server configuration loaded", "path", configPath)

	// pgx also understands libpq variables. Only unified config and explicit XIAOWEI_* overrides apply here.
	for _, name := range []string{
		"PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD", "PGPASSFILE",
		"PGAPPNAME", "PGCONNECT_TIMEOUT", "PGSSLMODE", "PGSSLKEY", "PGSSLCERT",
		"PGSSLSNI", "PGSSLROOTCERT", "PGSSLPASSWORD", "PGSSLNEGOTIATION",
		"PGTARGETSESSIONATTRS", "PGSERVICE", "PGSERVICEFILE", "PGTZ", "PGOPTIONS",
		"PGMINPROTOCOLVERSION", "PGMAXPROTOCOLVERSION", "PGCHANNELBINDING", "PGREQUIREAUTH",
	} {
		if err := os.Unsetenv(name); err != nil {
			return errors.New("cannot isolate PostgreSQL environment")
		}
	}

	startupCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	store, err := db.Open(startupCtx, db.Options{
		Host:     cfg.Database.Host,
		Port:     cfg.Database.Port,
		Database: cfg.Database.Name,
		User:     cfg.Database.User,
		Password: cfg.Database.Password,
		SSLMode:  cfg.Database.SSLMode,
	})
	cancel()
	if err != nil {
		return err
	}
	defer store.Close()
	slog.Info("PostgreSQL connected")

	listener, err := net.Listen("tcp", cfg.Server.ListenAddr)
	if err != nil {
		return fmt.Errorf("listen HTTP: %w", err)
	}
	server := &http.Server{
		Handler:           httpapi.NewHandler(store.Ping),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	failures := make(chan error, 1)
	go func() { failures <- server.Serve(listener) }()
	slog.Info("server listening", "address", listener.Addr().String())

	select {
	case err := <-failures:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		slog.Info("server stopping")
		if err := server.Shutdown(shutdownCtx); err != nil {
			_ = server.Close()
			return err
		}
		if err := <-failures; !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		slog.Info("server stopped")
		return nil
	}
}
