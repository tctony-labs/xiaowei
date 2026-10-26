import Foundation

protocol SessionStore: Sendable {
    func deviceID() async throws -> String
    func load(server: String) async throws -> Data?
    func save(_ authenticated: Data, server: String) async throws
    func remove(server: String) async throws
}

struct SessionStorageError: Error, LocalizedError {
    let status: Int32

    var errorDescription: String? {
        "无法读写登录信息，请重试（\(status)）"
    }
}
