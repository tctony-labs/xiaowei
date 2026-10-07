package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	pb "github.com/tctony-labs/xiaowei/contracts/go/gen/xiaowei/server"
	"github.com/tctony-labs/xiaowei/server/internal/auth"
	"github.com/tctony-labs/xiaowei/server/internal/db"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

type authFixture struct {
	pool       *pgxpool.Pool
	configPath string
	address    string
	userID     string
	password   string
}

func newAuthFixture(t *testing.T) authFixture {
	t.Helper()
	uri := os.Getenv("XIAOWEI_TEST_DATABASE_URL")
	if uri == "" {
		t.Skip("set XIAOWEI_TEST_DATABASE_URL to run real authentication integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	admin, err := pgx.Connect(ctx, uri)
	if err != nil {
		t.Fatal("cannot connect test database")
	}
	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		t.Fatal(err)
	}
	name := fmt.Sprintf("xw_auth_%x", suffix)
	quoted := pgx.Identifier{name}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+quoted); err != nil {
		_ = admin.Close(ctx)
		t.Fatal(err)
	}
	var pool *pgxpool.Pool
	t.Cleanup(func() {
		if pool != nil {
			pool.Close()
		}
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if _, err := admin.Exec(cleanupCtx, "DROP DATABASE "+quoted+" WITH (FORCE)"); err != nil {
			t.Errorf("cannot clean up isolated authentication database: %v", err)
		}
		_ = admin.Close(cleanupCtx)
	})
	parsed, err := url.Parse(uri)
	if err != nil {
		t.Fatal("invalid test database URL")
	}
	parsed.Path = "/" + name
	pool, err = pgxpool.New(ctx, parsed.String())
	if err != nil {
		t.Fatal("cannot open isolated database")
	}
	cfg := pool.Config().ConnConfig
	options := db.Options{
		Host: cfg.Host, Port: int(cfg.Port), Database: name, User: cfg.User, Password: cfg.Password, SSLMode: "disable",
	}
	store, err := db.Open(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	user, err := store.CreateUser(ctx)
	store.Close()
	if err != nil {
		t.Fatal(err)
	}
	password := "  fixture-password  "
	hash, err := auth.HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx,
		"INSERT INTO email_identities (user_pk, email, password_hash) VALUES ($1, $2, $3)",
		user.ID, "user@example.com", hash)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	_ = listener.Close()
	path := filepath.Join(t.TempDir(), "server.yaml")
	yaml := fmt.Sprintf(`server:
  listen_addr: %q
database:
  host: %q
  port: %d
  name: %q
  user: %q
  password: %q
  ssl_mode: disable
`, address, cfg.Host, cfg.Port, name, cfg.User, cfg.Password)
	if err := os.WriteFile(path, []byte(yaml), 0600); err != nil {
		t.Fatal(err)
	}
	for key, value := range map[string]string{
		"XIAOWEI_LISTEN_ADDR": address, "XIAOWEI_DATABASE_HOST": cfg.Host,
		"XIAOWEI_DATABASE_PORT": strconv.Itoa(int(cfg.Port)), "XIAOWEI_DATABASE_NAME": name,
		"XIAOWEI_DATABASE_USER": cfg.User, "XIAOWEI_DATABASE_PASSWORD": cfg.Password,
		"XIAOWEI_DATABASE_SSL_MODE":     "disable",
		"XIAOWEI_AUTH_ACCESS_TOKEN_TTL": "2h", "XIAOWEI_AUTH_REFRESH_TOKEN_TTL": "720h",
		"XIAOWEI_BOOTSTRAP_ADMIN_EMAIL": "", "XIAOWEI_BOOTSTRAP_ADMIN_PASSWORD": "",
	} {
		t.Setenv(key, value)
	}
	return authFixture{pool: pool, configPath: path, address: address, userID: user.PublicID, password: password}
}

