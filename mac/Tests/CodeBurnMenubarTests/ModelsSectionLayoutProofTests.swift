import AppKit
import SwiftUI
import Testing
@testable import CodeBurnMenubar

/// Native layout proof for the Models section's per-model token line, rendered
/// through NSHostingView in an offscreen window at the popover's REAL 360pt
/// width using the actual popover root (`MenuBarContent`), so every horizontal
/// padding that affects a row is present. No status item is created, no
/// popover is shown, nothing is ordered onto the screen, and no CLI is
/// invoked: payloads are injected through the AppStore testing hooks and
/// refreshes are suppressed.
///
/// When `CODEBURN_LAYOUT_PROOF_DIR` is set, each variant is written there as a
/// 2x PNG (the review evidence artifacts). The suite always renders through a
/// real AppKit layout pass and asserts the image comes out; PNG writing is a
/// best-effort side effect.
/// This is fixture / native-view evidence — NOT installed-app validation.
@Suite("Models section layout proof")
@MainActor
struct ModelsSectionLayoutProofTests {

    // MARK: - Fixtures

    /// Cost-descending model rows the way `buildTopModels` emits them: a long
    /// display name with savings, a ≥1B cache-read count, a known-zero row,
    /// and a legacy row that predates the counts (secondary line hidden).
    private static func savingsPresentPayload() -> MenubarPayload {
        payload(topModels: [
            ModelEntry(name: "Gemini 3.7 Flash Thinking (Preview Channel)", cost: 84.7, savingsUSD: 12.4, savingsBaselineModel: "", calls: 3311,
                       inputTokens: 152_300_456, outputTokens: 40_234_112, cacheReadTokens: 1_180_456_789, cacheWriteTokens: 46_112_003),
            ModelEntry(name: "gpt-6-astra", cost: 51.2, savingsUSD: 0, savingsBaselineModel: "", calls: 8455,
                       inputTokens: 33_624_660, outputTokens: 5_018_920, cacheReadTokens: 12_345_678_901, cacheWriteTokens: 0),
            ModelEntry(name: "Llama Local", cost: 0, savingsUSD: 9.9, savingsBaselineModel: "", calls: 82,
                       inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0),
            ModelEntry(name: "Legacy Snapshot Model", cost: 9.99, savingsUSD: 0, savingsBaselineModel: "", calls: 4),
        ])
    }

    /// No savings anywhere in the period, so the Saved column is absent and
    /// the token line gets the extra room — plus a $0-cost row whose observed
    /// tokens must still render.
    private static func savingsAbsentPayload() -> MenubarPayload {
        payload(topModels: [
            ModelEntry(name: "Claude Opus 4.8", cost: 331.2, savingsUSD: 0, savingsBaselineModel: "", calls: 4812,
                       inputTokens: 152_600_000, outputTokens: 9_640_000, cacheReadTokens: 119_400_000, cacheWriteTokens: 16_000_000),
            ModelEntry(name: "my-proxy-model", cost: 0, savingsUSD: 0, savingsBaselineModel: "", calls: 176,
                       inputTokens: 4_800_000, outputTokens: 400_000, cacheReadTokens: 0, cacheWriteTokens: 0),
        ])
    }

