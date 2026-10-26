// Package ws serves authenticated WebSocket API requests and server notifications.
package ws

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"unicode/utf8"
)

const (
	MaxPayload  = 8 * 1024 * 1024
	maxMetadata = 64 * 1024
	maxOptions  = 64 * 1024
	limit       = 128
)

type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func Failure(code, message string) error { return &Error{Code: code, Message: message} }

func protocolError(err error) *Error {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return contextError(err).(*Error)
	}
	var value *Error
	if errors.As(err, &value) {
		return value
	}
	return &Error{Code: "HANDLER_ERROR", Message: "remote handler failed"}
}

type Route struct {
	Name            string        `json:"name"`
	Kind            string        `json:"kind"`
	ControlVersion  int           `json:"controlVersion"`
	ContractVersion int           `json:"contractVersion"`
	Input           string        `json:"input"`
	Output          string        `json:"output"`
	TimeoutMS       int           `json:"timeoutMs,omitempty"`
	MaxConcurrency  int           `json:"maxConcurrency,omitempty"`
	StreamPolicy    *StreamPolicy `json:"streamPolicy,omitempty"`
	OptionsSchema   string        `json:"optionsSchema,omitempty"`
}

type Event struct {
	Validate func([]byte) error `json:"-"`
	Name     string             `json:"name"`
	Policy   string             `json:"policy"`
}

type Manifest struct {
	Routes []Route `json:"routes"`
	Events []Event `json:"events"`
}

type header struct {
	Version      int           `json:"v"`
	Generation   string        `json:"generation"`
	Op           string        `json:"op"`
	ID           string        `json:"id,omitempty"`
	Target       string        `json:"target,omitempty"`
	Route        *Route        `json:"route,omitempty"`
	Event        string        `json:"event,omitempty"`
	Error        *Error        `json:"error,omitempty"`
	Manifest     *Manifest     `json:"manifest,omitempty"`
	Token        string        `json:"token,omitempty"`
	Policy       *StreamPolicy `json:"policy,omitempty"`
	Done         bool          `json:"done,omitempty"`
	OptionsBytes int           `json:"optionsBytes"`
}

type frame struct {
	header
	payload []byte
	options []byte
}

func encode(f frame) ([]byte, error) {
	f.OptionsBytes = len(f.options)
	if len(f.payload) > MaxPayload || len(f.options) > maxOptions {
		return nil, Failure("RESOURCE_EXHAUSTED", "WebSocket payload too large")
	}
	metadata, err := json.Marshal(f.header)
	if err != nil || len(metadata) > maxMetadata {
		return nil, Failure("RESOURCE_EXHAUSTED", "WebSocket metadata too large")
	}
	result := make([]byte, 4+len(metadata)+len(f.payload)+len(f.options))
	binary.BigEndian.PutUint32(result, uint32(len(metadata)))
	copy(result[4:], metadata)
	copy(result[4+len(metadata):], f.payload)
	copy(result[4+len(metadata)+len(f.payload):], f.options)
	return result, nil
}

func decode(data []byte) (frame, error) {
	invalid := Failure("INCOMPATIBLE", "invalid WebSocket frame")
	if len(data) < 4 || len(data) > 4+maxMetadata+MaxPayload+maxOptions {
		return frame{}, invalid
	}
	size := int(binary.BigEndian.Uint32(data))
	if size > maxMetadata || size+4 > len(data) || !utf8.Valid(data[4:4+size]) {
		return frame{}, invalid
	}
	var f frame
	if json.Unmarshal(data[4:4+size], &f.header) != nil || f.Version != 1 || len(f.Generation) > 100 ||
		f.Op == "" || len(f.ID) > 100 || len(f.Target) > 100 || f.OptionsBytes < 0 || f.OptionsBytes > maxOptions {
		return frame{}, invalid
	}
	end := len(data) - f.OptionsBytes
	if end < 4+size || end-4-size > MaxPayload {
		return frame{}, invalid
	}
	f.payload = data[4+size : end]
	f.options = data[end:]
	return f, nil
}

func validName(name string) bool {
	if name == "" || len(name) > 200 {
		return false
	}
	for i, char := range name {
		if char == '.' && (i == 0 || i == len(name)-1 || name[i-1] == '.') {
			return false
		}
	}
	return true
}

func validateManifest(m Manifest) error {
	if len(m.Routes) > 256 || len(m.Events) > 256 {
		return Failure("RESOURCE_EXHAUSTED", "manifest too large")
	}
	names := map[string]bool{}
	for _, r := range m.Routes {
		if !validName(r.Name) || !validName(r.Input) || !validName(r.Output) || names[r.Name] ||
			r.ControlVersion != 3 || r.ContractVersion != 1 || (r.Kind != "unary" && r.Kind != "serverStreaming") ||
			r.TimeoutMS < 1 || r.TimeoutMS > 2147483647 || r.MaxConcurrency < 1 || r.MaxConcurrency > 4096 {
			return Failure("INCOMPATIBLE", "invalid route manifest")
		}
		if r.StreamPolicy != nil && !r.StreamPolicy.valid() {
			return Failure("INCOMPATIBLE", "invalid stream policy")
		}
		names[r.Name] = true
	}
	names = map[string]bool{}
	for _, e := range m.Events {
		if !validName(e.Name) || names[e.Name] ||
			(e.Policy != "ordered" && e.Policy != "coalesce" && e.Policy != "drop") {
			return Failure("INCOMPATIBLE", "invalid event manifest")
		}
		names[e.Name] = true
	}
	return nil
}
