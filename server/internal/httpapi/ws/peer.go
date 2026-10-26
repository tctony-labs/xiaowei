package ws

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

type Options struct {
	Runtime      *Runtime
	Authenticate func(context.Context, string) (context.Context, error)
	Check        func(context.Context) error
	Opened       func(*Peer)
	Closed       func(*Peer)
}

type queuedWrite struct {
	data []byte
	done chan error
}

type Peer struct {
	verifyMu      sync.RWMutex
	terminal      bool
	ctx           context.Context
	cancel        context.CancelFunc
	socket        *websocket.Conn
	runtime       *Runtime
	generation    string
	check         func(context.Context) error
	mu            sync.Mutex
	ended         bool
	sequence      uint64
	pending       map[string]chan frame
	serving       map[string]context.CancelFunc
	streams       map[string]*streamState
	opening       map[string]context.CancelFunc
	subscriptions map[string]*eventSubscription
	activeStreams int
	receiving     int
	controls      int
	queuedBytes   int
	writes        chan queuedWrite
	closeOnce     sync.Once
}

// ServeHTTP keeps upgraded sockets owned by the caller's server lifetime.
func ServeHTTP(w http.ResponseWriter, r *http.Request, options Options) {
	socket, err := websocket.Accept(w, r, &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		return
	}
	defer socket.CloseNow()
	socket.SetReadLimit(4 + maxMetadata + MaxPayload + maxOptions)
	handshake, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	kind, data, err := socket.Read(handshake)
	if err != nil || kind != websocket.MessageBinary {
		cancel()
		return
	}
	first, err := decode(data)
	if err != nil || first.Op != "authenticate" || first.Generation != "" || first.Token == "" ||
		first.Manifest == nil || len(first.payload) != 0 || len(first.options) != 0 {
		cancel()
		return
	}
	// The published handshake carries an empty client manifest. All API interfaces are served here.
	if len(first.Manifest.Routes) != 0 || len(first.Manifest.Events) != 0 {
		cancel()
		return
	}
	authenticated, err := options.Authenticate(handshake, first.Token)
	first.Token = ""
	if err != nil {
		payload, _ := encode(frame{header: header{Version: 1, Op: "ready", Error: protocolError(err)}})
		_ = socket.Write(handshake, websocket.MessageBinary, payload)
		cancel()
		return
	}
	// Keep identity values while removing the finite authentication deadline; shutdown uses request lifetime.
	ctx, stop := context.WithCancel(context.WithoutCancel(authenticated))
	cancel()
	defer stop()
	generation := make([]byte, 16)
	if _, err := rand.Read(generation); err != nil {
		return
	}
	peer := &Peer{ctx: ctx, cancel: stop, socket: socket, runtime: options.Runtime,
		generation: hex.EncodeToString(generation), check: options.Check,
		pending: map[string]chan frame{}, serving: map[string]context.CancelFunc{},
		streams: map[string]*streamState{}, opening: map[string]context.CancelFunc{},
		subscriptions: map[string]*eventSubscription{}, writes: make(chan queuedWrite, limit+32)}
	defer peer.Close()
	go peer.writeLoop()
	peer.send(frame{header: header{Op: "ready", Manifest: &peer.runtime.manifest}})
	if options.Opened != nil {
		options.Opened(peer)
	}
	if options.Closed != nil {
		defer options.Closed(peer)
	}
	go func() {
		select {
		case <-r.Context().Done():
			peer.Close()
		case <-ctx.Done():
		}
	}()
	go peer.monitor()
	peer.readLoop()
}

func (p *Peer) Context() context.Context { return p.ctx }

func (p *Peer) monitor() {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-p.ctx.Done():
			return
		case <-ticker.C:
			if p.verify(p.ctx, true) != nil {
				return
			}
		}
	}
}

func (p *Peer) send(f frame) {
	p.enqueue(f, nil)
}

