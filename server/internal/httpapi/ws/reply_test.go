package ws

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	pb "github.com/tctony-labs/xiaowei/contracts/out/proto-server-go/gen/testing"
	"google.golang.org/protobuf/proto"
)

func TestReplyCleanupOnceAndLateRegistration(t *testing.T) {
	completion := &replyCompletion{}
	ctx := context.WithValue(context.Background(), replyKey{}, completion)
	var calls atomic.Int32
	AfterReply(ctx, func() { calls.Add(1) })
	completion.finish()
	completion.finish()
	AfterReply(ctx, func() { calls.Add(1) })
	if calls.Load() != 2 {
		t.Fatal("reply cleanup was lost or repeated")
	}
	peer := &Peer{}
	if peer.EndAfterReply(ctx) == nil {
		t.Fatal("late terminal request accepted")
	}
}

func TestTerminalReplyIsWrittenBeforeCloseAndNewOperationsAreRejected(t *testing.T) {
	entered := make(chan *Peer, 1)
	release := make(chan struct{})
	cleaned := make(chan struct{})
	methods := pb.File_testing_fixture_proto.Services().ByName("Fixture").Methods()
	method := methods.ByName("Echo")
	runtime, err := New([]Registration{{Method: method, Name: "fixture/Echo",
		Handler: func(
			ctx context.Context, input proto.Message, peer *Peer,
		) (proto.Message, error) {
			if err := peer.EndAfterReply(ctx); err != nil {
				return nil, err
			}
			AfterReply(ctx, func() { close(cleaned) })
			entered <- peer
			<-release
			return input, nil
		},
	}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	socket, generation := testPeer(t, runtime)
	route := runtime.manifest.Routes[0]
	if route.Input != "testing.Envelope" || route.Output != "testing.Envelope" {
		t.Fatal("export name changed PB identity")
	}
	payload, _ := proto.Marshal(&pb.Envelope{Text: "final success"})
	sendTest(t, socket, frame{header: header{Version: 1, Generation: generation,
		Op: "invoke", ID: "c:terminal", Route: &route}, payload: payload})
	peer := <-entered
	peer.verifyMu.Lock()
	peer.check = func(context.Context) error { return Failure("UNAUTHORIZED", "session revoked") }
	peer.verifyMu.Unlock()
	if peer.verify(context.Background(), true) != nil {
		t.Fatal("monitor raced terminal reply")
	}
	sendTest(t, socket, frame{header: header{Version: 1, Generation: generation,
		Op: "invoke", ID: "c:after", Route: &route}})
	rejected := readTest(t, socket)
	if rejected.ID != "c:after" || rejected.Error == nil ||
		rejected.Error.Code != "OWNER_UNAVAILABLE" {
		t.Fatal("terminal connection accepted another operation")
	}
	select {
	case <-cleaned:
		t.Fatal("reply cleanup ran before write")
	default:
	}
	close(release)
	response := readTest(t, socket)
	if response.ID != "c:terminal" || response.Error != nil ||
		string(response.payload) != string(payload) {
		t.Fatal("terminal response was lost")
	}
	select {
	case <-cleaned:
	case <-time.After(time.Second):
		t.Fatal("terminal cleanup not released")
	}
}

func TestReplyCleanupOnCancellationTimeoutAndSocketClose(t *testing.T) {
	for _, scenario := range []string{"cancel", "timeout", "socket close"} {
		t.Run(scenario, func(t *testing.T) {
			entered := make(chan struct{})
			cleaned := make(chan struct{})
			late := make(chan struct{})
			release := make(chan struct{})
			methods := pb.File_testing_fixture_proto.Services().ByName("Fixture").Methods()
			method := methods.ByName("Echo")
			runtime, err := New([]Registration{{Method: method, Timeout: 80 * time.Millisecond,
				Handler: func(
					ctx context.Context, input proto.Message, peer *Peer,
				) (proto.Message, error) {
					if err := peer.EndAfterReply(ctx); err != nil {
						return nil, err
					}
					AfterReply(ctx, func() { close(cleaned) })
					close(entered)
					<-release
					AfterReply(ctx, func() { close(late) })
					return input, nil
				},
			}}, nil)
			if err != nil {
				t.Fatal(err)
			}
			socket, generation := testPeer(t, runtime)
			route := runtime.manifest.Routes[0]
			sendTest(t, socket, frame{header: header{Version: 1, Generation: generation,
				Op: "invoke", ID: "c:1", Route: &route}})
			<-entered
			switch scenario {
			case "cancel":
				sendTest(t, socket, frame{header: header{Version: 1, Generation: generation,
					Op: "cancel", ID: "c:cancel", Target: "c:1"}})
			case "socket close":
				_ = socket.CloseNow()
			}
			select {
			case <-cleaned:
			case <-time.After(time.Second):
				t.Fatal("cleanup leaked")
			}
			close(release)
			select {
			case <-late:
			case <-time.After(time.Second):
				t.Fatal("late callback leaked")
			}
		})
	}
}
