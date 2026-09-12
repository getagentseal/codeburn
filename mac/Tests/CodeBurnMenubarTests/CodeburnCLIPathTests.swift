import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("CodeburnCLI PATH")
struct CodeburnCLIPathTests {
    @Test("Spotlight-minimal PATH can launch a mise npm-backend CLI")
    func spotlightCanLaunchMiseCLI() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("CodeburnCLIPathTests-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let home = root.appendingPathComponent("home", isDirectory: true)
        let wrapper = home
            .appendingPathComponent(".local/share/mise/installs/npm-codeburn/latest/node_modules/.bin/codeburn")
        let nodeShim = home.appendingPathComponent(".local/share/mise/shims/node")
        try FileManager.default.createDirectory(
            at: wrapper.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try FileManager.default.createDirectory(
            at: nodeShim.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try "#!/bin/sh\nexec node \"$@\"\n".write(to: wrapper, atomically: true, encoding: .utf8)
        try "#!/bin/sh\nprintf 'mise-node-ok\\n'\n".write(to: nodeShim, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: wrapper.path)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: nodeShim.path)

        let augmentedPath = CodeburnCLI.augmentedPath(
            "/usr/bin:/bin",
            homeDirectory: home.path,
            environment: [:]
        )
        // Keep the behavior fixture independent of tools installed on the CI host.
        // Every retained entry came from the production augmentation above.
        let isolatedPath = augmentedPath
            .split(separator: ":")
            .map(String.init)
            .filter { $0 == "/usr/bin" || $0 == "/bin" || $0.hasPrefix(home.path + "/") }
            .joined(separator: ":")
        #expect(isolatedPath.split(separator: ":").contains(Substring(nodeShim.deletingLastPathComponent().path)))

        let process = Process()
        let stdout = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["--", wrapper.path, "--version"]
        process.environment = [
            "HOME": home.path,
            "PATH": isolatedPath,
        ]
        process.standardOutput = stdout
        process.standardError = Pipe()

        try process.run()
        process.waitUntilExit()
        let output = String(decoding: stdout.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)

        #expect(process.terminationStatus == 0)
        #expect(output == "mise-node-ok\n")
    }

    @Test("custom mise data directory is added once")
    func customMiseDataDirectoryIsDeduplicated() {
        let customShims = "/Volumes/Tools/mise/shims"
        let path = CodeburnCLI.augmentedPath(
            "/usr/bin:\(customShims)",
            homeDirectory: "/Users/test",
            environment: ["MISE_DATA_DIR": "/Volumes/Tools/mise"]
        )

        #expect(path.split(separator: ":").filter { $0 == Substring(customShims) }.count == 1)
    }

    @Test("Spotlight-minimal PATH can launch a CLI whose only node is a Nix profile")
    func spotlightCanLaunchNixCLI() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("CodeburnCLIPathTests-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let home = root.appendingPathComponent("home", isDirectory: true)
        let wrapper = home.appendingPathComponent(".local/bin/codeburn")
        let nodeBin = home.appendingPathComponent(".nix-profile/bin/node")
        try FileManager.default.createDirectory(
            at: wrapper.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try FileManager.default.createDirectory(
            at: nodeBin.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        // Mirrors the real shim, which resolves `node` through PATH via `#!/usr/bin/env node`.
        try "#!/bin/sh\nexec node \"$@\"\n".write(to: wrapper, atomically: true, encoding: .utf8)
        try "#!/bin/sh\nprintf 'nix-node-ok\\n'\n".write(to: nodeBin, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: wrapper.path)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: nodeBin.path)

        let augmentedPath = CodeburnCLI.augmentedPath(
            "/usr/bin:/bin",
            homeDirectory: home.path,
            environment: [:]
        )
        // Keep the behavior fixture independent of tools installed on the CI host.
        // Every retained entry came from the production augmentation above.
        let isolatedPath = augmentedPath
            .split(separator: ":")
            .map(String.init)
            .filter { $0 == "/usr/bin" || $0 == "/bin" || $0.hasPrefix(home.path + "/") }
            .joined(separator: ":")

        let process = Process()
        let stdout = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["--", wrapper.path, "--version"]
        process.environment = [
            "HOME": home.path,
            "PATH": isolatedPath,
        ]
        process.standardOutput = stdout
        process.standardError = Pipe()

        try process.run()
        process.waitUntilExit()
        let output = String(decoding: stdout.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)

        #expect(process.terminationStatus == 0)
        #expect(output == "nix-node-ok\n")
    }

    @Test("nix-darwin per-user profile is derived from the home directory")
    func nixDarwinPerUserProfileIsIncluded() {
        let path = CodeburnCLI.augmentedPath(
            "/usr/bin:/bin",
            homeDirectory: "/Users/test",
            environment: [:]
        )
        let entries = path.split(separator: ":").map(String.init)

        #expect(entries.contains("/etc/profiles/per-user/test/bin"))
        #expect(entries.contains("/run/current-system/sw/bin"))
    }

    /// Regression: the app picked up whichever `node` came first on the inherited
    /// PATH, so an nvm default of v20 shadowed the v24 that installed the CLI and
    /// every refresh failed with "codeburn requires Node.js >= 22.13.0".
    @Test("interpreter beside the CLI wins over an older node on PATH")
    func siblingNodeIsPreferredOverInheritedPath() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("CodeburnCLIPathTests-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let newBin = root.appendingPathComponent("node/v24/bin", isDirectory: true)
        let oldBin = root.appendingPathComponent("node/v20/bin", isDirectory: true)
        try FileManager.default.createDirectory(at: newBin, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: oldBin, withIntermediateDirectories: true)
        for bin in [newBin, oldBin] {
            let node = bin.appendingPathComponent("node")
            try "#!/bin/sh\n".write(to: node, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: node.path)
        }

        let path = CodeburnCLI.augmentedPath(
            "\(oldBin.path):/usr/bin:/bin",
            homeDirectory: root.appendingPathComponent("home").path,
            environment: [:],
            resolvedCLI: newBin.appendingPathComponent("codeburn").path
        )
        let entries = path.split(separator: ":").map(String.init)

        #expect(entries.first == newBin.path)
        #expect(entries.firstIndex(of: newBin.path)! < entries.firstIndex(of: oldBin.path)!)
        // The stale entry still has to survive: it is where the rest of that
        // toolchain lives, it just no longer decides which node runs.
        #expect(entries.contains(oldBin.path))
    }

    @Test("a CLI directory already on PATH is promoted, not duplicated")
    func siblingNodeDirectoryIsNotDuplicated() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("CodeburnCLIPathTests-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let bin = root.appendingPathComponent("bin", isDirectory: true)
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        let node = bin.appendingPathComponent("node")
        try "#!/bin/sh\n".write(to: node, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: node.path)

        let path = CodeburnCLI.augmentedPath(
            "/usr/bin:\(bin.path):/bin",
            homeDirectory: root.appendingPathComponent("home").path,
            environment: [:],
            resolvedCLI: bin.appendingPathComponent("codeburn").path
        )
        let entries = path.split(separator: ":").map(String.init)

        #expect(entries.first == bin.path)
        #expect(entries.filter { $0 == bin.path }.count == 1)
    }

    /// A bare `codeburn` (PATH lookup) or a directory with no interpreter beside it
    /// must leave the inherited order untouched -- reordering PATH on a guess would
    /// change which tools every other lookup resolves to.
    @Test("PATH order is untouched when there is no sibling interpreter")
    func inheritedOrderSurvivesWithoutSiblingNode() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("CodeburnCLIPathTests-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let bin = root.appendingPathComponent("bin", isDirectory: true)
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)

        for cli in [bin.appendingPathComponent("codeburn").path, "codeburn"] {
            let path = CodeburnCLI.augmentedPath(
                "/usr/bin:/bin",
                homeDirectory: root.appendingPathComponent("home").path,
                environment: [:],
                resolvedCLI: cli
            )
            let entries = path.split(separator: ":").map(String.init)
            #expect(entries.first == "/usr/bin")
            #expect(entries.dropFirst().first == "/bin")
            #expect(!entries.contains(bin.path))
        }
    }
}