func (p *Peer) enqueue(f frame, done chan error) {
	f.Version = 1
	f.Generation = p.generation
	data, err := encode(f)
	if err != nil {
		p.Close()
		return
	}
	p.mu.Lock()
	if p.ended {
		p.mu.Unlock()
		return
	}
	if p.queuedBytes+len(data) > 2*MaxPayload {
		p.mu.Unlock()
		p.Close()
		return
	}
	p.queuedBytes += len(data)
	select {
	case p.writes <- queuedWrite{data: data, done: done}:
		p.mu.Unlock()
	default:
		p.mu.Unlock()
		p.Close()
	}
}

func (p *Peer) writeLoop() {
	for {
		select {
		case <-p.ctx.Done():
			return
		case item := <-p.writes:
			ctx, cancel := context.WithTimeout(p.ctx, 5*time.Second)
			err := p.socket.Write(ctx, websocket.MessageBinary, item.data)
			cancel()
			p.mu.Lock()
			p.queuedBytes -= len(item.data)
			p.mu.Unlock()
			if item.done != nil {
				item.done <- err
			}
			if err != nil {
				p.Close()
				return
			}
		}
	}
}

func control(op string) bool {
	return op == "cancel" || op == "stream.cancel" || op == "unsubscribe" || op == "ping"
}

func (p *Peer) readLoop() {
	for {
		ctx, cancel := context.WithTimeout(p.ctx, 45*time.Second)
		kind, data, err := p.socket.Read(ctx)
		cancel()
		if err != nil || kind != websocket.MessageBinary {
			return
		}
		f, err := decode(data)
		if err != nil || f.Generation != p.generation {
			return
		}
		if f.Op == "result" {
			p.mu.Lock()
			target := p.pending[f.ID]
			p.mu.Unlock()
			if target != nil {
				select {
				case target <- f:
				default:
				}
			}
			continue
		}
		p.mu.Lock()
		_, duplicate := p.serving[f.ID]
		isControl := control(f.Op)
		full := (!isControl && p.receiving >= limit) || (isControl && p.controls >= 32)
		if !strings.HasPrefix(f.ID, "c:") || duplicate || full {
			p.mu.Unlock()
			return
		}
		ctx, cancel = context.WithCancel(p.ctx)
		p.serving[f.ID] = cancel
		if isControl {
			p.controls++
		} else {
			p.receiving++
		}
		// Install open cancellation before another frame can cancel it.
		if f.Op == "stream.open" {
			p.opening[f.ID] = cancel
		}
		p.mu.Unlock()
		go func() {
			defer func() {
				p.mu.Lock()
				delete(p.serving, f.ID)
				if isControl {
					p.controls--
				} else {
					p.receiving--
				}
				p.mu.Unlock()
				if f.Op != "stream.open" {
					cancel()
				}
			}()
			completion := &replyCompletion{}
			ctx = context.WithValue(ctx, replyKey{}, completion)
			stopCleanup := context.AfterFunc(ctx, completion.finish)
			defer stopCleanup()
			defer completion.finish()
			response, err := p.safeServe(ctx, f)
			response.Op = "result"
			response.ID = f.ID
			if err != nil {
				response.Error = protocolError(err)
			}
			p.sendReply(ctx, response)
		}()
	}
}

func (p *Peer) safeServe(ctx context.Context, f frame) (response frame, err error) {
	defer func() {
		if recover() != nil {
			err = Failure("HANDLER_ERROR", "remote operation panicked")
		}
	}()
	return p.serve(ctx, f)
}

