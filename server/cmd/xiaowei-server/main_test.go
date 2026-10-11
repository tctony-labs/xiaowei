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

func TestCheckConfigDoesNotConnectOrListen(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	host, port, err := net.SplitHostPort(listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "config.yaml")
	yaml := "server:\n  listen_addr: " + listener.Addr().String() + "\ndatabase:\n  host: " + host +
		"\n  port: " + port + "\n  name: test\n  user: test\n  password: private-password\n"
	if err := os.WriteFile(path, []byte(yaml), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PGSERVICE", "check-config-must-not-change-environment")
	if err := run(path, true); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("PGSERVICE") != "check-config-must-not-change-environment" {
		t.Fatal("configuration check entered database setup")
	}
	if err := listener.(*net.TCPListener).SetDeadline(time.Now().Add(50 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	connection, err := listener.Accept()
	if err == nil {
		connection.Close()
		t.Fatal("configuration check connected to the database")
	}
	if timeout, ok := err.(net.Error); !ok || !timeout.Timeout() {
		t.Fatal(err)
	}
}

func TestCheckConfigRejectsInvalidConfiguration(t *testing.T) {
	for _, tc := range []struct {
		name string
		yaml string
		want string
	}{
		{"missing file", "", "cannot read config file"},
		{"missing field", "database: {host: localhost, name: test, user: test}", "database.password"},
		{"invalid type", "database: {port: private-password}", "database.port"},
		{"unknown field", "private-password: value", "unknown field"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "config.yaml")
			if tc.yaml != "" {
				if err := os.WriteFile(path, []byte(tc.yaml), 0600); err != nil {
					t.Fatal(err)
				}
			}
			err := run(path, true)
			if err == nil || !strings.Contains(err.Error(), tc.want) || !strings.Contains(err.Error(), path) {
				t.Fatalf("expected actionable check failure, got %v", err)
			}
			if strings.Contains(err.Error(), "private-password") {
				t.Fatal("configuration check exposed a secret")
			}
		})
	}
}

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
