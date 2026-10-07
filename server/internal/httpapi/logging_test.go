package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	pb "github.com/tctony-labs/xiaowei/contracts/go/gen/xiaowei/server"
	"github.com/tctony-labs/xiaowei/server/internal/auth"
	"github.com/tctony-labs/xiaowei/server/internal/config"
)

func captureRequestLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	buffer := new(bytes.Buffer)
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(buffer, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(previous) })
	return buffer
}

func requestSummary(t *testing.T, buffer *bytes.Buffer) map[string]any {
	t.Helper()
	decoder := json.NewDecoder(strings.NewReader(buffer.String()))
	var summary map[string]any
	var started map[string]any
	starts, count := 0, 0
	for {
		var entry map[string]any
		if err := decoder.Decode(&entry); err == io.EOF {
			break
		} else if err != nil {
			t.Fatal("invalid structured log")
		}
		if entry["msg"] == "HTTP request started" {
			if count != 0 {
				t.Fatal("start log followed completion")
			}
			started = entry
			starts++
		}
		if entry["msg"] == "HTTP request completed" {
			if starts != 1 {
				t.Fatal("request did not start before completion")
			}
			summary = entry
			count++
		}
	}
	if count != 1 || starts != 1 {
		t.Fatalf("got %d starts and %d summaries, want one each", starts, count)
	}
	if started["level"] != "INFO" || started["method"] != summary["method"] || started["path"] != summary["path"] {
		t.Fatal("incorrect start metadata")
	}
	for _, field := range []string{"duration_ms", "http_status", "code", "outcome"} {
		if _, exists := started[field]; exists {
			t.Fatal("start log contains result fields")
		}
	}
	if _, exists := summary["outcome"]; exists {
		t.Fatal("completion log contains derived outcome")
	}
	if duration, ok := summary["duration_ms"].(float64); !ok || duration < 0 {
		t.Fatal("missing request duration")
	}
	return summary
}

func TestRequestLoggingRoutesAndFailures(t *testing.T) {
	for _, tc := range []struct {
		name, method, path, body, logPath, level string
		code                                     int32
		readiness                                func(context.Context) error
	}{
		{"health", "GET", "/healthz?foo=private-query", "", "/healthz", "INFO", 0, nil},
		{"ready", "GET", "/readyz", "", "/readyz", "INFO", 0, nil},
		{"wrong method", "POST", "/healthz", "", "/healthz", "WARN", 10000, nil},
		{"missing", "GET", "/private-path?foo=private-query", "", "[unmatched]", "WARN", 10004, nil},
		{"decode", "POST", "/api/auth/login", `{"foo":"private-body"}`, "/api/auth/login", "WARN", 10000, nil},
		{"argument", "POST", "/api/auth/login", `{}`, "/api/auth/login", "WARN", 10001, nil},
		{"unauthenticated", "GET", "/api/auth/me", "", "/api/auth/me", "WARN", 10002, nil},
		{"unavailable", "GET", "/readyz", "", "/readyz", "ERROR", 10008,
			func(context.Context) error { return errors.New("private-db-password") }},
		{"panic", "GET", "/readyz", "", "/readyz", "ERROR", 10009,
			func(context.Context) error { panic("private-panic-value") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			logs := captureRequestLogs(t)
			check := tc.readiness
			if check == nil {
				check = func(context.Context) error { return nil }
			}
			handler := NewHandler(check, nil, config.DefaultServerRateLimit(), config.DefaultAuthRateLimit())
			r := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			r.Header.Set("Authorization", "Basic private-access")
			r.Header.Set("Cookie", "foo=private-cookie")
			r.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, r)
			entry := requestSummary(t, logs)
			if entry["level"] != tc.level || entry["path"] != tc.logPath || entry["method"] != tc.method ||
				entry["http_status"] != float64(200) || entry["code"] != float64(tc.code) {
				t.Fatalf("incorrect request metadata: %v", entry)
			}
			var body pb.BaseResponse
			if json.Unmarshal(response.Body.Bytes(), &body) != nil || response.Code != 200 || body.Code != tc.code {
				t.Fatal("logging changed the response")
			}
			for _, secret := range []string{"private-query", "private-path", "private-body", "private-access",
				"private-cookie", "private-db-password", "private-panic-value"} {
				if strings.Contains(logs.String(), secret) {
					t.Fatal("HTTP logs exposed private content")
				}
			}
		})
	}
}

