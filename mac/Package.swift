// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CodeBurnMenubar",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "CodeBurnMenubar", targets: ["CodeBurnMenubar"])
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-testing.git", from: "6.2.3")
    ],
    targets: [
        .executableTarget(
            name: "CodeBurnMenubar",
            path: "Sources/CodeBurnMenubar",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency")
            ]
        ),
        .testTarget(
            name: "CodeBurnMenubarTests",
            dependencies: [
                "CodeBurnMenubar",
                .product(name: "Testing", package: "swift-testing")
            ],
            path: "Tests/CodeBurnMenubarTests"
        )
    ]
)
