import Foundation
import Observation
import OSLog
import ProtoServer
import XiaoweiMobile

private struct AccountFailure: Error {
    let code: Int32
}

@MainActor
@Observable
final class AccountSession {
    enum Status {
        case signedOut
        case restoring
        case signingIn
        case signingOut
        case signedIn
        case offline
        case storageError
    }

    private enum Command {
        case login(Data)
        case restore(Bool)
        case maintain
        case logout

        var isLogin: Bool {
            if case .login = self { return true }
            return false
        }

        var isRestore: Bool {
            if case .restore = self { return true }
            return false
        }
    }

    let server: String
    private(set) var status = Status.signedOut
    private(set) var userID = ""
    private(set) var email = ""
    private(set) var errorMessage: String?
    private(set) var isWorking = false

    @ObservationIgnored private let store: any SessionStore
    @ObservationIgnored private let deviceID: String
    @ObservationIgnored private let seed: Data?
    @ObservationIgnored private let logger = Logger(
        subsystem: "com.tctony.xiaowei.ios", category: "account"
    )
    @ObservationIgnored private var client: MobileClient?
    @ObservationIgnored private var bytes: Data?
    @ObservationIgnored private var persisted: Data?
    @ObservationIgnored private var loaded = false
    @ObservationIgnored private var active = false
    @ObservationIgnored private var activation: UInt64 = 0
    @ObservationIgnored private var operation: AccountOperation?
    @ObservationIgnored private var work: Task<Void, Never>?
    @ObservationIgnored private var maintenance: Task<Void, Never>?
    @ObservationIgnored private var pendingRemoval = false
    @ObservationIgnored private var currentCommand: Command?
    @ObservationIgnored private var pendingRestore = false
    @ObservationIgnored private var forceRestore = false
    @ObservationIgnored private var lastConnection: UInt64?
    @ObservationIgnored private var connected = false
    @ObservationIgnored private var lastRejection: UInt64?

    init(server: String, deviceID: String, store: any SessionStore, seed: Data? = nil) {
        self.server = server
        self.deviceID = deviceID
        self.store = store
        self.seed = seed
    }

    var isAuthenticated: Bool { bytes != nil }

    var statusLabel: String {
        switch status {
        case .signedOut: "未登录"
        case .restoring: "正在恢复"
        case .signingIn: "正在登录"
        case .signingOut: "正在退出"
        case .signedIn: "已登录"
        case .offline: "离线，登录信息已保留"
        case .storageError: "登录信息保存失败"
        }
    }

    var context: SessionContext {
        SessionContext(
            server: server,
            authenticated: persisted,
            connect: active && persisted != nil && persisted == bytes && !pendingRemoval
        )
    }

    func activate(client: MobileClient) async throws {
        active = true
        activation += 1
        let expected = activation
        if self.client !== client {
            lastConnection = nil
            connected = false
            lastRejection = nil
        }
        self.client = client
        do {
            if !loaded {
                var stored = try await store.load(server: server)
                if stored == nil, let seed {
                    try await store.save(seed, server: server)
                    stored = seed
                }
                if let stored { try display(stored) }
                bytes = stored
                persisted = stored
                loaded = true
            }
            guard active, activation == expected else { return }
            _ = try await client.setSession(context: context)
            guard active, activation == expected else { return }
            if bytes != nil || pendingRemoval { begin(.restore(false)) }
        } catch {
            status = .storageError
            errorMessage = "无法读取登录信息，请重试"
            logger.error("Account activation failed category=\(Self.category(error))")
            throw error
        }
    }

    func login(email: String, password: String) {
        guard !isAuthenticated else { return }
        var credential = Xiaowei_Server_PasswordLogin()
        credential.email = email.trimmingCharacters(in: .whitespacesAndNewlines)
        credential.password = password
        var request = Xiaowei_Server_LoginRequest()
        request.deviceID = deviceID
        request.deviceName = "iPhone"
        request.credential = .password(credential)
        do {
            begin(.login(try request.serializedData()))
        } catch {
            errorMessage = "无法准备登录请求"
        }
    }

    func retry() { begin(.restore(false)) }

    func logout() { begin(.logout) }

    func cancelOperation() {
        operation?.cancel()
        work?.cancel()
    }

    func deactivate() {
        active = false
        activation += 1
        maintenance?.cancel()
        maintenance = nil
        pendingRestore = false
        forceRestore = false
        cancelOperation()
    }

    func waitForIdle() async {
        while let task = work { await task.value }
    }

    func detachClient() { client = nil }

