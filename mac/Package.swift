// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CodeBurnMenubar",
    // English is the development language: every key in Localizable.strings *is*
    // its English copy, so a key with no translation renders as correct English
    // instead of a dotted identifier. Declaring it here is also what lets SwiftPM
    // treat Resources/<locale>.lproj as localized resources at all.
    defaultLocalization: "en",
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
            resources: [
                .process("Resources/ProviderIcons"),
                // Emitted into the target resource bundle as `<locale>.lproj/
                // Localizable.strings`, which is the layout NSBundle needs to
                // resolve a table per localization. Lookups go through
                // `L(_:)` / `Bundle.module`, never `Bundle.main`: the strings
                // live in the SwiftPM resource bundle inside Contents/Resources,
                // not at the app bundle's resource root.
                .process("Resources/en.lproj"),
                .process("Resources/zh-Hans.lproj")
            ],
            swiftSettings: [
                .enableUpcomingFeature("StrictConcurrency")
            ],
            linkerSettings: [
                .linkedLibrary("sqlite3")
            ]
        ),
        .testTarget(
            name: "CodeBurnMenubarTests",
            dependencies: ["CodeBurnMenubar"],
            path: "Tests/CodeBurnMenubarTests",
            linkerSettings: [
                .linkedLibrary("sqlite3")
            ]
        )
    ]
)
