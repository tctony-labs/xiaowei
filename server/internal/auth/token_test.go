package auth

import (
	"bytes"
	"crypto/sha256"
	"strings"
	"testing"
)

func TestTokenTypesAndEncoding(t *testing.T) {
	access, err := randomValue("at_", 32)
	if err != nil {
		t.Fatal(err)
	}
	hash, err := tokenHash(access, "at_")
	want := sha256.Sum256([]byte(access))
	if err != nil || !bytes.Equal(hash, want[:]) {
		t.Fatal("token digest does not match")
	}
	for _, token := range []string{
		access, "rt_" + strings.Repeat("!", 43), "rt_" + strings.Repeat("A", 42),
		"rt_" + strings.Repeat("A", 42) + "B", "rt_" + strings.Repeat("A", 43) + "=",
	} {
		if _, err := tokenHash(token, "rt_"); err == nil {
			t.Fatal("invalid refresh token accepted")
		}
	}
	refresh, err := randomValue("rt_", 32)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tokenHash(refresh, "rt_"); err != nil {
		t.Fatal(err)
	}
	session, err := randomValue("s_", 16)
	if err != nil || len(session) != 24 {
		t.Fatal("invalid public session ID")
	}
}

func TestEmailNormalization(t *testing.T) {
	for _, value := range []string{" User+tag@Example.COM ", "user+tag@example.com"} {
		got, err := NormalizeEmail(value)
		if err != nil || got != "user+tag@example.com" {
			t.Fatal("email normalization changed alias identity")
		}
	}
	for _, value := range []string{"", "not-an-email", "Name <a@example.com>", "用户@example.com"} {
		if _, err := NormalizeEmail(value); err == nil {
			t.Fatal("invalid email accepted")
		}
	}
}