    private static func payload(topModels: [ModelEntry]) -> MenubarPayload {
        MenubarPayload(
            generated: "2026-09-07T00:00:00Z",
            current: CurrentBlock(
                label: "Today",
                cost: 155.89,
                calls: 11852,
                sessions: 14,
                oneShotRate: 0.74,
                inputTokens: 186_000_000,
                outputTokens: 45_000_000,
                cacheHitPercent: 63.4,
                codexCredits: 0,
                topActivities: [],
                topModels: topModels,
                localModelSavings: LocalModelSavings(totalUSD: 9.9, calls: 82, byModel: [], byProvider: []),
                providers: [:],
                topProjects: [],
                modelEfficiency: [],
                topSessions: [],
                retryTax: RetryTax(totalUSD: 0, retries: 0, editTurns: 0, byModel: []),
                routingWaste: RoutingWaste(totalSavingsUSD: 0, baselineModel: "", baselineCostPerEdit: 0, byModel: []),
                tools: [],
                skills: [],
                subagents: [],
                mcpServers: []
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

    /// The exact view the popover installs (CodeBurnApp.makePopoverContent):
    /// the real root, the real width, the real environments. The popover
    /// surface renders dark, so the scheme is pinned or every `.primary` text
    /// renders black-on-black.
    private func popoverContent(store: AppStore) -> some View {
        MenuBarContent()
            .environment(store)
            .environment(UpdateChecker())
            .environment(\.colorScheme, .dark)
            .frame(width: 360)
    }

    /// Render through a REAL NSHostingView inside a borderless window that is
    /// never ordered on screen, forcing a genuine AppKit layout pass (ImageRenderer
    /// alone does not run the scroll-content layout this popover root needs).
    /// Height comes from the hosting view's own fittingSize — the same signal
    /// the popover's `.preferredContentSize` sizing uses — so the full Models
    /// section is captured at the real 360pt width without inventing a canvas.
    @discardableResult
    private func render(name: String, store: AppStore, proofDir: String?) throws -> NSSize {
        let hosting = NSHostingView(rootView: popoverContent(store: store))
        hosting.frame = NSRect(x: 0, y: 0, width: 360, height: 1)
        hosting.layoutSubtreeIfNeeded()
        let fitted = hosting.fittingSize
        #expect(fitted.width == 360)
        let size = NSSize(width: 360, height: max(fitted.height, 660)) // floor: popoverHeight

        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false,
        )
        hosting.frame = NSRect(origin: .zero, size: size)
        window.contentView = hosting
        // Offscreen by construction: never ordered front, never visible.
        window.orderOut(nil)
        hosting.layoutSubtreeIfNeeded()

        guard let bitmap = hosting.bitmapImageRepForCachingDisplay(in: NSRect(origin: .zero, size: size)) else {
            Issue.record("bitmapImageRepForCachingDisplay failed for \(name)")
            return .zero
        }
        hosting.cacheDisplay(in: NSRect(origin: .zero, size: size), to: bitmap)

        if let proofDir {
            let data = try #require(bitmap.representation(using: .png, properties: [:]))
            let url = URL(fileURLWithPath: proofDir).appendingPathComponent("menubar-\(name).png")
            try data.write(to: url)
        }
        return size
    }

    // MARK: - Tests

    @Test("token line renders at the real 360pt popover width with savings present and absent")
    func rendersAtPopoverWidth() throws {
        let proofDir = ProcessInfo.processInfo.environment["CODEBURN_LAYOUT_PROOF_DIR"]

        // Full popover at its REAL 360×660 (context: the Models section sits
        // below the fold, exactly as in the popover — the first row and the
        // column header row are what fit).
        let store = makeStore(payload: Self.savingsPresentPayload())
        #expect(store.hasCachedData)
        let withSavings = try render(name: "savings-present", store: store, proofDir: proofDir)
        #expect(withSavings.width == 360)

        let withoutSavings = try render(name: "savings-absent", store: makeStore(payload: Self.savingsAbsentPayload()), proofDir: proofDir)
        #expect(withoutSavings.width == 360)

        // Section-only renders at the same real width: the section carries its
        // own row padding and no extra horizontal wrapper in the popover, so
        // this is the exact row layout context, uncut. (The section has no
        // ScrollView, so ImageRenderer runs its layout faithfully.)
        if let proofDir {
            for (name, payload) in [("section-savings-present", Self.savingsPresentPayload()),
                                    ("section-savings-absent", Self.savingsAbsentPayload())] {
                let sectionStore = makeStore(payload: payload)
                let renderer = ImageRenderer(content: ModelsSection()
                    .environment(sectionStore)
                    .environment(\.colorScheme, .dark)
                    .frame(width: 360))
                renderer.scale = 2
                if let cgImage = renderer.cgImage {
                    let rep = NSBitmapImageRep(cgImage: cgImage)
                    if let data = rep.representation(using: .png, properties: [:]) {
                        try data.write(to: URL(fileURLWithPath: proofDir).appendingPathComponent("menubar-\(name).png"))
                    }
                }
            }
        }
    }

    @Test("exact token counts ride in the row accessibility text at every count magnitude")
    func accessibilityCarriesExactCounts() throws {
        let store = makeStore(payload: Self.savingsPresentPayload())
        let rows = store.payload.current.topModels
        #expect(rows[0].tokenAccessibilityText.contains("152,300,456 input"))
        #expect(rows[0].tokenAccessibilityText.contains("1,180,456,789 cache read (reused input)"))
        #expect(rows[1].tokenAccessibilityText.contains("12,345,678,901 cache read (reused input)"))
        // The legacy row has no counts at all, so no accessibility line either.
        #expect(rows[3].tokenAccessibilityText.isEmpty)
    }
}
