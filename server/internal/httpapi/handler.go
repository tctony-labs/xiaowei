package httpapi

import (
	"math"
	"net/http"
	"strconv"

	pb "github.com/tctony-labs/xiaowei/contracts/go/gen/xiaowei/server"
	"github.com/tctony-labs/xiaowei/server/internal/config"
)

func NewHandler(api *API, serverLimits config.ServerRateLimit,
	connections ...*ConnectionHub,
) http.Handler {
	globalLimiter := newLimiter()
	return withRequestLogging(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		entry := api.methods[r.URL.Path]
		if entry != nil {
			if tracked, ok := w.(*responseWriter); ok {
				tracked.apiMethod = string(entry.method.FullName())
			}
		}
		probe := entry != nil && entry.probe && r.Method == http.MethodPost
		if !probe && !globalLimiter.check(w, quota{
			key: sourceIP(r), limit: serverLimits.IP.Limit, window: serverLimits.IP.Window,
		}) {
			return
		}
		if r.URL.Path == "/api/ws" && len(connections) > 0 {
			if r.Method != http.MethodGet {
				writeProtocolError(w, int32(pb.ErrorCode_ERROR_CODE_INVALID_REQUEST),
					"不支持此请求方法")
				return
			}
			connections[0].ServeHTTP(w, r)
			return
		}
		if entry == nil {
			writeProtocolError(w, int32(pb.ErrorCode_ERROR_CODE_NOT_FOUND), "接口不存在")
			return
		}
		if r.Method != http.MethodPost {
			writeProtocolError(w, int32(pb.ErrorCode_ERROR_CODE_INVALID_REQUEST),
				"不支持此请求方法")
			return
		}
		call := apiCall{ip: sourceIP(r)}
		if entry.before != nil {
			if failure := entry.before(call); failure != nil {
				writeAuthError(w, string(entry.method.FullName()), failure)
				return
			}
		}
		input := entry.input.New().Interface()
		if !readAPIRequest(w, r, input, entry.method.Input().Fields().Len() == 0) {
			return
		}
		if entry.requiresSession {
			identity, err := api.auth.authenticate(r)
			if err != nil {
				writeAuthError(w, string(entry.method.FullName()), err)
				return
			}
			call.identity = identity
		}
		response, failure := entry.invoke(r.Context(), input, call)
		if failure != nil && failure.retry != 0 {
			seconds := int64(math.Ceil(failure.retry.Seconds()))
			w.Header().Set("Retry-After", strconv.FormatInt(seconds, 10))
		}
		writeAPIJSON(w, response)
	}), func(r *http.Request) string {
		if api.methods[r.URL.Path] != nil || (r.URL.Path == "/api/ws" && len(connections) > 0) {
			return r.URL.Path
		}
		return "[unmatched]"
	})
}
