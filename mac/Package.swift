// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CodeBurnMenubar",
    platforms: [
        // macOS 14 (Sonoma) is the floor: matches Info.plist LSMinimumSystemVersion,
        // the CLI install guard (MIN_MACOS_MAJOR=14), and mac/README. The earlier .v15
        // bump for NSAttributedString(attachment:) was a misdiagnosis, that initializer
        // is AppKit since macOS 10.0, so the binary's minos must not exclude Sonoma users.
        .macOS(.v14)
    ],
    products: [
        .executable(name: "CodeBurnMenubar", targets: ["CodeBurnMenubar"])
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
            dependencies: ["CodeBurnMenubar"],
            path: "Tests/CodeBurnMenubarTests"
        )
    ]
)
