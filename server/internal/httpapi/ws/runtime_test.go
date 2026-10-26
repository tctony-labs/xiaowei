package ws

import (
	"context"
	"encoding/binary"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	pb "github.com/tctony-labs/xiaowei/contracts/out/proto-server-go/gen/testing"
	"google.golang.org/protobuf/proto"
)

func TestWireRejectsMalformedAndPreservesBytes(t *testing.T) {
	input := frame{header: header{Version: 1, Generation: "test", Op: "invoke"},
		payload: []byte{0, 255, 128}, options: []byte{0, 255}}
	wire, err := encode(input)
	if err != nil {
		t.Fatal(err)
	}
	output, err := decode(wire)
	if err != nil || string(input.payload) != string(output.payload) ||
		string(input.options) != string(output.options) {
		t.Fatal("wire did not preserve original bytes")
	}
	badLength := append([]byte(nil), wire...)
	binary.BigEndian.PutUint32(badLength, maxMetadata+1)
	for _, data := range [][]byte{nil, {0, 0, 0}, badLength, []byte("invalid")} {
		if _, err := decode(data); err == nil {
			t.Fatal("malformed frame accepted")
		}
	}
	if _, err := encode(frame{payload: make([]byte, MaxPayload+1)}); err == nil {
		t.Fatal("oversized payload accepted")
	}
}

func testPeer(t *testing.T, runtime *Runtime) (*websocket.Conn, string) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ServeHTTP(w, r, Options{Runtime: runtime, Authenticate: func(
			ctx context.Context, token string,
		) (context.Context, error) {
			if token != "fixture" {
				return nil, Failure("UNAUTHORIZED", "credential rejected")
			}
			return ctx, nil
		}})
	}))
	t.Cleanup(server.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	socket, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = socket.CloseNow() })
	sendTest(t, socket, frame{header: header{Version: 1, Op: "authenticate", Token: "fixture",
		Manifest: &Manifest{Routes: []Route{}, Events: []Event{}}}})
	ready := readTest(t, socket)
	if ready.Op != "ready" || ready.Generation == "" {
		t.Fatal("missing authenticated ready")
	}
	return socket, ready.Generation
}

func sendTest(t *testing.T, socket *websocket.Conn, value frame) {
	t.Helper()
	wire, err := encode(value)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := socket.Write(ctx, websocket.MessageBinary, wire); err != nil {
		t.Fatal(err)
	}
}

func readTest(t *testing.T, socket *websocket.Conn) frame {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, wire, err := socket.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	f, err := decode(wire)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func TestTimeoutAndCancellationRetainActualAdmission(t *testing.T) {
	started := make(chan struct{}, 2)
	release := make(chan struct{})
	methods := pb.File_testing_fixture_proto.Services().ByName("Fixture").Methods()
	runtime, err := New([]Registration{{Method: methods.ByName("Echo"), MaxConcurrency: 1,
		Timeout: 30 * time.Millisecond,
		Handler: func(ctx context.Context, input proto.Message, peer *Peer) (proto.Message, error) {
			started <- struct{}{}
			<-release
			return input, nil
		}}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	socket, generation := testPeer(t, runtime)
	route := runtime.manifest.Routes[0]
	sendTest(t, socket, frame{header: header{
		Version: 1, Generation: generation, Op: "invoke", ID: "c:1", Route: &route,
	}})
	<-started
	response := readTest(t, socket)
	if response.Error == nil || response.Error.Code != "TIMEOUT" {
		t.Fatal("missing execution timeout")
	}
	sendTest(t, socket, frame{header: header{
		Version: 1, Generation: generation, Op: "invoke", ID: "c:2", Route: &route,
	}})
	response = readTest(t, socket)
	if response.Error == nil || response.Error.Code != "CONCURRENCY_FULL" {
		t.Fatal("timeout released actual handler admission")
	}
	close(release)
}

func TestNetworkRoutesAreExplicitAndConnectionGenerationIsRequired(t *testing.T) {
	runtime, err := New(nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	socket, generation := testPeer(t, runtime)
	sendTest(t, socket, frame{header: header{Version: 1, Generation: generation, Op: "invoke", ID: "c:1",
		Route: &Route{Name: "local.Storage.Get", Kind: "unary", ControlVersion: 3, ContractVersion: 1,
			Input: "testing.Envelope", Output: "testing.Envelope"}}})
	response := readTest(t, socket)
	if response.Error == nil || response.Error.Code != "UNAUTHORIZED" {
		t.Fatal("local route exposed over network")
	}
	sendTest(t, socket, frame{header: header{Version: 1, Generation: "old", Op: "ping", ID: "c:2"}})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, _, err := socket.Read(ctx); err == nil {
		t.Fatal("stale connection generation accepted")
	}
}

func TestHandshakeRejectsClientInterfaces(t *testing.T) {
	runtime, err := New(nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ServeHTTP(w, r, Options{Runtime: runtime, Authenticate: func(
			ctx context.Context, _ string,
		) (context.Context, error) {
			return ctx, nil
		}})
	}))
	t.Cleanup(server.Close)

	for _, scenario := range []struct {
		name     string
		manifest Manifest
	}{
		{
			name: "method",
			manifest: Manifest{Routes: []Route{{
				Name: "client.Echo", Kind: "unary", ControlVersion: 3, ContractVersion: 1,
				Input: "testing.Envelope", Output: "testing.Envelope",
				TimeoutMS: 1000, MaxConcurrency: 1,
			}}},
		},
		{
			name:     "event",
			manifest: Manifest{Events: []Event{{Name: "client.Changed", Policy: "ordered"}}},
		},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			socket, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), nil)
			if err != nil {
				t.Fatal(err)
			}
			defer socket.CloseNow()
			sendTest(t, socket, frame{header: header{
				Version: 1, Op: "authenticate", Token: "fixture", Manifest: &scenario.manifest,
			}})
			if _, _, err := socket.Read(ctx); err == nil {
				t.Fatal("server accepted client interfaces")
			}
		})
	}
}
