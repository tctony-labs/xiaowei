package ws

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"

	fixture "github.com/tctony-labs/xiaowei/contracts/out/proto-server-go/gen/testing"
	pb "github.com/tctony-labs/xiaowei/contracts/out/proto-server-go/gen/xiaowei/server"
	"google.golang.org/protobuf/proto"
)

func captureLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	buffer := new(bytes.Buffer)
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(buffer, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	return buffer
}

func requestLog(t *testing.T, buffer *bytes.Buffer) map[string]any {
	t.Helper()
	var entry map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(buffer.Bytes()), &entry); err != nil {
		t.Fatal(err)
	}
	if entry["msg"] != "WebSocket request completed" || entry["transport"] != "websocket" ||
		entry["duration_ms"] == nil {
		t.Fatalf("missing request metadata: %v", entry)
	}
	return entry
}

func TestRequestLogsIncludeFailuresBeforeHandlerExecution(t *testing.T) {
	logs := captureLogs(t)
	calls := 0
	methods := fixture.File_testing_fixture_proto.Services().ByName("Fixture").Methods()
	method := methods.ByName("Echo")
	runtime, err := New([]Registration{{Method: method,
		Handler: func(_ context.Context, input proto.Message, _ *Peer) (proto.Message, error) {
			calls++
			return input, nil
		},
	}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	incompatible := runtime.manifest.Routes[0]
	incompatible.ContractVersion++
	for _, scenario := range []struct {
		name    string
		route   *Route
		payload []byte
		code    string
		message string
		method  string
	}{
		{"missing", nil, nil, "INVALID_ARGUMENT", "missing route", "[unexported]"},
		{"unknown", &Route{Name: "private-route"}, nil, "UNAUTHORIZED",
			"route not exported to network", "[unexported]"},
		{"contract", &incompatible, nil, "INCOMPATIBLE",
			"route contract mismatch", string(method.FullName())},
		{"protobuf", &runtime.manifest.Routes[0], []byte{255}, "INVALID_ARGUMENT",
			"invalid request protobuf", string(method.FullName())},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			logs.Reset()
			_, err := runtime.invoke(context.Background(), nil,
				frame{header: header{Route: scenario.route}, payload: scenario.payload})
			if err == nil || protocolError(err).Code != scenario.code || calls != 0 {
				t.Fatalf("request unexpectedly reached handler: calls=%d err=%v", calls, err)
			}
			entry := requestLog(t, logs)
			if entry["code"] != scenario.code || entry["response_msg"] != scenario.message ||
				entry["level"] != "WARN" || entry["method"] != scenario.method {
				t.Fatalf("original protocol error missing: %v", entry)
			}
			if strings.Contains(logs.String(), "private-route") {
				t.Fatal("unexported route was logged verbatim")
			}
		})
	}
}

func TestRequestLogsUseBusinessCodeAndMessage(t *testing.T) {
	logs := captureLogs(t)
	response := new(pb.GetCurrentUserResponse)
	methods := pb.File_xiaowei_server_auth_proto.Services().ByName("Auth").Methods()
	method := methods.ByName("GetCurrentUser")
	runtime, err := New([]Registration{{Method: method,
		Handler: func(context.Context, proto.Message, *Peer) (proto.Message, error) {
			return response, nil
		},
	}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []struct {
		code    int32
		message string
		level   string
	}{
		{0, "成功", "INFO"},
		{10100, "邮箱或密码错误", "WARN"},
		{10008, "数据库暂不可用", "ERROR"},
	} {
		logs.Reset()
		response.Code, response.Msg = scenario.code, scenario.message
		payload, err := runtime.invoke(context.Background(), nil,
			frame{header: header{Route: &runtime.manifest.Routes[0]}})
		if err != nil {
			t.Fatal(err)
		}
		decoded := new(pb.GetCurrentUserResponse)
		if err := proto.Unmarshal(payload, decoded); err != nil || !proto.Equal(response, decoded) {
			t.Fatalf("logging changed response: %v", err)
		}
		entry := requestLog(t, logs)
		if entry["code"] != float64(scenario.code) || entry["response_msg"] != scenario.message ||
			entry["level"] != scenario.level {
			t.Fatalf("original business response missing: %v", entry)
		}
	}
}
