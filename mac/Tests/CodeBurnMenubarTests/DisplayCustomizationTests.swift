import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("Display customization")
struct DisplayCustomizationTests {

    // MARK: - CostGranularity

    @Test("exact granularity formats with two decimal places")
    func exactGranularity() {
        #expect(CostGranularity.exact.format(437.08, symbol: "$") == "$437.08")
        #expect(CostGranularity.exact.format(0.5, symbol: "$") == "$0.50")
        #expect(CostGranularity.exact.format(1234.99, symbol: "€") == "€1234.99")
    }

    @Test("rounded granularity drops decimals")
    func roundedGranularity() {
        #expect(CostGranularity.rounded.format(437.08, symbol: "$") == "$437")
        #expect(CostGranularity.rounded.format(437.5, symbol: "$") == "$438")
        #expect(CostGranularity.rounded.format(0.49, symbol: "$") == "$0")
    }

    @Test("coarse granularity rounds to nearest significant digit")
    func coarseGranularity() {
        let result = CostGranularity.coarse.format(437.08, symbol: "$")
        // Should round to nearest 10 → $440
        #expect(result == "$440")

        let small = CostGranularity.coarse.format(5.3, symbol: "$")
        // Small values round to nearest 1
        #expect(small == "$5")

        let large = CostGranularity.coarse.format(1893.0, symbol: "$")
        // Should round to nearest 100 → $1900
        #expect(large == "$1900")
    }

    @Test("CostGranularity conforms to CaseIterable")
    func granularityAllCases() {
        #expect(CostGranularity.allCases.count == 3)
        #expect(CostGranularity.allCases.contains(.exact))
        #expect(CostGranularity.allCases.contains(.rounded))
        #expect(CostGranularity.allCases.contains(.coarse))
    }

    @Test("CostGranularity raw values are human-readable")
    func granularityRawValues() {
        #expect(CostGranularity.exact.rawValue == "Exact")
        #expect(CostGranularity.rounded.rawValue == "Rounded")
        #expect(CostGranularity.coarse.rawValue == "Coarse")
    }

    // MARK: - MenubarIcon

    @Test("all menubar icons have SF Symbol names")
    func menubarIconSystemNames() {
        for icon in MenubarIcon.allCases {
            #expect(!icon.systemName.isEmpty)
        }
    }

    @Test("all menubar icons have emoji")
    func menubarIconEmojis() {
        #expect(MenubarIcon.flame.emoji == "🔥")
        #expect(MenubarIcon.dollar.emoji == "💵")
        #expect(MenubarIcon.chart.emoji == "📊")
        #expect(MenubarIcon.bolt.emoji == "⚡")
        #expect(MenubarIcon.brain.emoji == "🧠")
        #expect(MenubarIcon.sparkle.emoji == "✨")
    }

    @Test("MenubarIcon has 6 options")
    func menubarIconCount() {
        #expect(MenubarIcon.allCases.count == 6)
    }

    @Test("MenubarIcon round-trips through rawValue")
    func menubarIconRoundTrip() {
        for icon in MenubarIcon.allCases {
            #expect(MenubarIcon(rawValue: icon.rawValue) == icon)
        }
    }
}
