import Foundation
import ProtoServer
import Security
import XCTest
import XiaoweiMobile
@testable import XiaoWei

private struct AccountTestFailure: Error {
    let line: UInt
}

private actor TestSessionStore: SessionStore {
    private var value: Data?
    private var failWrites = false
    private var failDeletes = false
    private var holdWrites = false
    private var gate: CheckedContinuation<Void, Never>?

    init(_ initial: Data?) { value = initial }

    func deviceID() -> String { "00000000-0000-4000-8000-000000000001" }
    func load(server: String) -> Data? { value }

    func save(_ authenticated: Data, server: String) async throws {
        if holdWrites { await withCheckedContinuation { gate = $0 } }
        if failWrites { throw SessionStorageError(status: errSecInteractionNotAllowed) }
        value = authenticated
    }

    func remove(server: String) throws {
        if failDeletes { throw SessionStorageError(status: errSecInteractionNotAllowed) }
        value = nil
    }

    func failSaving(_ value: Bool) { failWrites = value }
    func failRemoving(_ value: Bool) { failDeletes = value }
    func pauseWrites() { holdWrites = true }
    func isWriteWaiting() -> Bool { gate != nil }
    func releaseWrites() {
        holdWrites = false
        gate?.resume()
        gate = nil
    }
}

final class AccountSessionTests: XCTestCase {
    @MainActor
    func testAccountStorageAndCleanup() async throws {
        let fixture = try await RuntimeFixture.load()
        let valid = try fixture.sample("valid")
        let expired = try fixture.sample("expired")
        let rotated = try fixture.sample("rotated")
        let updated = try fixture.sample("updated")
        var restored = try Xiaowei_Server_Authenticated(serializedBytes: valid)
        restored.user = try Xiaowei_Server_Authenticated(serializedBytes: updated).user
        let restoredBytes = try restored.serializedData()

        try await runCase("login", fixture: fixture) { account, store, _ in
            account.login(email: "fixture@example.test", password: " synthetic fixture password ")
            await account.waitForIdle()
            try self.require(account.status == .signedIn)
            try self.require(await store.load(server: fixture.server) == valid)
            try await self.count(fixture, "login", equals: 1)
        }

        try await runCase("restore", fixture: fixture, initial: valid) { account, store, client in
            await account.waitForIdle()
            try self.require(account.status == .signedIn)
            try self.require(await store.load(server: fixture.server) == restoredBytes)
            account.deactivate()
            await account.waitForIdle()
            try await client.pause()
            try await account.activate(client: client)
            await account.waitForIdle()
            try self.require(account.status == .signedIn)
            try await self.count(fixture, "user", equals: 2)
        }

        try await runCase(
            "checkpoint-save-failure", fixture: fixture, initial: expired, failWrites: true
        ) { account, store, _ in
            await account.waitForIdle()
            try self.require(account.status == .storageError)
            try self.require(await store.load(server: fixture.server) == expired)
            try await self.count(fixture, "refresh", equals: 1)
            try await self.count(fixture, "user", equals: 0)
            await store.failSaving(false)
            account.retry()
            await account.waitForIdle()
            try self.require(account.status == .signedIn)
            try self.require(await store.load(server: fixture.server) == updated)
            try await self.count(fixture, "refresh", equals: 1)
        }

        try await runCase(
            "checkpoint-cancel", fixture: fixture, initial: expired, holdWrites: true
        ) { account, store, client in
            try await self.eventually { await store.isWriteWaiting() }
            try await self.count(fixture, "refresh", equals: 1)
            try await self.count(fixture, "user", equals: 0)
            account.deactivate()
            await store.releaseWrites()
            await account.waitForIdle()
            try self.require(await store.load(server: fixture.server) == rotated)
            try await client.pause()
            try await account.activate(client: client)
            await account.waitForIdle()
            try self.require(account.status == .signedIn)
            try await self.count(fixture, "refresh", equals: 1)
        }

        try await runCase(
            "offline-retained", fixture: fixture, initial: valid, mode: "unavailable"
        ) { account, store, _ in
            await account.waitForIdle()
            try self.require(account.status == .offline)
            try self.require(account.isAuthenticated)
            try self.require(await store.load(server: fixture.server) == valid)
        }

        try await runCase(
            "invalidated", fixture: fixture, initial: valid, mode: "invalid"
        ) { account, store, _ in
            await account.waitForIdle()
            try self.require(!account.isAuthenticated)
            try self.require(await store.load(server: fixture.server) == nil)
        }

        try await runCase(
            "login-rollback", fixture: fixture, failWrites: true
        ) { account, store, _ in
            account.login(email: "fixture@example.test", password: " synthetic fixture password ")
            await account.waitForIdle()
            try self.require(!account.isAuthenticated)
            try self.require(await store.load(server: fixture.server) == nil)
            try await self.count(fixture, "login", equals: 1)
            try await self.count(fixture, "logout", equals: 1)
        }

        try await runCase(
            "login-save-cancel", fixture: fixture, holdWrites: true
        ) { account, store, _ in
            account.login(email: "fixture@example.test", password: " synthetic fixture password ")
            try await self.eventually { await store.isWriteWaiting() }
            account.deactivate()
            await store.releaseWrites()
            await account.waitForIdle()
            try self.require(!account.isAuthenticated)
            try self.require(await store.load(server: fixture.server) == nil)
            try await self.count(fixture, "logout", equals: 1)
        }

        try await runCase(
            "logout-offline", fixture: fixture, initial: valid
        ) { account, store, _ in
            await account.waitForIdle()
            let saved = await store.load(server: fixture.server)
            _ = try await fixture.get("mode/unavailable")
            account.logout()
            await account.waitForIdle()
            try self.require(account.status == .offline)
            try self.require(account.isAuthenticated)
            try self.require(await store.load(server: fixture.server) == saved)
        }

        try await runCase(
            "logout-delete-failure", fixture: fixture, initial: valid
        ) { account, store, _ in
            await account.waitForIdle()
            await store.failRemoving(true)
            account.logout()
            await account.waitForIdle()
            try self.require(account.status == .storageError)
            try self.require(account.isAuthenticated)
            try await self.count(fixture, "logout", equals: 1)
            await store.failRemoving(false)
            account.retry()
            await account.waitForIdle()
            try self.require(!account.isAuthenticated)
            try self.require(await store.load(server: fixture.server) == nil)
            try await self.count(fixture, "logout", equals: 1)
        }
        _ = try await fixture.get("account-complete")
        print("iOS account persistence, checkpoints, cancellation and failure cases passed")
    }

