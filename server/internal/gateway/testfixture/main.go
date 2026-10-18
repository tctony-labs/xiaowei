// A standalone, test-only endpoint. Never linked into the application binary.
package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"sync/atomic"
	"time"

	pb "github.com/tctony-labs/xiaowei/contracts/go/gen/testing"
	"github.com/tctony-labs/xiaowei/server/internal/gateway"
	"google.golang.org/protobuf/proto"
)

var active atomic.Int32
var received atomic.Int32

func main() {
	methods := pb.File_testing_fixture_proto.Services().ByName("Fixture").Methods()
	callback := gateway.Route{Name: "testing.PeerFixture.Echo", Kind: "unary", ControlVersion: 3,
		ContractVersion: 1, Input: "testing.Envelope", Output: "testing.Envelope"}
	remoteWatch := gateway.Route{Name: "testing.PeerFixture.Watch", Kind: "serverStreaming", ControlVersion: 3,
		ContractVersion: 1, Input: "testing.Envelope", Output: "testing.Changed"}
	policy := gateway.DefaultStreamPolicy()
	policy.ConsumerIdleMS = 300
	runtime, err := gateway.New([]gateway.Registration{
		{Method: methods.ByName("Echo"), Timeout: 5 * time.Second, MaxConcurrency: 2,
			Handler: func(ctx context.Context, request proto.Message, peer *gateway.Peer) (proto.Message, error) {
				value := request.(*pb.Envelope)
				switch value.Text {
				case "disconnect":
					peer.Close()
					return nil, gateway.Failure("OWNER_UNAVAILABLE", "fixture disconnected")
				case "callback":
					wire, _ := proto.Marshal(value)
					result, err := peer.Invoke(ctx, callback, wire)
					if err != nil {
						return nil, err
					}
					response := new(pb.Envelope)
					err = proto.Unmarshal(result, response)
					return response, err
				case "reverse-stream":
					wire, _ := proto.Marshal(value)
					stream, err := peer.Stream(ctx, remoteWatch, wire)
					if err != nil {
						return nil, err
					}
					defer stream.Close()
					var count uint64
					for {
						_, done, err := stream.Next(ctx)
						if err != nil {
							return nil, err
						}
						if done {
							break
						}
						count++
					}
					return &pb.Envelope{Id: count}, nil
				case "wait":
					active.Add(1)
					defer active.Add(-1)
					<-ctx.Done()
					return nil, ctx.Err()
				case "ignore":
					time.Sleep(400 * time.Millisecond)
				case "eventcount":
					return &pb.Envelope{Id: uint64(received.Load())}, nil
				case "active":
					return &pb.Envelope{Id: uint64(active.Load())}, nil
				case "publish":
					wire, _ := proto.Marshal(&pb.Changed{Value: value})
					err := peer.Publish("testing.Changed", wire, func(filter []byte) bool {
						expected := new(pb.Envelope)
						return proto.Unmarshal(filter, expected) == nil && expected.Id == value.Id
					})
					return value, err
				case "subscribe":
					_, err := peer.Subscribe(ctx, "testing.Changed", nil, func(_ context.Context, wire []byte) error {
						event := new(pb.Changed)
						if proto.Unmarshal(wire, event) == nil {
							received.Add(1)
						}
						return nil
					})
					return value, err
				case "failure":
					return nil, gateway.Failure("INVALID_ARGUMENT", "fixture rejected")
				}
				return value, nil
			}},
		{Method: methods.ByName("Watch"), Policy: policy,
			StreamHandler: func(ctx context.Context, request proto.Message, _ *gateway.Peer) (gateway.Source, error) {
				input := request.(*pb.Envelope)
				if input.Text == "openwait" {
					<-ctx.Done()
					return nil, ctx.Err()
				}
				active.Add(1)
				return &source{request: input}, nil
			}},
	}, []gateway.Event{{Name: "testing.Changed", Policy: "ordered", Validate: func(filter []byte) error {
		if proto.Unmarshal(filter, new(pb.Envelope)) != nil {
			return gateway.Failure("INVALID_ARGUMENT", "invalid filter")
		}
		return nil
	}}})
	if err != nil {
		panic(err)
	}
	address := os.Getenv("XIAOWEI_WS_FIXTURE_LISTEN")
	if address == "" {
		address = "127.0.0.1:0"
	}
	listener, err := net.Listen("tcp", address)
	if err != nil {
		panic(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gateway.ServeHTTP(w, r, gateway.Options{Runtime: runtime,
			Authenticate: func(ctx context.Context, token string) (context.Context, error) {
				if token != "fixture" {
					return nil, gateway.Failure("UNAUTHORIZED", "fixture credential rejected")
				}
				return ctx, nil
			}, AllowRemote: func(gateway.Manifest) bool { return true }})
	})}
	fmt.Println("ws://" + listener.Addr().String())
	go func() { _, _ = io.Copy(io.Discard, os.Stdin); _ = server.Close() }()
	_ = server.Serve(listener)
}

type source struct {
	request *pb.Envelope
	index   int
}

func (s *source) Next(ctx context.Context) ([]byte, bool, error) {
	if s.request.Text == "nextwait" {
		<-ctx.Done()
		return nil, false, ctx.Err()
	}
	if s.request.Text == "fail" && s.index == 1 {
		return nil, false, gateway.Failure("INVALID_ARGUMENT", "producer rejected")
	}
	if s.index == 3 {
		return nil, true, nil
	}
	s.index++
	value := proto.Clone(s.request).(*pb.Envelope)
	value.Id = uint64(s.index)
	wire, err := proto.Marshal(&pb.Changed{Value: value})
	return wire, false, err
}

func (s *source) Close() error { active.Add(-1); return nil }
