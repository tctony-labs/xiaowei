package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"time"

	pb "github.com/tctony-labs/xiaowei/contracts/out/proto-server-go/gen/xiaowei/server"
	"github.com/tctony-labs/xiaowei/server/internal/httpapi/ws"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

type tokenKey struct{}

// Test-only bridge to the desktop's isolated HTTP authentication fixture. Both directions
// use real sockets and production PB/wire codecs; no client transport injection is needed.
func authFixture() http.Handler {
	target := os.Getenv("XIAOWEI_AUTH_FIXTURE_TARGET")
	if target == "" {
		return nil
	}
	client := &http.Client{Timeout: 5 * time.Second}
	post := func(ctx context.Context, path string, token string, body []byte) ([]byte, error) {
		request, err := http.NewRequestWithContext(ctx, "POST", target+path, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("X-Fixture-Transport", "websocket")
		response, err := client.Do(request)
		if err != nil {
			return nil, err
		}
		defer response.Body.Close()
		return io.ReadAll(io.LimitReader(response.Body, 65537))
	}
	methods := pb.File_xiaowei_server_auth_proto.Services().ByName("Auth").Methods()
	registrations := []ws.Registration{}
	for _, name := range []string{"GetCurrentUser", "Logout"} {
		method := methods.ByName(protoreflect.Name(name))
		registrations = append(registrations, ws.Registration{
			Method: method, Name: "Auth/" + name,
			Handler: func(
				ctx context.Context, input proto.Message, peer *ws.Peer,
			) (proto.Message, error) {
				body, err := protojson.Marshal(input)
				if err != nil {
					return nil, err
				}
				wire, err := post(ctx, "/api/Auth/"+name, ctx.Value(tokenKey{}).(string), body)
				if err != nil {
					return nil, ws.Failure("OWNER_UNAVAILABLE", "fixture unavailable")
				}
				if name == "Logout" {
					if err := peer.EndAfterReply(ctx); err != nil {
						return nil, err
					}
					response := new(pb.LogoutResponse)
					return response, protojson.Unmarshal(wire, response)
				}
				response := new(pb.GetCurrentUserResponse)
				return response, protojson.Unmarshal(wire, response)
			},
		})
	}
	runtime, err := ws.New(registrations, nil)
	if err != nil {
		panic(err)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws.ServeHTTP(w, r, ws.Options{Runtime: runtime,
			Authenticate: func(ctx context.Context, token string) (context.Context, error) {
				wire, err := post(ctx, "/fixture/authenticate", token, []byte("{}"))
				if err != nil {
					return nil, ws.Failure("OWNER_UNAVAILABLE", "fixture unavailable")
				}
				var result struct{ Code string }
				if json.Unmarshal(wire, &result) != nil || result.Code == "unavailable" {
					return nil, ws.Failure("OWNER_UNAVAILABLE", "fixture unavailable")
				}
				if result.Code != "authenticated" {
					return nil, ws.Failure("UNAUTHORIZED", "fixture rejected")
				}
				return context.WithValue(ctx, tokenKey{}, token), nil
			},
		})
	})
}
