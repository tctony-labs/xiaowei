package main

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestStartupFailureDoesNotListen(t *testing.T) {
	t.Setenv("PGSERVICE", "private-password")
	t.Setenv("PGSERVICEFILE", "/missing/service-file")
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	_ = listener.Close()

	path := filepath.Join(t.TempDir(), "config.yaml")
	yaml := "server:\n  listen_addr: " + address + `
database:
  host: "127.0.0.1"
  port: 1
  name: "test"
  user: "test"
  password: "private-password"
  ssl_mode: "disable"
`
	if err := os.WriteFile(path, []byte(yaml), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := serve(ctx, path); err == nil || strings.Contains(err.Error(), "private-password") ||
		!strings.Contains(err.Error(), "connect PostgreSQL") {
		t.Fatalf("expected safe startup error, got %v", err)
	}
	connection, err := net.DialTimeout("tcp", address, 100*time.Millisecond)
	if err == nil {
		connection.Close()
		t.Fatal("HTTP listener started before database became ready")
	}
}

func TestMissingConfigAndCanceledStartup(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing.yaml")
	if err := serve(context.Background(), path); err == nil {
		t.Fatal("missing config accepted")
	}
	path = filepath.Join(t.TempDir(), "config.yaml")
	yaml := `database:
  host: "127.0.0.1"
  name: "test"
  user: "test"
  password: "private-password"
  ssl_mode: "disable"
`
	if err := os.WriteFile(path, []byte(yaml), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := serve(ctx, path); err == nil {
		t.Fatal("canceled startup succeeded")
	}
}
