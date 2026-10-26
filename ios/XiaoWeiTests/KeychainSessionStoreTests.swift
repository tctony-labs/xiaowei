import Foundation
import LocalAuthentication
import Security
import XCTest
@testable import XiaoWei

final class KeychainSessionStoreTests: XCTestCase {
    func testKeychainPersistenceAndAccessPolicy() async throws {
        let service = "com.tctony.xiaowei.ios.tests.store." + UUID().uuidString
        let server = "https://keychain.example.test"
        defer {
            SecItemDelete([
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
            ] as CFDictionary)
        }
        let store = KeychainSessionStore(service: service)
        let firstID = try await store.deviceID()
        XCTAssertEqual(UUID(uuidString: firstID)?.uuidString.lowercased(), firstID)

        let first = Data("synthetic keychain probe".utf8)
        try await store.save(first, server: server)
        let reopened = KeychainSessionStore(service: service)
        let restored = try await reopened.load(server: server)
        let secondID = try await reopened.deviceID()
        XCTAssertTrue(restored == first)
        XCTAssertEqual(firstID, secondID)

        var result: CFTypeRef?
        let status = SecItemCopyMatching([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "session:" + server,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ] as CFDictionary, &result)
        XCTAssertEqual(status, errSecSuccess)
        let attributes = try XCTUnwrap(result as? [String: Any])
        XCTAssertEqual(
            attributes[kSecAttrAccessible as String] as? String,
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String
        )
        XCTAssertEqual(attributes[kSecAttrSynchronizable as String] as? Bool, false)
        // Security may return a default access-control object even without explicit flags.
        // Verify the behavior: a fresh context must read without authentication UI.
        let context = LAContext()
        context.interactionNotAllowed = true
        var nonInteractiveResult: CFTypeRef?
        let nonInteractive = SecItemCopyMatching([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "session:" + server,
            kSecReturnData as String: true,
            kSecUseAuthenticationContext as String: context,
        ] as CFDictionary, &nonInteractiveResult)
        XCTAssertEqual(nonInteractive, errSecSuccess)
        XCTAssertTrue((nonInteractiveResult as? Data) == first)

        let isolated = KeychainSessionStore(service: service + ".isolated")
        let absent = try await isolated.load(server: server)
        XCTAssertNil(absent)
        let updated = Data("updated synthetic probe".utf8)
        try await reopened.save(updated, server: server)
        let latest = try await store.load(server: server)
        XCTAssertTrue(latest == updated)

        try await store.remove(server: server)
        try await store.remove(server: server)
        let removed = try await reopened.load(server: server)
        let retainedID = try await store.deviceID()
        XCTAssertNil(removed)
        XCTAssertEqual(retainedID, firstID)
        print("iOS Keychain persistence, device identity, isolation and access policy passed")
    }
}
