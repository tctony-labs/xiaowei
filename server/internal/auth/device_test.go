package auth

import "testing"

func TestDeviceID(t *testing.T) {
	for _, value := range []string{
		"550e8400-e29b-41d4-a716-446655440000",
		"00000000-0000-4000-8000-000000000000",
	} {
		if !validDeviceID(value) {
			t.Fatal("valid UUID v4 rejected")
		}
	}
	for _, value := range []string{
		"", "d_aaaaaaaaaaaaaaaaaaaaaa", "550E8400-e29b-41d4-a716-446655440000",
		"550e8400-e29b-11d4-a716-446655440000", "550e8400-e29b-41d4-7716-446655440000",
		"550e8400e29b41d4a716446655440000", "550e8400-e29b-41d4-a716-446655440000 ",
	} {
		if validDeviceID(value) {
			t.Fatal("invalid or noncanonical UUID accepted")
		}
	}
}
