import XCTest
@testable import CodeBurnMenubar

final class DataClientDecodeErrorTests: XCTestCase {
    func testDecodeFailureMessageIncludesStdoutPreviewAndStderr() async throws {
        let stdoutBanner = "NODE_V25_STDOUT_BANNER leaked before JSON"
        let stderrText = "stderr marker: node emitted diagnostics"

        try await withFakeCodeburn(stdout: "\(stdoutBanner)\n\(validMenubarJSON())", stderr: stderrText) {
            do {
                _ = try await DataClient.fetch(period: .today, provider: .all, includeOptimize: false)
                XCTFail("Expected menubar payload decode to fail")
            } catch {
                let message = String(describing: error)
                XCTAssertTrue(message.contains(stdoutBanner), "message did not include stdout preview: \(message)")
                XCTAssertTrue(message.contains(stderrText), "message did not include stderr: \(message)")
            }
        }
    }

    func testDecodeFailureStdoutPreviewIsCappedAtFourKilobytes() async throws {
        let stdoutHead = "CAP_START_STDOUT_515"
        let stdoutTail = "CAP_TAIL_SHOULD_NOT_APPEAR"
        let largeStdout = stdoutHead
            + String(repeating: "A", count: 5_000)
            + stdoutTail
            + "\n"
            + validMenubarJSON()
        let stderrText = "stderr marker: cap diagnostics"

        try await withFakeCodeburn(stdout: largeStdout, stderr: stderrText) {
            do {
                _ = try await DataClient.fetch(period: .today, provider: .all, includeOptimize: false)
                XCTFail("Expected menubar payload decode to fail")
            } catch {
                let message = String(describing: error)
                XCTAssertTrue(message.contains(stdoutHead), "message did not include start of stdout preview: \(message)")
                XCTAssertTrue(message.contains(stderrText), "message did not include stderr: \(message)")
                XCTAssertFalse(message.contains(stdoutTail), "message embedded stdout beyond the 4 KB preview cap")
            }
        }
    }

    private func withFakeCodeburn(stdout: String, stderr: String, body: () async throws -> Void) async throws {
        let fakeURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("codeburn-fake-\(UUID().uuidString)")
        let script = """
        #!/bin/sh
        cat <<'CODEBURN_STDOUT_EOF'
        \(stdout)
        CODEBURN_STDOUT_EOF
        cat >&2 <<'CODEBURN_STDERR_EOF'
        \(stderr)
        CODEBURN_STDERR_EOF
        exit 0
        """
        try script.write(to: fakeURL, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: fakeURL.path)

        let previousAllow = getenv("CODEBURN_ALLOW_DEV_BIN").map { String(cString: $0) }
        let previousBin = getenv("CODEBURN_BIN").map { String(cString: $0) }
        setenv("CODEBURN_ALLOW_DEV_BIN", "1", 1)
        setenv("CODEBURN_BIN", fakeURL.path, 1)
        defer {
            restoreEnv("CODEBURN_ALLOW_DEV_BIN", previousAllow)
            restoreEnv("CODEBURN_BIN", previousBin)
            try? FileManager.default.removeItem(at: fakeURL)
        }

        try await body()
    }

    private func restoreEnv(_ name: String, _ value: String?) {
        if let value {
            setenv(name, value, 1)
        } else {
            unsetenv(name)
        }
    }

    private func validMenubarJSON() -> String {
        """
        {"generated":"2026-06-22T00:00:00Z","current":{"label":"Today","cost":0,"calls":0,"sessions":0,"oneShotRate":null,"inputTokens":0,"outputTokens":0,"cacheHitPercent":0,"codexCredits":0,"topActivities":[],"topModels":[],"localModelSavings":{"totalUSD":0,"calls":0,"byModel":[],"byProvider":[]},"providers":{},"topProjects":[],"modelEfficiency":[],"topSessions":[],"retryTax":{"totalUSD":0,"retries":0,"editTurns":0,"byModel":[]},"routingWaste":{"totalSavingsUSD":0,"baselineModel":"","baselineCostPerEdit":0,"byModel":[]},"tools":[],"skills":[],"subagents":[],"mcpServers":[]},"optimize":{"findingCount":0,"savingsUSD":0,"topFindings":[]},"history":{"daily":[]}}
        """
    }
}
