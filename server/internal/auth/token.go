package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
)

func randomValue(prefix string, size int) (string, error) {
	value := make([]byte, size)
	if _, err := rand.Read(value); err != nil {
		return "", errors.New("generate authentication credential failed")
	}
	return prefix + base64.RawURLEncoding.EncodeToString(value), nil
}

func tokenHash(token, prefix string) ([]byte, error) {
	if !strings.HasPrefix(token, prefix) || len(token) != len(prefix)+43 {
		return nil, ErrUnauthenticated
	}
	value, err := base64.RawURLEncoding.Strict().DecodeString(token[len(prefix):])
	if err != nil || len(value) != 32 {
		return nil, ErrUnauthenticated
	}
	hash := sha256.Sum256([]byte(token))
	return hash[:], nil
}
