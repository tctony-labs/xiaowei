package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	pb "github.com/tctony-labs/xiaowei/contracts/go/gen/xiaowei/server"
	"github.com/tctony-labs/xiaowei/server/internal/gateway"
	"google.golang.org/protobuf/proto"
)

var wsSequence atomic.Uint64

func wsWrite(t *testing.T, socket *websocket.Conn, header any, payload []byte) {
	t.Helper()
	metadata, err := json.Marshal(header)
	if err != nil {
		t.Fatal(err)
	}
	body := make([]byte, 4+len(metadata)+len(payload))
	binary.BigEndian.PutUint32(body, uint32(len(metadata)))
	copy(body[4:], metadata)
	copy(body[4+len(metadata):], payload)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := socket.Write(ctx, websocket.MessageBinary, body); err != nil {
		t.Fatal(err)
	}
}

func wsRead(t *testing.T, socket *websocket.Conn) (map[string]json.RawMessage, []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, body, err := socket.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(body) < 4 {
		t.Fatal("invalid WebSocket frame")
	}
	size := int(binary.BigEndian.Uint32(body))
	if size > len(body)-4 {
		t.Fatal("invalid WebSocket metadata size")
	}
	var header map[string]json.RawMessage
	if json.Unmarshal(body[4:4+size], &header) != nil {
		t.Fatal("invalid WebSocket metadata")
	}
	return header, body[4+size:]
}

func wsLogin(t *testing.T, fixture authFixture, token string) (*websocket.Conn, string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	socket, _, err := websocket.Dial(ctx, "ws://"+fixture.address+"/api/ws", nil)
	if err != nil {
		t.Fatalf("WebSocket upgrade failed: %v", err)
	}
	t.Cleanup(func() { _ = socket.CloseNow() })
	wsWrite(t, socket, map[string]any{"v": 1, "generation": "", "op": "authenticate", "token": token,
		"manifest": gateway.Manifest{Routes: []gateway.Route{}, Events: []gateway.Event{}}, "optionsBytes": 0}, nil)
	header, _ := wsRead(t, socket)
	if len(header["manifest"]) > 0 {
		var manifest gateway.Manifest
		if json.Unmarshal(header["manifest"], &manifest) != nil || len(manifest.Routes) != 2 {
			t.Fatal("WS must export exactly the two session-required API methods")
		}
		for _, route := range manifest.Routes {
			if route.Name != "auth.Auth/GetCurrentUser" && route.Name != "auth.Auth/Logout" {
				t.Fatal("public or full-name API leaked into WS manifest")
			}
		}
	}
	var generation string
	_ = json.Unmarshal(header["generation"], &generation)
	return socket, generation
}

func wsMe(t *testing.T, socket *websocket.Conn, generation string) *pb.GetCurrentUserResponse {
	t.Helper()
	wsWrite(t, socket, map[string]any{"v": 1, "generation": generation, "op": "invoke", "id": fmt.Sprintf("c:me:%d", wsSequence.Add(1)),
		"optionsBytes": 0, "route": gateway.Route{Name: "auth.Auth/GetCurrentUser", Kind: "unary",
			ControlVersion: 3, ContractVersion: 1, Input: "xiaowei.common.Empty",
			Output: "xiaowei.server.auth.GetCurrentUserResponse"}}, nil)
	header, payload := wsRead(t, socket)
	if len(header["error"]) != 0 {
		t.Fatal("authenticated method failed")
	}
	response := new(pb.GetCurrentUserResponse)
	if proto.Unmarshal(payload, response) != nil {
		t.Fatal("invalid typed WebSocket response")
	}
	return response
}

func wsMustClose(t *testing.T, socket *websocket.Conn) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for {
		_, _, err := socket.Read(ctx)
		if ctx.Err() != nil {
			t.Fatal("revoked connection did not close promptly")
		}
		if err != nil {
			return
		}
	}
}

func TestWebSocketAuthenticationSessionIsolationAndShutdown(t *testing.T) {
	fixture := newAuthFixture(t)
	stop := startAuthServer(t, fixture)
	a := loginFixture(t, fixture)
	b := loginFixture(t, fixture)
	first, firstGeneration := wsLogin(t, fixture, a.Tokens.AccessToken)
	second, secondGeneration := wsLogin(t, fixture, b.Tokens.AccessToken)
	// Public methods remain unavailable even to an authenticated socket.
	for _, name := range []string{"auth.Auth/Login", "auth.Auth/Refresh",
		"common.Health/Check", "common.Health/Ready", "xiaowei.server.auth.Auth.GetCurrentUser"} {
		wsWrite(t, first, map[string]any{"v": 1, "generation": firstGeneration,
			"op": "invoke", "id": fmt.Sprintf("c:public:%d", wsSequence.Add(1)), "optionsBytes": 0,
			"route": gateway.Route{Name: name, Kind: "unary", ControlVersion: 3, ContractVersion: 1,
				Input: "xiaowei.common.Empty", Output: "xiaowei.server.common.BaseResponse"}}, nil)
		header, _ := wsRead(t, first)
		var failure gateway.Error
		if json.Unmarshal(header["error"], &failure) != nil || failure.Code != "UNAUTHORIZED" {
			t.Fatal("unexported or old full-name method accepted over WS")
		}
	}
	me := wsMe(t, first, firstGeneration)
	if me.Data == nil || me.Data.User.UserId != fixture.userID || me.Data.SessionId != a.Tokens.SessionId ||
		me.Data.Device.DeviceId != a.Device.DeviceId {
		t.Fatal("WebSocket identity did not come from authenticated session")
	}
	refresh := new(pb.RefreshResponse)
	requireAuthResponse(t, requestAuth(fixture.address, "POST", "/api/auth.Auth/Refresh", "",
		&pb.RefreshRequest{RefreshToken: a.Tokens.RefreshToken}), 200, 0, refresh)
	rotated, rotatedGeneration := wsLogin(t, fixture, refresh.Data.AccessToken)
	if wsMe(t, rotated, rotatedGeneration).Data.SessionId != a.Tokens.SessionId {
		t.Fatal("refresh changed session identity")
	}
	_ = wsMe(t, first, firstGeneration)
	requireAuthResponse(t, requestAuth(fixture.address, "POST", "/api/auth.Auth/Logout",
		refresh.Data.AccessToken, nil),
		200, 0, new(pb.LogoutResponse))
	wsMustClose(t, first)
	wsMustClose(t, rotated)
	if wsMe(t, second, secondGeneration).Data.SessionId != b.Tokens.SessionId {
		t.Fatal("logout closed another device")
	}
	request := passwordRequest("user@example.com", fixture.password, b.Device.DeviceId)
	requireAuthResponse(t, requestAuth(fixture.address, "POST", "/api/auth.Auth/Login",
		"", request),
		200, 0, new(pb.LoginResponse))
	wsMustClose(t, second)
	rejected, generation := wsLogin(t, fixture, a.Tokens.AccessToken)
	if generation != "" {
		t.Fatal("revoked access authenticated WebSocket")
	}
	_ = rejected.CloseNow()
	c := loginFixture(t, fixture)
	open, _ := wsLogin(t, fixture, c.Tokens.AccessToken)
	stop()
	wsMustClose(t, open)
}

