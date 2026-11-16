package ws

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// Socket goroutines can log concurrently; deliver complete JSON records without sharing a buffer.
type connectionLogWriter chan map[string]any

func (w connectionLogWriter) Write(data []byte) (int, error) {
	var entry map[string]any
	if err := json.Unmarshal(data, &entry); err != nil {
		return 0, err
	}
	w <- entry
	return len(data), nil
}

func TestConnectionLogsPreserveFirstCloseCause(t *testing.T) {
	logs := make(connectionLogWriter, 128)
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })

	for _, scenario := range []struct {
		name   string
		source string
		level  string
		code   string
	}{
		{"graceful", "read", "INFO", ""},
		{"abrupt", "read", "WARN", ""},
		{"malformed", "decode", "WARN", "INCOMPATIBLE"},
		{"generation", "generation_mismatch", "WARN", "INCOMPATIBLE"},
		{"shutdown", "server_shutdown", "INFO", ""},
		{"rejected", "rejected", "WARN", "UNAUTHORIZED"},
		{"idle", "read_timeout", "WARN", ""},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			runtime, err := New(nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			opened := make(chan *Peer, 1)
			closed := make(chan struct{})
			handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				ServeHTTP(w, r, Options{
					Runtime: runtime,
					Authenticate: func(ctx context.Context, _ string) (context.Context, error) {
						return ctx, nil
					},
					Opened: func(peer *Peer) { opened <- peer },
				})
				close(closed)
			})
			server := httptest.NewServer(handler)
			t.Cleanup(server.Close)
			ctx, cancel := context.WithTimeout(context.Background(), 50*time.Second)
			defer cancel()
			socket, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), nil)
			if err != nil {
				t.Fatal(err)
			}
			defer socket.CloseNow()
			sendTest(t, socket, frame{header: header{Version: 1, Op: "authenticate",
				Token: "private-token", Manifest: &Manifest{}}})
			ready := readTest(t, socket)
			peer := <-opened
			if ready.Generation != peer.ConnectionID() || ready.Generation == "" {
				t.Fatal("connection ID does not match the wire generation")
			}

			switch scenario.name {
			case "graceful":
				_ = socket.Close(websocket.StatusNormalClosure, "private-close-reason")
			case "abrupt":
				_ = socket.CloseNow()
			case "malformed":
				_ = socket.Write(ctx, websocket.MessageBinary, []byte("private-payload"))
			case "generation":
				sendTest(t, socket, frame{header: header{
					Version: 1, Generation: "private-generation", Op: "ping", ID: "c:1",
				}})
			case "shutdown":
				peer.CloseWithReason("server_shutdown", nil)
			case "rejected":
				peer.Reject(Failure("UNAUTHORIZED", "session revoked"))
			case "idle":
				// Exercise the actual 45-second read deadline, with no client heartbeat.
			}
			select {
			case <-closed:
			case <-ctx.Done():
				t.Fatal("connection did not terminate")
			}
			peer.Close()

			var entries []map[string]any
			for len(logs) > 0 {
				entries = append(entries, <-logs)
			}
			if len(entries) != 1 {
				t.Fatalf("expected one close record, got %v", entries)
			}
			entry := entries[0]
			if entry["msg"] != "WebSocket disconnected" ||
				entry["connection_id"] != ready.Generation || entry["source"] != scenario.source ||
				entry["level"] != scenario.level {
				t.Fatalf("missing original close cause: %v", entry)
			}
			for _, field := range []string{
				"duration_ms", "last_received_ms", "last_sent_ms",
				"pending_requests", "queued_bytes",
			} {
				if _, ok := entry[field].(float64); !ok {
					t.Fatalf("missing numeric field %s: %v", field, entry)
				}
			}
			if scenario.code != "" && entry["code"] != scenario.code {
				t.Fatalf("lost protocol error: %v", entry)
			}
			if scenario.name == "graceful" && entry["ws_close_code"] != float64(1000) {
				t.Fatalf("lost close frame code: %v", entry)
			}
			if scenario.name == "abrupt" && entry["error"] == nil {
				t.Fatalf("lost underlying socket error: %v", entry)
			}
			if scenario.name == "idle" && entry["last_received_ms"].(float64) < 44_000 {
				t.Fatalf("read deadline did not retain idle duration: %v", entry)
			}
			encoded, _ := json.Marshal(entry)
			if strings.Contains(string(encoded), "private-") {
				t.Fatalf("logged credential or frame content: %s", encoded)
			}
		})
	}
}
