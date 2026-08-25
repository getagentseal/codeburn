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
}
