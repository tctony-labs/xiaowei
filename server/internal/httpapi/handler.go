package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
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
		health bool
	}{
		"/healthz": {http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
			writeHealth(w)
		}, true},
		"/readyz": {http.MethodGet, func(w http.ResponseWriter, r *http.Request) {
			ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
			defer cancel()
			if err := checkDatabase(ctx); err != nil {
				writeProtocolError(w, int32(pb.ErrorCode_ERROR_CODE_UNAVAILABLE), "服务暂不可用")
				return
			}
			writeHealth(w)
		}, true},
		"/api/auth/login":   {http.MethodPost, api.login, false},
		"/api/auth/refresh": {http.MethodPost, api.refresh, false},
		"/api/auth/me":      {http.MethodGet, api.me, false},
		"/api/auth/logout":  {http.MethodPost, api.logout, false},
	}
	return withRequestLogging(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		route, exists := routes[r.URL.Path]
		health := exists && route.health && r.Method == route.method
		if !health && !globalLimiter.check(w, quota{
			key: sourceIP(r), limit: serverLimits.IP.Limit, window: serverLimits.IP.Window,
		}) {
			return
		}
		if !exists {
			writeProtocolError(w, int32(pb.ErrorCode_ERROR_CODE_NOT_FOUND), "接口不存在")
			return
		}
		if r.Method != route.method {
			writeProtocolError(w, int32(pb.ErrorCode_ERROR_CODE_INVALID_REQUEST), "不支持此请求方法")
			return
		}
		route.handle(w, r)
	}), func(r *http.Request) string {
		_, exists := routes[r.URL.Path]
		if !exists {
			return "[unmatched]"
		}
		// Supply matched route metadata before logging; never echo unknown paths.
		return r.URL.Path
	})
}

func writeHealth(w http.ResponseWriter) {
	recordResponseCode(w, 0)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(struct {
		Code int32             `json:"code"`
		Msg  string            `json:"msg"`
		Data map[string]string `json:"data"`
	}{Msg: "成功", Data: map[string]string{"status": "ok"}})
}