func TestWebSocketExpiryClosesConnection(t *testing.T) {
	fixture := newAuthFixture(t)
	startAuthServer(t, fixture)
	a := loginFixture(t, fixture)
	socket, generation := wsLogin(t, fixture, a.Tokens.AccessToken)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, err := fixture.pool.Exec(ctx, `UPDATE session_access_tokens SET expires_at = now() - interval '1 second'
        WHERE session_id = $1`, a.Tokens.SessionId); err != nil {
		t.Fatal(err)
	}
	wsWrite(t, socket, map[string]any{
		"v": 1, "generation": generation, "op": "ping", "id": "c:expired", "optionsBytes": 0,
	}, nil)
	wsMustClose(t, socket)
}

func TestWebSocketDatabaseFailureDoesNotAuthorizeRequests(t *testing.T) {
	fixture := newAuthFixture(t)
	startAuthServer(t, fixture)
	identity := loginFixture(t, fixture)
	socket, generation := wsLogin(t, fixture, identity.Tokens.AccessToken)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, err := fixture.pool.Exec(ctx,
		"ALTER TABLE session_access_tokens RENAME TO offline_access_tokens"); err != nil {
		t.Fatal(err)
	}
	wsWrite(t, socket, map[string]any{
		"v": 1, "generation": generation, "op": "ping", "id": "c:database", "optionsBytes": 0,
	}, nil)
	header, _ := wsRead(t, socket)
	var failure gateway.Error
	if json.Unmarshal(header["error"], &failure) != nil || failure.Code != "OWNER_UNAVAILABLE" {
		t.Fatal("database failure was not reported as temporary unavailability")
	}
	wsMustClose(t, socket)
}

func TestWebSocketLogoutReturnsSuccessBeforeSessionConnectionsClose(t *testing.T) {
	fixture := newAuthFixture(t)
	t.Setenv("XIAOWEI_AUTH_RATE_LIMIT_LOGIN_EMAIL_IP_LIMIT", "20")
	startAuthServer(t, fixture)
	other := loginFixture(t, fixture)
	otherSocket, otherGeneration := wsLogin(t, fixture, other.Tokens.AccessToken)
	for attempt := 0; attempt < 8; attempt++ {
		identity := loginFixture(t, fixture)
		socket, generation := wsLogin(t, fixture, identity.Tokens.AccessToken)
		sameSession, _ := wsLogin(t, fixture, identity.Tokens.AccessToken)
		httpMe := new(pb.GetCurrentUserResponse)
		requireAuthResponse(t, requestAuth(fixture.address, "POST", "/api/auth.Auth/GetCurrentUser",
			identity.Tokens.AccessToken, nil), 200, 0, httpMe)
		if !proto.Equal(httpMe, wsMe(t, socket, generation)) {
			t.Fatal("HTTP/WS handlers diverged")
		}
		wsWrite(t, socket, map[string]any{"v": 1, "generation": generation,
			"op": "invoke", "id": "c:logout", "optionsBytes": 0,
			"route": gateway.Route{Name: "auth.Auth/Logout", Kind: "unary", ControlVersion: 3,
				ContractVersion: 1, Input: "xiaowei.common.Empty", Output: "xiaowei.server.auth.LogoutResponse"}}, nil)
		header, payload := wsRead(t, socket)
		response := new(pb.LogoutResponse)
		var id string
		_ = json.Unmarshal(header["id"], &id)
		if id != "c:logout" || len(header["error"]) != 0 || proto.Unmarshal(payload, response) != nil ||
			response.Code != 0 || response.Data == nil {
			t.Fatal("logout success was lost before close")
		}
		wsMustClose(t, socket)
		wsMustClose(t, sameSession)
		requireAuthResponse(t, requestAuth(fixture.address, "POST", "/api/auth.Auth/GetCurrentUser",
			identity.Tokens.AccessToken, nil), 200, 10002, nil)
		if wsMe(t, otherSocket, otherGeneration).Data.SessionId != other.Tokens.SessionId {
			t.Fatal("WS logout affected another device")
		}
	}
}