    @MainActor
    private func runCase(
        _ name: String,
        fixture: RuntimeFixture,
        initial: Data? = nil,
        failWrites: Bool = false,
        holdWrites: Bool = false,
        mode: String = "normal",
        body: (AccountSession, TestSessionStore, MobileClient) async throws -> Void
    ) async throws {
        _ = try await fixture.get("reset")
        _ = try await fixture.get("mode/" + mode)
        let client = try MobileClient()
        let store = TestSessionStore(initial)
        await store.failSaving(failWrites)
        if holdWrites { await store.pauseWrites() }
        let account = AccountSession(
            server: fixture.server,
            deviceID: await store.deviceID(),
            store: store
        )
        do {
            try await account.activate(client: client)
            try await body(account, store, client)
        } catch {
            account.deactivate()
            await store.releaseWrites()
            await account.waitForIdle()
            try? await client.shutdown()
            throw error
        }
        account.deactivate()
        await store.releaseWrites()
        await account.waitForIdle()
        try await client.shutdown()
        _ = try await fixture.get("case/" + name)
    }

    private func require(_ condition: Bool, line: UInt = #line) throws {
        if !condition { throw AccountTestFailure(line: line) }
    }

    @MainActor
    private func count(_ fixture: RuntimeFixture, _ key: String, equals expected: Int)
        async throws {
        let data = try await fixture.get("state")
        let value = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let counts = try XCTUnwrap(value["counts"] as? [String: Int])
        XCTAssertEqual(counts[key], expected, "Unexpected fixture request count for " + key)
    }

    @MainActor
    private func eventually(_ condition: @MainActor () async -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(10)
        while ContinuousClock.now < deadline {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(50))
        }
        throw AccountTestFailure(line: #line)
    }
}
