import Foundation
import ProtoServer

struct AppConfiguration: Sendable {
    let server: String
    let keychainService: String
    let deviceID: String?
    let seed: Data?

    static func load() async throws -> Self {
        #if DEBUG
        let process = ProcessInfo.processInfo
        let arguments = process.arguments
        if let index = arguments.firstIndex(of: "--fixture-control"),
           arguments.indices.contains(index + 1),
           let base = URL(string: arguments[index + 1]) {
            var request = URLRequest(url: base.appendingPathComponent("bootstrap"))
            request.timeoutInterval = 15
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                throw URLError(.badServerResponse)
            }
            struct Bootstrap: Decodable {
                let server: String
                let samples: [String: String]
            }
            let bootstrap = try JSONDecoder().decode(Bootstrap.self, from: data)
            guard let encoded = bootstrap.samples["valid"],
                  let sample = Data(base64Encoded: encoded) else {
                throw URLError(.cannotDecodeContentData)
            }
            let authenticated = try Xiaowei_Server_Authenticated(serializedBytes: sample)
            return Self(
                server: bootstrap.server,
                keychainService: "com.tctony.xiaowei.ios.tests." + base.lastPathComponent,
                deviceID: authenticated.device.deviceID,
                seed: arguments.contains("--account-fixture") ? nil : sample
            )
        }
        if arguments.contains("--verification-public")
            || process.environment["XCTestConfigurationFilePath"] != nil {
            return Self(
                server: "https://xiaowei.tctony.com",
                keychainService: "com.tctony.xiaowei.ios.tests.public",
                deviceID: nil,
                seed: nil
            )
        }
        #endif
        return Self(
            server: "https://xiaowei.tctony.com",
            keychainService: "com.tctony.xiaowei.ios.session",
            deviceID: nil,
            seed: nil
        )
    }
}
