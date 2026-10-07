package httpapi

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
	common "github.com/tctony-labs/xiaowei/contracts/go/gen/xiaowei"
	pb "github.com/tctony-labs/xiaowei/contracts/go/gen/xiaowei/server"
	"github.com/tctony-labs/xiaowei/server/internal/auth"
	"github.com/tctony-labs/xiaowei/server/internal/config"
	"github.com/tctony-labs/xiaowei/server/internal/db"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

type authAPI struct {
	service *auth.Service
	limiter *limiter
	limits  config.AuthRateLimit
}

func (a *authAPI) login(w http.ResponseWriter, r *http.Request) {
	request := new(pb.LoginRequest)
	if !readAuthRequest(w, r, request, false) {
		return
	}
	credential, ok := request.Credential.(*pb.LoginRequest_Password)
	if !ok || credential.Password == nil {
		writeAuthError(w, "login", auth.ErrInvalidArgument)
		return
	}
	if request.ThirdpartyBindToken != nil {
		if request.GetThirdpartyBindToken() == "" {
			writeAuthError(w, "login", auth.ErrInvalidArgument)
		} else {
			writeProtocolError(w, int32(pb.AuthErrorCode_AUTH_ERROR_CODE_THIRDPARTY_BINDING_UNSUPPORTED),
				"暂不支持第三方账号绑定")
		}
		return
	}
	email, err := auth.NormalizeEmail(credential.Password.Email)
	if err != nil {
		writeAuthError(w, "login", auth.ErrInvalidArgument)
		return
	}
	if !a.limiter.check(w, loginQuotas(r, email, a.limits)...) {
		return
	}
	result, err := a.service.Login(
		r.Context(), email, credential.Password.Password, request.DeviceId, request.DeviceName,
	)
	if err != nil {
		writeAuthError(w, "login", err)
		return
	}
	slog.Info("user logged in", "user_id", result.Identity.User.PublicID, "session_id", result.Tokens.SessionID)
	writeAuthJSON(w, &pb.LoginResponse{
		Msg: "成功",
		Data: &pb.LoginResult{Result: &pb.LoginResult_Authenticated{
			Authenticated: &pb.Authenticated{
				User: userMessage(result.Identity), Tokens: tokenMessage(result.Tokens),
				Device: deviceMessage(result.Identity.Device),
			},
		}},
	})
}

func (a *authAPI) refresh(w http.ResponseWriter, r *http.Request) {
	if !a.limiter.check(w, quota{
		key: "refresh:" + sourceIP(r), limit: a.limits.RefreshIP.Limit, window: a.limits.RefreshIP.Window,
	}) {
		return
	}
	request := new(pb.RefreshRequest)
	if !readAuthRequest(w, r, request, false) {
		return
	}
	tokens, err := a.service.Refresh(r.Context(), request.RefreshToken)
	if err != nil {
		writeAuthError(w, "refresh", err)
		return
	}
	slog.Info("session refreshed", "session_id", tokens.SessionID)
	writeAuthJSON(w, &pb.RefreshResponse{Msg: "成功", Data: tokenMessage(tokens)})
}

func (a *authAPI) authenticate(w http.ResponseWriter, r *http.Request) (db.SessionUser, bool) {
	values := r.Header.Values("Authorization")
	if len(values) != 1 {
		writeAuthError(w, "authenticate", auth.ErrUnauthenticated)
		return db.SessionUser{}, false
	}
	parts := strings.Split(values[0], " ")
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || parts[1] == "" {
		writeAuthError(w, "authenticate", auth.ErrUnauthenticated)
		return db.SessionUser{}, false
	}
	identity, err := a.service.Authenticate(r.Context(), parts[1])
	if err != nil {
		writeAuthError(w, "authenticate", err)
		return db.SessionUser{}, false
	}
	return identity, true
}

func (a *authAPI) me(w http.ResponseWriter, r *http.Request) {
	identity, ok := a.authenticate(w, r)
	if !ok {
		return
	}
	writeAuthJSON(w, &pb.GetCurrentUserResponse{
		Msg: "成功",
		Data: &pb.GetCurrentUserData{
			User: userMessage(identity), SessionId: identity.SessionID, Device: deviceMessage(identity.Device),
		},
	})
}

func (a *authAPI) logout(w http.ResponseWriter, r *http.Request) {
	if !readAuthRequest(w, r, new(common.Empty), true) {
		return
	}
	identity, ok := a.authenticate(w, r)
	if !ok {
		return
	}
	if err := a.service.Logout(r.Context(), identity); err != nil {
		writeAuthError(w, "logout", err)
		return
	}
	slog.Info("session logged out", "user_id", identity.User.PublicID, "session_id", identity.SessionID)
	writeAuthJSON(w, &pb.LogoutResponse{Msg: "成功", Data: new(common.Empty)})
}

func readAuthRequest(w http.ResponseWriter, r *http.Request, message proto.Message, allowEmpty bool) bool {
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

func writeAuthError(w http.ResponseWriter, operation string, err error) {
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
	writeProtocolError(w, code, message)
}

func writeAuthJSON(w http.ResponseWriter, message interface {
	proto.Message
	GetCode() int32
}) {
	body, err := (protojson.MarshalOptions{UseProtoNames: true, EmitDefaultValues: true}).Marshal(message)
	if err != nil {
		writeAuthError(w, "encode", auth.ErrInternal)
		return
	}
	recordResponseCode(w, message.GetCode())
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(body)
}
