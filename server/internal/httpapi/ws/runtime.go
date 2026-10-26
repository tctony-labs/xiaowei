package ws

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"
)

type Handler func(context.Context, proto.Message, *Peer) (proto.Message, error)
type StreamHandler func(context.Context, proto.Message, *Peer) (Source, error)

// Source is pulled once per remote next request; implementations must honor cancellation.
type Source interface {
	Next(context.Context) ([]byte, bool, error)
	Close() error
}

type Registration struct {
	// Name overrides the network export address; message descriptors remain unchanged.
	Name           string
	Method         protoreflect.MethodDescriptor
	Handler        Handler
	StreamHandler  StreamHandler
	Timeout        time.Duration
	MaxConcurrency int
	Policy         StreamPolicy
}

type entry struct {
	registration Registration
	route        Route
	slots        chan struct{}
}

type Runtime struct {
	streamMu      sync.Mutex
	activeStreams int
	entries       map[string]*entry
	events        map[string]Event
	manifest      Manifest
}

func New(registrations []Registration, events []Event) (*Runtime, error) {
	runtime := &Runtime{entries: map[string]*entry{}, events: map[string]Event{},
		manifest: Manifest{Routes: []Route{}, Events: []Event{}}}
	for _, registration := range registrations {
		method := registration.Method
		if method == nil || method.IsStreamingClient() {
			return nil, Failure("INVALID_ARGUMENT", "unsupported method")
		}
		if registration.Timeout == 0 {
			registration.Timeout = 30 * time.Second
		}
		if registration.MaxConcurrency == 0 {
			registration.MaxConcurrency = 32
		}
		kind := "unary"
		if method.IsStreamingServer() {
			kind = "serverStreaming"
		}
		name := registration.Name
		if name == "" {
			name = string(method.FullName())
		}
		route := Route{Name: name, Kind: kind, ControlVersion: 3, ContractVersion: 1,
			Input: string(method.Input().FullName()), Output: string(method.Output().FullName()),
			TimeoutMS: int(registration.Timeout.Milliseconds()), MaxConcurrency: registration.MaxConcurrency}
		if (kind == "unary" && (registration.Handler == nil || registration.StreamHandler != nil)) ||
			(kind == "serverStreaming" && (registration.StreamHandler == nil || registration.Handler != nil)) {
			return nil, Failure("INVALID_ARGUMENT", "handler kind mismatch")
		}
		if kind == "serverStreaming" {
			if registration.Policy.MaxChunkBytes == 0 {
				registration.Policy = DefaultStreamPolicy()
			}
			route.StreamPolicy = &registration.Policy
		}
		if registration.MaxConcurrency < 1 || registration.MaxConcurrency > 4096 {
			return nil, Failure("INVALID_ARGUMENT", "invalid concurrency")
		}
		if runtime.entries[route.Name] != nil {
			return nil, Failure("CONFLICT", "duplicate route")
		}
		runtime.entries[route.Name] = &entry{registration, route, make(chan struct{}, registration.MaxConcurrency)}
		runtime.manifest.Routes = append(runtime.manifest.Routes, route)
	}
	for _, event := range events {
		if _, ok := runtime.events[event.Name]; ok {
			return nil, Failure("CONFLICT", "duplicate event")
		}
		runtime.events[event.Name] = event
		runtime.manifest.Events = append(runtime.manifest.Events, event)
	}
	if err := validateManifest(runtime.manifest); err != nil {
		return nil, err
	}
	return runtime, nil
}

func sameRoute(a, b Route) bool {
	return a.Name == b.Name && a.Kind == b.Kind && a.Input == b.Input && a.Output == b.Output &&
		a.ControlVersion == b.ControlVersion && a.ContractVersion == b.ContractVersion
}

func (r *Runtime) lookup(route *Route) (*entry, proto.Message, error) {
	if route == nil {
		return nil, nil, Failure("INVALID_ARGUMENT", "missing route")
	}
	entry := r.entries[route.Name]
	if entry == nil {
		return nil, nil, Failure("UNAUTHORIZED", "route not exported to network")
	}
	if !sameRoute(entry.route, *route) {
		return nil, nil, Failure("INCOMPATIBLE", "route contract mismatch")
	}
	typ, err := protoregistry.GlobalTypes.FindMessageByName(entry.registration.Method.Input().FullName())
	if err != nil {
		return nil, nil, Failure("HANDLER_ERROR", "request type unavailable")
	}
	return entry, typ.New().Interface(), nil
}

func (r *Runtime) invoke(ctx context.Context, peer *Peer, f frame) (response []byte, failure error) {
	entry, input, err := r.lookup(f.Route)
	if err != nil {
		return nil, err
	}
	started := time.Now()
	defer func() {
		code := "OK"
		level := slog.LevelInfo
		if failure != nil {
			code = protocolError(failure).Code
			level = slog.LevelWarn
		}
		slog.Log(ctx, level, "WebSocket request completed",
			"method", string(entry.registration.Method.FullName()),
			"transport", "websocket", "code", code, "duration_ms", time.Since(started).Milliseconds())
	}()
	if entry.route.Kind != "unary" {
		return nil, Failure("WRONG_METHOD_KIND", "unary operation required")
	}
	if len(f.options) != 0 {
		return nil, Failure("INVALID_ARGUMENT", "method has no service options")
	}
	if proto.Unmarshal(f.payload, input) != nil {
		return nil, Failure("INVALID_ARGUMENT", "invalid request protobuf")
	}
	select {
	case entry.slots <- struct{}{}:
	default:
		return nil, Failure("CONCURRENCY_FULL", "method concurrency full")
	}
	ctx, cancel := context.WithTimeout(ctx, entry.registration.Timeout)
	defer cancel()
	type result struct {
		value []byte
		err   error
	}
	done := make(chan result, 1)
	go func() {
		defer func() {
			if recover() != nil {
				done <- result{err: Failure("HANDLER_ERROR", "handler panicked")}
			}
			<-entry.slots
		}()
		response, err := entry.registration.Handler(ctx, input, peer)
		if err != nil {
			done <- result{err: err}
			return
		}
		if response == nil ||
			response.ProtoReflect().Descriptor().FullName() != entry.registration.Method.Output().FullName() {
			done <- result{err: Failure("HANDLER_ERROR", "invalid handler response")}
			return
		}
		value, err := proto.Marshal(response)
		if len(value) > MaxPayload {
			err = Failure("RESOURCE_EXHAUSTED", "response too large")
		}
		done <- result{value, err}
	}()
	select {
	case response := <-done:
		return response.value, response.err
	case <-ctx.Done():
		return nil, contextError(ctx.Err())
	}
}

