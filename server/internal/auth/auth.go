package auth

import (
	"context"
	"errors"
	"fmt"
	"net/mail"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/tctony-labs/xiaowei/server/internal/db"
)

var (
	ErrInvalidArgument    = errors.New("invalid authentication input")
	ErrInvalidCredentials = errors.New("invalid email or password")
	ErrUnauthenticated    = errors.New("invalid or expired authentication credential")
	ErrUnavailable        = errors.New("authentication temporarily unavailable")
	ErrInternal           = errors.New("authentication failed")
)

type Options struct {
	AccessTokenTTL  time.Duration
	RefreshTokenTTL time.Duration
}

type Service struct {
	store         *db.Store
	options       Options
	dummyHash     string
	passwordSlots chan struct{}
}

type Tokens struct {
	SessionID        string
	AccessToken      string
	RefreshToken     string
	AccessExpiresAt  time.Time
	RefreshExpiresAt time.Time
}

type LoginResult struct {
	Identity db.SessionUser
	Tokens   Tokens
}

func New(store *db.Store, options Options) (*Service, error) {
	if options.AccessTokenTTL <= 0 || options.RefreshTokenTTL <= options.AccessTokenTTL {
		return nil, errors.New("invalid authentication token lifetimes")
	}
	dummyPassword, err := randomValue("", 32)
	if err != nil {
		return nil, err
	}
	dummyHash, err := HashPassword(dummyPassword)
	if err != nil {
		return nil, err
	}
	return &Service{
		store: store, options: options, dummyHash: dummyHash, passwordSlots: make(chan struct{}, 2),
	}, nil
}

func NormalizeEmail(value string) (string, error) {
	value = strings.ToLower(strings.TrimSpace(value))
	if len(value) == 0 || len(value) > 254 {
		return "", ErrInvalidArgument
	}
	for _, ch := range value {
		if ch > 127 {
			return "", ErrInvalidArgument
		}
	}
	address, err := mail.ParseAddress(value)
	if err != nil || address.Address != value || address.Name != "" {
		return "", ErrInvalidArgument
	}
	return value, nil
}

func (s *Service) Login(ctx context.Context, email, password, deviceID, deviceName string) (LoginResult, error) {
	email, err := NormalizeEmail(email)
	if err != nil || !validDeviceID(deviceID) || len(password) == 0 || len(password) > 1024 || len(deviceName) > 128 ||
		!utf8.ValidString(deviceName) || strings.IndexFunc(deviceName, unicode.IsControl) >= 0 {
		return LoginResult{}, ErrInvalidArgument
	}

	identity, err := s.store.FindEmailIdentity(ctx, email)
	missing := errors.Is(err, db.ErrUserNotFound)
	if err != nil && !missing {
		return LoginResult{}, unavailable(err)
	}
	encoded := identity.PasswordHash
	if missing {
		encoded = s.dummyHash
	}
	valid, err := s.checkPassword(ctx, password, encoded)
	if err != nil {
		return LoginResult{}, unavailable(err)
	}
	if !valid || missing {
		return LoginResult{}, ErrInvalidCredentials
	}
	if err := ctx.Err(); err != nil {
		return LoginResult{}, unavailable(err)
	}

	now := time.Now().UTC()
	tokens, hashes, err := s.newTokens(now)
	if err != nil {
		return LoginResult{}, err
	}
	tokens.SessionID, err = randomValue("s_", 16)
	if err != nil {
		return LoginResult{}, ErrInternal
	}
	device := db.Device{ID: deviceID, Name: deviceName}
	if err := s.store.CreateSession(ctx, identity.User.ID, tokens.SessionID, device, hashes, now); err != nil {
		return LoginResult{}, unavailable(err)
	}
	return LoginResult{
		Identity: db.SessionUser{
			User: identity.User, Email: identity.Email, SessionID: tokens.SessionID,
			Device: db.Device{ID: deviceID, Name: deviceName},
		},
		Tokens: tokens,
	}, nil
}

var deviceIDPattern = regexp.MustCompile(
	`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
)

func validDeviceID(value string) bool {
	return deviceIDPattern.MatchString(value)
}

func unavailable(err error) error {
	return fmt.Errorf("%w: %w", ErrUnavailable, err)
}

func (s *Service) newTokens(now time.Time) (Tokens, db.SessionTokens, error) {
	access, err := randomValue("at_", 32)
	if err != nil {
		return Tokens{}, db.SessionTokens{}, ErrInternal
	}
	refresh, err := randomValue("rt_", 32)
	if err != nil {
		return Tokens{}, db.SessionTokens{}, ErrInternal
	}
	accessHash, _ := tokenHash(access, "at_")
	refreshHash, _ := tokenHash(refresh, "rt_")
	tokens := Tokens{
		AccessToken: access, RefreshToken: refresh,
		AccessExpiresAt: now.Add(s.options.AccessTokenTTL), RefreshExpiresAt: now.Add(s.options.RefreshTokenTTL),
	}
	return tokens, db.SessionTokens{
		AccessHash: accessHash, RefreshHash: refreshHash,
		AccessExpiresAt: tokens.AccessExpiresAt, RefreshExpiresAt: tokens.RefreshExpiresAt,
	}, nil
}

func (s *Service) Authenticate(ctx context.Context, accessToken string) (db.SessionUser, error) {
	hash, err := tokenHash(accessToken, "at_")
	if err != nil {
		return db.SessionUser{}, err
	}
	user, err := s.store.FindSessionByAccessHash(ctx, hash, time.Now().UTC())
	if errors.Is(err, db.ErrInvalidSession) {
		return db.SessionUser{}, ErrUnauthenticated
	}
	if err != nil {
		return db.SessionUser{}, unavailable(err)
	}
	return user, nil
}

func (s *Service) Refresh(ctx context.Context, refreshToken string) (Tokens, error) {
	hash, err := tokenHash(refreshToken, "rt_")
	if err != nil {
		return Tokens{}, err
	}
	now := time.Now().UTC()
	tokens, hashes, err := s.newTokens(now)
	if err != nil {
		return Tokens{}, err
	}
	tokens.SessionID, err = s.store.RotateSession(ctx, hash, hashes, now)
	if errors.Is(err, db.ErrInvalidSession) {
		return Tokens{}, ErrUnauthenticated
	}
	if err != nil {
		return Tokens{}, unavailable(err)
	}
	return tokens, nil
}

func (s *Service) Logout(ctx context.Context, identity db.SessionUser) error {
	err := s.store.RevokeSession(ctx, identity.SessionID, time.Now().UTC())
	if errors.Is(err, db.ErrInvalidSession) {
		return ErrUnauthenticated
	}
	if err != nil {
		return unavailable(err)
	}
	return nil
}
