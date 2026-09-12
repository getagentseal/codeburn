import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("Capacity Dock preferences")
struct CapacityDockPreferencesTests {
    private func defaults() -> UserDefaults {
        let suiteName = "CodeBurnMenubarTests.CapacityDock.\(UUID().uuidString)"
        return UserDefaults(suiteName: suiteName)!
    }

    @Test("fresh installs keep the dock off with Codex as the only resting provider")
    func freshDefaults() {
        let defaults = defaults()

        let snapshot = CapacityDockPreferences.load(defaults: defaults)

        #expect(snapshot.isEnabled == false)
        #expect(snapshot.selectedProviders == [.codex])
        #expect(snapshot.preferredProvider == .codex)
        #expect(snapshot.dockedEdge == .right)
        #expect(snapshot.attachmentEdge == .right)
        #expect(snapshot.normalizedHorizontalOffset == nil)
        #expect(snapshot.normalizedVerticalOffset == nil)
        #expect(snapshot.scale == 0.6)
        #expect(snapshot.theme == .graphite)
        #expect(snapshot.gaugeShape == .squircle)
        #expect(snapshot.glanceWindows.isEmpty)
        #expect(snapshot.glanceWindow(for: .claude) == .billing)
    }

    @Test("dock material theme persists independently from placement")
    func persistsTheme() {
        let defaults = defaults()

        CapacityDockPreferences.setTheme(.liquidGlass, defaults: defaults)
        #expect(CapacityDockPreferences.load(defaults: defaults).theme == .liquidGlass)

        CapacityDockPreferences.setTheme(.graphite, defaults: defaults)
        #expect(CapacityDockPreferences.load(defaults: defaults).theme == .graphite)
    }

    @Test("gauge channel shape persists independently from the dock surface")
    func persistsGaugeShape() {
        let defaults = defaults()

        CapacityDockPreferences.setGaugeShape(.squircle, defaults: defaults)
        #expect(CapacityDockPreferences.load(defaults: defaults).gaugeShape == .squircle)
        #expect(CapacityDockPreferences.load(defaults: defaults).theme == .graphite)

        CapacityDockPreferences.setGaugeShape(.circle, defaults: defaults)
        #expect(CapacityDockPreferences.load(defaults: defaults).gaugeShape == .circle)
    }

    @Test("dock placement persists as one coherent preference")
    func persistsDockPlacement() {
        let defaults = defaults()

        CapacityDockPreferences.setPlacement(
            dockedEdge: nil,
            attachmentEdge: .top,
            normalizedHorizontalOffset: 0.28,
            normalizedVerticalOffset: 0.64,
            defaults: defaults
        )
        let floating = CapacityDockPreferences.load(defaults: defaults)
        #expect(floating.dockedEdge == nil)
        #expect(floating.attachmentEdge == .top)
        #expect(floating.normalizedHorizontalOffset == 0.28)
        #expect(floating.normalizedVerticalOffset == 0.64)

        CapacityDockPreferences.setPlacement(
            dockedEdge: .left,
            normalizedHorizontalOffset: 0.91,
            normalizedVerticalOffset: 0.36,
            defaults: defaults
        )
        let docked = CapacityDockPreferences.load(defaults: defaults)
        #expect(docked.dockedEdge == .left)
        #expect(docked.attachmentEdge == .left)
        #expect(docked.normalizedHorizontalOffset == 0.91)
        #expect(docked.normalizedVerticalOffset == 0.36)
    }

