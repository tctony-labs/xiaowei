package httpapi

import (
	"log/slog"
	"net/http"
	"runtime/debug"
	"time"

	pb "github.com/tctony-labs/xiaowei/contracts/go/gen/xiaowei/server"
)

func withRequestLogging(next http.Handler, resolveRoute func(*http.Request) string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		path := resolveRoute(r)
		tracked := &responseWriter{ResponseWriter: w, path: path}
		slog.InfoContext(r.Context(), "HTTP request started", "method", r.Method, "path", path)
		defer func() {
			if recover() != nil {
				tracked.panicked = true
				// Panic values may contain request data. Only retain the diagnostic stack.
				slog.Error("HTTP handler panicked", "stack", string(debug.Stack()))
				if !tracked.written {
					writeProtocolError(tracked, int32(pb.ErrorCode_ERROR_CODE_INTERNAL_ERROR), "服务器内部错误")
				}
			}
			tracked.log(r, time.Since(start))
		}()
		next.ServeHTTP(tracked, r)
	})
}

type responseWriter struct {
	http.ResponseWriter
	written   bool
	status    int
	code      *int32
	path      string
	panicked  bool
	writeFail bool
}

func (w *responseWriter) WriteHeader(status int) {
	if !w.written {
		w.status = status
		w.written = true
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *responseWriter) Write(body []byte) (int, error) {
	if !w.written {
		w.WriteHeader(http.StatusOK)
	}
	n, err := w.ResponseWriter.Write(body)
	if err != nil {
		w.writeFail = true
	}
	return n, err
}

func recordResponseCode(w http.ResponseWriter, code int32) {
	if tracked, ok := w.(*responseWriter); ok {
		tracked.code = &code
	}
}

func (w *responseWriter) log(r *http.Request, duration time.Duration) {
	level := slog.LevelInfo
	switch {
	case w.panicked:
		level = slog.LevelError
	case w.writeFail:
		level = slog.LevelError
	case w.status >= 500:
		level = slog.LevelError
	case w.status >= 400:
		level = slog.LevelWarn
	case w.code == nil:
		level = slog.LevelError
	case *w.code == int32(pb.ErrorCode_ERROR_CODE_INTERNAL_ERROR) ||
		*w.code == int32(pb.ErrorCode_ERROR_CODE_UNAVAILABLE):
		level = slog.LevelError
	case *w.code != 0:
		level = slog.LevelWarn
	}

	// Only metadata enters this logger; no body, headers or raw URL is inspected.
	fields := []any{
		"method", r.Method, "path", w.path, "duration_ms", duration.Milliseconds(),
	}
	status := w.status
	if !w.written {
		// net/http sends an implicit 200 when a handler returns without writing.
		status = http.StatusOK
	}
	fields = append(fields, "http_status", status)
	if w.code != nil {
		fields = append(fields, "code", *w.code)
	}
	slog.Log(r.Context(), level, "HTTP request completed", fields...)
}