func startAuthServer(t *testing.T, fixture authFixture) func() {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	finished := make(chan error, 1)
	go func() { finished <- serve(ctx, fixture.configPath) }()
	var once sync.Once
	stop := func() {
		once.Do(func() {
			cancel()
			select {
			case err := <-finished:
				if err != nil {
					t.Errorf("authentication server stopped with error: %v", err)
				}
			case <-time.After(7 * time.Second):
				t.Error("authentication server did not stop")
			}
		})
	}
	t.Cleanup(stop)
	client := &http.Client{Timeout: 200 * time.Millisecond}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case err := <-finished:
			cancel()
			once.Do(func() {})
			t.Fatalf("authentication server did not start: %v", err)
		default:
		}
		response, err := client.Get("http://" + fixture.address + "/readyz")
		if err == nil {
			var body struct {
				Code *int32 `json:"code"`
			}
			decodeErr := json.NewDecoder(response.Body).Decode(&body)
			_ = response.Body.Close()
			if response.StatusCode == 200 && decodeErr == nil && body.Code != nil && *body.Code == 0 {
				return stop
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("authentication server never became ready")
	return stop
}

type authResponse struct {
	status int
	body   []byte
	header http.Header
	err    error
}

func requestAuth(address, method, path, token string, message proto.Message) authResponse {
	var body []byte
	var err error
	if message != nil {
		body, err = (protojson.MarshalOptions{UseProtoNames: true}).Marshal(message)
		if err != nil {
			return authResponse{err: err}
		}
	}
	r, err := http.NewRequest(method, "http://"+address+path, bytes.NewReader(body))
	if err != nil {
		return authResponse{err: err}
	}
	r.Header.Set("Content-Type", "application/json")
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	client := &http.Client{Timeout: 5 * time.Second}
	response, err := client.Do(r)
	if err != nil {
		return authResponse{err: err}
	}
	defer response.Body.Close()
	body, err = io.ReadAll(response.Body)
	return authResponse{status: response.StatusCode, body: body, header: response.Header, err: err}
}

func requireAuthResponse(t *testing.T, response authResponse, status int, code int32, message proto.Message) {
	t.Helper()
	if response.err != nil || response.status != status {
		t.Fatalf("authentication response status = %d, want %d; network error = %v",
			response.status, status, response.err)
	}
	if response.header.Get("Cache-Control") != "no-store" {
		t.Fatal("authentication response can be cached")
	}
	var envelope struct {
		Code *int32          `json:"code"`
		Msg  *string         `json:"msg"`
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(response.body, &envelope); err != nil ||
		envelope.Code == nil || *envelope.Code != code || envelope.Msg == nil {
		t.Fatal("missing or incorrect business result")
	}
	if code == 0 && (len(envelope.Data) == 0 || string(envelope.Data) == "null") {
		t.Fatal("successful response omitted data")
	}
	if code != 0 && len(envelope.Data) != 0 {
		t.Fatal("failed response included data")
	}
	if message != nil && protojson.Unmarshal(response.body, message) != nil {
		t.Fatal("invalid authentication response message")
	}
}

func testDeviceID(t *testing.T) string {
	t.Helper()
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		t.Fatal(err)
	}
	value[6] = value[6]&0x0f | 0x40
	value[8] = value[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", value[:4], value[4:6], value[6:8], value[8:10], value[10:])
}

func loginFixture(t *testing.T, fixture authFixture) *pb.Authenticated {
	t.Helper()
	result := new(pb.LoginResponse)
	request := passwordRequest(" USER@EXAMPLE.COM ", fixture.password, testDeviceID(t))
	response := requestAuth(fixture.address, "POST", "/api/auth/login", "", request)
	requireAuthResponse(t, response, 200, 0, result)
	identity := result.GetData().GetAuthenticated()
	if identity == nil || identity.User.UserId != fixture.userID || identity.User.Email != "user@example.com" ||
		strings.Contains(string(response.body), `"id":`) {
		t.Fatal("login returned wrong user or internal ID")
	}
	return result.Data.GetAuthenticated()
}

type authLogs struct {
	mu   sync.Mutex
	data bytes.Buffer
}

func (l *authLogs) Write(data []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.data.Write(data)
}

func (l *authLogs) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.data.String()
}

func TestAuthenticationHTTPAndRestart(t *testing.T) {
	fixture := newAuthFixture(t)
	logs := new(authLogs)
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	stop := startAuthServer(t, fixture)

	wrong := new(pb.LoginResponse)
	missing := new(pb.LoginResponse)
	requireAuthResponse(t, requestAuth(fixture.address, "POST", "/api/auth/login", "",
		passwordRequest("user@example.com", "wrong-password", testDeviceID(t))),
		200, int32(pb.AuthErrorCode_AUTH_ERROR_CODE_INVALID_CREDENTIALS), wrong)
	requireAuthResponse(t, requestAuth(fixture.address, "POST", "/api/auth/login", "",
		passwordRequest("missing@example.com", fixture.password, testDeviceID(t))),
		200, int32(pb.AuthErrorCode_AUTH_ERROR_CODE_INVALID_CREDENTIALS), missing)
	if !proto.Equal(wrong, missing) || wrong.Code != int32(pb.AuthErrorCode_AUTH_ERROR_CODE_INVALID_CREDENTIALS) {
		t.Fatal("login revealed whether email exists")
	}
	first, second := loginFixture(t, fixture), loginFixture(t, fixture)
	if first.Tokens.SessionId == second.Tokens.SessionId || first.Device.DeviceId == second.Device.DeviceId {
		t.Fatal("same device label merged separate logins")
	}
	delta := first.Tokens.RefreshExpiresAtMs - first.Tokens.AccessExpiresAtMs
	if delta != (720*time.Hour - 2*time.Hour).Milliseconds() {
		t.Fatal("token expiry defaults were not used")
	}
	me := new(pb.GetCurrentUserResponse)
	requireAuthResponse(t,
		requestAuth(fixture.address, "GET", "/api/auth/me", first.Tokens.AccessToken, nil), 200, 0, me)
	if me.Data.User.UserId != fixture.userID || me.Data.SessionId != first.Tokens.SessionId ||
		!proto.Equal(me.Data.Device, first.Device) {
		t.Fatal("bearer did not resolve trusted identity")
	}
	requireAuthResponse(t,
		requestAuth(fixture.address, "GET", "/api/auth/me", first.Tokens.RefreshToken, nil),
		200, int32(pb.ErrorCode_ERROR_CODE_UNAUTHENTICATED), nil)
	requireAuthResponse(t, requestAuth(fixture.address, "POST", "/api/auth/refresh", "",
		&pb.RefreshRequest{RefreshToken: first.Tokens.AccessToken}),
		200, int32(pb.ErrorCode_ERROR_CODE_UNAUTHENTICATED), nil)

	rotated := new(pb.RefreshResponse)
	requireAuthResponse(t, requestAuth(fixture.address, "POST", "/api/auth/refresh", "",
		&pb.RefreshRequest{RefreshToken: first.Tokens.RefreshToken}), 200, 0, rotated)
	requireAuthResponse(t, requestAuth(fixture.address, "POST", "/api/auth/refresh", "",
		&pb.RefreshRequest{RefreshToken: first.Tokens.RefreshToken}),
		200, int32(pb.ErrorCode_ERROR_CODE_UNAUTHENTICATED), nil)
	for _, token := range []string{first.Tokens.AccessToken, rotated.Data.AccessToken} {
		requireAuthResponse(t, requestAuth(fixture.address, "GET", "/api/auth/me", token, nil), 200, 0, nil)
	}

	results := make(chan authResponse, 5)
	var workers sync.WaitGroup
	for range 5 {
		workers.Go(func() {
			results <- requestAuth(fixture.address, "POST", "/api/auth/refresh", "",
				&pb.RefreshRequest{RefreshToken: rotated.Data.RefreshToken})
		})
	}
	workers.Wait()
	close(results)
	winner := new(pb.RefreshResponse)
	successes := 0
	for result := range results {
		decoded := new(pb.RefreshResponse)
		if err := protojson.Unmarshal(result.body, decoded); err != nil {
			t.Fatal("invalid refresh response")
		}
		if decoded.Code == 0 {
			successes++
			requireAuthResponse(t, result, 200, 0, winner)
		} else {
			requireAuthResponse(t, result, 200, int32(pb.ErrorCode_ERROR_CODE_UNAUTHENTICATED), nil)
		}
	}
	if successes != 1 {
		t.Fatal("HTTP concurrent refresh did not have exactly one winner")
	}
	current := new(pb.RefreshResponse)
	requireAuthResponse(t, requestAuth(fixture.address, "POST", "/api/auth/refresh", "",
		&pb.RefreshRequest{RefreshToken: winner.Data.RefreshToken}), 200, 0, current)
	if current.Data.RefreshExpiresAtMs < rotated.Data.RefreshExpiresAtMs {
		t.Fatal("refresh did not renew expiry")
	}

	stop()
	stop = startAuthServer(t, fixture)
	for _, token := range []string{first.Tokens.AccessToken, current.Data.AccessToken, second.Tokens.AccessToken} {
		requireAuthResponse(t, requestAuth(fixture.address, "GET", "/api/auth/me", token, nil), 200, 0, nil)
	}
	requireAuthResponse(t,
		requestAuth(fixture.address, "POST", "/api/auth/logout", current.Data.AccessToken, nil), 200, 0, nil)
	for _, token := range []string{
		first.Tokens.AccessToken, rotated.Data.AccessToken, winner.Data.AccessToken, current.Data.AccessToken,
	} {
		requireAuthResponse(t, requestAuth(fixture.address, "GET", "/api/auth/me", token, nil),
			200, int32(pb.ErrorCode_ERROR_CODE_UNAUTHENTICATED), nil)
	}
	requireAuthResponse(t, requestAuth(fixture.address, "POST", "/api/auth/refresh", "",
		&pb.RefreshRequest{RefreshToken: current.Data.RefreshToken}),
		200, int32(pb.ErrorCode_ERROR_CODE_UNAUTHENTICATED), nil)
	requireAuthResponse(t,
		requestAuth(fixture.address, "GET", "/api/auth/me", second.Tokens.AccessToken, nil), 200, 0, nil)

	var refreshHash []byte
	var passwordHash string
	err := fixture.pool.QueryRow(context.Background(), `
        SELECT s.refresh_token_hash, e.password_hash
        FROM auth_sessions s JOIN email_identities e ON e.user_pk = s.user_pk
        WHERE s.session_id = $1
    `, second.Tokens.SessionId).Scan(&refreshHash, &passwordHash)
	wantHash := sha256.Sum256([]byte(second.Tokens.RefreshToken))
	if err != nil || !bytes.Equal(refreshHash, wantHash[:]) || passwordHash == fixture.password {
		t.Fatal("database contains incorrect credential hashes")
	}
	stop()
	for _, secret := range []string{
		fixture.password, "user@example.com", first.Tokens.AccessToken, first.Tokens.RefreshToken,
		rotated.Data.RefreshToken, winner.Data.RefreshToken, current.Data.RefreshToken, second.Tokens.AccessToken,
	} {
		if strings.Contains(logs.String(), secret) {
			t.Fatal("authentication logs exposed private data")
		}
	}
}

func TestAuthenticationExpiryRateLimitAndDatabaseFailure(t *testing.T) {
	fixture := newAuthFixture(t)
	stop := startAuthServer(t, fixture)
	defer stop()
	login := loginFixture(t, fixture)
	ctx := context.Background()
	_, err := fixture.pool.Exec(ctx,
		"UPDATE session_access_tokens SET expires_at = now() - interval '1 second' WHERE session_id = $1",
		login.Tokens.SessionId)
	if err != nil {
		t.Fatal(err)
	}
	requireAuthResponse(t, requestAuth(fixture.address, "GET", "/api/auth/me", login.Tokens.AccessToken, nil),
		200, int32(pb.ErrorCode_ERROR_CODE_UNAUTHENTICATED), nil)
	refreshed := new(pb.RefreshResponse)
	requireAuthResponse(t, requestAuth(fixture.address, "POST", "/api/auth/refresh", "",
		&pb.RefreshRequest{RefreshToken: login.Tokens.RefreshToken}), 200, 0, refreshed)
	_, err = fixture.pool.Exec(ctx,
		"UPDATE auth_sessions SET refresh_expires_at = now() - interval '1 second' WHERE session_id = $1",
		login.Tokens.SessionId)
	if err != nil {
		t.Fatal(err)
	}
	requireAuthResponse(t, requestAuth(fixture.address, "POST", "/api/auth/refresh", "",
		&pb.RefreshRequest{RefreshToken: refreshed.Data.RefreshToken}),
		200, int32(pb.ErrorCode_ERROR_CODE_UNAUTHENTICATED), nil)
	for i := range 5 {
		response := requestAuth(fixture.address, "POST", "/api/auth/login", "",
			passwordRequest("user@example.com", "wrong-password", testDeviceID(t)))
		want := 200
		code := int32(pb.AuthErrorCode_AUTH_ERROR_CODE_INVALID_CREDENTIALS)
		if i == 4 {
			want = 200
			code = int32(pb.ErrorCode_ERROR_CODE_RATE_LIMITED)
			if response.header.Get("Retry-After") == "" {
				t.Fatal("rate limit did not include retry interval")
			}
		}
		requireAuthResponse(t, response, want, code, nil)
	}
	_, err = fixture.pool.Exec(ctx, "ALTER TABLE email_identities RENAME TO temporarily_unavailable_identities")
	if err != nil {
		t.Fatal(err)
	}
	response := requestAuth(fixture.address, "GET", "/api/auth/me", refreshed.Data.AccessToken, nil)
	requireAuthResponse(t, response, 200, int32(pb.ErrorCode_ERROR_CODE_UNAVAILABLE), nil)
	var body map[string]any
	if err := json.Unmarshal(response.body, &body); err != nil || strings.Contains(string(response.body), "SQLSTATE") {
		t.Fatal("database failure leaked internal detail")
	}
	if _, err := fixture.pool.Exec(ctx,
		"ALTER TABLE temporarily_unavailable_identities RENAME TO email_identities"); err != nil {
		t.Fatal(err)
	}
	requireAuthResponse(t,
		requestAuth(fixture.address, "GET", "/api/auth/me", refreshed.Data.AccessToken, nil), 200, 0, nil)
}

func passwordRequest(email, password, deviceID string) *pb.LoginRequest {
	return &pb.LoginRequest{
		DeviceId: deviceID, DeviceName: "test device",
		Credential: &pb.LoginRequest_Password{Password: &pb.PasswordLogin{Email: email, Password: password}},
	}
}

func TestDeviceReloginAndRejectedBindingHTTP(t *testing.T) {
	fixture := newAuthFixture(t)
	stop := startAuthServer(t, fixture)
	defer stop()
	first := loginFixture(t, fixture)
	other := loginFixture(t, fixture)
	request := passwordRequest("user@example.com", fixture.password, first.Device.DeviceId)
	request.DeviceName = "renamed"
	token := "private-bind-secret"
	request.ThirdpartyBindToken = &token
	requireAuthResponse(t, requestAuth(fixture.address, "POST", "/api/auth/login", "", request),
		200, int32(pb.AuthErrorCode_AUTH_ERROR_CODE_THIRDPARTY_BINDING_UNSUPPORTED), nil)
	requireAuthResponse(t, requestAuth(fixture.address, "GET", "/api/auth/me", first.Tokens.AccessToken, nil),
		200, 0, nil)
	var count int
	err := fixture.pool.QueryRow(context.Background(), "SELECT count(*) FROM auth_sessions").Scan(&count)
	if err != nil || count != 2 {
		t.Fatal("unsupported binding changed sessions")
	}
	request.ThirdpartyBindToken = nil
	request.GetPassword().Password = "wrong"
	requireAuthResponse(t, requestAuth(fixture.address, "POST", "/api/auth/login", "", request),
		200, int32(pb.AuthErrorCode_AUTH_ERROR_CODE_INVALID_CREDENTIALS), nil)
	requireAuthResponse(t, requestAuth(fixture.address, "GET", "/api/auth/me", first.Tokens.AccessToken, nil),
		200, 0, nil)
	request.GetPassword().Password = fixture.password
	replacement := new(pb.LoginResponse)
	requireAuthResponse(t, requestAuth(fixture.address, "POST", "/api/auth/login", "", request), 200, 0, replacement)
	current := replacement.Data.GetAuthenticated()
	if current == nil || current.Device.DeviceId != first.Device.DeviceId || current.Device.DeviceName != "renamed" {
		t.Fatal("replacement did not retain device identity")
	}
	requireAuthResponse(t, requestAuth(fixture.address, "GET", "/api/auth/me", first.Tokens.AccessToken, nil),
		200, int32(pb.ErrorCode_ERROR_CODE_UNAUTHENTICATED), nil)
	requireAuthResponse(t, requestAuth(fixture.address, "POST", "/api/auth/refresh", "",
		&pb.RefreshRequest{RefreshToken: first.Tokens.RefreshToken}),
		200, int32(pb.ErrorCode_ERROR_CODE_UNAUTHENTICATED), nil)
	for _, access := range []string{current.Tokens.AccessToken, other.Tokens.AccessToken} {
		requireAuthResponse(t, requestAuth(fixture.address, "GET", "/api/auth/me", access, nil), 200, 0, nil)
	}
}

func TestConfiguredRateLimitsHTTP(t *testing.T) {
	fixture := newAuthFixture(t)
	t.Setenv("XIAOWEI_SERVER_RATE_LIMIT_IP_LIMIT", "3")
	t.Setenv("XIAOWEI_SERVER_RATE_LIMIT_IP_WINDOW", "5m")
	t.Setenv("XIAOWEI_AUTH_RATE_LIMIT_LOGIN_EMAIL_IP_LIMIT", "1")
	t.Setenv("XIAOWEI_AUTH_RATE_LIMIT_LOGIN_EMAIL_IP_WINDOW", "10m")
	stop := startAuthServer(t, fixture)
	defer stop()

	for i, code := range []int32{10100, 10007, 10007, 10007} {
		response := requestAuth(fixture.address, "POST", "/api/auth/login", "",
			passwordRequest("user@example.com", "wrong-password", testDeviceID(t)))
		requireAuthResponse(t, response, 200, code, nil)
		if i > 0 {
			retry, err := strconv.Atoi(response.header.Get("Retry-After"))
			if err != nil || (i < 3 && (retry < 590 || retry > 600)) || (i == 3 && (retry < 290 || retry > 300)) {
				t.Fatalf("request %d did not use configured window: %q", i, response.header.Get("Retry-After"))
			}
		}
	}
	for _, path := range []string{"/healthz", "/readyz"} {
		requireAuthResponse(t, requestAuth(fixture.address, "GET", path, "", nil), 200, 0, nil)
	}
}
