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

	pb "github.com/tctony-labs/xiaowei/contracts/out/proto-server-go/gen/xiaowei/server"
	"github.com/tctony-labs/xiaowei/server/internal/config"
)

func TestHealthRoute(t *testing.T) {
	api := NewAPI(
		func(context.Context) error { return nil }, nil, config.DefaultAuthRateLimit(),
	)
	handler := NewHandler(api, config.DefaultServerRateLimit())
	for _, tc := range []struct {
		method string
		path   string
		status int
	}{
		{http.MethodPost, "/api/Health/Check", 0},
		{http.MethodGet, "/api/Health/Check", int(pb.ErrorCode_ERROR_CODE_INVALID_REQUEST)},
		{http.MethodGet, "/missing", int(pb.ErrorCode_ERROR_CODE_NOT_FOUND)},
	} {
		t.Run(tc.method+tc.path, func(t *testing.T) {
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(tc.method, tc.path, nil))
			var body struct {
				Code int            `json:"code"`
				Data map[string]any `json:"data"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || response.Code != 200 ||
				body.Code != tc.status {
				t.Fatalf("unexpected response: %s", response.Body)
			}
			if tc.status == 0 && (body.Data == nil || len(body.Data) != 0) {
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
			api := NewAPI(
				tc.check, nil, config.DefaultAuthRateLimit(),
			)
			handler := NewHandler(api, config.DefaultServerRateLimit())
			handler.ServeHTTP(response, httptest.NewRequest("POST", "/api/Health/Ready",
				nil))
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
	api := NewAPI(
		func(ctx context.Context) error { return ctx.Err() }, nil, config.DefaultAuthRateLimit(),
	)
	handler := NewHandler(api, config.DefaultServerRateLimit())
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("POST", "/api/Health/Ready",
		nil).WithContext(ctx))
	var body pb.BaseResponse
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || response.Code != 200 ||
		body.Code != int32(pb.ErrorCode_ERROR_CODE_UNAVAILABLE) {
		t.Fatal("request cancellation was not propagated")
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("GET", "/api/Health/Ready", nil))
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || response.Code != 200 ||
		body.Code != int32(pb.ErrorCode_ERROR_CODE_INVALID_REQUEST) {
		t.Fatal("readiness accepted GET")
	}
}

func TestHandlerPanicAndUnnormalizedPaths(t *testing.T) {
	api := NewAPI(
		func(context.Context) error { panic("private-secret") }, nil, config.DefaultAuthRateLimit(),
	)
	handler := NewHandler(api, config.DefaultServerRateLimit())
	for _, path := range []string{
		"/api/Health/Ready",
		"//api/Health/Check",
		"/a/../api/Health/Check",
		"/api/Health/Check/",
	} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest("POST", path, nil))
		var body pb.BaseResponse
		want := int32(pb.ErrorCode_ERROR_CODE_NOT_FOUND)
		if path == "/api/Health/Ready" {
			want = int32(pb.ErrorCode_ERROR_CODE_INTERNAL_ERROR)
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || w.Code != 200 || body.Code != want ||
			strings.Contains(w.Body.String(), "private-secret") || w.Header().Get("Location") != "" {
			t.Fatal("handler escaped the common response")
		}
	}
}
