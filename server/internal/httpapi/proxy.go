package httpapi

import (
	"context"
	"net/http"
	"net/netip"
	"strings"
)

type sourceIPKey struct{}

// WithTrustedProxies accepts a single X-Real-IP only from an explicitly configured TCP peer.
// The reverse proxy must replace the incoming header, rather than append to it.
func WithTrustedProxies(next http.Handler, trusted []netip.Prefix) http.Handler {
	if len(trusted) == 0 {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		peer, err := netip.ParseAddr(sourceIP(r))
		if err == nil {
			for _, prefix := range trusted {
				if !prefix.Contains(peer.Unmap()) {
					continue
				}
				values := r.Header.Values("X-Real-IP")
				if len(values) == 1 {
					client, err := netip.ParseAddr(strings.TrimSpace(values[0]))
					if err == nil && client.Zone() == "" {
						ctx := context.WithValue(r.Context(), sourceIPKey{}, client.Unmap().String())
						r = r.WithContext(ctx)
					}
				}
				break
			}
		}
		next.ServeHTTP(w, r)
	})
}
