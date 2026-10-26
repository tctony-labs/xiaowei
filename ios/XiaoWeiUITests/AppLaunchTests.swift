import Foundation
import XCTest

private struct UITestFailure: Error {
    let message: String
}

final class AppLaunchTests: XCTestCase {
    @MainActor
    func testPublicServerAndLifecycle() async throws {
        let app = XCUIApplication()
        app.launchArguments = ["--verification-public"]
        app.launch()
        try await startupNetwork(app, allowLocalAccess: true)
        tap(app, "connection.check")
        try await waitForLabel(app, "service.status", "服务正常")
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Public HTTPS App"
        screenshot.lifetime = .keepAlways
        add(screenshot)

        XCUIDevice.shared.press(.home)
        XCTAssertTrue(app.wait(for: .runningBackground, timeout: 10))
        app.activate()
        try await waitForLabel(app, "lifecycle.status", "准备就绪")
        tap(app, "connection.stop")
        try await waitForLabel(app, "lifecycle.status", "已停止")
        try await waitForLabel(app, "connection.status", "未连接")

        tap(app, "connection.check")
        try await waitForLabel(app, "lifecycle.status", "准备就绪")
        try await waitForLabel(app, "service.status", "服务正常")
        tap(app, "connection.stop")
        try await waitForLabel(app, "lifecycle.status", "已停止")
        app.terminate()
        print("iOS public HTTPS App, foreground lifecycle and client recreation passed")
    }

    @MainActor
    func testForegroundNetworkAndShutdown() async throws {
        let address = try XCTUnwrap(
            ProcessInfo.processInfo.environment["XIAOWEI_FIXTURE_CONTROL_URL"]
        )
        let control = try XCTUnwrap(URL(string: address))
        let app = XCUIApplication()
        app.launchArguments = ["--fixture-control", address]
        #if !targetEnvironment(simulator)
        app.resetAuthorizationStatus(for: .localNetwork)
        app.launch()
        try await startupNetwork(app, allowLocalAccess: false)
        try await waitForLabel(app, "lifecycle.status", "连接不可用")
        try await waitForLabel(app, "connection.status", "未连接")
        print("iOS local network denial produced a recoverable failure")
        app.terminate()
        app.resetAuthorizationStatus(for: .localNetwork)
        #endif

        app.launch()
        try await startupNetwork(app, allowLocalAccess: true)
        try await waitForLabel(app, "lifecycle.status", "准备就绪")
        try await waitForLabel(app, "connection.status", "已连接")
        try await waitForLabel(app, "account.status", "已登录")

        tap(app, "connection.check")
        try await waitForLabel(app, "service.status", "服务正常")
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Connected App"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        XCUIDevice.shared.press(.home)
        try await waitForState(control) { state in
            (state["openWebSockets"] as? Int) == 0 && (state["connections"] as? Int) == 1
        }

        app.activate()
        try await waitForLabel(app, "lifecycle.status", "准备就绪")
        try await waitForLabel(app, "connection.status", "已连接")
        try await waitForLabel(app, "account.status", "已登录")
        tap(app, "connection.check")
        try await waitForState(control) { state in
            let counts = state["counts"] as? [String: Int]
            return counts?["health"] == 2
        }
        try await waitForLabel(app, "service.status", "服务正常")
        tap(app, "connection.stop")
        try await waitForLabel(app, "lifecycle.status", "已停止")
        try await waitForLabel(app, "connection.status", "未连接")
        try await waitForState(control) { ($0["openWebSockets"] as? Int) == 0 }

        tap(app, "connection.check")
        try await waitForLabel(app, "lifecycle.status", "准备就绪")
        try await waitForLabel(app, "connection.status", "已连接")
        try await waitForLabel(app, "account.status", "已登录")
        try await waitForLabel(app, "service.status", "服务正常")
        try await waitForState(control) { state in
            let counts = state["counts"] as? [String: Int]
            return counts?["health"] == 3
        }
        tap(app, "connection.stop")
        try await waitForLabel(app, "lifecycle.status", "已停止")
        try await waitForState(control) { ($0["openWebSockets"] as? Int) == 0 }
        _ = try await get(control.appendingPathComponent("ui-complete"))
        app.terminate()
        print("iOS App foreground, background, reconnect, shutdown and recreation passed")
    }

