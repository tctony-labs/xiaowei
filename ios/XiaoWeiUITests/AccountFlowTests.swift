import Foundation
import XCTest

private struct AccountUIFailure: Error {
    let message: String
}

final class AccountFlowTests: XCTestCase {
    @MainActor
    func testPasswordLoginRestoreCancelAndLogout() async throws {
        continueAfterFailure = false
        let address = try XCTUnwrap(
            ProcessInfo.processInfo.environment["XIAOWEI_FIXTURE_CONTROL_URL"]
        )
        let control = try XCTUnwrap(URL(string: address))
        let app = XCUIApplication()
        app.launchArguments = ["--fixture-control", address, "--account-fixture"]
        app.launch()
        try await waitForLabel(app, "lifecycle.status", "准备就绪")
        try await waitForLabel(app, "account.status", "未登录")

        tap(app, "account.login")
        enterCredentials(app, password: "wrong synthetic password")
        tap(app, "login.submit")
        XCTAssertTrue(app.staticTexts["邮箱或密码错误"].waitForExistence(timeout: 15))
        enterPassword(app, " synthetic fixture password ")
        tap(app, "login.submit")
        try await waitForLabel(app, "account.status", "已登录")
        try await waitForLabel(app, "connection.status", "已连接")
        try await waitForState(control, minimumUsers: 1, minimumConnections: 1)
        _ = try await get(control, "disconnect")
        try await waitForState(control, minimumUsers: 2, minimumConnections: 2)
        try await waitForLabel(app, "account.status", "已登录")
        try await waitForLabel(app, "connection.status", "已连接")
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Synthetic account signed in"
        screenshot.lifetime = .keepAlways
        add(screenshot)

        app.terminate()
        app.launch()
        try await waitForLabel(app, "account.status", "已登录")
        try await waitForLabel(app, "connection.status", "已连接")
        let restoredEmail = app.staticTexts.matching(NSPredicate(
            format: "label CONTAINS %@", "updated@example.test"
        )).firstMatch
        guard restoredEmail.waitForExistence(timeout: 5) else {
            throw AccountUIFailure(message: "Relaunch did not display the restored user")
        }
        tap(app, "account.logout")
        try await waitForLabel(app, "account.status", "未登录")
        try await waitForLabel(app, "connection.status", "未连接")
        app.terminate()
        app.launch()
        try await waitForLabel(app, "lifecycle.status", "准备就绪")
        try await waitForLabel(app, "account.status", "未登录")

        _ = try await get(control, "mode/hold-login")
        tap(app, "account.login")
        enterCredentials(app, password: " synthetic fixture password ")
        tap(app, "login.submit")
        _ = try await get(control, "wait/request-login")
        tap(app, "login.cancel")
        _ = try await get(control, "wait/closed-login")
        try await waitForLabel(app, "account.status", "未登录")
        tap(app, "connection.stop")
        try await waitForLabel(app, "lifecycle.status", "已停止")
        _ = try await get(control, "account-ui-complete")
        app.terminate()
        print("iOS form failure, login, Keychain relaunch, logout and cancellation passed")
    }

    @MainActor
    private func enterCredentials(_ app: XCUIApplication, password: String) {
        let email = app.textFields["login.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 10))
        email.tap()
        email.typeText("fixture@example.test")
        enterPassword(app, password)
    }

    @MainActor
    private func enterPassword(_ app: XCUIApplication, _ password: String) {
        let field = app.secureTextFields["login.password"]
        field.tap()
        field.typeText(password)
    }

    @MainActor
    private func tap(_ app: XCUIApplication, _ identifier: String) {
        let button = app.buttons[identifier]
        XCTAssertTrue(button.waitForExistence(timeout: 10))
        for _ in 0..<4 {
            if button.isHittable { break }
            app.swipeUp()
        }
        button.tap()
    }

    @MainActor
    private func waitForLabel(_ app: XCUIApplication, _ identifier: String, _ value: String)
        async throws {
        let system = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let deadline = ContinuousClock.now + .seconds(25)
        while ContinuousClock.now < deadline {
            let alert = system.alerts.firstMatch
            if alert.exists {
                for label in ["仅限无线局域网", "WLAN Only", "允许", "Allow", "好", "OK"] {
                    if alert.buttons[label].exists {
                        alert.buttons[label].tap()
                        break
                    }
                }
            }
            let element = app.descendants(matching: .any)
                .matching(identifier: identifier).firstMatch
            if element.exists && (element.value as? String) == value { return }
            try await Task.sleep(for: .milliseconds(150))
        }
        throw AccountUIFailure(message: identifier + " did not become " + value)
    }

    @MainActor
    private func waitForState(_ control: URL, minimumUsers: Int, minimumConnections: Int)
        async throws {
        let deadline = ContinuousClock.now + .seconds(15)
        while ContinuousClock.now < deadline {
            let data = try await get(control, "state")
            let state = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            let counts = try XCTUnwrap(state["counts"] as? [String: Int])
            if (counts["user"] ?? 0) >= minimumUsers
                && (state["connections"] as? Int ?? 0) >= minimumConnections { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw AccountUIFailure(message: "Account did not validate the reconnected session")
    }

    @MainActor
    private func get(_ control: URL, _ path: String) async throws -> Data {
        var request = URLRequest(url: control.appendingPathComponent(path))
        request.timeoutInterval = 20
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw AccountUIFailure(message: "Fixture control request failed")
        }
        return data
    }
}
