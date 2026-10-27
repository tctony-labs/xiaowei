import Foundation
import XCTest
import XiaoweiMobile

private struct RuntimeFailure: Error {
    let message: String

    init(_ message: String) {
        self.message = message
    }
}

struct RuntimeFixture: Sendable {
    let control: URL
    let server: String
    let samples: [String: String]

    static func load() async throws -> Self {
        guard let address = ProcessInfo.processInfo.environment["XIAOWEI_FIXTURE_CONTROL_URL"],
              let control = URL(string: address) else {
            throw RuntimeFailure("Missing fixture control URL")
        }
        let (data, response) = try await URLSession.shared.data(
            from: control.appendingPathComponent("bootstrap")
        )
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw RuntimeFailure("Fixture bootstrap failed")
        }
        struct Bootstrap: Decodable {
            let server: String
            let samples: [String: String]
        }
        let value = try JSONDecoder().decode(Bootstrap.self, from: data)
        return Self(control: control, server: value.server, samples: value.samples)
    }

    func sample(_ name: String) throws -> Data {
        guard let encoded = samples[name], let data = Data(base64Encoded: encoded) else {
            throw RuntimeFailure("Missing generated fixture sample: " + name)
        }
        return data
    }

    func get(_ path: String) async throws -> Data {
        var request = URLRequest(url: control.appendingPathComponent(path))
        request.timeoutInterval = 20
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw RuntimeFailure("Fixture control failed: " + path)
        }
        return data
    }
}

final class MobileRuntimeTests: XCTestCase {
    @MainActor
    func testRustNetworkAndLifecycle() async throws {
        let fixture = try await RuntimeFixture.load()
        let client = try MobileClient()
        do {
            try await Self.exercise(client, fixture: fixture)
            _ = try await fixture.get("complete")
        } catch {
            try? await client.shutdown()
            throw error
        }
    }

    @MainActor
    func testPublicHttpsUsesRust() async throws {
        let client = try MobileClient()
        do {
            let request = try client.invoke(
                context: SessionContext(
                    server: "https://xiaowei.tctony.com", authenticated: nil, connect: false
                ),
                method: "xiaowei.server.Health.Check",
                payload: Data(),
                options: RequestOptions(timeoutMs: 15_000, transport: .http)
            )
            let data = try await request.run()
            await request.shutdown()
            try Self.require(!data.isEmpty)
            try await client.shutdown()
            print("iOS Rust public HTTPS request passed")
        } catch {
            try? await client.shutdown()
            throw error
        }
    }

    private static func require(_ condition: Bool, line: UInt = #line) throws {
        if !condition { throw RuntimeFailure("Runtime assertion failed at line " + String(line)) }
    }

