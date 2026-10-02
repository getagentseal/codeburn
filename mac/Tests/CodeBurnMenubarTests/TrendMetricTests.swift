import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("Trend metric toggle")
struct TrendMetricTests {
    @Test("defaults to cost when the toggle hasn't been switched")
    func defaultsToCost() {
        #expect(trendUsesTokens(showTokens: false, totalTokens: 500) == false)
    }

    @Test("tokens chosen with token data present uses tokens")
    func tokensChosenWithData() {
        #expect(trendUsesTokens(showTokens: true, totalTokens: 500) == true)
    }

    @Test("tokens chosen but no token data (per-provider history) falls back to cost")
    func tokensChosenWithoutData() {
        #expect(trendUsesTokens(showTokens: true, totalTokens: 0) == false)
    }

    /// `@AppStorage` reads its initial value from the property's own default
    /// literal, which a test can't observe without touching real
    /// `UserDefaults`. Guards the literal in source instead, so a future edit
    /// can't silently flip the trend chart to opening on tokens.
    @Test("codeburn.trendShowsTokens defaults to false in source")
    func appStorageKeyDefaultsToFalse() throws {
        let file = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // CodeBurnMenubarTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // mac
            .appendingPathComponent("Sources/CodeBurnMenubar/Views/HeatmapSection.swift")
        let source = try String(contentsOf: file, encoding: .utf8)
        #expect(source.contains(#"@AppStorage("codeburn.trendShowsTokens") private var showTokens = false"#))
    }
}