func (p *Peer) serve(ctx context.Context, f frame) (frame, error) {
	if f.Op == "cancel" || f.Op == "stream.cancel" {
		p.mu.Lock()
		cancel := p.serving[f.Target]
		open := p.opening[f.Target]
		stream := p.streams[f.Target]
		p.mu.Unlock()
		if cancel != nil {
			cancel()
		}
		if f.Op == "stream.cancel" {
			if open != nil {
				open()
			}
			if stream != nil {
				stream.finish(Failure("CANCELLED", "stream cancelled"))
				cleanup := time.NewTimer(time.Second)
				defer cleanup.Stop()
				select {
				case <-stream.cleaned:
				case <-cleanup.C:
					return frame{}, Failure("TIMEOUT", "stream cleanup timed out")
				}
			}
		}
		return frame{}, nil
	}
	if f.Op == "unsubscribe" {
		p.mu.Lock()
		subscription := p.subscriptions[f.Target]
		delete(p.subscriptions, f.Target)
		p.mu.Unlock()
		if subscription != nil {
			subscription.cancel()
		}
		return frame{}, nil
	}
	if err := p.verify(ctx, false); err != nil {
		return frame{}, err
	}

	switch f.Op {
	case "ping":
		return frame{}, nil
	case "invoke":
		payload, err := p.runtime.invoke(ctx, p, f)
		return frame{payload: payload}, err
	case "stream.open":
		return p.openStream(ctx, f)
	case "stream.next":
		p.mu.Lock()
		stream := p.streams[f.Target]
		p.mu.Unlock()
		if stream == nil {
			return frame{}, Failure("OWNER_UNAVAILABLE", "stream unavailable")
		}
		payload, done, err := stream.next(ctx)
		return frame{header: header{Done: done}, payload: payload}, err
	case "subscribe":
		return frame{}, p.subscribeLocal(ctx, f)
	default:
		return frame{}, Failure("INVALID_ARGUMENT", "unknown WebSocket operation")
	}
}

func (p *Peer) openStream(ctx context.Context, f frame) (response frame, failure error) {
	defer func() {
		if failure != nil {
			p.mu.Lock()
			cancel := p.opening[f.ID]
			delete(p.opening, f.ID)
			p.mu.Unlock()
			if cancel != nil {
				cancel()
			}
		}
	}()
	entry, input, err := p.runtime.lookup(f.Route)
	if err != nil {
		return frame{}, err
	}
	if entry.route.Kind != "serverStreaming" {
		return frame{}, Failure("WRONG_METHOD_KIND", "stream operation required")
	}
	if err := decodeInput(f, input); err != nil {
		return frame{}, err
	}
	policy := entry.registration.Policy
	p.mu.Lock()
	p.runtime.streamMu.Lock()
	full := p.activeStreams >= policy.MaxCallerStreams || p.runtime.activeStreams >= policy.MaxOwnerStreams || p.ended
	if !full {
		p.activeStreams++
		p.runtime.activeStreams++
	}
	p.runtime.streamMu.Unlock()
	p.mu.Unlock()
	if full {
		return frame{}, Failure("RESOURCE_EXHAUSTED", "stream quota full")
	}
	releaseCount := func() {
		p.mu.Lock()
		p.activeStreams--
		p.mu.Unlock()
		p.runtime.streamMu.Lock()
		p.runtime.activeStreams--
		p.runtime.streamMu.Unlock()
	}
	select {
	case entry.slots <- struct{}{}:
	default:
		releaseCount()
		return frame{}, Failure("CONCURRENCY_FULL", "stream concurrency full")
	}
	released := func() { <-entry.slots; releaseCount() }
	streamCtx, stop := context.WithCancel(ctx)
	opened := make(chan Source, 1)
	failed := make(chan error, 1)
	go func() {
		defer func() {
			if recover() != nil {
				failed <- Failure("HANDLER_ERROR", "stream factory panicked")
			}
		}()
		source, err := entry.registration.StreamHandler(streamCtx, input, p)
		if err != nil {
			failed <- err
			return
		}
		if source == nil {
			failed <- Failure("HANDLER_ERROR", "missing stream source")
			return
		}
		opened <- source
	}()
	timer := time.NewTimer(time.Duration(policy.OpenTimeoutMS) * time.Millisecond)
	defer timer.Stop()
	var source Source
	select {
	case source = <-opened:
	case err := <-failed:
		stop()
		released()
		return frame{}, err
	case <-ctx.Done():
		err = contextError(ctx.Err())
	case <-timer.C:
		err = Failure("TIMEOUT", "stream open timed out")
	}
	if err != nil {
		stop()
		go func() {
			select {
			case source := <-opened:
				closeSource(source)
			case <-failed:
			}
			released()
		}()
		p.mu.Lock()
		delete(p.opening, f.ID)
		p.mu.Unlock()
		return frame{}, err
	}
	state := &streamState{
		source: source, ctx: streamCtx, cancel: stop, policy: policy,
		released: released, cleaned: make(chan struct{}),
	}
	state.notify = func(err error) {
		code := "OK"
		if err != nil {
			code = protocolError(err).Code
		}
		slog.Info("WebSocket stream ended", "method", entry.route.Name, "code", code)
		p.mu.Lock()
		delete(p.streams, f.ID)
		delete(p.opening, f.ID)
		p.mu.Unlock()
		end := frame{header: header{Op: "stream.end", Target: f.ID, Done: true}}
		if err != nil {
			end.Error = protocolError(err)
		}
		p.send(end)
	}
	state.mu.Lock()
	state.timer = time.AfterFunc(time.Duration(policy.ConsumerIdleMS)*time.Millisecond,
		func() { state.finish(Failure("TIMEOUT", "stream idle timed out")) })
	if policy.TotalMS > 0 {
		state.total = time.AfterFunc(time.Duration(policy.TotalMS)*time.Millisecond,
			func() { state.finish(Failure("TIMEOUT", "stream total timed out")) })
	}
	p.mu.Lock()
	ended := p.ended || ctx.Err() != nil || state.ended
	if !ended {
		delete(p.opening, f.ID)
		p.streams[f.ID] = state
	}
	p.mu.Unlock()
	state.mu.Unlock()
	if ended {
		state.finish(Failure("CANCELLED", "stream open cancelled"))
		return frame{}, contextError(ctx.Err())
	}
	return frame{header: header{Policy: &policy}}, nil
}

