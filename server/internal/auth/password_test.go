package auth

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestPasswordHashAndValidation(t *testing.T) {
	password := "  a password with spaces  "
	first, err := HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	second, err := HashPassword(password)
	if err != nil || first == second {
		t.Fatal("independent salts were not used")
	}
	for _, tc := range []struct {
		password string
		want     bool
	}{
		{password, true}, {strings.TrimSpace(password), false}, {"wrong", false},
	} {
		valid, err := verifyPassword(tc.password, first)
		if err != nil || valid != tc.want {
			t.Fatalf("password validation = %v, %v", valid, err)
		}
	}
	for _, encoded := range []string{
		"", "plaintext", strings.Replace(first, "v=19", "v=16", 1),
		strings.Replace(first, "m=19456", "m=4294967295", 1),
		strings.Replace(first, "t=2", "t=0", 1), strings.Replace(first, "p=1", "p=256", 1),
		strings.Replace(first, "t=2", "t=9999999999999999", 1), first + "$extra",
	} {
		if _, err := verifyPassword(password, encoded); err == nil {
			t.Fatal("invalid password hash accepted")
		}
	}
	for _, password := range []string{"", strings.Repeat("a", 1025)} {
		if _, err := HashPassword(password); !errors.Is(err, ErrInvalidArgument) {
			t.Fatal("invalid password size accepted")
		}
	}
}

func TestPasswordQueueCancellation(t *testing.T) {
	service := &Service{passwordSlots: make(chan struct{}, 2)}
	service.passwordSlots <- struct{}{}
	service.passwordSlots <- struct{}{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	finished := make(chan error, 1)
	go func() {
		_, err := service.checkPassword(ctx, "password", "unused")
		finished <- err
	}()
	select {
	case <-finished:
		t.Fatal("password verification bypassed the full queue")
	case <-time.After(10 * time.Millisecond):
	}
	cancel()
	if err := <-finished; !errors.Is(err, context.Canceled) {
		t.Fatal("canceled password request did not stop")
	}
	if len(service.passwordSlots) != 2 {
		t.Fatal("cancellation released another request's slot")
	}
}

func BenchmarkHashPassword(b *testing.B) {
	b.ReportAllocs()
	for b.Loop() {
		if _, err := HashPassword("test-password"); err != nil {
			b.Fatal(err)
		}
	}
}