func TestRequestLoggingRateLimit(t *testing.T) {
	logs := captureRequestLogs(t)
	limits := config.DefaultServerRateLimit()
	limits.IP.Limit = 1
	handler := NewHandler(func(context.Context) error { return nil }, nil, limits, config.DefaultAuthRateLimit())
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/missing", nil))
	logs.Reset()
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("POST", "/api/auth/login", strings.NewReader("{}")))
	entry := requestSummary(t, logs)
	if entry["level"] != "WARN" || entry["code"] != float64(10007) || entry["path"] != "/api/auth/login" ||
		response.Header().Get("Retry-After") == "" || strings.Contains(logs.String(), "HTTP request rate limited") {
		t.Fatal("rate limit did not produce a single warning summary")
	}
}

type failingWriter struct {
	*httptest.ResponseRecorder
}

func (w failingWriter) Write([]byte) (int, error) {
	return 0, errors.New("private-write-error")
}

func TestRequestLoggingArbitraryBusinessAndTransport(t *testing.T) {
	for _, tc := range []struct {
		name, level  string
		code         *int32
		handle       http.HandlerFunc
		writeFailure bool
	}{
		{"success", "INFO", new(int32), func(w http.ResponseWriter, _ *http.Request) {
			writeProtocolError(w, 0, "private-message")
		}, false},
		{"body", "INFO", new(int32), func(w http.ResponseWriter, _ *http.Request) {
			recordResponseCode(w, 0)
			_, _ = w.Write([]byte(`{"code":0,"msg":"private-message","data":{"foo":"private-refresh"}}`))
		}, false},
		{"write failure", "ERROR", new(int32), func(w http.ResponseWriter, _ *http.Request) {
			writeProtocolError(w, 0, "private-message")
		}, true},
		{"missing code", "ERROR", nil, func(http.ResponseWriter, *http.Request) {}, false},
		{"panic after write", "ERROR", new(int32), func(w http.ResponseWriter, _ *http.Request) {
			writeProtocolError(w, 0, "private-message")
			panic("private-panic")
		}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			logs := captureRequestLogs(t)
			handler := withRequestLogging(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				// The start log must exist while the business handler is still running.
				if !strings.Contains(logs.String(), `"msg":"HTTP request started"`) ||
					strings.Contains(logs.String(), `"msg":"HTTP request completed"`) {
					t.Fatal("start log not emitted before handler")
				}
				tc.handle(w, r)
			}), func(*http.Request) string {
				return "/api/other/:id"
			})
			response := httptest.NewRecorder()
			var writer http.ResponseWriter = response
			if tc.writeFailure {
				writer = failingWriter{response}
			}
			r := httptest.NewRequest("POST", "/api/other/private-path?foo=private-query",
				strings.NewReader(`{"foo":"private-password","email":"private@example.com"}`))
			r.Header.Set("Authorization", "Bearer private-access")
			r.Header.Set("Cookie", "private-cookie")
			handler.ServeHTTP(writer, r)
			entry := requestSummary(t, logs)
			if entry["level"] != tc.level || entry["path"] != "/api/other/:id" {
				t.Fatalf("incorrect arbitrary route summary: %v", entry)
			}
			if tc.code == nil {
				if _, exists := entry["code"]; exists {
					t.Fatal("invented response code")
				}
			} else if entry["code"] != float64(*tc.code) {
				t.Fatal("incorrect response code")
			}
			if tc.name == "panic after write" && strings.Contains(response.Body.String(), "服务器内部错误") {
				t.Fatal("panic appended a second response")
			}
			for _, secret := range []string{"private-path", "private-query", "private-password", "private@example.com",
				"private-access", "private-cookie", "private-message", "private-refresh",
				"private-write-error", "private-panic"} {
				if strings.Contains(logs.String(), secret) {
					t.Fatal("arbitrary business request leaked private content")
				}
			}
		})
	}
}

func TestBusinessErrorDiagnosticsExcludeDriverText(t *testing.T) {
	logs := captureRequestLogs(t)
	writeAuthError(httptest.NewRecorder(), "login", fmt.Errorf("%w: %w", auth.ErrUnavailable,
		&pgconn.PgError{Code: "42P01", Message: "private-message", Detail: "private-password", Where: "private-query"}))
	if !strings.Contains(logs.String(), `"sqlstate":"42P01"`) || !strings.Contains(logs.String(), `"level":"ERROR"`) {
		t.Fatal("safe database diagnostics lost")
	}
	if strings.Contains(logs.String(), "private-") {
		t.Fatal("business diagnostic exposed driver text")
	}
}
