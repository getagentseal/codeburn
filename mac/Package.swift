// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CodeBurnMenubar",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "CodeBurnMenubar", targets: ["CodeBurnMenubar"]),
        .executable(name: "CodeBurnRefreshAgent", targets: ["CodeBurnRefreshAgent"])
    ],
    targets: [
        .executableTarget(
            name: "CodeBurnMenubar",
            path: "Sources/CodeBurnMenubar",
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency")
            ]
        ),
        .executableTarget(
            name: "CodeBurnRefreshAgent",
            path: "Sources/CodeBurnRefreshAgent"
        ),
        .testTarget(
            name: "CodeBurnMenubarTests",
            dependencies: ["CodeBurnMenubar"],
            path: "Tests/CodeBurnMenubarTests"
        )
    ]
)
