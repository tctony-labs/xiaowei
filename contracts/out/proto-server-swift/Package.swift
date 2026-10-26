// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "ProtoServer",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "ProtoServer", targets: ["ProtoServer"])
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-protobuf.git", exact: "1.39.0")
    ],
    targets: [
        .target(
            name: "ProtoServer",
            dependencies: [.product(name: "SwiftProtobuf", package: "swift-protobuf")]
        )
    ],
    swiftLanguageModes: [.v6]
)