    @MainActor
    private static func exercise(_ client: MobileClient, fixture: RuntimeFixture) async throws {
        let server = fixture.server
        let valid = try fixture.sample("valid")
        let expired = try fixture.sample("expired")
        let rotated = try fixture.sample("rotated")
        let updated = try fixture.sample("updated")
        let loginRequest = try fixture.sample("login")
        let healthResponse = try fixture.sample("health")
        let businessResponse = try fixture.sample("business")
        let updated2 = try fixture.sample("updated2")

        func context(_ suffix: String = "", auth: Data? = nil, connect: Bool = false)
            -> SessionContext {
            SessionContext(server: server + suffix, authenticated: auth, connect: connect)
        }
        let options = RequestOptions(timeoutMs: nil, transport: .auto)
        let subscription = try client.subscribeConnection()
        let initial = try await subscription.next()
        try require(initial?.status == .disconnected)

        _ = try await client.setSession(context: context(auth: valid, connect: true))
        while let snapshot = try await subscription.next() {
            if snapshot.status == .connected {
                try require(snapshot.generation > 0)
                try require(snapshot.authentication == .authenticated)
                break
            }
        }
        let websocket = try client.invoke(
            context: context(auth: valid),
            method: "xiaowei.server.Auth.GetCurrentUser",
            payload: Data(),
            options: RequestOptions(timeoutMs: nil, transport: .websocket)
        )
        let currentUser = try await websocket.run()
        try require(!currentUser.isEmpty)
        await websocket.shutdown()

        let health = try client.invoke(
            context: context(auth: valid), method: "xiaowei.server.Health.Check",
            payload: Data(), options: options
        )
        let first = try await health.run()
        let repeated = try await health.run()
        try require(first == healthResponse && repeated == first)
        await health.shutdown()

        let business = try client.invoke(
            context: context("/business"), method: "xiaowei.server.Health.Check",
            payload: Data(), options: options
        )
        let businessResult = try await business.run()
        try require(businessResult == businessResponse)
        await business.shutdown()

        let never = try client.invoke(
            context: context("/never"), method: "xiaowei.server.Health.Check",
            payload: Data(), options: options
        )
        never.cancel()
        do {
            _ = try await never.run()
            throw RuntimeFailure("cancelled request ran")
        } catch MobileError.Core(_, let category, _) {
            try require(category == "cancelled")
        }
        await never.shutdown()

        let timeout = try client.invoke(
            context: context("/timeout"), method: "xiaowei.server.Health.Check",
            payload: Data(), options: RequestOptions(timeoutMs: 1000, transport: .http)
        )
        do {
            _ = try await timeout.run()
            throw RuntimeFailure("request did not time out")
        } catch MobileError.Core(_, let category, _) {
            try require(category == "timeout")
        }
        await timeout.shutdown()

        let slow = try client.invoke(
            context: context("/cancel"), method: "xiaowei.server.Health.Check",
            payload: Data(), options: options
        )
        let task = Task.detached {
            try await withTaskCancellationHandler {
                try await slow.run()
            } onCancel: {
                slow.cancel()
            }
        }
        _ = try await fixture.get("wait/request-cancel")
        task.cancel()
        switch await task.result {
        case .success:
            throw RuntimeFailure("cancelled task succeeded")
        case .failure:
            break
        }
        await slow.shutdown()

        let restore = try client.restore(context: context(auth: expired), force: false)
        let checkpoint = try await restore.run()
        try require(checkpoint.code == 0 && checkpoint.checkpoint)
        try require(checkpoint.authenticated == rotated)
        restore.cancel()
        let retained = try await Task.detached {
            try await restore.settledResult()
        }.value
        try require(retained.code != 0 && !retained.checkpoint)
        try require(retained.authenticated == rotated)
        try require(retained.credentialVersion == checkpoint.credentialVersion)
        try await restore.shutdown()

        let resumed = try client.restore(context: context(auth: rotated), force: false)
        let result = try await resumed.run()
        try require(result.code == 0 && !result.checkpoint)
        try require(result.authenticated == updated)
        try await resumed.shutdown()

        let continued = try client.restore(context: context(auth: updated), force: true)
        let nextCheckpoint = try await continued.run()
        try require(nextCheckpoint.code == 0 && nextCheckpoint.checkpoint)
        try require(nextCheckpoint.authenticated == updated2)
        _ = try await client.setSession(context: context(auth: updated2))
        let continuedResult = try await continued.resume(
            credentialVersion: nextCheckpoint.credentialVersion
        )
        try require(continuedResult.code == 0 && !continuedResult.checkpoint)
        try require(continuedResult.credentialVersion == nextCheckpoint.credentialVersion)
        try require(continuedResult.authenticated == updated2)
        try await continued.shutdown()

        let logout = try client.logout(context: context(auth: updated2))
        let loggedOut = try await logout.run()
        try require(loggedOut.code == 0)
        try await logout.shutdown()
        let login = try client.login(context: context(), request: loginRequest)
        let loggedIn = try await login.run()
        try require(loggedIn.code == 0 && loggedIn.authenticated == valid)
        try await login.shutdown()

        subscription.stop()
        let ended = try await subscription.next()
        try require(ended == nil)
        try await client.pause()
        _ = try await client.setSession(context: context())

        let finalCall = try client.invoke(
            context: context("/close"), method: "xiaowei.server.Health.Check",
            payload: Data(), options: options
        )
        let finalTask = Task.detached { try await finalCall.run() }
        _ = try await fixture.get("wait/request-close")
        try await client.shutdown()
        try await client.shutdown()
        switch await finalTask.result {
        case .success:
            throw RuntimeFailure("closed client request succeeded")
        case .failure:
            break
        }
        print("iOS Rust network, checkpoints, cancellation and cleanup passed")
    }
}
