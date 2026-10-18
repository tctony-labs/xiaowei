package gateway

import (
	"context"
	"sync"
	"time"
)

// RemoteStream reads one chunk per Next; no prefetch or transparent replay occurs.
type RemoteStream struct {
	peer   *Peer
	id     string
	Policy StreamPolicy
	mu     sync.Mutex
	busy   bool
	ended  bool
	reason error
	life   context.Context
	cancel context.CancelFunc
}

func (p *Peer) Stream(ctx context.Context, route Route, payload []byte) (*RemoteStream, error) {
	found := false
	for _, exported := range p.remote.Routes {
		if sameRoute(route, exported) && route.Kind == "serverStreaming" {
			found = true
			break
		}
	}
	if !found {
		return nil, Failure("UNAUTHORIZED", "remote stream not exported")
	}
	id, err := p.allocate("stream.open")
	if err != nil {
		return nil, err
	}
	terminal := make(chan frame, 1)
	p.mu.Lock()
	if len(p.streamReaders) >= 32 {
		p.mu.Unlock()
		return nil, Failure("RESOURCE_EXHAUSTED", "stream quota full")
	}
	p.streamReaders[id] = terminal
	p.mu.Unlock()
	life, cancel := context.WithCancel(ctx)
	stream := &RemoteStream{peer: p, id: id, life: life, cancel: cancel}
	go func() {
		select {
		case frame := <-terminal:
			var err error
			if frame.Error != nil {
				err = frame.Error
			}
			stream.finish(err)
		case <-life.Done():
			stream.finish(contextError(life.Err()))
		case <-p.ctx.Done():
			stream.finish(Failure("OWNER_UNAVAILABLE", "connection closed"))
		}
	}()
	result, err := p.requestID(life, frame{header: header{Op: "stream.open", ID: id, Route: &route}, payload: payload})
	if err != nil {
		stream.finish(err)
		return nil, err
	}
	if result.Policy == nil || !result.Policy.valid() {
		stream.finish(Failure("INCOMPATIBLE", "invalid stream policy"))
		return nil, Failure("INCOMPATIBLE", "invalid stream policy")
	}
	stream.Policy = *result.Policy
	return stream, nil
}

func (s *RemoteStream) finish(err error) {
	s.mu.Lock()
	if s.ended {
		s.mu.Unlock()
		return
	}
	s.ended = true
	s.reason = err
	s.cancel()
	s.mu.Unlock()
	s.peer.mu.Lock()
	delete(s.peer.streamReaders, s.id)
	s.peer.mu.Unlock()
}

func (s *RemoteStream) Next(ctx context.Context) ([]byte, bool, error) {
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
	s.mu.Unlock()
	defer func() { s.mu.Lock(); s.busy = false; s.mu.Unlock() }()
	request, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(s.life, cancel)
	defer stop()
	defer cancel()
	result, err := s.peer.request(request, frame{header: header{Op: "stream.next", Target: s.id},
		timeout: time.Duration(s.Policy.ProducerIdleMS)*time.Millisecond + time.Second})
	if err != nil {
		s.mu.Lock()
		ended, reason := s.ended, s.reason
		s.mu.Unlock()
		if ended {
			return nil, true, reason
		}
		_ = s.Close()
		return nil, true, err
	}
	if result.Done {
		s.finish(nil)
	}
	if len(result.payload) > s.Policy.MaxChunkBytes {
		_ = s.Close()
		return nil, true, Failure("RESOURCE_EXHAUSTED", "chunk too large")
	}
	return result.payload, result.Done, nil
}

func (s *RemoteStream) Close() error {
	s.finish(Failure("CANCELLED", "stream cancelled"))
	_, err := s.peer.request(s.peer.ctx, frame{header: header{Op: "stream.cancel", Target: s.id}})
	return err
}