    func connectionChanged(_ snapshot: ConnectionSnapshot) {
        let becameConnected = snapshot.status == .connected
            && (!connected || lastConnection != snapshot.generation)
        connected = snapshot.status == .connected
        if snapshot.authentication == .rejected, lastRejection != snapshot.generation {
            lastRejection = snapshot.generation
            requestRestore(force: true)
        } else if becameConnected {
            lastConnection = snapshot.generation
            requestRestore(force: false)
        }
    }

    private func requestRestore(force: Bool) {
        guard active, bytes != nil else { return }
        if isWorking {
            if force || currentCommand?.isRestore != true {
                pendingRestore = true
                forceRestore = forceRestore || force
            }
        } else {
            begin(.restore(force))
        }
    }

    private func begin(_ command: Command) {
        guard active, loaded, !isWorking, let client else { return }
        maintenance?.cancel()
        maintenance = nil
        isWorking = true
        currentCommand = command
        errorMessage = nil
        status = switch command {
        case .login: .signingIn
        case .logout: .signingOut
        default: .restoring
        }
        work = Task { [weak self] in
            guard let self else { return }
            await self.perform(command, client: client)
            self.operation = nil
            self.currentCommand = nil
            self.isWorking = false
            self.work = nil
            if self.pendingRestore, self.active, self.bytes != nil {
                let force = self.forceRestore
                self.pendingRestore = false
                self.forceRestore = false
                self.begin(.restore(force))
            }
        }
    }

    private func perform(_ command: Command, client: MobileClient) async {
        var opened: AccountOperation?
        var loginCommitted = false
        var nextAt = Int64(Date().timeIntervalSince1970 * 1000) + 30_000
        do {
            if pendingRemoval {
                try await removeSession(client)
                return
            }
            try await savePending()
            try Task.checkCancellation()
            let op: AccountOperation
            switch command {
            case .login(let request):
                op = try client.login(
                    context: SessionContext(server: server, authenticated: nil, connect: false),
                    request: request
                )
            case .restore(let force):
                guard bytes != nil else {
                    status = .signedOut
                    return
                }
                op = try client.restore(context: context, force: force)
            case .maintain:
                guard bytes != nil else {
                    status = .signedOut
                    return
                }
                op = try client.maintain(context: context, force: false)
            case .logout:
                guard bytes != nil else {
                    status = .signedOut
                    return
                }
                op = try client.logout(context: context)
            }
            opened = op
            operation = op
            let outcome = try await withTaskCancellationHandler {
                var value = try await op.run()
                while true {
                    if !command.isLogin { try await accept(value) }
                    try Task.checkCancellation()
                    if value.code != Xiaowei_Server_ErrorCode.success.rawValue {
                        throw AccountFailure(code: value.code)
                    }
                    if !value.checkpoint { return value }
                    value = try await op.resume(credentialVersion: value.credentialVersion)
                }
            } onCancel: {
                op.cancel()
            }
            _ = await finish(op)
            opened = nil
            operation = nil
            nextAt = outcome.nextMaintenanceAtMs

            switch command {
            case .login:
                guard let authenticated = outcome.authenticated else {
                    throw AccountFailure(
                        code: Int32(Xiaowei_Server_ErrorCode.internalError.rawValue)
                    )
                }
                try validate(authenticated)
                do {
                    try Task.checkCancellation()
                    try await store.save(authenticated, server: server)
                    try Task.checkCancellation()
                    guard active else { throw CancellationError() }
                } catch {
                    await discardLogin(authenticated, client: client)
                    throw error
                }
                bytes = authenticated
                persisted = authenticated
                try display(authenticated)
                loginCommitted = true
                _ = try await client.setSession(context: context)
                status = .signedIn
                logger.info("Login committed to Keychain")
            case .logout:
                pendingRemoval = true
                try await removeSession(client)
            default:
                status = .signedIn
                logger.info("Account restoration or maintenance completed")
            }
        } catch {
            if let opened {
                if let retained = await finish(opened) {
                    if case .login = command {
                        if !loginCommitted, let authenticated = retained.authenticated {
                            await discardLogin(authenticated, client: client)
                        }
                    } else {
                        do {
                            try await accept(retained)
                        } catch {
                            logger.error("Retained credential save failed")
                        }
                    }
                }
                operation = nil
            }
            if let failure = error as? AccountFailure,
               failure.code == Xiaowei_Server_ErrorCode.unauthenticated.rawValue,
               !Task.isCancelled {
                pendingRemoval = true
                do {
                    try await removeSession(client)
                } catch {
                    showFailure(error)
                }
            } else if Task.isCancelled {
                if persisted != bytes || pendingRemoval {
                    status = .storageError
                    errorMessage = "登录信息保存失败，请重试"
                } else {
                    status = bytes == nil ? .signedOut : .offline
                }
            } else {
                showFailure(error)
            }
            if persisted != bytes || pendingRemoval {
                await stopConnection(client)
            }
            logger.notice("Account operation ended category=\(Self.category(error))")
        }
        schedule(nextAt: status == .signedIn ? nextAt : nil)
    }