func contextError(err error) error {
	if errors.Is(err, context.DeadlineExceeded) {
		return Failure("TIMEOUT", "remote operation timed out")
	}
	return Failure("CANCELLED", "remote operation cancelled")
}

type StreamPolicy struct {
	MaxChunkBytes    int `json:"maxChunkBytes"`
	QueueItems       int `json:"queueItems"`
	QueueBytes       int `json:"queueBytes"`
	MaxOwnerStreams  int `json:"maxOwnerStreams"`
	MaxCallerStreams int `json:"maxCallerStreams"`
	OpenTimeoutMS    int `json:"openTimeoutMs"`
	ProducerIdleMS   int `json:"producerIdleMs"`
	ConsumerIdleMS   int `json:"consumerIdleMs"`
	TotalMS          int `json:"totalMs"`
}

func DefaultStreamPolicy() StreamPolicy {
	return StreamPolicy{1024 * 1024, 16, 4 * 1024 * 1024, 128, 32, 10000, 60000, 60000, 0}
}

func (p StreamPolicy) valid() bool {
	return p.MaxChunkBytes > 0 && p.MaxChunkBytes <= MaxPayload && p.QueueItems > 0 && p.QueueItems <= 4096 &&
		p.QueueBytes > 0 && p.QueueBytes <= MaxPayload && p.MaxOwnerStreams > 0 && p.MaxOwnerStreams <= 4096 &&
		p.MaxCallerStreams > 0 && p.MaxCallerStreams <= 4096 && p.OpenTimeoutMS > 0 && p.OpenTimeoutMS <= 2147483647 &&
		p.ProducerIdleMS > 0 && p.ProducerIdleMS <= 2147483647 &&
		p.ConsumerIdleMS > 0 && p.ConsumerIdleMS <= 2147483647 &&
		p.TotalMS >= 0 && p.TotalMS <= 2147483647
}

type streamState struct {
	mu         sync.Mutex
	source     Source
	ctx        context.Context
	cancel     context.CancelFunc
	policy     StreamPolicy
	timer      *time.Timer
	total      *time.Timer
	busy       bool
	ended      bool
	reason     error
	nextDone   chan struct{}
	finishOnce sync.Once
	cleaned    chan struct{}
	released   func()
	notify     func(error)
}

func (s *streamState) finish(err error) {
	s.finishOnce.Do(func() {
		s.mu.Lock()
		s.ended = true
		s.reason = err
		s.cancel()
		if s.timer != nil {
			s.timer.Stop()
		}
		if s.total != nil {
			s.total.Stop()
		}
		source := s.source
		busy := s.nextDone
		s.mu.Unlock()
		go func() {
			if busy != nil {
				<-busy
			}
			if source != nil {
				closeSource(source)
			}
			s.released()
			close(s.cleaned)
		}()
		s.notify(err)
	})
}

func (s *streamState) next(ctx context.Context) ([]byte, bool, error) {
	s.mu.Lock()
	if s.ended {
		err := s.reason
		s.mu.Unlock()
		return nil, true, err
	}
	if s.busy {
		s.mu.Unlock()
		return nil, false, Failure("CONCURRENCY_FULL", "one pending next per stream")
	}
	s.busy = true
	s.nextDone = make(chan struct{})
	s.timer.Reset(time.Duration(s.policy.ProducerIdleMS) * time.Millisecond)
	done := s.nextDone
	source := s.source
	s.mu.Unlock()
	type result struct {
		payload []byte
		end     bool
		err     error
	}
	completed := make(chan result, 1)
	go func() {
		defer close(done)
		defer func() {
			if recover() != nil {
				completed <- result{err: Failure("HANDLER_ERROR", "producer panicked")}
			}
		}()
		value, end, err := source.Next(s.ctx)
		completed <- result{value, end, err}
	}()
	var value result
	select {
	case value = <-completed:
	case <-s.ctx.Done():
		s.mu.Lock()
		reason := s.reason
		s.mu.Unlock()
		return nil, true, reason
	case <-ctx.Done():
		s.finish(contextError(ctx.Err()))
		return nil, true, contextError(ctx.Err())
	}
	s.mu.Lock()
	s.busy = false
	if !s.ended {
		s.timer.Reset(time.Duration(s.policy.ConsumerIdleMS) * time.Millisecond)
	}
	s.mu.Unlock()
	if len(value.payload) > s.policy.MaxChunkBytes {
		value.err = Failure("RESOURCE_EXHAUSTED", "stream chunk too large")
	}
	if value.end || value.err != nil {
		s.finish(value.err)
	}
	return value.payload, value.end, value.err
}

func closeSource(source Source) {
	defer func() {
		if recover() != nil {
			slog.Error("WebSocket stream cleanup panicked")
		}
	}()
	if source.Close() != nil {
		slog.Warn("WebSocket stream cleanup failed")
	}
}
