// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "ContractCodec",
    platforms: [.macOS(.v14)],
    dependencies: [.package(path: "../../out/proto-server-swift")],
    targets: [
        .executableTarget(
            name: "ContractCodec",
            dependencies: [.product(name: "ProtoServer", package: "proto-server-swift")]
        )
    ],
    swiftLanguageModes: [.v6]
)
