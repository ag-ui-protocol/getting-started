// swift-tools-version: 5.9
// The swift-tools-version declares the minimum version of Swift required to build this package.

import PackageDescription

let package = Package(
    name: "AGUISwift",
    platforms: [
        .iOS(.v16),
        .macOS(.v13),
    ],
    products: [
        .library(
            name: "AGUICore",
            targets: ["AGUICore"]),
        .library(
            name: "AGUIClient",
            targets: ["AGUIClient"]),
        .library(
            name: "AGUIAgentSDK",
            targets: ["AGUIAgentSDK"]),
        .library(
            name: "AGUITools",
            targets: ["AGUITools"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-docc-plugin", from: "1.0.0"),
    ],
    targets: [
        .target(
            name: "AGUICore",
            dependencies: []),
        .target(
            name: "AGUIClient",
            dependencies: ["AGUICore"]),
        .target(
            name: "AGUIAgentSDK",
            dependencies: ["AGUICore", "AGUIClient", "AGUITools"]),
        .target(
            name: "AGUITools",
            dependencies: ["AGUICore"]),
        .testTarget(
            name: "AGUICoreTests",
            dependencies: ["AGUICore"]),
        .testTarget(
            name: "AGUIClientTests",
            dependencies: ["AGUIClient"]),
        .testTarget(
            name: "AGUIAgentSDKTests",
            dependencies: ["AGUIAgentSDK", "AGUIClient", "AGUITools"]),
        .testTarget(
            name: "AGUIToolsTests",
            dependencies: ["AGUITools"]),
    ]
)

