import Foundation
import Testing
@testable import CodeBurnMenubar

/// Builds a minimal-but-valid MenubarPayload with `daily` populated to a given length so tests
/// can exercise the post-decode array-length guards without constructing hundreds of fields.
private func payload(with dailyCount: Int, topModelsPerEntry: Int = 0, billing: BillingInfo? = nil) -> MenubarPayload {
    let entry = DailyHistoryEntry(
        date: "2026-04-19",
        cost: 0,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        topModels: Array(
            repeating: DailyModelBreakdown(name: "m", cost: 0, calls: 0, inputTokens: 0, outputTokens: 0),
            count: topModelsPerEntry
        )
    )
    return MenubarPayload(
        generated: "",
        billing: billing,
        current: CurrentBlock(
            label: "", cost: nil, calls: 0, sessions: 0, oneShotRate: nil,
            inputTokens: 0, outputTokens: 0, cacheHitPercent: 0,
            topActivities: [], topModels: [], providers: [:]
        ),
        optimize: OptimizeBlock(findingCount: 0, savingsUSD: 0, topFindings: []),
        history: HistoryBlock(daily: Array(repeating: entry, count: dailyCount))
    )
}

@Suite("DataClient -- payload bounds")
struct DataClientBoundsTests {
    @Test("accepts a payload within every per-array cap")
    func acceptsWithinBounds() throws {
        try DataClient.validatePayloadBounds(payload(with: 400, topModelsPerEntry: 64))
    }

    @Test("rejects history.daily longer than cap")
    func rejectsOversizedDaily() {
        #expect(throws: DataClientError.self) {
            try DataClient.validatePayloadBounds(payload(with: 401))
        }
    }

    @Test("rejects an oversized nested topModels array")
    func rejectsOversizedTopModels() {
        #expect(throws: DataClientError.self) {
            try DataClient.validatePayloadBounds(payload(with: 1, topModelsPerEntry: 65))
        }
    }

    @Test("rejects oversized current.topActivities")
    func rejectsOversizedActivities() {
        let base = payload(with: 0)
        let oversizeActivities = Array(
            repeating: ActivityEntry(name: "a", cost: 0, turns: 0, oneShotRate: nil),
            count: 65
        )
        let poisoned = MenubarPayload(
            generated: base.generated,
            billing: base.billing,
            current: CurrentBlock(
                label: "", cost: nil, calls: 0, sessions: 0, oneShotRate: nil,
                inputTokens: 0, outputTokens: 0, cacheHitPercent: 0,
                topActivities: oversizeActivities,
                topModels: [],
                providers: [:]
            ),
            optimize: base.optimize,
            history: base.history
        )
        #expect(throws: DataClientError.self) {
            try DataClient.validatePayloadBounds(poisoned)
        }
    }
}

// MARK: - Billing Mode Tests

@Suite("Billing mode detection")
struct BillingModeTests {
    @Test("defaults to legacy mode when billing block absent")
    func legacyModeDefault() {
        let p = payload(with: 0, billing: nil)
        #expect(p.billingMode == .legacy)
    }

    @Test("detects credits mode from billing block")
    func creditsMode() {
        let billing = BillingInfo(mode: .credits, creditsPerDollar: 1600, surchargeRate: nil)
        let p = payload(with: 0, billing: billing)
        #expect(p.billingMode == .credits)
    }

    @Test("detects token_plus mode from billing block")
    func tokenPlusMode() {
        let billing = BillingInfo(mode: .tokenPlus, creditsPerDollar: nil, surchargeRate: 0.3)
        let p = payload(with: 0, billing: billing)
        #expect(p.billingMode == .tokenPlus)
    }
}

@Suite("Billing JSON decoding")
struct BillingDecodingTests {

