package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestReadinessRequiresHTTPAndBusinessSuccess(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
		ready  bool
	}{
		{"ready", 200, `{"code":0,"msg":"成功","data":{}}`, true},
		{"database unavailable", 200, `{"code":10005,"msg":"unavailable"}`, false},
		{"missing code", 200, `{}`, false},
		{"null code", 200, `{"code":null}`, false},
		{"string code", 200, `{"code":"0"}`, false},
		{"invalid JSON", 200, `<html>unavailable</html>`, false},
		{"HTTP failure", 503, `{"code":0}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, err := io.ReadAll(r.Body)
				if err != nil || r.Method != "POST" || r.URL.Path != "/api/common.Health/Ready" ||
					r.Header.Get("Content-Type") != "application/json" ||
					strings.TrimSpace(string(body)) != "{}" {
					t.Error("readiness did not use the canonical POST API")
				}
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			}))
			defer server.Close()
			err := checkReadiness(server.Client(), server.URL+"/api/common.Health/Ready")
			if (err == nil) != tc.ready {
				t.Fatalf("readiness = %v, want %v", err == nil, tc.ready)
			}
		})
	}
}

func TestReadinessNetworkFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	address := server.URL
	server.Close()
	if err := checkReadiness(&http.Client{Timeout: time.Second}, address); err == nil {
		t.Fatal("unreachable server was considered ready")
	}
}
