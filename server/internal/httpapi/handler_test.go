package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestHealthRoute(t *testing.T) {
	handler := NewHandler(func(context.Context) error { return nil })
	for _, tc := range []struct {
		method string
		path   string
		status int
	}{
		{http.MethodGet, "/healthz", http.StatusOK},
		{http.MethodPost, "/healthz", http.StatusMethodNotAllowed},
		{http.MethodGet, "/missing", http.StatusNotFound},
	} {
		t.Run(tc.method+tc.path, func(t *testing.T) {
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(tc.method, tc.path, nil))
			if response.Code != tc.status {
				t.Fatalf("status = %d, want %d", response.Code, tc.status)
			}
			if tc.status == http.StatusOK {
				var body map[string]string
				if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil ||
					body["status"] != "ok" {
					t.Fatalf("invalid health response: %s", response.Body.String())
				}
			}
		})
	}
}

func TestReadiness(t *testing.T) {
	for _, tc := range []struct {
		name  string
		check func(context.Context) error
		want  int
	}{
		{"ready", func(context.Context) error { return nil }, http.StatusOK},
		{"unavailable", func(context.Context) error { return errors.New("private-db-password") }, 503},
		{"timeout", func(ctx context.Context) error {
			<-ctx.Done()
			return ctx.Err()
		}, 503},
	} {
		t.Run(tc.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			start := time.Now()
			NewHandler(tc.check).ServeHTTP(response, httptest.NewRequest("GET", "/readyz", nil))
			if response.Code != tc.want || strings.Contains(response.Body.String(), "private-db-password") {
				t.Fatalf("unexpected readiness response: %d %s", response.Code, response.Body)
			}
			if time.Since(start) > 3*time.Second {
				t.Fatal("readiness did not finish within its timeout")
			}
		})
	}
}

func TestReadinessCancellationAndMethod(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	handler := NewHandler(func(ctx context.Context) error { return ctx.Err() })
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("GET", "/readyz", nil).WithContext(ctx))
	if response.Code != 503 {
		t.Fatal("request cancellation was not propagated")
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("POST", "/readyz", nil))
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatal("readiness accepted a write method")
	}
}
