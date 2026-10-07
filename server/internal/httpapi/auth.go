package httpapi

import (
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strings"

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
				"third-party binding is not supported")
		}
		return
	}
	email, err := auth.NormalizeEmail(credential.Password.Email)
	if err != nil {
		writeAuthError(w, "login", auth.ErrInvalidArgument)
		return
	}
	if !a.limiter.check(w, "login", loginQuotas(r, email, a.limits)...) {
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
		Msg: "ok",
		Data: &pb.LoginResult{Result: &pb.LoginResult_Authenticated{
			Authenticated: &pb.Authenticated{
				User: userMessage(result.Identity), Tokens: tokenMessage(result.Tokens),
				Device: deviceMessage(result.Identity.Device),
			},
		}},
	})
}

func (a *authAPI) refresh(w http.ResponseWriter, r *http.Request) {
	if !a.limiter.check(w, "refresh", quota{key: "refresh:" + sourceIP(r), limit: a.limits.RefreshIP.Limit, window: a.limits.RefreshIP.Window}) {
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
	writeAuthJSON(w, &pb.RefreshResponse{Msg: "ok", Data: tokenMessage(tokens)})
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
		Msg: "ok",
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
	writeAuthJSON(w, &pb.LogoutResponse{Msg: "ok", Data: new(common.Empty)})
}

func readAuthRequest(w http.ResponseWriter, r *http.Request, message proto.Message, allowEmpty bool) bool {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 16*1024))
	if err != nil {
		var sizeError *http.MaxBytesError
		if errors.As(err, &sizeError) {
			writeProtocolError(w, int32(pb.ErrorCode_ERROR_CODE_REQUEST_TOO_LARGE), "request too large")
		} else {
			writeProtocolError(w, int32(pb.ErrorCode_ERROR_CODE_INVALID_REQUEST), "invalid request")
		}
		return false
	}
	if allowEmpty && len(body) == 0 {
		return true
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		writeProtocolError(w, int32(pb.ErrorCode_ERROR_CODE_UNSUPPORTED_MEDIA_TYPE),
			"content type must be application/json")
		return false
	}
	if err := protojson.Unmarshal(body, message); err != nil {
		writeProtocolError(w, int32(pb.ErrorCode_ERROR_CODE_INVALID_REQUEST), "invalid request")
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
	message := "authentication failed"
	switch {
	case errors.Is(err, auth.ErrInvalidArgument):
		code, message = int32(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT), "invalid request"
	case errors.Is(err, auth.ErrInvalidCredentials):
		code = int32(pb.AuthErrorCode_AUTH_ERROR_CODE_INVALID_CREDENTIALS)
		message = "invalid email or password"
	case errors.Is(err, auth.ErrUnauthenticated):
		code, message = int32(pb.ErrorCode_ERROR_CODE_UNAUTHENTICATED), "invalid or expired credential"
	case errors.Is(err, auth.ErrUnavailable):
		code, message = int32(pb.ErrorCode_ERROR_CODE_UNAVAILABLE), "authentication unavailable"
	}
	if code == int32(pb.ErrorCode_ERROR_CODE_INTERNAL_ERROR) || code == int32(pb.ErrorCode_ERROR_CODE_UNAVAILABLE) {
		slog.Error("authentication request failed", "operation", operation, "code", code, "error", err)
	} else {
		slog.Info("authentication request rejected", "operation", operation, "code", code)
	}
	writeProtocolError(w, code, message)
}

func writeAuthJSON(w http.ResponseWriter, message proto.Message) {
	body, err := (protojson.MarshalOptions{UseProtoNames: true, EmitDefaultValues: true}).Marshal(message)
	if err != nil {
		writeAuthError(w, "encode", auth.ErrInternal)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(body)
}
