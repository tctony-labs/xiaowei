import Foundation
import Security

actor KeychainSessionStore: SessionStore {
    private let service: String

    init(service: String = "com.tctony.xiaowei.ios.session") {
        self.service = service
    }

    func deviceID() throws -> String {
        if let existing = try read(account: "device-id") {
            return try decodeDeviceID(existing)
        }
        let candidate = UUID().uuidString.lowercased()
        let values = item(account: "device-id", data: Data(candidate.utf8))
        let status = SecItemAdd(values as CFDictionary, nil)
        if status == errSecDuplicateItem, let existing = try read(account: "device-id") {
            return try decodeDeviceID(existing)
        }
        try requireSuccess(status)
        return candidate
    }

    func load(server: String) throws -> Data? {
        try read(account: "session:" + server)
    }

    func save(_ authenticated: Data, server: String) throws {
        let account = "session:" + server
        let attributes = [
            kSecValueData as String: authenticated,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ] as [String: Any]
        let status = SecItemUpdate(
            query(account: account) as CFDictionary,
            attributes as CFDictionary
        )
        if status == errSecItemNotFound {
            let values = item(account: account, data: authenticated)
            try requireSuccess(SecItemAdd(values as CFDictionary, nil))
        } else {
            try requireSuccess(status)
        }
    }

    func remove(server: String) throws {
        let status = SecItemDelete(query(account: "session:" + server) as CFDictionary)
        if status != errSecItemNotFound { try requireSuccess(status) }
    }

    private func query(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
        ]
    }

    private func item(account: String, data: Data) -> [String: Any] {
        var values = query(account: account)
        values[kSecValueData as String] = data
        values[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return values
    }

    private func read(account: String) throws -> Data? {
        var values = query(account: account)
        values[kSecReturnData as String] = true
        values[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(values as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        try requireSuccess(status)
        guard let data = result as? Data else { throw SessionStorageError(status: errSecDecode) }
        return data
    }

    private func decodeDeviceID(_ data: Data) throws -> String {
        guard let value = String(data: data, encoding: .utf8),
              let uuid = UUID(uuidString: value), uuid.uuidString.lowercased() == value else {
            throw SessionStorageError(status: errSecDecode)
        }
        return value
    }

    private func requireSuccess(_ status: OSStatus) throws {
        if status != errSecSuccess { throw SessionStorageError(status: status) }
    }
}
