package httpapi

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"runtime/debug"
	"time"

	pb "github.com/tctony-labs/xiaowei/contracts/go/gen/xiaowei/server"
	"github.com/tctony-labs/xiaowei/server/internal/auth"
	"github.com/tctony-labs/xiaowei/server/internal/config"
)

func NewHandler(checkDatabase func(context.Context) error, authService *auth.Service,
	serverLimits config.ServerRateLimit, authLimits config.AuthRateLimit,
) http.Handler {
	api := &authAPI{service: authService, limiter: newLimiter(), limits: authLimits}
	globalLimiter := newLimiter()
	routes := map[string]struct {
		method string
		handle http.HandlerFunc
	}{
		"/healthz": {http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
			writeHealth(w)
		}},
		"/readyz": {http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
			ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
			defer cancel()
			if err := checkDatabase(ctx); err != nil {
				slog.Warn("readiness check failed")
				writeProtocolError(w, int32(pb.ErrorCode_ERROR_CODE_UNAVAILABLE), "service unavailable")
				return
			}
			writeHealth(w)
		}},
		"/api/auth/login":   {http.MethodPost, api.login},
		"/api/auth/refresh": {http.MethodPost, api.refresh},
		"/api/auth/me":      {http.MethodGet, api.me},
		"/api/auth/logout":  {http.MethodPost, api.logout},
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tracked := &responseWriter{ResponseWriter: w}
		defer func() {
			if recover() != nil {
				// Do not log the panic value: it may contain request data or credentials.
				slog.Error("HTTP handler panicked", "stack", string(debug.Stack()))
				if !tracked.written {
					writeProtocolError(tracked, int32(pb.ErrorCode_ERROR_CODE_INTERNAL_ERROR), "internal error")
				}
			}
		}()
		health := r.Method == http.MethodGet && (r.URL.Path == "/healthz" || r.URL.Path == "/readyz")
		if !health && !globalLimiter.check(tracked, "global", quota{
			key: sourceIP(r), limit: serverLimits.IP.Limit, window: serverLimits.IP.Window,
		}) {
			return
		}
		route, exists := routes[r.URL.Path]
		if !exists {
			writeProtocolError(tracked, int32(pb.ErrorCode_ERROR_CODE_NOT_FOUND), "route not found")
			return
		}
		if r.Method != route.method {
			writeProtocolError(tracked, int32(pb.ErrorCode_ERROR_CODE_INVALID_REQUEST), "unsupported method")
			return
		}
		route.handle(tracked, r)
	})
}

func writeHealth(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(struct {
		Code int32             `json:"code"`
		Msg  string            `json:"msg"`
		Data map[string]string `json:"data"`
	}{Msg: "ok", Data: map[string]string{"status": "ok"}})
}

type responseWriter struct {
	http.ResponseWriter
	written bool
}

func (w *responseWriter) WriteHeader(status int) {
	w.written = true
	w.ResponseWriter.WriteHeader(status)
}

func (w *responseWriter) Write(body []byte) (int, error) {
	w.written = true
	return w.ResponseWriter.Write(body)
}
