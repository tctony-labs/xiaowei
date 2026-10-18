package httpapi

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	fixture "github.com/tctony-labs/xiaowei/contracts/go/gen/testing"
	pb "github.com/tctony-labs/xiaowei/contracts/go/gen/xiaowei/server"
	"github.com/tctony-labs/xiaowei/server/internal/config"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protodesc"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"
	"google.golang.org/protobuf/types/descriptorpb"
)

func TestAPIMetadataValidationAndNetworkNames(t *testing.T) {
	method := pb.File_xiaowei_server_auth_proto.Services().ByName("Auth").Methods().Get(0)
	handler := func(context.Context, proto.Message, apiCall) (proto.Message, error) {
		return &pb.LoginResponse{}, nil
	}
	for _, registrations := range [][]apiRegistration{
		{{method: method}},
		{{handler: handler}},
		{{method: method, handler: handler}, {method: method, handler: handler}},
		{{
			method:  fixture.File_testing_fixture_proto.Services().Get(0).Methods().Get(0),
			handler: handler,
		}},
	} {
		if _, err := newAPI(nil, registrations); err == nil {
			t.Fatal("invalid registration accepted")
		}
	}
	api := NewAPI(func(context.Context) error { return nil }, nil, config.DefaultAuthRateLimit())
	if len(api.methods) != 6 {
		t.Fatal("unexpected API registration count")
	}
	for path, entry := range api.methods {
		if path != "/api/"+entry.id {
			t.Fatal("inconsistent network name")
		}
		required := entry.method.Name() == "GetCurrentUser" || entry.method.Name() == "Logout"
		if entry.requiresSession != required {
			t.Fatal("incorrect session requirement")
		}
	}
}

func TestAPIDefaultRequiresSessionAtHTTPBoundary(t *testing.T) {
	withAPI := func(options *pb.ApiMethodOptions) *descriptorpb.MethodOptions {
		methodOptions := new(descriptorpb.MethodOptions)
		proto.SetExtension(methodOptions, pb.E_Api, options)
		return methodOptions
	}
	for _, tc := range []struct {
		name            string
		options         *descriptorpb.MethodOptions
		requiresSession bool
	}{
		{"no method options", nil, true},
		{"no API option", new(descriptorpb.MethodOptions), true},
		{"empty API option", withAPI(new(pb.ApiMethodOptions)), true},
		{"explicit false", withAPI(&pb.ApiMethodOptions{NoLogin: false}), true},
		{"explicit true", withAPI(&pb.ApiMethodOptions{NoLogin: true}), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			descriptor := protodesc.ToFileDescriptorProto(pb.File_xiaowei_server_auth_proto)
			descriptor.Service[0].Method[0].Options = tc.options
			file, err := protodesc.NewFile(descriptor, protoregistry.GlobalFiles)
			if err != nil {
				t.Fatal(err)
			}
			called := false
			api, err := newAPI(&authAPI{}, []apiRegistration{{
				method: file.Services().Get(0).Methods().Get(0),
				handler: func(context.Context, proto.Message, apiCall) (proto.Message, error) {
					called = true
					return &pb.LoginResponse{Msg: "成功", Data: new(pb.LoginResult)}, nil
				},
			}})
			if err != nil {
				t.Fatal(err)
			}
			method := api.methods["/api/auth.Auth/Login"]
			if method.requiresSession != tc.requiresSession {
				t.Fatal("incorrect default access policy")
			}
			response := httptest.NewRecorder()
			request := httptest.NewRequest("POST", "/api/auth.Auth/Login", strings.NewReader("{}"))
			request.Header.Set("Content-Type", "application/json")
			NewHandler(api, config.DefaultServerRateLimit()).ServeHTTP(response, request)
			var result pb.BaseResponse
			if json.Unmarshal(response.Body.Bytes(), &result) != nil {
				t.Fatal("invalid API response")
			}
			if tc.requiresSession {
				if called || result.Code != int32(pb.ErrorCode_ERROR_CODE_UNAUTHENTICATED) {
					t.Fatal("an omitted or false flag bypassed authentication")
				}
			} else if !called || result.Code != 0 {
				t.Fatal("no_login=true did not allow HTTP without a session")
			}
		})
	}
}

func TestDirectMigrationRemovesOldPathsAndKeepsTypedEmptyData(t *testing.T) {
	api := NewAPI(func(context.Context) error { return nil }, nil, config.DefaultAuthRateLimit())
	handler := NewHandler(api, config.DefaultServerRateLimit())
	for _, path := range []string{"/healthz", "/readyz", "/api/auth/login", "/api/auth/refresh",
		"/api/auth/me", "/api/auth/logout", "/api/xiaowei.server.common.Health/Check"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest("POST", path, nil))
		var result pb.BaseResponse
		if json.Unmarshal(response.Body.Bytes(), &result) != nil || result.Code != 10004 {
			t.Fatalf("old route still available: %s", path)
		}
	}
	for _, method := range api.ordered {
		if method.method.Parent().Name() != protoreflect.Name("Health") {
			continue
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest("POST", "/api/"+method.id, nil))
		var result struct {
			Code int
			Data map[string]any
		}
		if json.Unmarshal(response.Body.Bytes(), &result) != nil || result.Code != 0 ||
			result.Data == nil || len(result.Data) != 0 {
			t.Fatal("health response does not match proto")
		}
	}
}
