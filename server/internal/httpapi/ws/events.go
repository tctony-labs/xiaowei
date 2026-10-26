package ws

import (
	"context"
	"sync"
	"time"

	"google.golang.org/protobuf/proto"
)

func decodeInput(f frame, input proto.Message) error {
	if len(f.options) != 0 {
		return Failure("INVALID_ARGUMENT", "method has no service options")
	}
	if proto.Unmarshal(f.payload, input) != nil {
		return Failure("INVALID_ARGUMENT", "invalid request protobuf")
	}
	return nil
}

type eventSubscription struct {
	ctx    context.Context
	cancel context.CancelFunc
	event  Event
	filter []byte
	mu     sync.Mutex
	queue  [][]byte
	bytes  int
	wake   chan struct{}
}

func (p *Peer) subscribeLocal(ctx context.Context, f frame) error {
	event, ok := p.runtime.events[f.Event]
	if !ok {
		return Failure("UNAUTHORIZED", "event not exported")
	}
	if event.Validate != nil {
		if err := event.Validate(f.payload); err != nil {
			return err
		}
	} else if len(f.payload) != 0 {
		return Failure("INVALID_ARGUMENT", "event does not accept a filter")
	}
	// Filters are business-defined opaque PB. A publisher explicitly supplies matching logic.
	life, cancel := context.WithCancel(p.ctx)
	subscription := &eventSubscription{ctx: life, cancel: cancel, event: event,
		filter: append([]byte(nil), f.payload...), wake: make(chan struct{}, 1)}
	p.mu.Lock()
	if len(p.subscriptions) >= limit || p.ended || ctx.Err() != nil {
		p.mu.Unlock()
		cancel()
		return Failure("RESOURCE_EXHAUSTED", "subscription table full")
	}
	p.subscriptions[f.ID] = subscription
	p.mu.Unlock()
	go func() {
		for {
			select {
			case <-life.Done():
				return
			case <-subscription.wake:
			}
			for {
				subscription.mu.Lock()
				if len(subscription.queue) == 0 {
					subscription.mu.Unlock()
					break
				}
				value := subscription.queue[0]
				subscription.queue = subscription.queue[1:]
				subscription.bytes -= len(value)
				subscription.mu.Unlock()
				delivery, stop := context.WithTimeout(life, 10*time.Second)
				err := p.deliverEvent(delivery, f.ID, value)
				stop()
				if err != nil {
					if life.Err() != nil {
						return
					}
					p.Close()
					return
				}
			}
		}
	}()
	return nil
}

// Publish addresses only this authenticated connection, never another user's subscriptions.
// For filtered events the business owner must validate and match each subscription's filter.
func (p *Peer) Publish(event string, payload []byte, matches func([]byte) bool) error {
	if len(payload) > MaxPayload {
		return Failure("RESOURCE_EXHAUSTED", "event too large")
	}
	p.mu.Lock()
	subscriptions := make([]*eventSubscription, 0, len(p.subscriptions))
	for _, subscription := range p.subscriptions {
		if subscription.event.Name == event {
			subscriptions = append(subscriptions, subscription)
		}
	}
	p.mu.Unlock()
	for _, subscription := range subscriptions {
		if len(subscription.filter) != 0 && (matches == nil || !matches(subscription.filter)) {
			continue
		}
		subscription.mu.Lock()
		if subscription.ctx.Err() != nil {
			subscription.mu.Unlock()
			continue
		}
		if subscription.event.Policy == "drop" && len(subscription.queue) > 0 {
			subscription.mu.Unlock()
			continue
		}
		if subscription.event.Policy == "coalesce" {
			subscription.queue = nil
			subscription.bytes = 0
		}
		if len(subscription.queue) >= 16 || subscription.bytes+len(payload) > 4*1024*1024 {
			subscription.mu.Unlock()
			p.Close()
			return Failure("RESOURCE_EXHAUSTED", "event queue full")
		}
		subscription.queue = append(subscription.queue, append([]byte(nil), payload...))
		subscription.bytes += len(payload)
		subscription.mu.Unlock()
		select {
		case subscription.wake <- struct{}{}:
		default:
		}
	}
	return nil
}
