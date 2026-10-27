import Foundation
import Observation
import OSLog
import ProtoServer
import UIKit
import XiaoweiMobile

@MainActor
@Observable
final class AppModel {
    enum Phase {
        case starting
        case ready
        case pausing
        case paused
        case closing
        case closed
        case failed
    }

    private(set) var phase = Phase.starting
    private(set) var healthStatus = "尚未检查"
    private(set) var connectionStatus = "未连接"
    private(set) var isChecking = false
    private(set) var account: AccountSession?

    @ObservationIgnored private let logger = Logger(
        subsystem: "com.tctony.xiaowei.ios", category: "lifecycle"
    )
    @ObservationIgnored private var client: MobileClient?
    @ObservationIgnored private var subscription: ConnectionSubscription?
    @ObservationIgnored private var observation: Task<Void, Never>?
    @ObservationIgnored private var transition: Task<Void, Never>?
    @ObservationIgnored private var call: ApiCall?
    @ObservationIgnored private var revision: UInt64 = 0
    @ObservationIgnored private var foreground = false
    @ObservationIgnored private var backgroundTime = UIBackgroundTaskIdentifier.invalid
    @ObservationIgnored private var backgroundRevision: UInt64?

    var phaseLabel: String {
        switch phase {
        case .starting: "准备中"
        case .ready: "准备就绪"
        case .pausing: "正在暂停"
        case .paused: "已暂停"
        case .closing: "正在停止"
        case .closed: "已停止"
        case .failed: "连接不可用"
        }
    }

    func enterForeground() {
        guard !foreground || phase == .failed else { return }
        foreground = true
        revision += 1
        let expected = revision
        let previous = transition
        phase = .starting
        transition = Task { [weak self] in
            await previous?.value
            guard let self, self.foreground, self.revision == expected else { return }
            do {
                if self.account == nil {
                    let configuration = try await AppConfiguration.load()
                    let store = KeychainSessionStore(service: configuration.keychainService)
                    let deviceID: String
                    if let configured = configuration.deviceID {
                        deviceID = configured
                    } else {
                        deviceID = try await store.deviceID()
                    }
                    self.account = AccountSession(
                        server: configuration.server, deviceID: deviceID,
                        store: store, seed: configuration.seed
                    )
                }
                guard self.foreground, self.revision == expected else { return }
                let client = try self.client ?? MobileClient()
                self.client = client
                try await self.account?.activate(client: client)
                guard self.foreground, self.revision == expected else { return }
                try self.observe(client, revision: expected)
                self.phase = .ready
                self.logger.info("Mobile client active revision=\(expected)")
            } catch {
                guard self.revision == expected else { return }
                self.phase = .failed
                self.logger.error("Activation failed category=\(Self.category(error))")
            }
        }
    }

    func enterBackground() {
        guard foreground else { return }
        foreground = false
        revision += 1
        let expected = revision
        let previous = transition
        call?.cancel()
        account?.deactivate()
        stopObservation()
        if isChecking { healthStatus = "已取消" }
        isChecking = false
        phase = .pausing
        endBackgroundTime()
        backgroundRevision = expected
        backgroundTime = UIApplication.shared.beginBackgroundTask(withName: "Pause connections") {
            [weak self] in
            Task { @MainActor in
                guard let self else { return }
                self.logger.notice("Background cleanup time expired")
                self.endBackgroundTime(revision: expected)
            }
        }
        transition = Task { [weak self] in
            await previous?.value
            guard let self else { return }
            do {
                await self.account?.waitForIdle()
                try await self.client?.pause()
                if self.revision == expected {
                    self.connectionStatus = "未连接"
                    self.phase = .paused
                }
                self.logger.info("Mobile client paused revision=\(expected)")
            } catch {
                if self.revision == expected { self.phase = .failed }
                self.logger.error("Pause failed category=\(Self.category(error))")
            }
            self.endBackgroundTime(revision: expected)
        }
    }

    func checkConnection() async {
        await transition?.value
        guard foreground, phase == .ready, !isChecking, let client, let account else { return }
        let expected = revision
        isChecking = true
        healthStatus = "检查中"
        do {
            let request = try client.invoke(
                context: account.context,
                method: Xiaowei_Server_Health.Check,
                payload: Data(),
                options: RequestOptions(timeoutMs: 10_000, transport: .http)
            )
            call = request
            do {
                let response = try await withTaskCancellationHandler {
                    try await request.run()
                } onCancel: {
                    request.cancel()
                }
                await request.shutdown()
                guard revision == expected else { return }
                let result = try Xiaowei_Server_BaseResponse(serializedBytes: response)
                healthStatus = result.code == Xiaowei_Server_ErrorCode.success.rawValue
                    && result.hasData ? "服务正常" : "服务不可用"
                logger.info("Health request completed bytes=\(response.count)")
            } catch {
                await request.shutdown()
                throw error
            }
        } catch {
            guard revision == expected else { return }
            healthStatus = "连接失败"
            logger.error("Health request failed category=\(Self.category(error))")
        }
        if revision == expected {
            call = nil
            isChecking = false
        }
    }

    func shutdown() async {
        foreground = false
        revision += 1
        let expected = revision
        let previous = transition
        call?.cancel()
        account?.deactivate()
        stopObservation()
        if isChecking { healthStatus = "已取消" }
        isChecking = false
        phase = .closing
        let cleanup = Task { [weak self] in
            await previous?.value
            guard let self else { return }
            do {
                await self.account?.waitForIdle()
                try await self.client?.shutdown()
                self.client = nil
                self.account?.detachClient()
                self.call = nil
                if self.revision == expected {
                    self.connectionStatus = "未连接"
                    self.phase = .closed
                }
                self.logger.info("Mobile client shutdown completed")
            } catch {
                if self.revision == expected { self.phase = .failed }
                self.logger.error("Shutdown failed category=\(Self.category(error))")
            }
        }
        transition = cleanup
        await cleanup.value
    }

    private func observe(_ client: MobileClient, revision expected: UInt64) throws {
        stopObservation()
        let stream = try client.subscribeConnection()
        subscription = stream
        observation = Task { [weak self] in
            do {
                while let snapshot = try await stream.next() {
                    guard let self, self.revision == expected else { break }
                    self.connectionStatus = switch snapshot.status {
                    case .disconnected: "未连接"
                    case .connecting: "连接中"
                    case .connected: "已连接"
                    case .reconnecting: "重新连接中"
                    }
                    self.account?.connectionChanged(snapshot)
                    self.logger.info("Connection state changed generation=\(snapshot.generation)")
                }
            } catch {
                self?.logger.error("Connection observation failed category=\(Self.category(error))")
            }
        }
    }

    private func stopObservation() {
        subscription?.stop()
        observation?.cancel()
        subscription = nil
        observation = nil
    }

    private func endBackgroundTime(revision expected: UInt64? = nil) {
        if let expected, backgroundRevision != expected { return }
        guard backgroundTime != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTime)
        backgroundTime = .invalid
        backgroundRevision = nil
    }

    nonisolated private static func category(_ error: Error) -> String {
        switch error {
        case MobileError.Core(_, let category, _): category
        case MobileError.Local: "local"
        default: "platform"
        }
    }
}
