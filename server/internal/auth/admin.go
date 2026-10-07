package auth

import (
	"context"
	"errors"
	"log/slog"
)

func (s *Service) InitializeAdmin(ctx context.Context, email, password string) error {
	initialized, err := s.store.AdminInitialized(ctx)
	if err != nil {
		return err
	}
	if initialized {
		slog.Info("administrator initialization skipped", "reason", "already initialized")
		return nil
	}

	email, err = NormalizeEmail(email)
	if err != nil {
		return errors.New("administrator initialization email is invalid")
	}
	if !validNewPassword(password) {
		return errors.New("administrator initialization password must be 6-32 printable ASCII characters")
	}
	passwordHash, err := HashPassword(password)
	if err != nil {
		return err
	}
	user, created, err := s.store.InitializeAdmin(ctx, email, passwordHash)
	if err != nil {
		return err
	}
	if created {
		slog.Info("administrator initialized", "user_id", user.PublicID)
	} else {
		slog.Info("administrator initialization skipped", "reason", "already initialized")
	}
	return nil
}

func validNewPassword(password string) bool {
	if len(password) < 6 || len(password) > 32 {
		return false
	}
	for i := range len(password) {
		if password[i] < 0x20 || password[i] > 0x7e {
			return false
		}
	}
	return true
}
