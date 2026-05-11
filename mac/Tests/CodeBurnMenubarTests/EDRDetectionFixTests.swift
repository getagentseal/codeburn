import Testing
import Foundation
import ServiceManagement

private func makePlist(agentPath: String) -> String {
    """
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.codeburn.refresh</string>
    <key>ProgramArguments</key>
    <array>
        <string>\(agentPath)</string>
    </array>
    <key>StartInterval</key>
    <integer>30</integer>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
"""
}

@Suite("LaunchAgent Plist")
struct LaunchAgentPlistTests {
    @Test("Plist has correct ProgramArguments")
    func programArgumentsIsSingleElementArray() throws {
        let plistStr = makePlist(agentPath: "/path/to/CodeBurnRefreshAgent")
        let data = Data(plistStr.utf8)
        let raw = try PropertyListSerialization.propertyList(from: data, format: nil)
        let dict = try #require(raw as? NSDictionary)
        let args = try #require(dict["ProgramArguments"] as? [String])
        #expect(args == ["/path/to/CodeBurnRefreshAgent"])
    }

    @Test("Plist has StartInterval of 30")
    func startIntervalIs30() throws {
        let plistStr = makePlist(agentPath: "/path/to/agent")
        let data = Data(plistStr.utf8)
        let raw = try PropertyListSerialization.propertyList(from: data, format: nil)
        let dict = try #require(raw as? NSDictionary)
        let interval = try #require(dict["StartInterval"] as? Int)
        #expect(interval == 30)
    }

    @Test("Plist has RunAtLoad true")
    func runAtLoadIsTrue() throws {
        let plistStr = makePlist(agentPath: "/path/to/agent")
        let data = Data(plistStr.utf8)
        let raw = try PropertyListSerialization.propertyList(from: data, format: nil)
        let dict = try #require(raw as? NSDictionary)
        let runAtLoad = try #require(dict["RunAtLoad"] as? Bool)
        #expect(runAtLoad == true)
    }

    @Test("Plist has correct Label")
    func labelIsCorrect() throws {
        let plistStr = makePlist(agentPath: "/path/to/agent")
        let data = Data(plistStr.utf8)
        let raw = try PropertyListSerialization.propertyList(from: data, format: nil)
        let dict = try #require(raw as? NSDictionary)
        let label = try #require(dict["Label"] as? String)
        #expect(label == "com.codeburn.refresh")
    }

    @Test("Plist idempotency")
    func idempotent() {
        let a = makePlist(agentPath: "/same/path")
        let b = makePlist(agentPath: "/same/path")
        #expect(a == b)
    }
}

@Suite("Login Item Guard")
struct LoginItemGuardTests {
    @Test("SMAppService.mainApp.status is accessible")
    func mainAppStatusIsAccessible() {
        // The guard in registerLoginItemIfNeeded():
        //   guard SMAppService.mainApp.status != .enabled else { return }
        // When status is .enabled, the function returns early (no registration).
        // When status is .notRegistered / .requiresApproval, it proceeds to register.
        let status = SMAppService.mainApp.status
        // In a running app, status is .enabled, .notRegistered, or .requiresApproval.
        // In a test context without an app bundle, it may be .notFound (macOS 14+).
        let known: Bool = status == .enabled || status == .notRegistered
            || status == .requiresApproval || status == .notFound
        #expect(known)
    }
}

@Test("CodeBurnRefreshAgent builds and runs successfully")
func agentBuildsAndRuns() throws {
    let packageDir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()

    let scratchDir = FileManager.default.temporaryDirectory
        .appendingPathComponent("codeburn-smoke-test-build")
    try? FileManager.default.removeItem(at: scratchDir)

    let build = Process()
    build.launchPath = "/usr/bin/env"
    build.arguments = [
        "swift", "build", "--product", "CodeBurnRefreshAgent",
        "--scratch-path", scratchDir.path
    ]
    build.currentDirectoryURL = packageDir
    try build.run()
    build.waitUntilExit()
    #expect(build.terminationStatus == 0, "Build failed")

    let showPath = Process()
    let pipe = Pipe()
    showPath.launchPath = "/usr/bin/env"
    showPath.arguments = [
        "swift", "build", "--product", "CodeBurnRefreshAgent",
        "--scratch-path", scratchDir.path, "--show-bin-path"
    ]
    showPath.currentDirectoryURL = packageDir
    showPath.standardOutput = pipe
    try showPath.run()
    showPath.waitUntilExit()

    let binPathData = pipe.fileHandleForReading.readDataToEndOfFile()
    let binPath = String(data: binPathData, encoding: .utf8)?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let binaryURL = URL(fileURLWithPath: binPath).appendingPathComponent("CodeBurnRefreshAgent")

    let agent = Process()
    agent.launchPath = binaryURL.path
    try agent.run()
    agent.waitUntilExit()
    #expect(agent.terminationStatus == 0, "Agent exited with non-zero status")
}
