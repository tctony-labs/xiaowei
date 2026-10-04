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

	pb "github.com/tctony-labs/xiaowei/contracts/go/gen/xiaowei/server"
	"github.com/tctony-labs/xiaowei/server/internal/config"
)

func TestHealthRoute(t *testing.T) {
	handler := NewHandler(func(context.Context) error { return nil }, nil,
		config.DefaultServerRateLimit(), config.DefaultAuthRateLimit())
	for _, tc := range []struct {
		method string
		path   string
		status int
	}{
		{http.MethodGet, "/healthz", 0},
		{http.MethodPost, "/healthz", int(pb.ErrorCode_ERROR_CODE_INVALID_REQUEST)},
		{http.MethodGet, "/missing", int(pb.ErrorCode_ERROR_CODE_NOT_FOUND)},
	} {
		t.Run(tc.method+tc.path, func(t *testing.T) {
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(tc.method, tc.path, nil))
			var body struct {
				Code int `json:"code"`
				Data *struct {
					Status string `json:"status"`
				} `json:"data"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || response.Code != 200 ||
				body.Code != tc.status {
				t.Fatalf("unexpected response: %s", response.Body)
			}
			if tc.status == 0 && (body.Data == nil || body.Data.Status != "ok") {
				t.Fatal("health data missing")
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
		{"ready", func(context.Context) error { return nil }, 0},
		{"unavailable", func(context.Context) error {
			return errors.New("private-db-password")
		}, int(pb.ErrorCode_ERROR_CODE_UNAVAILABLE)},
		{"timeout", func(ctx context.Context) error {
			<-ctx.Done()
			return ctx.Err()
		}, int(pb.ErrorCode_ERROR_CODE_UNAVAILABLE)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			start := time.Now()
			handler := NewHandler(tc.check, nil, config.DefaultServerRateLimit(), config.DefaultAuthRateLimit())
			handler.ServeHTTP(response, httptest.NewRequest("GET", "/readyz", nil))
			var body struct {
				Code int `json:"code"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || response.Code != 200 ||
				body.Code != tc.want || strings.Contains(response.Body.String(), "private-db-password") {
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
	handler := NewHandler(func(ctx context.Context) error { return ctx.Err() }, nil,
		config.DefaultServerRateLimit(), config.DefaultAuthRateLimit())
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("GET", "/readyz", nil).WithContext(ctx))
	var body pb.ErrorResponse
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || response.Code != 200 ||
		body.Code != int32(pb.ErrorCode_ERROR_CODE_UNAVAILABLE) {
		t.Fatal("request cancellation was not propagated")
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("POST", "/readyz", nil))
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || response.Code != 200 ||
		body.Code != int32(pb.ErrorCode_ERROR_CODE_INVALID_REQUEST) {
		t.Fatal("readiness accepted a write method")
	}
}

func TestHandlerPanicAndUnnormalizedPaths(t *testing.T) {
	handler := NewHandler(func(context.Context) error { panic("private-secret") }, nil,
		config.DefaultServerRateLimit(), config.DefaultAuthRateLimit())
	for _, path := range []string{"/readyz", "//healthz", "/a/../healthz", "/healthz/"} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		var body pb.ErrorResponse
		want := int32(pb.ErrorCode_ERROR_CODE_NOT_FOUND)
		if path == "/readyz" {
			want = int32(pb.ErrorCode_ERROR_CODE_INTERNAL_ERROR)
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || w.Code != 200 || body.Code != want ||
			strings.Contains(w.Body.String(), "private-secret") || w.Header().Get("Location") != "" {
			t.Fatal("handler escaped the common response")
		}
	}
}
