package httpapi

import (
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tctony-labs/xiaowei/server/internal/config"
)

func TestLimiterConcurrencyAndExpiry(t *testing.T) {
	l := newLimiter()
	now := time.Now()
	q := quota{key: "source", limit: 5, window: time.Minute}
	var accepted atomic.Int32
	var workers sync.WaitGroup
	for range 20 {
		workers.Go(func() {
			if l.allow(now, q) == 0 {
				accepted.Add(1)
			}
		})
	}
	workers.Wait()
	if accepted.Load() != 5 || l.allow(now.Add(30*time.Second), q) != 30*time.Second {
		t.Fatal("window limit or retry duration incorrect")
	}
	if l.allow(now.Add(time.Minute), q) != 0 {
		t.Fatal("expired limit did not reset")
	}
}

func TestLimiterCapacityAndAtomicQuotas(t *testing.T) {
	l := newLimiter()
	l.capacity = 2
	now := time.Now()
	first := quota{key: "first", limit: 1, window: time.Minute}
	second := quota{key: "second", limit: 2, window: time.Minute}
	if l.allow(now, first, second) != 0 || l.allow(now, first, second) == 0 {
		t.Fatal("combined quotas incorrect")
	}
	if l.windows[second.key].count != 1 {
		t.Fatal("rejected request consumed another quota")
	}
	third := quota{key: "third", limit: 1, window: time.Minute}
	if l.allow(now, third) == 0 || len(l.windows) != 2 {
		t.Fatal("limiter capacity was exceeded")
	}
	if l.allow(now.Add(time.Minute), third) != 0 || len(l.windows) != 1 {
		t.Fatal("expired keys were not cleaned up")
	}
}

func TestSourceIgnoresProxyHeaders(t *testing.T) {
	r := httptest.NewRequest("POST", "/api/auth/login", nil)
	r.RemoteAddr = "[::ffff:192.0.2.1]:1234"
	r.Header.Set("X-Forwarded-For", "198.51.100.1")
	if sourceIP(r) != "192.0.2.1" {
		t.Fatal("proxy header changed trusted source")
	}
	first := loginQuotas(r, "a@example.com", config.DefaultAuthRateLimit())
	second := loginQuotas(r, "b@example.com", config.DefaultAuthRateLimit())
	if first[1].key == second[1].key {
		t.Fatal("email quotas are not isolated")
	}
}
