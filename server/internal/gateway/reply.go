package gateway

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

type replyKey struct{}

type replyCompletion struct {
	mu        sync.Mutex
	finished  bool
	callbacks []func()
}

// AfterReply runs once after the final socket write, or on cancellation/failed delivery.
// A late handler still releases its cleanup immediately after request completion.
func AfterReply(ctx context.Context, callback func()) {
	completion, ok := ctx.Value(replyKey{}).(*replyCompletion)
	if !ok {
		callback()
		return
	}
	completion.mu.Lock()
	if !completion.finished {
		completion.callbacks = append(completion.callbacks, callback)
		completion.mu.Unlock()
		return
	}
	completion.mu.Unlock()
	runCleanup(callback)
}

func (c *replyCompletion) finish() {
	c.mu.Lock()
	if c.finished {
		c.mu.Unlock()
		return
	}
	c.finished = true
	callbacks := c.callbacks
	c.callbacks = nil
	c.mu.Unlock()
	for _, callback := range callbacks {
		runCleanup(callback)
	}
}

func runCleanup(callback func()) {
	defer func() {
		if recover() != nil {
			slog.Error("Gateway reply cleanup panicked")
		}
	}()
	callback()
}

// EndAfterReply stops new operations and periodic checks until this request's final reply.
// The request timeout, write deadline and cancellation bound the terminal state.
func (p *Peer) EndAfterReply(ctx context.Context) error {
	completion, ok := ctx.Value(replyKey{}).(*replyCompletion)
	if !ok {
		return Failure("HANDLER_ERROR", "missing reply lifecycle")
	}
	p.verifyMu.Lock()
	defer p.verifyMu.Unlock()
	completion.mu.Lock()
	defer completion.mu.Unlock()
	if completion.finished || ctx.Err() != nil || p.terminal {
		return Failure("CANCELLED", "request already ended")
	}
	p.terminal = true
	completion.callbacks = append(completion.callbacks, p.Close)
	return nil
}

func (p *Peer) verify(ctx context.Context, background bool) error {
	p.verifyMu.RLock()
	defer p.verifyMu.RUnlock()
	if p.terminal {
		if background {
			return nil
		}
		return Failure("OWNER_UNAVAILABLE", "connection is ending")
	}
	if p.check == nil {
		return nil
	}
	checkCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	err := p.check(checkCtx)
	if err != nil {
		p.Reject(err)
	}
	return err
}

func (p *Peer) sendReply(ctx context.Context, response frame) {
	written := make(chan error, 1)
	p.enqueue(response, written)
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	select {
	case err := <-written:
		if err != nil {
			p.Close()
		}
	case <-ctx.Done():
	case <-p.ctx.Done():
	case <-timer.C:
		p.Close()
	}
}
