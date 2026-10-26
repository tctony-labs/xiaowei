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

	pb "github.com/tctony-labs/xiaowei/contracts/out/proto-server-go/gen/testing"
	"github.com/tctony-labs/xiaowei/server/internal/httpapi/ws"
	"google.golang.org/protobuf/proto"
)

var active atomic.Int32

func main() {
	methods := pb.File_testing_fixture_proto.Services().ByName("Fixture").Methods()
	policy := ws.DefaultStreamPolicy()
	policy.ConsumerIdleMS = 300
	runtime, err := ws.New([]ws.Registration{
		{Method: methods.ByName("Echo"), Timeout: 5 * time.Second, MaxConcurrency: 2,
			Handler: func(ctx context.Context, request proto.Message, peer *ws.Peer) (proto.Message, error) {
				value := request.(*pb.Envelope)
				switch value.Text {
				case "disconnect":
					peer.Close()
					return nil, ws.Failure("OWNER_UNAVAILABLE", "fixture disconnected")
				case "wait":
					active.Add(1)
					defer active.Add(-1)
					<-ctx.Done()
					return nil, ctx.Err()
				case "ignore":
					time.Sleep(400 * time.Millisecond)
				case "active":
					return &pb.Envelope{Id: uint64(active.Load())}, nil
				case "publish":
					wire, _ := proto.Marshal(&pb.Changed{Value: value})
					err := peer.Publish("testing.Changed", wire, func(filter []byte) bool {
						expected := new(pb.Envelope)
						return proto.Unmarshal(filter, expected) == nil && expected.Id == value.Id
					})
					return value, err
				case "failure":
					return nil, ws.Failure("INVALID_ARGUMENT", "fixture rejected")
				}
				return value, nil
			}},
		{Method: methods.ByName("Watch"), Policy: policy,
			StreamHandler: func(ctx context.Context, request proto.Message, _ *ws.Peer) (ws.Source, error) {
				input := request.(*pb.Envelope)
				if input.Text == "openwait" {
					<-ctx.Done()
					return nil, ctx.Err()
				}
				active.Add(1)
				return &source{request: input}, nil
			}},
	}, []ws.Event{{Name: "testing.Changed", Policy: "ordered", Validate: func(filter []byte) error {
		if proto.Unmarshal(filter, new(pb.Envelope)) != nil {
			return ws.Failure("INVALID_ARGUMENT", "invalid filter")
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
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws.ServeHTTP(w, r, ws.Options{Runtime: runtime,
			Authenticate: func(ctx context.Context, token string) (context.Context, error) {
				if token != "fixture" {
					return nil, ws.Failure("UNAUTHORIZED", "fixture credential rejected")
				}
				return ctx, nil
			}})
	})
	var endpoint http.Handler = handler
	if auth := authFixture(); auth != nil {
		endpoint = auth
	}
	server := &http.Server{Handler: endpoint}
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
		return nil, false, ws.Failure("INVALID_ARGUMENT", "producer rejected")
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