func (p *Peer) deliverEvent(ctx context.Context, target string, payload []byte) error {
	if ctx.Err() != nil {
		return contextError(ctx.Err())
	}
	response := make(chan frame, 1)
	p.mu.Lock()
	if p.ended {
		p.mu.Unlock()
		return Failure("OWNER_UNAVAILABLE", "connection closed")
	}
	if len(p.pending) >= limit {
		p.mu.Unlock()
		return Failure("RESOURCE_EXHAUSTED", "notification table full")
	}
	p.sequence++
	id := "s:" + hexID(p.sequence)
	p.pending[id] = response
	p.mu.Unlock()
	defer func() { p.mu.Lock(); delete(p.pending, id); p.mu.Unlock() }()
	p.send(frame{header: header{Op: "event", ID: id, Target: target}, payload: payload})
	select {
	case result := <-response:
		if result.Error != nil {
			return result.Error
		}
		return nil
	case <-ctx.Done():
		p.send(frame{header: header{Op: "cancel", ID: "s:cancel:" + id, Target: id}})
		return contextError(ctx.Err())
	case <-p.ctx.Done():
		return Failure("OWNER_UNAVAILABLE", "connection closed")
	}
}

func hexID(id uint64) string {
	var data [8]byte
	for i := 7; i >= 0; i-- {
		data[i] = byte(id)
		id >>= 8
	}
	return hex.EncodeToString(data[:])
}

// Reject reports a safe protocol reason before terminating the connection.
func (p *Peer) Reject(reason error) {
	data, err := encode(frame{header: header{Version: 1, Generation: p.generation,
		Op: "connection.end", Error: protocolError(reason)}})
	if err == nil {
		ctx, cancel := context.WithTimeout(p.ctx, time.Second)
		_ = p.socket.Write(ctx, websocket.MessageBinary, data)
		cancel()
	}
	p.Close()
}

func (p *Peer) Close() {
	p.closeOnce.Do(func() {
		p.mu.Lock()
		p.ended = true
		p.cancel()
		for _, cancel := range p.serving {
			cancel()
		}
		for _, cancel := range p.opening {
			cancel()
		}
		streams := make([]*streamState, 0, len(p.streams))
		for _, stream := range p.streams {
			streams = append(streams, stream)
		}
		for _, subscription := range p.subscriptions {
			subscription.cancel()
		}
		p.mu.Unlock()
		for _, stream := range streams {
			stream.finish(Failure("OWNER_UNAVAILABLE", "connection closed"))
		}
		_ = p.socket.CloseNow()
	})
}
