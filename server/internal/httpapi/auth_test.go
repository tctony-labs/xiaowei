package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"

	common "github.com/tctony-labs/xiaowei/contracts/go/gen/xiaowei"
	pb "github.com/tctony-labs/xiaowei/contracts/go/gen/xiaowei/server"
	"github.com/tctony-labs/xiaowei/server/internal/auth"
	"github.com/tctony-labs/xiaowei/server/internal/config"
)

func TestAuthJSONBoundaries(t *testing.T) {
	for _, tc := range []struct {
		name, body, contentType string
		want                    pb.ErrorCode
	}{
		{"unknown", `{"private-secret":true}`, "application/json", pb.ErrorCode_ERROR_CODE_INVALID_REQUEST},
		{"type", `{"password":123}`, "application/json", pb.ErrorCode_ERROR_CODE_INVALID_REQUEST},
		{"duplicate", `{"password":{"email":"a@b.com","email":"c@d.com"}}`,
			"application/json", pb.ErrorCode_ERROR_CODE_INVALID_REQUEST},
		{"multiple", `{} {}`, "application/json", pb.ErrorCode_ERROR_CODE_INVALID_REQUEST},
		{"oversize", strings.Repeat("private-secret", 2000),
			"application/json", pb.ErrorCode_ERROR_CODE_REQUEST_TOO_LARGE},
		{"media", `{}`, "text/plain", pb.ErrorCode_ERROR_CODE_UNSUPPORTED_MEDIA_TYPE},
		{"empty", "", "application/json", pb.ErrorCode_ERROR_CODE_INVALID_REQUEST},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "/api/auth/login", strings.NewReader(tc.body))
			r.Header.Set("Content-Type", tc.contentType)
			w := httptest.NewRecorder()
			if readAuthRequest(w, r, new(pb.LoginRequest), false) || w.Code != 200 ||
				strings.Contains(w.Body.String(), "private-secret") || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("invalid JSON accepted or unsafe response")
			}
			response := new(pb.BaseResponse)
			if err := protojson.Unmarshal(w.Body.Bytes(), response); err != nil || response.Code != int32(tc.want) {
				t.Fatal("incorrect decoding error code")
			}
		})
	}
	for _, body := range []string{"", "{}"} {
		r := httptest.NewRequest("POST", "/api/auth/logout", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		if !readAuthRequest(httptest.NewRecorder(), r, new(common.Empty), true) {
			t.Fatal("valid empty logout request rejected")
		}
	}
}

func TestAuthHeaderAndMethods(t *testing.T) {
	handler := NewHandler(func(context.Context) error { return nil }, nil,
		config.DefaultServerRateLimit(), config.DefaultAuthRateLimit())
	for _, header := range []string{"", "Basic private-secret", "Bearer", "Bearer  private-secret"} {
		r := httptest.NewRequest("GET", "/api/auth/me?token=private-secret", nil)
		r.Header.Set("Authorization", header)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		response := new(pb.GetCurrentUserResponse)
		if err := protojson.Unmarshal(w.Body.Bytes(), response); err != nil || w.Code != 200 ||
			response.Code != int32(pb.ErrorCode_ERROR_CODE_UNAUTHENTICATED) || response.Data != nil ||
			strings.Contains(w.Body.String(), "private-secret") {
			t.Fatal("invalid header accepted or token leaked")
		}
	}
	r := httptest.NewRequest("GET", "/api/auth/me", nil)
	r.Header.Add("Authorization", "Bearer first")
	r.Header.Add("Authorization", "Bearer second")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	response := new(pb.GetCurrentUserResponse)
	if err := protojson.Unmarshal(w.Body.Bytes(), response); err != nil || w.Code != 200 ||
		response.Code != int32(pb.ErrorCode_ERROR_CODE_UNAUTHENTICATED) || response.Data != nil {
		t.Fatal("multiple authorization headers accepted")
	}
	for _, path := range []string{"login", "refresh", "logout"} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/auth/"+path, nil))
		response := new(pb.BaseResponse)
		if err := protojson.Unmarshal(w.Body.Bytes(), response); err != nil || w.Code != 200 ||
			response.Code != int32(pb.ErrorCode_ERROR_CODE_INVALID_REQUEST) {
			t.Fatal("authentication route accepted wrong method")
		}
	}
}

func TestAuthErrorSanitization(t *testing.T) {
	for _, tc := range []struct {
		err    error
		status int
		code   int32
	}{
		{auth.ErrInvalidArgument, 200, int32(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT)},
		{auth.ErrInvalidCredentials, 200, int32(pb.AuthErrorCode_AUTH_ERROR_CODE_INVALID_CREDENTIALS)},
		{auth.ErrUnauthenticated, 200, int32(pb.ErrorCode_ERROR_CODE_UNAUTHENTICATED)},
		{auth.ErrUnavailable, 200, int32(pb.ErrorCode_ERROR_CODE_UNAVAILABLE)},
		{errors.New("private-secret"), 200, int32(pb.ErrorCode_ERROR_CODE_INTERNAL_ERROR)},
	} {
		w := httptest.NewRecorder()
		writeAuthError(w, "test", tc.err)
		var wire struct {
			Code int32 `json:"code"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &wire); err != nil || wire.Code != tc.code {
			t.Fatal("error code must be a JSON number matching the generated enum")
		}
		response := new(pb.BaseResponse)
		if err := protojson.Unmarshal(w.Body.Bytes(), response); err != nil || w.Code != tc.status ||
			response.Code != tc.code {
			t.Fatal("error code does not match the failure")
		}
		if strings.Contains(w.Body.String(), "private-secret") || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("error response exposed internal details")
		}
	}
}

func TestLoginCredentialAndBindingBoundaries(t *testing.T) {
	handler := NewHandler(func(context.Context) error { return nil }, nil,
		config.DefaultServerRateLimit(), config.DefaultAuthRateLimit())
	for _, tc := range []struct {
		body string
		code int32
	}{
		{`{}`, int32(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT)},
		{`{"wechat":{}}`, int32(pb.ErrorCode_ERROR_CODE_INVALID_REQUEST)},
		{`{"password":{},"password":{}}`, int32(pb.ErrorCode_ERROR_CODE_INVALID_REQUEST)},
		{`{"password":{},"thirdparty_bind_token":""}`, int32(pb.ErrorCode_ERROR_CODE_INVALID_ARGUMENT)},
		{`{"password":{},"thirdparty_bind_token":"private-secret"}`,
			int32(pb.AuthErrorCode_AUTH_ERROR_CODE_THIRDPARTY_BINDING_UNSUPPORTED)},
	} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest("POST", "/api/auth/login", strings.NewReader(tc.body))
		r.Header.Set("Content-Type", "application/json")
		handler.ServeHTTP(w, r)
		response := new(pb.LoginResponse)
		if err := protojson.Unmarshal(w.Body.Bytes(), response); err != nil || w.Code != 200 ||
			response.Code != tc.code || response.Data != nil || strings.Contains(w.Body.String(), "private-secret") {
			t.Fatal("invalid credential or binding input was not rejected before accessing the service")
		}
	}
}
