package httpapi

import (
	"crypto/sha256"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"

	pb "github.com/tctony-labs/xiaowei/contracts/go/gen/xiaowei/server"
	"github.com/tctony-labs/xiaowei/server/internal/config"
)

type quota struct {
	key    string
	limit  int
	window time.Duration
}

type window struct {
	count int
	until time.Time
}

type limiter struct {
	mu        sync.Mutex
	windows   map[string]window
	nextSweep time.Time
	capacity  int
}

func newLimiter() *limiter {
	return &limiter{windows: make(map[string]window), capacity: 10_000}
}

func (l *limiter) allow(now time.Time, quotas ...quota) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()

	if !now.Before(l.nextSweep) {
		for key, state := range l.windows {
			if !now.Before(state.until) {
				delete(l.windows, key)
			}
		}
		l.nextSweep = now.Add(time.Minute)
	}
	newKeys := 0
	for _, q := range quotas {
		state, exists := l.windows[q.key]
		if !exists {
			newKeys++
		}
		if now.Before(state.until) && state.count >= q.limit {
			return state.until.Sub(now)
		}
	}
	if len(l.windows)+newKeys > l.capacity {
		return time.Minute
	}
	for _, q := range quotas {
		state := l.windows[q.key]
		if !now.Before(state.until) {
			state = window{until: now.Add(q.window)}
		}
		state.count++
		l.windows[q.key] = state
	}
	return 0
}

func sourceIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return "unknown"
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return "unknown"
	}
	return ip.String()
}

func loginQuotas(r *http.Request, email string, limits config.AuthRateLimit) []quota {
	ip := sourceIP(r)
	emailHash := sha256.Sum256([]byte(email))
	return []quota{
		{key: "login:" + ip, limit: limits.LoginIP.Limit, window: limits.LoginIP.Window},
		{
			key:   fmt.Sprintf("email:%s:%x", ip, emailHash),
			limit: limits.LoginEmailIP.Limit, window: limits.LoginEmailIP.Window,
		},
	}
}

func (l *limiter) check(w http.ResponseWriter, quotas ...quota) bool {
	retry := l.allow(time.Now(), quotas...)
	if retry == 0 {
		return true
	}
	seconds := int64(retry / time.Second)
	if retry%time.Second != 0 {
		seconds++
	}
	w.Header().Set("Retry-After", strconv.FormatInt(seconds, 10))
	writeProtocolError(w, int32(pb.ErrorCode_ERROR_CODE_RATE_LIMITED), "请求过于频繁，请稍后重试")
	return false
}
