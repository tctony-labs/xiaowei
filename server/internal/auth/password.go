package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"golang.org/x/crypto/argon2"
)

const passwordMemory = 19 * 1024

func HashPassword(password string) (string, error) {
	if len(password) == 0 || len(password) > 1024 {
		return "", ErrInvalidArgument
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", errors.New("generate password salt failed")
	}
	key := argon2.IDKey([]byte(password), salt, 2, passwordMemory, 1, 32)
	return fmt.Sprintf("$argon2id$v=19$m=%d,t=2,p=1$%s$%s", passwordMemory,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key)), nil
}

func verifyPassword(password, encoded string) (bool, error) {
	if len(encoded) > 256 {
		return false, errors.New("invalid password hash encoding")
	}
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[0] != "" || parts[1] != "argon2id" || parts[2] != "v=19" {
		return false, errors.New("invalid password hash encoding")
	}
	parameters := strings.Split(parts[3], ",")
	if len(parameters) != 3 {
		return false, errors.New("invalid password hash parameters")
	}
	values := make([]uint32, 3)
	for i, prefix := range []string{"m=", "t=", "p="} {
		if !strings.HasPrefix(parameters[i], prefix) {
			return false, errors.New("invalid password hash parameters")
		}
		value, err := strconv.ParseUint(strings.TrimPrefix(parameters[i], prefix), 10, 32)
		if err != nil {
			return false, errors.New("invalid password hash parameters")
		}
		values[i] = uint32(value)
	}
	memory, iterations, parallelism := values[0], values[1], values[2]
	if memory < 8*1024 || memory > 64*1024 || iterations < 1 || iterations > 4 ||
		parallelism < 1 || parallelism > 4 {
		return false, errors.New("password hash parameters exceed supported bounds")
	}
	salt, saltErr := base64.RawStdEncoding.Strict().DecodeString(parts[4])
	key, keyErr := base64.RawStdEncoding.Strict().DecodeString(parts[5])
	if saltErr != nil || keyErr != nil || len(salt) != 16 || len(key) != 32 {
		return false, errors.New("invalid password hash encoding")
	}
	actual := argon2.IDKey([]byte(password), salt, iterations, memory, uint8(parallelism), uint32(len(key)))
	return subtle.ConstantTimeCompare(actual, key) == 1, nil
}

func (s *Service) checkPassword(ctx context.Context, password, encoded string) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	select {
	case s.passwordSlots <- struct{}{}:
		defer func() { <-s.passwordSlots }()
	case <-ctx.Done():
		return false, ctx.Err()
	}
	if err := ctx.Err(); err != nil {
		return false, err
	}
	return verifyPassword(password, encoded)
}
