package auth

import (
	"strings"
	"testing"
)

func TestNewPasswordPolicy(t *testing.T) {
	for _, tc := range []struct {
		password string
		valid    bool
	}{
		{"123456", true}, {strings.Repeat("a", 32), true}, {"  ab  ", true},
		{"Aa1!$#", true}, {"", false}, {"12345", false}, {strings.Repeat("a", 33), false},
		{"中文密码123456", false}, {"é123456", false}, {"abc\ndef", false}, {"abc\tdef", false},
		{"abc\x00def", false}, {"abc\x7fdef", false},
	} {
		if got := validNewPassword(tc.password); got != tc.valid {
			t.Fatalf("password policy returned %v, want %v", got, tc.valid)
		}
	}
}
