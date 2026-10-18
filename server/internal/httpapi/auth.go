package httpapi

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"math"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	common "github.com/tctony-labs/xiaowei/contracts/go/gen/xiaowei"
	pb "github.com/tctony-labs/xiaowei/contracts/go/gen/xiaowei/server"
	"github.com/tctony-labs/xiaowei/server/internal/auth"
	"github.com/tctony-labs/xiaowei/server/internal/config"
	"github.com/tctony-labs/xiaowei/server/internal/db"
	"github.com/tctony-labs/xiaowei/server/internal/gateway"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

type authAPI struct {
	service *auth.Service
	limiter *limiter
	limits  config.AuthRateLimit
}

func (a *authAPI) login(
	ctx context.Context, input proto.Message, call apiCall,
) (proto.Message, error) {
	request := input.(*pb.LoginRequest)
	credential, ok := request.Credential.(*pb.LoginRequest_Password)
	if !ok || credential.Password == nil {
		return nil, auth.ErrInvalidArgument
	}
	if request.ThirdpartyBindToken != nil {
		if request.GetThirdpartyBindToken() == "" {
			return nil, auth.ErrInvalidArgument
		}
		return nil, &apiError{
			code: int32(pb.AuthErrorCode_AUTH_ERROR_CODE_THIRDPARTY_BINDING_UNSUPPORTED),
			msg:  "暂不支持第三方账号绑定",
		}
	}
	email, err := auth.NormalizeEmail(credential.Password.Email)
	if err != nil {
		return nil, auth.ErrInvalidArgument
	}
	retry := a.limiter.allow(time.Now(), loginQuotas(call.ip, email, a.limits)...)
	if retry != 0 {
		return nil, rateLimitError(retry)
	}
	result, err := a.service.Login(
		ctx, email, credential.Password.Password, request.DeviceId, request.DeviceName,
	)
	if err != nil {
		return nil, err
	}
	slog.Info("user logged in", "user_id", result.Identity.User.PublicID,
		"session_id", result.Tokens.SessionID)
	return &pb.LoginResponse{Msg: "成功", Data: &pb.LoginResult{
		Result: &pb.LoginResult_Authenticated{Authenticated: &pb.Authenticated{
			User: userMessage(result.Identity), Tokens: tokenMessage(result.Tokens),
			Device: deviceMessage(result.Identity.Device),
		}},
	}}, nil
}

func (a *authAPI) refreshLimit(call apiCall) *apiError {
	retry := a.limiter.allow(time.Now(), quota{
		key: "refresh:" + call.ip, limit: a.limits.RefreshIP.Limit, window: a.limits.RefreshIP.Window,
	})
	if retry != 0 {
		return rateLimitError(retry)
	}
	return nil
}

func (a *authAPI) refresh(
	ctx context.Context, input proto.Message, _ apiCall,
) (proto.Message, error) {
	tokens, err := a.service.Refresh(ctx, input.(*pb.RefreshRequest).RefreshToken)
	if err != nil {
		return nil, err
	}
	slog.Info("session refreshed", "session_id", tokens.SessionID)
	return &pb.RefreshResponse{Msg: "成功", Data: tokenMessage(tokens)}, nil
}

func (a *authAPI) authenticate(r *http.Request) (db.SessionUser, error) {
	values := r.Header.Values("Authorization")
	if len(values) != 1 {
		return db.SessionUser{}, auth.ErrUnauthenticated
	}
	parts := strings.Split(values[0], " ")
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || parts[1] == "" {
		return db.SessionUser{}, auth.ErrUnauthenticated
	}
	return a.service.Authenticate(r.Context(), parts[1])
}

func (a *authAPI) me(_ context.Context, _ proto.Message, call apiCall) (proto.Message, error) {
	identity := call.identity
	return &pb.GetCurrentUserResponse{Msg: "成功", Data: &pb.GetCurrentUserData{
		User: userMessage(identity), SessionId: identity.SessionID, Device: deviceMessage(identity.Device),
	}}, nil
}

func (a *authAPI) logout(
	ctx context.Context, _ proto.Message, call apiCall,
) (proto.Message, error) {
	if call.peer != nil {
		if err := call.peer.EndAfterReply(ctx); err != nil {
			return nil, err
		}
		ctx = auth.WithSessionChangeDelivery(ctx, func(notify func()) {
			gateway.AfterReply(ctx, notify)
		})
	}
	if err := a.service.Logout(ctx, call.identity); err != nil {
		return nil, err
	}
	slog.Info("session logged out", "user_id", call.identity.User.PublicID,
		"session_id", call.identity.SessionID)
	return &pb.LogoutResponse{Msg: "成功", Data: new(common.Empty)}, nil
}

