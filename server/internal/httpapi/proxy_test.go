package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"

	"github.com/tctony-labs/xiaowei/server/internal/config"
)

func TestProxySourceRequiresTrustedPeerAndSingleIP(t *testing.T) {
	for _, tc := range []struct {
		name    string
		peer    string
		headers []string
		want    string
	}{
		{"trusted IPv4", "172.18.0.1:1234", []string{"198.51.100.1"}, "198.51.100.1"},
		{"normalized IPv4", "[::ffff:172.18.0.1]:1234", []string{"::ffff:198.51.100.1"}, "198.51.100.1"},
		{"IPv6 client", "172.18.0.1:1234", []string{"2001:db8::1"}, "2001:db8::1"},
		{"untrusted peer", "192.0.2.1:1234", []string{"198.51.100.1"}, "192.0.2.1"},
		{"missing header", "172.18.0.1:1234", nil, "172.18.0.1"},
		{"invalid header", "172.18.0.1:1234", []string{"invalid"}, "172.18.0.1"},
		{"IP list", "172.18.0.1:1234", []string{"198.51.100.1, 192.0.2.1"}, "172.18.0.1"},
		{"multiple headers", "172.18.0.1:1234", []string{"198.51.100.1", "192.0.2.1"}, "172.18.0.1"},
		{"zone identifier", "172.18.0.1:1234", []string{"fe80::1%eth0"}, "172.18.0.1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			handler := WithTrustedProxies(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if got := sourceIP(r); got != tc.want {
					t.Fatalf("source = %s, want %s", got, tc.want)
				}
			}), []netip.Prefix{netip.MustParsePrefix("172.18.0.1/32")})
			r := httptest.NewRequest("GET", "/", nil)
			r.RemoteAddr = tc.peer
			r.Header["X-Real-Ip"] = tc.headers
			r.Header.Set("X-Forwarded-For", "203.0.113.1")
			handler.ServeHTTP(httptest.NewRecorder(), r)
		})
	}
}

func TestTrustedProxySeparatesRateLimitsWithoutTrustingDirectSpoofing(t *testing.T) {
	limits := config.DefaultServerRateLimit()
	limits.IP.Limit = 1
	api := NewAPI(
		func(context.Context) error { return nil }, nil, config.DefaultAuthRateLimit(),
	)
	handler := NewHandler(api, limits)
	handler = WithTrustedProxies(handler, []netip.Prefix{netip.MustParsePrefix("172.18.0.1/32")})
	request := func(peer, client string) int32 {
		t.Helper()
		r := httptest.NewRequest("POST", "/api/auth.Auth/GetCurrentUser", nil)
		r.RemoteAddr = peer
		r.Header.Set("X-Real-IP", client)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		var body struct {
			Code int32 `json:"code"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return body.Code
	}
	if request("172.18.0.1:1234", "198.51.100.1") != 10002 ||
		request("172.18.0.1:1234", "198.51.100.1") != 10007 ||
		request("172.18.0.1:1234", "198.51.100.2") != 10002 {
		t.Fatal("clients behind the trusted proxy share an IP quota")
	}
	if request("192.0.2.1:1234", "203.0.113.1") != 10002 ||
		request("192.0.2.1:1234", "203.0.113.2") != 10007 {
		t.Fatal("direct client spoofing bypasses the IP quota")
	}
}
