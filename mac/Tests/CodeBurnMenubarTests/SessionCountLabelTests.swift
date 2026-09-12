import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("Session count labels and payload decode")
struct SessionCountLabelTests {
    @Test("lower-bound phrasing never names occupancy or cache")
    func phrasing() {
        #expect(SessionCountLabel.text(sessions: 3, basis: "partial") == "At least 3 sessions")
        #expect(SessionCountLabel.text(sessions: 1, basis: "partial") == "At least 1 session")
        #expect(SessionCountLabel.text(sessions: 0, basis: "partial") == "Session count unavailable")
        #expect(SessionCountLabel.text(sessions: 1, basis: "identity") == "1 session")
        #expect(SessionCountLabel.text(sessions: 2, basis: nil) == "At least 2 sessions")
        #expect(!SessionCountLabel.text(sessions: 3, basis: "partial").localizedCaseInsensitiveContains("occupancy"))
        #expect(!SessionCountLabel.text(sessions: 3, basis: "partial").localizedCaseInsensitiveContains("cache"))
        #expect(SessionCountLabel.text(sessions: 0, basis: "identity") == "0 sessions")
    }

    @Test("compact row phrasing marks a bound without spelling it out")
    func compactPhrasing() {
        #expect(SessionCountLabel.compact(sessions: 12, basis: "identity") == "12 sess")
        #expect(SessionCountLabel.compact(sessions: 12, basis: "partial") == "≥12 sess")
        #expect(SessionCountLabel.compact(sessions: 12, basis: nil) == "≥12 sess")
        #expect(SessionCountLabel.compact(sessions: 0, basis: "partial") == "Unavailable")
    }

    @Test("combined-scope copy never presents a device sum as a count")
    func combinedScopeUnavailable() {
        #expect(SessionCountLabel.combinedText == "Session count unavailable")
        #expect(SessionCountLabel.combinedHelp == "Session identities are unavailable across devices.")
        #expect(!SessionCountLabel.combinedText.hasPrefix("At least"))
        #expect(SessionCountLabel.helpText(combined: true, basis: "identity") == SessionCountLabel.combinedHelp)
        #expect(SessionCountLabel.helpText(combined: true, basis: nil) == SessionCountLabel.combinedHelp)
        #expect(SessionCountLabel.helpText(combined: false, basis: "identity") == "")
        #expect(SessionCountLabel.text(sessions: 0, basis: "identity") == "0 sessions")
        #expect(SessionCountLabel.text(sessions: 3, basis: "partial") == "At least 3 sessions")
    }

    @Test("older payloads with a required numeric average still decode")
    func legacyAverageDecodes() throws {
        let json = """
        {"name":"vault","cost":4,"savingsUSD":0,"sessions":2,"avgCostPerSession":2,"sessionDetails":[]}
        """.data(using: .utf8)!
        let row = try JSONDecoder().decode(ProjectEntry.self, from: json)
        #expect(row.sessions == 2)
        #expect(row.avgCostPerSession == 2)
        #expect(row.sessionCountBasis == nil)
        #expect(SessionCountLabel.averageText(row.avgCostPerSession, basis: row.sessionCountBasis, format: { _ in "$2" }) == "—")
    }

    @Test("partial project omits average and keeps the numeric sessions field")
    func partialOmitsAverage() throws {
        let json = """
        {"name":"vault","cost":4,"savingsUSD":0,"sessions":3,"sessionCountBasis":"partial","sessionDetails":[]}
        """.data(using: .utf8)!
        let row = try JSONDecoder().decode(ProjectEntry.self, from: json)
        #expect(row.sessions == 3)
        #expect(row.avgCostPerSession == nil)
        #expect(row.sessionCountBasis == "partial")
        #expect(SessionCountLabel.text(sessions: row.sessions, basis: row.sessionCountBasis) == "At least 3 sessions")
    }

    @Test("headline basis is optional on older current blocks")
    func currentBlockLegacy() throws {
        let json = """
        {"label":"Last 7 days","cost":4,"calls":4,"sessions":1,"oneShotRate":null,"inputTokens":0,"outputTokens":0,"cacheHitPercent":0,"topActivities":[],"topModels":[],"localModelSavings":{"totalUSD":0,"calls":0,"byModel":[],"byProvider":[]},"providers":{},"topProjects":[],"modelEfficiency":[],"topSessions":[],"retryTax":{"totalUSD":0,"retries":0,"editTurns":0,"byModel":[]},"routingWaste":{"totalSavingsUSD":0,"baselineModel":"","baselineCostPerEdit":0,"byModel":[]},"tools":[],"skills":[],"subagents":[],"mcpServers":[]}
        """.data(using: .utf8)!
        let current = try JSONDecoder().decode(CurrentBlock.self, from: json)
        #expect(current.sessions == 1)
        #expect(current.sessionCountBasis == nil)
        #expect(SessionCountLabel.text(sessions: current.sessions, basis: current.sessionCountBasis) == "At least 1 session")
    }
}