func readAPIRequest(w http.ResponseWriter, r *http.Request, message proto.Message, allowEmpty bool) bool {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 16*1024))
	if err != nil {
		var sizeError *http.MaxBytesError
		if errors.As(err, &sizeError) {
			writeProtocolError(w, int32(pb.ErrorCode_ERROR_CODE_REQUEST_TOO_LARGE), "请求内容过大")
		} else {
			writeProtocolError(w, int32(pb.ErrorCode_ERROR_CODE_INVALID_REQUEST), "请求格式错误")
		}
		return false
	}
	if allowEmpty && len(body) == 0 {
		return true
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		writeProtocolError(w, int32(pb.ErrorCode_ERROR_CODE_UNSUPPORTED_MEDIA_TYPE),
			"请求内容类型必须为 application/json")
		return false
	}
	if err := protojson.Unmarshal(body, message); err != nil {
		writeProtocolError(w, int32(pb.ErrorCode_ERROR_CODE_INVALID_REQUEST), "请求格式错误")
		return false
	}
	return true
}

func userMessage(identity db.SessionUser) *pb.UserSnapshot {
	return &pb.UserSnapshot{
		UserId: identity.User.PublicID, Email: identity.Email, CreatedAtMs: identity.User.CreatedAt.UnixMilli(),
	}
}

func deviceMessage(device db.Device) *pb.DeviceSnapshot {
	return &pb.DeviceSnapshot{DeviceId: device.ID, DeviceName: device.Name}
}

func tokenMessage(tokens auth.Tokens) *pb.TokenPair {
	return &pb.TokenPair{
		SessionId: tokens.SessionID, AccessToken: tokens.AccessToken, RefreshToken: tokens.RefreshToken,
		AccessExpiresAtMs: tokens.AccessExpiresAt.UnixMilli(), RefreshExpiresAtMs: tokens.RefreshExpiresAt.UnixMilli(),
	}
}

type apiError struct {
	code  int32
	msg   string
	retry time.Duration
}

func (e *apiError) Error() string { return e.msg }

func rateLimitError(retry time.Duration) *apiError {
	return &apiError{code: int32(pb.ErrorCode_ERROR_CODE_RATE_LIMITED),
		msg: "请求过于频繁，请稍后重试", retry: retry}
}

func writeAuthError(w http.ResponseWriter, operation string, err error) {
	failure := authFailure(operation, err)
	if failure.retry != 0 {
		seconds := int64(math.Ceil(failure.retry.Seconds()))
		w.Header().Set("Retry-After", strconv.FormatInt(seconds, 10))
	}
	writeProtocolError(w, failure.code, failure.msg)
}

func authFailure(operation string, err error) *apiError {
	var failure *apiError
	if errors.As(err, &failure) {
		return failure
	}
	code := int32(pb.ErrorCode_ERROR_CODE_INTERNAL_ERROR)
	message := "认证失败，请稍后重试"
	switch {
	case errors.Is(err, auth.ErrInvalidArgument):
		code, message = int32(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT), "请求参数无效"
	case errors.Is(err, auth.ErrInvalidCredentials):
		code = int32(pb.AuthErrorCode_AUTH_ERROR_CODE_INVALID_CREDENTIALS)
		message = "邮箱或密码错误"
	case errors.Is(err, auth.ErrUnauthenticated):
		code, message = int32(pb.ErrorCode_ERROR_CODE_UNAUTHENTICATED), "登录凭据无效或已过期，请重新登录"
	case errors.Is(err, auth.ErrUnavailable):
		code, message = int32(pb.ErrorCode_ERROR_CODE_UNAVAILABLE), "认证服务暂不可用，请稍后重试"
	}
	if code == int32(pb.ErrorCode_ERROR_CODE_INTERNAL_ERROR) || code == int32(pb.ErrorCode_ERROR_CODE_UNAVAILABLE) {
		fields := []any{"operation", operation, "code", code}
		// Preserve safe diagnostic categories, never driver messages or request data.
		var databaseError *pgconn.PgError
		switch {
		case errors.As(err, &databaseError):
			fields = append(fields, "error_kind", "database", "sqlstate", databaseError.Code)
		case errors.Is(err, context.DeadlineExceeded):
			fields = append(fields, "error_kind", "timeout")
		case errors.Is(err, context.Canceled):
			fields = append(fields, "error_kind", "cancelled")
		default:
			fields = append(fields, "error_kind", "internal")
		}
		slog.Error("authentication request failed", fields...)
	}
	return &apiError{code: code, msg: message}
}

func writeAPIJSON(w http.ResponseWriter, message proto.Message) {
	body, err := (protojson.MarshalOptions{UseProtoNames: true, EmitDefaultValues: true}).Marshal(message)
	if err != nil {
		writeAuthError(w, "encode", auth.ErrInternal)
		return
	}
	recordResponseCode(w, int32(message.ProtoReflect().Get(
		message.ProtoReflect().Descriptor().Fields().ByName("code")).Int()))
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(body)
}
