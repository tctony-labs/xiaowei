package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"

	pb "github.com/tctony-labs/xiaowei/contracts/go/gen/xiaowei/server"
	"github.com/tctony-labs/xiaowei/server/internal/auth"
	"github.com/tctony-labs/xiaowei/server/internal/db"
	"github.com/tctony-labs/xiaowei/server/internal/gateway"
	"google.golang.org/protobuf/proto"
)

type connectionIdentity struct{}

type ConnectionHub struct {
	service        *auth.Service
	runtime        *gateway.Runtime
	mu             sync.Mutex
	peers          map[*gateway.Peer]db.SessionUser
	closed         bool
	unsubscribe    func()
	connections    map[uint64]context.CancelFunc
	nextConnection uint64
	maxConnections int
}

func NewConnectionHub(api *API) *ConnectionHub {
	registrations := make([]gateway.Registration, 0)
	for _, method := range api.ordered {
		if !method.requiresSession {
			continue
		}
		registrations = append(registrations, gateway.Registration{
			Method: method.method, Name: method.id,
			Handler: func(
				ctx context.Context, input proto.Message, peer *gateway.Peer,
			) (proto.Message, error) {
				call := apiCall{identity: ctx.Value(connectionIdentity{}).(db.SessionUser),
					ip:   ctx.Value(sourceIPKey{}).(string),
					peer: peer}
				response, _ := method.invoke(ctx, input, call)
				return response, nil
			},
		})
	}
	runtime, err := gateway.New(registrations, nil)
	if err != nil {
		panic("invalid built-in WebSocket routes")
	}
	hub := &ConnectionHub{
		service: api.auth.service, runtime: runtime, peers: map[*gateway.Peer]db.SessionUser{},
		connections: map[uint64]context.CancelFunc{}, maxConnections: 256,
	}
	hub.unsubscribe = api.auth.service.OnSessionChange(hub.sessionChanged)
	return hub
}

func (h *ConnectionHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithCancel(r.Context())
	ctx = context.WithValue(ctx, sourceIPKey{}, sourceIP(r))
	h.mu.Lock()
	if h.closed || len(h.connections) >= h.maxConnections {
		h.mu.Unlock()
		cancel()
		writeProtocolError(w, int32(pb.ErrorCode_ERROR_CODE_UNAVAILABLE), "连接暂不可用")
		return
	}
	h.nextConnection++
	id := h.nextConnection
	h.connections[id] = cancel
	h.mu.Unlock()
	defer func() {
		cancel()
		h.mu.Lock()
		delete(h.connections, id)
		h.mu.Unlock()
	}()
	var token string
	gateway.ServeHTTP(w, r.WithContext(ctx), gateway.Options{Runtime: h.runtime,
		Authenticate: func(ctx context.Context, credential string) (context.Context, error) {
			identity, err := h.service.Authenticate(ctx, credential)
			if err != nil {
				slog.Warn("WebSocket authentication rejected")
				if errors.Is(err, auth.ErrUnauthenticated) {
					return nil, gateway.Failure("UNAUTHORIZED", "登录凭据无效或已过期")
				}
				return nil, gateway.Failure("OWNER_UNAVAILABLE", "认证服务暂不可用")
			}
			token = credential
			return context.WithValue(ctx, connectionIdentity{}, identity), nil
		},
		Check: func(ctx context.Context) error {
			identity, err := h.service.Authenticate(ctx, token)
			if err != nil {
				if errors.Is(err, auth.ErrUnauthenticated) {
					return gateway.Failure("UNAUTHORIZED", "登录凭据无效或已过期")
				}
				return gateway.Failure("OWNER_UNAVAILABLE", "认证服务暂不可用")
			}
			bound := ctx.Value(connectionIdentity{}).(db.SessionUser)
			if identity.SessionID != bound.SessionID {
				return gateway.Failure("UNAUTHORIZED", "连接身份不一致")
			}
			return nil
		},
		Opened: func(peer *gateway.Peer) {
			identity := peer.Context().Value(connectionIdentity{}).(db.SessionUser)
			h.mu.Lock()
			closed := h.closed
			if !closed {
				h.peers[peer] = identity
			}
			h.mu.Unlock()
			if closed {
				peer.Close()
				return
			}
			check, cancel := context.WithTimeout(peer.Context(), 3*time.Second)
			_, err := h.service.Authenticate(check, token)
			cancel()
			if err != nil {
				peer.Close()
				return
			}
			slog.Info("WebSocket connected", "user_id", identity.User.PublicID, "session_id", identity.SessionID)
		},
		Closed: func(peer *gateway.Peer) {
			h.mu.Lock()
			identity := h.peers[peer]
			delete(h.peers, peer)
			h.mu.Unlock()
			slog.Info("WebSocket disconnected", "user_id", identity.User.PublicID, "session_id", identity.SessionID)
		},
	})
}

func (h *ConnectionHub) sessionChanged(change auth.SessionChange) {
	h.mu.Lock()
	peers := make([]*gateway.Peer, 0)
	for peer, identity := range h.peers {
		if (change.SessionID != "" && identity.SessionID == change.SessionID) ||
			(change.UserID != "" && identity.User.PublicID == change.UserID &&
				(change.DeviceID == "" || identity.Device.ID == change.DeviceID) &&
				identity.SessionID != change.KeepSessionID) {
			peers = append(peers, peer)
		}
	}
	h.mu.Unlock()
	for _, peer := range peers {
		go peer.Reject(gateway.Failure("UNAUTHORIZED", "会话已撤销，请重新登录"))
	}
}

func (h *ConnectionHub) Close() {
	h.mu.Lock()
	h.closed = true
	pending := make([]context.CancelFunc, 0, len(h.connections))
	for _, cancel := range h.connections {
		pending = append(pending, cancel)
	}
	peers := make([]*gateway.Peer, 0, len(h.peers))
	for peer := range h.peers {
		peers = append(peers, peer)
	}
	h.mu.Unlock()
	h.unsubscribe()
	for _, cancel := range pending {
		cancel()
	}
	for _, peer := range peers {
		peer.Close()
	}
}
