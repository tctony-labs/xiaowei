package db

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

func testSessionTokens(label string, now time.Time) SessionTokens {
	access := sha256.Sum256([]byte("access:" + label))
	refresh := sha256.Sum256([]byte("refresh:" + label))
	return SessionTokens{
		AccessHash: access[:], RefreshHash: refresh[:],
		AccessExpiresAt: now.Add(2 * time.Hour), RefreshExpiresAt: now.Add(720 * time.Hour),
	}
}

func createSessionIdentity(t *testing.T, store *Store) User {
	t.Helper()
	ctx := context.Background()
	user, err := store.CreateUser(ctx)
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.pool.Exec(ctx,
		"INSERT INTO email_identities (user_pk, email, password_hash) VALUES ($1, $2, $3)",
		user.ID, strings.ToLower(user.PublicID)+"@example.com", "test-hash")
	if err != nil {
		t.Fatal(err)
	}
	return user
}

func testSessionID(t *testing.T) string {
	t.Helper()
	value, err := newPublicID()
	if err != nil {
		t.Fatal(err)
	}
	return "s_" + value[2:]
}

func TestConcurrentRefreshKeepsWinningSession(t *testing.T) {
	_, options := testDatabase(t)
	ctx := context.Background()
	store, err := Open(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	user := createSessionIdentity(t, store)
	now := time.Now().UTC()
	initial := testSessionTokens("initial", now)
	sessionID := testSessionID(t)
	if err := store.CreateSession(ctx, user.ID, sessionID,
		Device{ID: testDeviceID(), Name: "device"}, initial, now); err != nil {
		t.Fatal(err)
	}

	type result struct {
		tokens SessionTokens
		err    error
	}
	results := make(chan result, 8)
	var workers sync.WaitGroup
	for i := range 8 {
		workers.Go(func() {
			tokens := testSessionTokens(fmt.Sprintf("attempt:%d", i), now.Add(time.Minute))
			id, err := store.RotateSession(ctx, initial.RefreshHash, tokens, now.Add(time.Minute))
			if err == nil && id != sessionID {
				err = errors.New("session ID changed")
			}
			results <- result{tokens: tokens, err: err}
		})
	}
	workers.Wait()
	close(results)
	var winner SessionTokens
	successes := 0
	for result := range results {
		if result.err == nil {
			successes++
			winner = result.tokens
		} else if !errors.Is(result.err, ErrInvalidSession) {
			t.Fatal(result.err)
		}
	}
	if successes != 1 {
		t.Fatalf("successful rotations = %d, want 1", successes)
	}
	for _, tokens := range []SessionTokens{initial, winner} {
		if _, err := store.FindSessionByAccessHash(ctx, tokens.AccessHash, now.Add(time.Minute)); err != nil {
			t.Fatal("refresh invalidated a valid access token")
		}
	}
	_, err = store.RotateSession(ctx, initial.RefreshHash, testSessionTokens("replay", now), now)
	if !errors.Is(err, ErrInvalidSession) {
		t.Fatal("old refresh token accepted")
	}
	if _, err := store.RotateSession(ctx, winner.RefreshHash, testSessionTokens("next", now), now); err != nil {
		t.Fatal("rejected old token revoked the winning refresh token")
	}
}

func TestSessionRollbackExpiryAndLogoutIsolation(t *testing.T) {
	_, options := testDatabase(t)
	ctx := context.Background()
	store, err := Open(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	user := createSessionIdentity(t, store)
	now := time.Now().UTC().Truncate(time.Microsecond)
	first, second := testSessionTokens("first", now), testSessionTokens("second", now)
	firstDevice := Device{ID: testDeviceID(), Name: "same device label"}
	firstID, secondID := testSessionID(t), testSessionID(t)
	for _, item := range []struct {
		id     string
		tokens SessionTokens
	}{{firstID, first}, {secondID, second}} {
		device := firstDevice
		if item.id == secondID {
			device.ID = testDeviceID()
		}
		if err := store.CreateSession(ctx, user.ID, item.id, device, item.tokens, now); err != nil {
			t.Fatal(err)
		}
	}
	bad := testSessionTokens("bad", now)
	bad.AccessHash = []byte("invalid length")
	failedID := testSessionID(t)
	if err := store.CreateSession(ctx, user.ID, failedID,
		Device{ID: firstDevice.ID, Name: "renamed"}, bad, now); err == nil {
		t.Fatal("broken session creation committed")
	}
	var count int
	if err := store.pool.QueryRow(ctx, "SELECT count(*) FROM auth_sessions WHERE session_id = $1", failedID).
		Scan(&count); err != nil || count != 0 {
		t.Fatal("failed session creation left a partial session")
	}
	if _, err := store.RotateSession(ctx, first.RefreshHash, bad, now); err == nil {
		t.Fatal("broken refresh transaction committed")
	}
	next := testSessionTokens("next", now.Add(time.Minute))
	if _, err := store.RotateSession(ctx, first.RefreshHash, next, now.Add(time.Minute)); err != nil {
		t.Fatal("failed transaction consumed the old refresh token")
	}
	_, err = store.FindSessionByAccessHash(ctx, first.AccessHash, first.AccessExpiresAt)
	if !errors.Is(err, ErrInvalidSession) {
		t.Fatal("expired access token accepted")
	}
	_, err = store.RotateSession(ctx, second.RefreshHash, bad, second.RefreshExpiresAt)
	if !errors.Is(err, ErrInvalidSession) {
		t.Fatal("expired refresh token accepted")
	}
	if err := store.RevokeSession(ctx, firstID, now.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	for _, hash := range [][]byte{first.AccessHash, next.AccessHash} {
		_, err = store.FindSessionByAccessHash(ctx, hash, now.Add(2*time.Minute))
		if !errors.Is(err, ErrInvalidSession) {
			t.Fatal("logout left an access token active")
		}
	}
	_, err = store.RotateSession(ctx, next.RefreshHash, bad, now.Add(2*time.Minute))
	if !errors.Is(err, ErrInvalidSession) {
		t.Fatal("logout left refresh active")
	}
	if _, err := store.FindSessionByAccessHash(ctx, second.AccessHash, now.Add(2*time.Minute)); err != nil {
		t.Fatal("logout revoked another device")
	}
}

func TestRefreshLogoutRace(t *testing.T) {
	_, options := testDatabase(t)
	ctx := context.Background()
	store, err := Open(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	user := createSessionIdentity(t, store)
	now := time.Now().UTC()
	for i := range 10 {
		id := testSessionID(t)
		initial := testSessionTokens(fmt.Sprintf("race:%d", i), now)
		next := testSessionTokens(fmt.Sprintf("race-next:%d", i), now)
		if err := store.CreateSession(ctx, user.ID, id, Device{ID: testDeviceID()}, initial, now); err != nil {
			t.Fatal(err)
		}
		start := make(chan struct{})
		results := make(chan error, 2)
		go func() {
			<-start
			_, err := store.RotateSession(ctx, initial.RefreshHash, next, now)
			results <- err
		}()
		go func() {
			<-start
			results <- store.RevokeSession(ctx, id, now)
		}()
		close(start)
		for range 2 {
			if err := <-results; err != nil && !errors.Is(err, ErrInvalidSession) {
				t.Fatal(err)
			}
		}
		if _, err := store.FindSessionByAccessHash(ctx, next.AccessHash, now); !errors.Is(err, ErrInvalidSession) {
			t.Fatal("refresh reactivated a logged-out session")
		}
		if _, err := store.RotateSession(ctx, next.RefreshHash, initial, now); !errors.Is(err, ErrInvalidSession) {
			t.Fatal("refresh after logout succeeded")
		}
	}
}

func testDeviceID() string {
	var value [16]byte
	_, _ = rand.Read(value[:])
	value[6] = value[6]&0x0f | 0x40
	value[8] = value[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", value[:4], value[4:6], value[6:8], value[8:10], value[10:])
}

func TestDeviceLoginReplacementAndConcurrency(t *testing.T) {
	_, options := testDatabase(t)
	ctx := context.Background()
	store, err := Open(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	user, otherUser := createSessionIdentity(t, store), createSessionIdentity(t, store)
	now := time.Now().UTC()
	device := Device{ID: testDeviceID(), Name: "first name"}
	first := testSessionTokens("device-first", now)
	other := testSessionTokens("other-user", now)
	otherDevice := testSessionTokens("other-device", now)
	for _, item := range []struct {
		user   User
		device Device
		tokens SessionTokens
	}{
		{user, device, first},
		{otherUser, device, other},
		{user, Device{ID: testDeviceID()}, otherDevice},
	} {
		if err := store.CreateSession(ctx, item.user.ID, testSessionID(t), item.device, item.tokens, now); err != nil {
			t.Fatal(err)
		}
	}
	bad := testSessionTokens("broken-replacement", now)
	bad.AccessHash = []byte("broken")
	if err := store.CreateSession(ctx, user.ID, testSessionID(t),
		Device{ID: device.ID, Name: "must roll back"}, bad, now); err == nil {
		t.Fatal("broken replacement succeeded")
	}
	identity, err := store.FindSessionByAccessHash(ctx, first.AccessHash, now)
	if err != nil || identity.Device.Name != device.Name {
		t.Fatal("failed replacement revoked the session or changed the device")
	}

	var workers sync.WaitGroup
	results := make(chan error, 8)
	candidates := make([]SessionTokens, 8)
	for i := range candidates {
		candidates[i] = testSessionTokens(fmt.Sprintf("login-%d", i), now)
		sessionID := testSessionID(t)
		workers.Go(func() {
			results <- store.CreateSession(ctx, user.ID, sessionID,
				Device{ID: device.ID, Name: "updated"}, candidates[i], now)
		})
	}
	workers.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatal(err)
		}
	}
	active := 0
	for _, tokens := range candidates {
		identity, err := store.FindSessionByAccessHash(ctx, tokens.AccessHash, now)
		if err == nil {
			active++
			if identity.Device.ID != device.ID || identity.Device.Name != "updated" {
				t.Fatal("wrong device identity")
			}
		} else if !errors.Is(err, ErrInvalidSession) {
			t.Fatal(err)
		}
	}
	if active != 1 {
		t.Fatalf("active sessions = %d, want 1", active)
	}
	if _, err := store.FindSessionByAccessHash(ctx, first.AccessHash, now); !errors.Is(err, ErrInvalidSession) {
		t.Fatal("old access survived replacement")
	}
	_, err = store.RotateSession(ctx, first.RefreshHash, testSessionTokens("old-refresh", now), now)
	if !errors.Is(err, ErrInvalidSession) {
		t.Fatal("old refresh survived replacement")
	}
	for _, tokens := range []SessionTokens{other, otherDevice} {
		if _, err := store.FindSessionByAccessHash(ctx, tokens.AccessHash, now); err != nil {
			t.Fatal("replacement revoked another account or device")
		}
	}
}

func TestReloginRacingRefresh(t *testing.T) {
	_, options := testDatabase(t)
	ctx := context.Background()
	store, err := Open(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	user := createSessionIdentity(t, store)
	device := Device{ID: testDeviceID()}
	now := time.Now().UTC()
	for i := range 8 {
		old := testSessionTokens(fmt.Sprintf("old-%d", i), now)
		refreshed := testSessionTokens(fmt.Sprintf("refreshed-%d", i), now)
		replacement := testSessionTokens(fmt.Sprintf("replacement-%d", i), now)
		if err := store.CreateSession(ctx, user.ID, testSessionID(t), device, old, now); err != nil {
			t.Fatal(err)
		}
		newID := testSessionID(t)
		start := make(chan struct{})
		results := make(chan error, 2)
		go func() {
			<-start
			_, err := store.RotateSession(ctx, old.RefreshHash, refreshed, now)
			results <- err
		}()
		go func() {
			<-start
			results <- store.CreateSession(ctx, user.ID, newID, device, replacement, now)
		}()
		close(start)
		for range 2 {
			if err := <-results; err != nil && !errors.Is(err, ErrInvalidSession) {
				t.Fatal(err)
			}
		}
		for _, tokens := range []SessionTokens{old, refreshed} {
			_, err := store.FindSessionByAccessHash(ctx, tokens.AccessHash, now)
			if !errors.Is(err, ErrInvalidSession) {
				t.Fatal("refresh kept a replaced device session alive")
			}
		}
		if _, err := store.FindSessionByAccessHash(ctx, replacement.AccessHash, now); err != nil {
			t.Fatal("replacement was invalidated by an old refresh")
		}
	}
}
