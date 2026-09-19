import AppKit
import SwiftUI
import Testing
@testable import CodeBurnMenubar

/// Offscreen render checks for the Models section's unpriced line (#1420):
/// one secondary line naming the usage the cost floor hid — models whose
/// recorded usage prices at $0 for lack of pricing data. Same harness as the
/// token-line suite: ImageRenderer renders the section itself at the real
/// 360pt popover width, payloads are injected through the AppStore testing
/// hooks, and refreshes are suppressed. No status item, no popover, no CLI.
/// This is fixture / native-view evidence — NOT installed-app validation.
@Suite("Models section unpriced line")
@MainActor
struct ModelsSectionUnpricedLineTests {

    // MARK: - Fixtures

    /// The shape the issue documented: a day whose largest line by tokens
    /// never made the cost table, because it prices at $0.
    private static func payload(unpriced: [UnpricedModelEntry]) -> MenubarPayload {
        MenubarPayload(
            generated: "2026-09-18T00:00:00Z",
            current: CurrentBlock(
                label: "Today",
                cost: 38.2,
                calls: 509,
                sessions: 6,
                oneShotRate: 0.74,
                inputTokens: 18_600_000,
                outputTokens: 4_500_000,
                cacheHitPercent: 63.4,
                codexCredits: 0,
                topActivities: [],
                topModels: [
                    ModelEntry(name: "Claude Opus 4.8", cost: 38.2, savingsUSD: 0, savingsBaselineModel: "", calls: 421,
                               inputTokens: 18_600_000, outputTokens: 4_500_000, cacheReadTokens: 0, cacheWriteTokens: 0),
                ],
                localModelSavings: LocalModelSavings(totalUSD: 0, calls: 0, byModel: [], byProvider: []),
                providers: [:],
                topProjects: [],
                modelEfficiency: [],
                topSessions: [],
                retryTax: RetryTax(totalUSD: 0, retries: 0, editTurns: 0, byModel: []),
                routingWaste: RoutingWaste(totalSavingsUSD: 0, baselineModel: "", baselineCostPerEdit: 0, byModel: []),
                tools: [],
                skills: [],
                subagents: [],
                mcpServers: [],
                unpricedModels: unpriced
            ),
            optimize: OptimizeBlock(findingCount: 0, savingsUSD: 0, topFindings: []),
            history: HistoryBlock(daily: []),
            combined: nil
        )
    }

    // MARK: - Harness

    private func makeStore(payload: MenubarPayload) -> AppStore {
        let store = AppStore()
        store.setCacheDateToTodayForTesting()
        store.suppressRefreshesForTesting()
        store.menuPopoverVisible = true
        // Pin the whole selection: saved menubar defaults must not decide what
        // a fixture render shows.
        store.selectedScope = .local
        store.selectedPeriod = .today
        store.selectedProvider = .all
        store.selectedDays = []
        store.selectedClaudeConfigSourceId = nil
        store.setCachedPayloadForTesting(payload, period: .today, provider: .all, fetchedAt: Date())
        // The popover renders its cold-cache overlay unless the store actually
        // serves the fixture from `payload`.
        if store.payload.current.cost != payload.current.cost {
            Issue.record("store failed to serve the fixture payload for the current key")
        }
        return store
    }

    /// Section-only render at the real popover width. ImageRenderer sizes its
    /// bitmap to the content, so the image's dimensions are the section's
    /// fitted size; returned in points by dividing out the 2x scale.
    @discardableResult
    private func renderSection(name: String, store: AppStore) throws -> CGSize {
        let renderer = ImageRenderer(content: ModelsSection()
            .environment(store)
            .environment(\.colorScheme, .dark)
            .frame(width: 360))
        renderer.scale = 2
        let cgImage = try #require(renderer.cgImage, "ImageRenderer produced no image for section \(name)")
        let scale = renderer.scale
        return CGSize(width: CGFloat(cgImage.width) / scale, height: CGFloat(cgImage.height) / scale)
    }

    // MARK: - Tests

    @Test("the unpriced line renders when the payload carries unpriced models, and hides otherwise")
    func lineRendersWithUnpricedModels() throws {
        let withUnpriced = try renderSection(
            name: "unpriced-present",
            store: makeStore(payload: Self.payload(unpriced: [
                UnpricedModelEntry(model: "acme/routed-claude", calls: 88, tokens: 429_100_000),
            ]))
        )
        let without = try renderSection(
            name: "unpriced-absent",
            store: makeStore(payload: Self.payload(unpriced: []))
        )
        // One secondary 10.5pt line plus its 3pt top padding; 8pt is the
        // conservative floor, the same margin the token-line suite uses.
        #expect(withUnpriced.height > without.height + 8)
    }

    @Test("older payloads without the block decode with the line hidden")
    func olderPayloadsDecode() throws {
        func decode(_ json: String) throws -> MenubarPayload {
            try JSONDecoder().decode(MenubarPayload.self, from: Data(json.utf8))
        }
        // The pre-#1420 shape: no unpricedModels key anywhere, so the line
        // must stay hidden rather than fail the payload.
        let legacy = try decode(#"""
        {"generated":"2026-09-18T00:00:00Z","current":{"label":"Today","cost":1,"calls":1,"sessions":1,"inputTokens":1,"outputTokens":1,"cacheHitPercent":0,"topActivities":[],"topModels":[],"localModelSavings":{"totalUSD":0,"calls":0,"byModel":[],"byProvider":[]},"providers":{},"topProjects":[],"modelEfficiency":[],"topSessions":[],"retryTax":{"totalUSD":0,"retries":0,"editTurns":0,"byModel":[]},"routingWaste":{"totalSavingsUSD":0,"baselineModel":"","baselineCostPerEdit":0,"byModel":[]},"tools":[],"skills":[],"subagents":[],"mcpServers":[]},"optimize":{"findingCount":0,"savingsUSD":0,"topFindings":[]},"history":{"daily":[]}}
        """#)
        #expect(legacy.current.unpricedModels.isEmpty)

        let withBlock = try decode(#"""
        {"generated":"2026-09-18T00:00:00Z","current":{"label":"Today","cost":1,"calls":1,"sessions":1,"inputTokens":1,"outputTokens":1,"cacheHitPercent":0,"topActivities":[],"topModels":[],"localModelSavings":{"totalUSD":0,"calls":0,"byModel":[],"byProvider":[]},"providers":{},"topProjects":[],"modelEfficiency":[],"topSessions":[],"retryTax":{"totalUSD":0,"retries":0,"editTurns":0,"byModel":[]},"routingWaste":{"totalSavingsUSD":0,"baselineModel":"","baselineCostPerEdit":0,"byModel":[]},"tools":[],"skills":[],"subagents":[],"mcpServers":[],"unpricedModels":[{"model":"acme/x","calls":2,"tokens":300}]},"optimize":{"findingCount":0,"savingsUSD":0,"topFindings":[]},"history":{"daily":[]}}
        """#)
        #expect(withBlock.current.unpricedModels == [UnpricedModelEntry(model: "acme/x", calls: 2, tokens: 300)])
    }
}