    @Test("decodes credits mode JSON with all fields")
    func decodeCreditsMode() throws {
        let json = """
        {
            "generated": "2026-04-20T12:00:00Z",
            "billing": {
                "mode": "credits",
                "creditsPerDollar": 1600
            },
            "current": {
                "label": "Today",
                "cost": null,
                "calls": 42,
                "sessions": 5,
                "oneShotRate": 0.75,
                "inputTokens": 10000,
                "outputTokens": 5000,
                "cacheHitPercent": 45.5,
                "creditsAugment": 12345,
                "creditsSynthesized": 500,
                "topActivities": [],
                "topModels": [
                    {"name": "claude-sonnet-4-20250514", "cost": null, "calls": 10, "creditsAugment": 5000}
                ],
                "providers": {}
            },
            "optimize": {"findingCount": 0, "savingsUSD": 0, "topFindings": []},
            "history": {"daily": []}
        }
        """
        let data = json.data(using: .utf8)!
        let payload = try JSONDecoder().decode(MenubarPayload.self, from: data)

        #expect(payload.billingMode == .credits)
        #expect(payload.billing?.creditsPerDollar == 1600)
        #expect(payload.current.cost == nil)
        #expect(payload.current.creditsAugment == 12345)
        #expect(payload.current.creditsSynthesized == 500)
        #expect(payload.current.topModels.first?.creditsAugment == 5000)
        #expect(payload.current.topModels.first?.cost == nil)
    }

    @Test("decodes token_plus mode JSON with all fields")
    func decodeTokenPlusMode() throws {
        let json = """
        {
            "generated": "2026-04-20T12:00:00Z",
            "billing": {
                "mode": "token_plus",
                "surchargeRate": 0.3
            },
            "current": {
                "label": "Today",
                "cost": 13.00,
                "calls": 42,
                "sessions": 5,
                "oneShotRate": 0.75,
                "inputTokens": 10000,
                "outputTokens": 5000,
                "cacheHitPercent": 45.5,
                "baseCostUsd": 10.00,
                "surchargeUsd": 3.00,
                "billedAmountUsd": 13.00,
                "topActivities": [],
                "topModels": [
                    {"name": "claude-sonnet-4-20250514", "cost": 6.50, "calls": 10, "baseCostUsd": 5.00, "billedAmountUsd": 6.50}
                ],
                "providers": {}
            },
            "optimize": {"findingCount": 0, "savingsUSD": 0, "topFindings": []},
            "history": {"daily": []}
        }
        """
        let data = json.data(using: .utf8)!
        let payload = try JSONDecoder().decode(MenubarPayload.self, from: data)

        #expect(payload.billingMode == .tokenPlus)
        #expect(payload.billing?.surchargeRate == 0.3)
        #expect(payload.current.cost == 13.00)
        #expect(payload.current.baseCostUsd == 10.00)
        #expect(payload.current.surchargeUsd == 3.00)
        #expect(payload.current.billedAmountUsd == 13.00)
        #expect(payload.current.topModels.first?.baseCostUsd == 5.00)
        #expect(payload.current.topModels.first?.billedAmountUsd == 6.50)
    }

    @Test("decodes legacy JSON (no billing block) with backwards compat")
    func decodeLegacyMode() throws {
        let json = """
        {
            "generated": "2026-04-20T12:00:00Z",
            "current": {
                "label": "Today",
                "cost": 25.50,
                "calls": 42,
                "sessions": 5,
                "oneShotRate": 0.75,
                "inputTokens": 10000,
                "outputTokens": 5000,
                "cacheHitPercent": 45.5,
                "topActivities": [],
                "topModels": [
                    {"name": "claude-sonnet-4-20250514", "cost": 12.50, "calls": 10}
                ],
                "providers": {}
            },
            "optimize": {"findingCount": 0, "savingsUSD": 0, "topFindings": []},
            "history": {"daily": []}
        }
        """
        let data = json.data(using: .utf8)!
        let payload = try JSONDecoder().decode(MenubarPayload.self, from: data)

        #expect(payload.billingMode == .legacy)
        #expect(payload.billing == nil)
        #expect(payload.current.cost == 25.50)
        #expect(payload.current.creditsAugment == nil)
        #expect(payload.current.topModels.first?.cost == 12.50)
    }
}
