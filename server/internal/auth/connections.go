package auth

import "context"

// SessionChange is emitted only after the corresponding database transaction commits.
// Listeners close live transports; they must not perform database work or block.
type SessionChange struct {
	UserID        string
	DeviceID      string
	SessionID     string
	KeepSessionID string
}

func (s *Service) OnSessionChange(listener func(SessionChange)) func() {
	s.connectionsMu.Lock()
	if s.connections == nil {
		s.connections = map[uint64]func(SessionChange){}
	}
	s.connectionSequence++
	id := s.connectionSequence
	s.connections[id] = listener
	s.connectionsMu.Unlock()
	return func() { s.connectionsMu.Lock(); delete(s.connections, id); s.connectionsMu.Unlock() }
}

func (s *Service) sessionChanged(change SessionChange) {
	s.connectionsMu.Lock()
	listeners := make([]func(SessionChange), 0, len(s.connections))
	for _, listener := range s.connections {
		listeners = append(listeners, listener)
	}
	s.connectionsMu.Unlock()
	for _, listener := range listeners {
		listener(change)
	}
}

// WithSessionChangeDelivery lets an adapter delay notification until its reply completes.
// Delivery must run the notification even on cancellation or a failed reply.
func WithSessionChangeDelivery(ctx context.Context, deliver func(func())) context.Context {
	return context.WithValue(ctx, sessionChangeDelivery{}, deliver)
}

type sessionChangeDelivery struct{}

func (s *Service) deliverSessionChange(ctx context.Context, change SessionChange) {
	notify := func() { s.sessionChanged(change) }
	if deliver, ok := ctx.Value(sessionChangeDelivery{}).(func(func())); ok {
		deliver(notify)
	} else {
		notify()
	}
}