    private func accept(_ outcome: AccountOutcome) async throws {
        if let authenticated = outcome.authenticated, authenticated != bytes {
            try validate(authenticated)
            bytes = authenticated
            try display(authenticated)
        }
        try await savePending()
    }

    private func savePending() async throws {
        guard let bytes, bytes != persisted else { return }
        try await store.save(bytes, server: server)
        persisted = bytes
        logger.info("Credential checkpoint saved to Keychain")
        if let client, active { _ = try await client.setSession(context: context) }
    }

    private func removeSession(_ client: MobileClient) async throws {
        try await store.remove(server: server)
        bytes = nil
        persisted = nil
        pendingRemoval = false
        userID = ""
        email = ""
        _ = try await client.setSession(context: context)
        status = .signedOut
        errorMessage = nil
        logger.info("Local account session removed")
    }

    private func finish(_ op: AccountOperation) async -> AccountOutcome? {
        do {
            return try await Task.detached {
                op.cancel()
                let result: AccountOutcome
                do {
                    result = try await op.settledResult()
                } catch {
                    try? await op.shutdown()
                    throw error
                }
                try await op.shutdown()
                return result
            }.value
        } catch {
            logger.error("Account operation cleanup failed category=\(Self.category(error))")
            return nil
        }
    }

    private func discardLogin(_ authenticated: Data, client: MobileClient) async {
        do {
            try await store.remove(server: server)
        } catch {
            pendingRemoval = true
            logger.error("Uncommitted login deletion failed")
        }
        do {
            let context = SessionContext(
                server: server, authenticated: authenticated, connect: false
            )
            let result = try await Task.detached {
                let revoke = try client.revoke(context: context)
                let outcome: AccountOutcome
                do {
                    outcome = try await revoke.run()
                } catch {
                    try? await revoke.shutdown()
                    throw error
                }
                try await revoke.shutdown()
                return outcome
            }.value
            logger.info("Uncommitted login revocation returned code=\(result.code)")
        } catch {
            logger.notice("Uncommitted login revocation was not confirmed")
        }
    }

    private func stopConnection(_ client: MobileClient) async {
        let context = SessionContext(server: server, authenticated: persisted, connect: false)
        _ = try? await Task.detached { try await client.setSession(context: context) }.value
    }

    private func validate(_ data: Data) throws {
        let value = try Xiaowei_Server_Authenticated(serializedBytes: data)
        guard value.hasUser, !value.user.userID.isEmpty,
              value.hasDevice, value.device.deviceID == deviceID,
              value.hasTokens, !value.tokens.sessionID.isEmpty,
              !value.tokens.accessToken.isEmpty, !value.tokens.refreshToken.isEmpty else {
            throw CocoaError(.coderReadCorrupt)
        }
    }

    private func display(_ data: Data) throws {
        try validate(data)
        let value = try Xiaowei_Server_Authenticated(serializedBytes: data)
        userID = value.user.userID
        email = value.user.email
    }

    private func showFailure(_ error: Error) {
        if error is SessionStorageError || persisted != bytes || pendingRemoval {
            status = .storageError
            errorMessage = "登录信息保存失败，请重试"
        } else if let failure = error as? AccountFailure,
                  failure.code == Xiaowei_Server_AuthErrorCode.invalidCredentials.rawValue {
            status = .signedOut
            errorMessage = "邮箱或密码错误"
        } else {
            status = bytes == nil ? .signedOut : .offline
            errorMessage = "暂时无法连接服务器，请重试"
        }
    }

    private func schedule(nextAt: Int64?) {
        guard active, bytes != nil, !pendingRemoval else { return }
        let delay = nextAt.map { max(1, Double($0) / 1000 - Date().timeIntervalSince1970) } ?? 30
        maintenance = Task { [weak self] in
            do {
                try await Task.sleep(for: .seconds(delay))
            } catch {
                return
            }
            guard let self, self.active else { return }
            self.begin(self.status == .signedIn ? .maintain : .restore(false))
        }
    }

    nonisolated private static func category(_ error: Error) -> String {
        if error is CancellationError { return "cancelled" }
        if error is SessionStorageError { return "storage" }
        if let failure = error as? AccountFailure { return "response-\(failure.code)" }
        if case MobileError.Core(_, let category, _) = error { return category }
        return "platform"
    }
}
