package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/tctony-labs/xiaowei/server/internal/config"
)

func TestGlobalRateLimit(t *testing.T) {
	limits := config.DefaultServerRateLimit()
	limits.IP = config.RateLimit{Limit: 2, Window: 1500 * time.Millisecond}
	handler := NewHandler(func(context.Context) error { return nil }, nil, limits, config.DefaultAuthRateLimit())
	request := func(method, path, ip string) (int32, string) {
		t.Helper()
		r := httptest.NewRequest(method, path, nil)
		r.RemoteAddr = ip
		r.Header.Set("X-Forwarded-For", "198.51.100.2")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		var body struct {
			Code int32
			Data json.RawMessage
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if w.Code != http.StatusOK {
			t.Fatal("non-200 response")
		}
		if body.Code == 10007 && body.Data != nil {
			t.Fatal("limit response has data")
		}
		return body.Code, w.Header().Get("Retry-After")
	}
	ip := "192.0.2.1:1234"
	if code, _ := request("GET", "/api/auth/me", ip); code != 10002 {
		t.Fatalf("first request: %d", code)
	}
	if code, _ := request("GET", "/missing", ip); code != 10004 {
		t.Fatalf("second request: %d", code)
	}
	if code, retry := request("POST", "/api/auth/logout", "[::ffff:192.0.2.1]:9999"); code != 10007 || retry != "2" {
		t.Fatalf("shared normalized IP quota: %d, %s", code, retry)
	}
	for _, path := range []string{"/healthz", "/readyz"} {
		if code, _ := request("GET", path, ip); code != 0 {
			t.Fatal("health limited")
		}
		if code, _ := request("POST", path, ip); code != 10007 {
			t.Fatal("invalid method bypassed limit")
		}
	}
	if code, _ := request("GET", "/api/auth/me", "192.0.2.2:1234"); code == 10007 {
		t.Fatal("IP quotas not isolated")
	}
}

func TestLayeredRateLimits(t *testing.T) {
	global := config.DefaultServerRateLimit()
	global.IP.Limit = 3
	dedicated := config.DefaultAuthRateLimit()
	dedicated.RefreshIP = config.RateLimit{Limit: 1, Window: 5 * time.Minute}
	handler := NewHandler(func(context.Context) error { return nil }, nil, global, dedicated)
	for i, wantRetry := range []string{"", "300", "300", "60"} {
		r := httptest.NewRequest("POST", "/api/auth/refresh", nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if got := w.Header().Get("Retry-After"); got != wantRetry {
			t.Fatalf("request %d: retry %q, want %q", i, got, wantRetry)
		}
	}
}
