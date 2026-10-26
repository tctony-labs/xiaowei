package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	pb "github.com/tctony-labs/xiaowei/contracts/out/proto-server-go/gen/xiaowei/server"
	"github.com/tctony-labs/xiaowei/server/internal/auth"
	"github.com/tctony-labs/xiaowei/server/internal/config"
)

func TestWebSocketCapacityIncludesPendingAuthenticationAndShutdownCancelsIt(t *testing.T) {
	service, err := auth.New(nil, auth.Options{AccessTokenTTL: time.Hour, RefreshTokenTTL: 24 * time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	hub := NewConnectionHub(NewAPI(func(context.Context) error { return nil }, service, config.DefaultAuthRateLimit()))
	hub.maxConnections = 2
	server := httptest.NewServer(hub)
	defer server.Close()
	defer hub.Close()
	address := "ws" + strings.TrimPrefix(server.URL, "http")
	dial := func() (*websocket.Conn, *http.Response, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		return websocket.Dial(ctx, address, nil)
	}
	first, _, err := dial()
	if err != nil {
		t.Fatal(err)
	}
	defer first.CloseNow()
	second, _, err := dial()
	if err != nil {
		t.Fatal(err)
	}
	defer second.CloseNow()
	// Neither client sends the authentication frame, so the authenticated peer table is empty.
	extra, response, err := dial()
	if extra != nil {
		_ = extra.CloseNow()
	}
	if err == nil || response == nil {
		t.Fatal("pending authentication bypassed connection capacity")
	}
	defer response.Body.Close()
	var result pb.BaseResponse
	if json.NewDecoder(response.Body).Decode(&result) != nil ||
		result.Code != int32(pb.ErrorCode_ERROR_CODE_UNAVAILABLE) {
		t.Fatal("connection capacity did not return the protocol unavailable result")
	}
	_ = first.CloseNow()
	deadline := time.Now().Add(2 * time.Second)
	var replacement *websocket.Conn
	for time.Now().Before(deadline) {
		replacement, response, err = dial()
		if err == nil {
			break
		}
		if response != nil {
			_ = response.Body.Close()
		}
		time.Sleep(time.Millisecond)
	}
	if err != nil || replacement == nil {
		t.Fatal("closed handshake did not release connection capacity")
	}
	defer replacement.CloseNow()
	hub.Close()
	for _, socket := range []*websocket.Conn{second, replacement} {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		_, _, err := socket.Read(ctx)
		expired := ctx.Err() != nil
		cancel()
		if err == nil || expired {
			t.Fatal("shutdown did not cancel unauthenticated handshake promptly")
		}
	}
}