    @Test("every audited provider can be selected for Capacity Dock")
    func supportsCompleteProviderCatalog() {
        #expect(CapacityDockPreferences.supportedProviders.count == 69)
        #expect(CapacityDockPreferences.supportedProviders.map(\.rawValue)
            == ProviderConnectionCatalog.providers.map(\.id))
        #expect(CapacityDockProvider(rawValue: "openrouter")?.displayName == "OpenRouter")
        #expect(CapacityDockProvider(rawValue: "unknown") == nil)
    }

    @Test("unknown and duplicate providers are removed in fixed product order")
    func normalizesProviderIdentifiers() {
        let defaults = defaults()
        defaults.set(
            ["copilot", "unknown", "claude", "copilot", "gemini"],
            forKey: CapacityDockPreferences.selectedProvidersKey
        )
        defaults.set("unknown", forKey: CapacityDockPreferences.preferredProviderKey)

        let snapshot = CapacityDockPreferences.load(defaults: defaults)

        #expect(snapshot.selectedProviders == [.claude, .gemini, .copilot])
        #expect(snapshot.preferredProvider == .claude)
    }

    @Test("an empty selection recovers to Codex")
    func neverAllowsEmptySelection() {
        let defaults = defaults()

        CapacityDockPreferences.setSelectedProviders([], defaults: defaults)
        let snapshot = CapacityDockPreferences.load(defaults: defaults)

        #expect(snapshot.selectedProviders == [.codex])
        #expect(snapshot.preferredProvider == .codex)
    }

    @Test("removing the preferred provider picks the first remaining provider")
    func preferredProviderStaysSelected() {
        let defaults = defaults()
        CapacityDockPreferences.setSelectedProviders([.claude, .codex], defaults: defaults)
        CapacityDockPreferences.setPreferredProvider(.codex, defaults: defaults)

        CapacityDockPreferences.setSelectedProviders([.gemini, .claude], defaults: defaults)
        let snapshot = CapacityDockPreferences.load(defaults: defaults)

        #expect(snapshot.selectedProviders == [.claude, .gemini])
        #expect(snapshot.preferredProvider == .claude)
    }

    @Test("vertical offsets are clamped to the normalized range")
    func clampsVerticalOffset() {
        let defaults = defaults()

        CapacityDockPreferences.setNormalizedVerticalOffset(1.7, defaults: defaults)
        #expect(CapacityDockPreferences.load(defaults: defaults).normalizedVerticalOffset == 1)

        CapacityDockPreferences.setNormalizedVerticalOffset(-0.4, defaults: defaults)
        #expect(CapacityDockPreferences.load(defaults: defaults).normalizedVerticalOffset == 0)

        CapacityDockPreferences.setNormalizedVerticalOffset(nil, defaults: defaults)
        #expect(CapacityDockPreferences.load(defaults: defaults).normalizedVerticalOffset == nil)
    }

    @Test("dock size is persisted and clamped to the supported range")
    func clampsScale() {
        let defaults = defaults()

        CapacityDockPreferences.setScale(1.8, defaults: defaults)
        #expect(CapacityDockPreferences.load(defaults: defaults).scale == 1.2)

        CapacityDockPreferences.setScale(0.2, defaults: defaults)
        #expect(CapacityDockPreferences.load(defaults: defaults).scale == 0.6)

        CapacityDockPreferences.setScale(0.8, defaults: defaults)
        #expect(CapacityDockPreferences.load(defaults: defaults).scale == 0.8)
    }

    @Test("auto-seed mirrors connected subscriptions in product order, capped at five")
    func autoSeedCapsAndOrders() {
        let defaults = defaults()
        let connected = Array(CapacityDockPreferences.supportedProviders.prefix(6)).reversed()

        CapacityDockPreferences.autoSeedFromConnected(Array(connected), defaults: defaults)

        let expected = Array(CapacityDockPreferences.supportedProviders.prefix(CapacityDockPreferences.maxAutoProviders))
        let snapshot = CapacityDockPreferences.load(defaults: defaults)
        #expect(snapshot.selectedProviders == expected)
        #expect(snapshot.selectedProviders.count == 5)
    }

    @Test("auto-seed no-ops once the user has manually chosen providers")
    func autoSeedRespectsManualLatch() {
        let defaults = defaults()
        CapacityDockPreferences.setSelectedProviders([.claude], defaults: defaults)

        CapacityDockPreferences.autoSeedFromConnected([.codex, .gemini], defaults: defaults)

        #expect(CapacityDockPreferences.load(defaults: defaults).selectedProviders == [.claude])
    }

    @Test("auto-seed no-ops when nothing is connected yet")
    func autoSeedIgnoresEmptyConnected() {
        let defaults = defaults()

        CapacityDockPreferences.autoSeedFromConnected([], defaults: defaults)

        #expect(CapacityDockPreferences.load(defaults: defaults).selectedProviders == [.codex])
    }
}
