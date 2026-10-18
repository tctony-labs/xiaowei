package httpapi

import (
	"context"
	"fmt"
	"strings"
	"time"

	common "github.com/tctony-labs/xiaowei/contracts/go/gen/xiaowei"
	pb "github.com/tctony-labs/xiaowei/contracts/go/gen/xiaowei/server"
	"github.com/tctony-labs/xiaowei/server/internal/auth"
	"github.com/tctony-labs/xiaowei/server/internal/config"
	"github.com/tctony-labs/xiaowei/server/internal/db"
	"github.com/tctony-labs/xiaowei/server/internal/gateway"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"
)

type apiCall struct {
	identity db.SessionUser
	ip       string
	peer     *gateway.Peer
}

type apiHandler func(context.Context, proto.Message, apiCall) (proto.Message, error)

type apiRegistration struct {
	method  protoreflect.MethodDescriptor
	handler apiHandler
	before  func(apiCall) *apiError
	probe   bool
}

type apiMethod struct {
	apiRegistration
	id              string
	requiresSession bool
	input           protoreflect.MessageType
	output          protoreflect.MessageType
}

// API owns one explicit business registration and shared authentication limits for both transports.
type API struct {
	auth    *authAPI
	methods map[string]*apiMethod
	ordered []*apiMethod
}

func NewAPI(checkDatabase func(context.Context) error, service *auth.Service,
	limits config.AuthRateLimit,
) *API {
	a := &authAPI{service: service, limiter: newLimiter(), limits: limits}
	authMethods := pb.File_xiaowei_server_auth_proto.Services().ByName("Auth").Methods()
	healthMethods := pb.File_xiaowei_server_common_proto.Services().ByName("Health").Methods()
	registrations := []apiRegistration{
		{method: authMethods.ByName("Login"), handler: a.login},
		{method: authMethods.ByName("Refresh"), handler: a.refresh, before: a.refreshLimit},
		{method: authMethods.ByName("GetCurrentUser"), handler: a.me},
		{method: authMethods.ByName("Logout"), handler: a.logout},
		{method: healthMethods.ByName("Check"), probe: true, handler: func(
			context.Context, proto.Message, apiCall,
		) (proto.Message, error) {
			return &pb.BaseResponse{Msg: "成功", Data: new(common.Empty)}, nil
		}},
		{method: healthMethods.ByName("Ready"), probe: true, handler: func(
			ctx context.Context, _ proto.Message, _ apiCall,
		) (proto.Message, error) {
			ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
			defer cancel()
			if checkDatabase(ctx) != nil {
				return nil, &apiError{
					code: int32(pb.ErrorCode_ERROR_CODE_UNAVAILABLE), msg: "服务暂不可用",
				}
			}
			return &pb.BaseResponse{Msg: "成功", Data: new(common.Empty)}, nil
		}},
	}
	api, err := newAPI(a, registrations)
	if err != nil {
		panic(err)
	}
	return api
}

func newAPI(a *authAPI, registrations []apiRegistration) (*API, error) {
	api := &API{auth: a, methods: map[string]*apiMethod{}}
	for _, registration := range registrations {
		method := registration.method
		if method == nil || registration.handler == nil ||
			method.IsStreamingClient() || method.IsStreamingServer() {
			return nil, fmt.Errorf("invalid server API registration")
		}
		service := string(method.Parent().FullName())
		const prefix = "xiaowei.server."
		if !strings.HasPrefix(service, prefix) || len(service) == len(prefix) {
			return nil, fmt.Errorf("invalid server API metadata: %s", method.FullName())
		}
		options := proto.GetExtension(method.Options(), pb.E_Api).(*pb.ApiMethodOptions)
		id := strings.TrimPrefix(service, prefix) + "/" + string(method.Name())
		if api.methods["/api/"+id] != nil {
			return nil, fmt.Errorf("duplicate server API route: %s", id)
		}
		input, err := protoregistry.GlobalTypes.FindMessageByName(method.Input().FullName())
		if err != nil {
			return nil, err
		}
		output, err := protoregistry.GlobalTypes.FindMessageByName(method.Output().FullName())
		if err != nil {
			return nil, err
		}
		fields := method.Output().Fields()
		if fields.ByName("code") == nil || fields.ByName("code").Kind() != protoreflect.Int32Kind ||
			fields.ByName("msg") == nil || fields.ByName("msg").Kind() != protoreflect.StringKind ||
			fields.ByName("data") == nil ||
			fields.ByName("data").Kind() != protoreflect.MessageKind {
			return nil, fmt.Errorf("invalid server API response: %s", method.FullName())
		}
		entry := &apiMethod{registration, id,
			!options.GetNoLogin(), input, output}
		api.methods["/api/"+id] = entry
		api.ordered = append(api.ordered, entry)
	}
	return api, nil
}

func (m *apiMethod) invoke(
	ctx context.Context, input proto.Message, call apiCall,
) (proto.Message, *apiError) {
	var failure *apiError
	response, err := m.handler(ctx, input, call)
	if err != nil {
		failure = authFailure(string(m.method.FullName()), err)
		response = m.output.New().Interface()
		message := response.ProtoReflect()
		fields := message.Descriptor().Fields()
		message.Set(fields.ByName("code"), protoreflect.ValueOfInt32(failure.code))
		message.Set(fields.ByName("msg"), protoreflect.ValueOfString(failure.msg))
	}
	if response == nil ||
		response.ProtoReflect().Descriptor().FullName() != m.method.Output().FullName() {
		panic("server API handler returned an invalid response")
	}

	return response, failure
}