    @MainActor
    private func tap(_ app: XCUIApplication, _ identifier: String) {
        let button = app.buttons[identifier]
        for _ in 0..<4 {
            if button.isHittable { break }
            app.swipeUp()
        }
        button.tap()
    }

    @MainActor
    private func startupNetwork(_ app: XCUIApplication, allowLocalAccess: Bool) async throws {
        let system = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let deadline = ContinuousClock.now + .seconds(30)
        var granted = false
        while ContinuousClock.now < deadline {
            let alert = system.alerts.firstMatch
            if alert.exists {
                let localPrompt = alert.staticTexts.matching(NSPredicate(
                    format: "label CONTAINS[c] %@ OR label CONTAINS[c] %@",
                    "本地网络", "local network"
                )).firstMatch.exists
                let labels = localPrompt && !allowLocalAccess
                    ? ["不允许", "Don’t Allow", "Don't Allow"]
                    : ["仅限无线局域网", "WLAN Only", "允许", "Allow", "好", "OK"]
                for label in labels {
                    if alert.buttons[label].exists {
                        alert.buttons[label].tap()
                        if localPrompt && !allowLocalAccess {
                            print("iOS local network permission denied through system UI")
                            return
                        }
                        granted = true
                        print("iOS network permission granted through system UI")
                        break
                    }
                }
            }

            let status = app.descendants(matching: .any)
                .matching(identifier: "lifecycle.status").firstMatch
            if allowLocalAccess && status.exists && (status.value as? String) == "准备就绪" {
                return
            }
            if allowLocalAccess && granted && status.exists
                && (status.value as? String) == "连接不可用" {
                app.terminate()
                app.launch()
                granted = false
            }
            try await Task.sleep(for: .milliseconds(150))
        }
        let message = allowLocalAccess
            ? "App did not become ready after network permission"
            : "Local network permission prompt did not appear; check device LAN access"
        throw UITestFailure(message: message)
    }

    @MainActor
    private func waitForLabel(_ app: XCUIApplication, _ identifier: String, _ value: String)
        async throws {
        var granted = false
        let monitor = addUIInterruptionMonitor(withDescription: "Network permission") { alert in
            for label in ["仅限无线局域网", "WLAN Only", "允许", "Allow", "好", "OK"] {
                if alert.buttons[label].exists {
                    alert.buttons[label].tap()
                    granted = true
                    return true
                }
            }
            return false
        }
        defer { removeUIInterruptionMonitor(monitor) }
        let deadline = ContinuousClock.now + .seconds(25)
        while ContinuousClock.now < deadline {
            let element = app.descendants(matching: .any)
                .matching(identifier: identifier).firstMatch
            if element.exists && (element.value as? String) == value { return }
            if granted && identifier == "service.status"
                && (element.value as? String) == "连接失败" {
                tap(app, "connection.check")
                granted = false
            }
            app.navigationBars.firstMatch.tap()
            try await Task.sleep(for: .milliseconds(150))
        }
        let element = app.descendants(matching: .any).matching(identifier: identifier).firstMatch
        let actual = element.exists ? String(describing: element.value) : "missing"
        throw UITestFailure(message: identifier + " expected " + value + ", actual " + actual)
    }

    @MainActor
    private func waitForState(_ control: URL, _ matches: ([String: Any]) -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(15)
        while ContinuousClock.now < deadline {
            let data = try await get(control.appendingPathComponent("state"))
            let state = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            if matches(state) { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw UITestFailure(message: "Fixture state did not settle")
    }

    @MainActor
    private func get(_ url: URL) async throws -> Data {
        var request = URLRequest(url: url)
        request.timeoutInterval = 20
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw UITestFailure(message: "Fixture control request failed")
        }
        return data
    }
}
