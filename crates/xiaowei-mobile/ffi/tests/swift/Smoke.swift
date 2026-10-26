import Foundation

@main
struct Smoke {
    static func main() async throws {
        let arguments = CommandLine.arguments
        precondition(arguments.count == 10)
        let server = arguments[1]
        let valid = Data(base64Encoded: arguments[2])!
        let expired = Data(base64Encoded: arguments[3])!
        let rotated = Data(base64Encoded: arguments[4])!
        let updated = Data(base64Encoded: arguments[5])!
        let loginRequest = Data(base64Encoded: arguments[6])!
        let healthResponse = Data(base64Encoded: arguments[7])!
        let businessResponse = Data(base64Encoded: arguments[8])!
        let updated2 = Data(base64Encoded: arguments[9])!

        func context(_ suffix: String = "", auth: Data? = nil, connect: Bool = false)
            -> SessionContext {
            SessionContext(server: server + suffix, authenticated: auth, connect: connect)
        }
        let options = RequestOptions(timeoutMs: nil, transport: .auto)
        let client = try MobileClient()
        let subscription = try client.subscribeConnection()
        let initial = try await subscription.next()
        precondition(initial?.status == .disconnected)

        _ = try await client.setSession(context: context(auth: valid, connect: true))
        while let snapshot = try await subscription.next() {
            if snapshot.status == .connected {
                precondition(snapshot.generation > 0)
                precondition(snapshot.authentication == .authenticated)
                break
            }
        }
        let websocket = try client.invoke(
            context: context(auth: valid),
            method: "xiaowei.server.auth.Auth.GetCurrentUser",
            payload: Data(),
            options: RequestOptions(timeoutMs: nil, transport: .websocket)
        )
        let currentUser = try await websocket.run()
        precondition(!currentUser.isEmpty)
        await websocket.shutdown()

        let health = try client.invoke(
            context: context(auth: valid), method: "xiaowei.server.common.Health.Check",
            payload: Data(), options: options
        )
        let first = try await health.run()
        let repeated = try await health.run()
        precondition(first == healthResponse && repeated == first)
        await health.shutdown()

        let business = try client.invoke(
            context: context("/business"), method: "xiaowei.server.common.Health.Check",
            payload: Data(), options: options
        )
        let businessResult = try await business.run()
        precondition(businessResult == businessResponse)
        await business.shutdown()

        let never = try client.invoke(
            context: context("/never"), method: "xiaowei.server.common.Health.Check",
            payload: Data(), options: options
        )
        never.cancel()
        do {
            _ = try await never.run()
            preconditionFailure("cancelled request ran")
        } catch MobileError.Core(_, let category, _) {
            precondition(category == "cancelled")
        }
        await never.shutdown()

        let timeout = try client.invoke(
            context: context("/timeout"), method: "xiaowei.server.common.Health.Check",
            payload: Data(), options: RequestOptions(timeoutMs: 30, transport: .http)
        )
        do {
            _ = try await timeout.run()
            preconditionFailure("request did not time out")
        } catch MobileError.Core(_, let category, _) {
            precondition(category == "timeout")
        }
        await timeout.shutdown()

        let slow = try client.invoke(
            context: context("/cancel"), method: "xiaowei.server.common.Health.Check",
            payload: Data(), options: options
        )
        let task = Task.detached {
            try await withTaskCancellationHandler {
                try await slow.run()
            } onCancel: {
                slow.cancel()
            }
        }
        precondition(readLine() == "cancel")
        task.cancel()
        switch await task.result {
        case .success:
            preconditionFailure("cancelled task succeeded")
        case .failure:
            break
        }
        await slow.shutdown()

        let restore = try client.restore(context: context(auth: expired), force: false)
        let checkpoint = try await restore.run()
        precondition(checkpoint.code == 0 && checkpoint.checkpoint)
        precondition(checkpoint.authenticated == rotated)
        restore.cancel()
        let retained = try await Task.detached {
            try await restore.settledResult()
        }.value
        precondition(retained.code != 0 && !retained.checkpoint)
        precondition(retained.authenticated == rotated)
        precondition(retained.credentialVersion == checkpoint.credentialVersion)
        try await restore.shutdown()

        let resumed = try client.restore(context: context(auth: rotated), force: false)
        let result = try await resumed.run()
        precondition(result.code == 0 && !result.checkpoint)
        precondition(result.authenticated == updated)
        try await resumed.shutdown()

        let continued = try client.restore(context: context(auth: updated), force: true)
        let nextCheckpoint = try await continued.run()
        precondition(nextCheckpoint.code == 0 && nextCheckpoint.checkpoint)
        precondition(nextCheckpoint.authenticated == updated2)
        _ = try await client.setSession(context: context(auth: updated2))
        let continuedResult = try await continued.resume(
            credentialVersion: nextCheckpoint.credentialVersion
        )
        precondition(continuedResult.code == 0 && !continuedResult.checkpoint)
        precondition(continuedResult.credentialVersion == nextCheckpoint.credentialVersion)
        precondition(continuedResult.authenticated == updated2)
        try await continued.shutdown()

        let logout = try client.logout(context: context(auth: updated2))
        let loggedOut = try await logout.run()
        precondition(loggedOut.code == 0)
        try await logout.shutdown()
        let login = try client.login(context: context(), request: loginRequest)
        let loggedIn = try await login.run()
        precondition(loggedIn.code == 0 && loggedIn.authenticated == valid)
        try await login.shutdown()

        subscription.stop()
        let ended = try await subscription.next()
        precondition(ended == nil)
        try await client.pause()
        _ = try await client.setSession(context: context())

        let finalCall = try client.invoke(
            context: context("/close"), method: "xiaowei.server.common.Health.Check",
            payload: Data(), options: options
        )
        let finalTask = Task.detached { try await finalCall.run() }
        precondition(readLine() == "close")
        try await client.shutdown()
        try await client.shutdown()
        switch await finalTask.result {
        case .success:
            preconditionFailure("closed client request succeeded")
        case .failure:
            break
        }
        print("Swift bindings passed")
    }
}
