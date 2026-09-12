import Foundation
import Testing
@testable import CodeBurnMenubar

private func window(
    _ label: String,
    _ percent: Double,
    resetsAt: Date? = nil
) -> QuotaSummary.Window {
    QuotaSummary.Window(label: label, percent: percent, resetsAt: resetsAt)
}

private func quota(
    _ details: [QuotaSummary.Window],
    primary: QuotaSummary.Window? = nil,
    filter: ProviderFilter = .claude
) -> QuotaSummary {
    QuotaSummary(
        providerFilter: filter,
        connection: .connected,
        primary: primary,
        details: details,
        planLabel: "Max 20x",
        footerLines: []
    )
}

/// Claude's shape: a 5-hour window, the weekly window that is also `primary`,
/// and the per-model weekly rows that must never be read as a short window.
private func claudeQuota() -> QuotaSummary {
    let weekly = window("Weekly", 0.21)
    return quota(
        [window("5-hour", 0.64), weekly, window("Weekly · Opus", 0.08)],
        primary: weekly
    )
}

@Suite("Capacity Dock glance window")
struct CapacityDockGlanceWindowTests {
    // MARK: - Which window a kind names

    @Test("the billing horizon is the weekly window and the burst horizon is the 5-hour one")
    func resolvesBothHorizons() {
        let claude = claudeQuota()

        #expect(CapacityDockGlanceWindow.window(.billing, quota: claude)?.label == "Weekly")
        #expect(CapacityDockGlanceWindow.window(.burst, quota: claude)?.label == "5-hour")
        #expect(CapacityDockGlanceWindow.isSwitchable(quota: claude))
    }

    @Test("the billing horizon stays the app-wide headline definition")
    func billingMatchesHeadline() {
        let claude = claudeQuota()

        #expect(CapacityDockGlanceWindow.window(.billing, quota: claude) == claude.headlineWindow)
    }

    @Test("a per-model weekly row is never mistaken for a short window")
    func perModelWeeklyIsNotBurst() {
        // "Weekly · Opus" contains "Opus", not an hour or a session, but a
        // naive "first window that is not the headline" rule would pick it.
        let weekly = window("Weekly", 0.3)
        let summary = quota([weekly, window("Weekly · Opus", 0.9)], primary: weekly)

        #expect(CapacityDockGlanceWindow.window(.burst, quota: summary) == nil)
        #expect(!CapacityDockGlanceWindow.isSwitchable(quota: summary))
    }

    @Test("session, hourly and daily labels all count as the burst horizon")
    func burstLabelVariants() {
        for label in ["5-hour", "Hourly", "Hour", "Daily", "Current session", "Today"] {
            let monthly = window("Monthly", 0.4)
            let summary = quota([window(label, 0.7), monthly], primary: monthly)
            #expect(CapacityDockGlanceWindow.window(.burst, quota: summary)?.label == label)
            #expect(CapacityDockGlanceWindow.window(.billing, quota: summary)?.label == "Monthly")
        }
    }

    @Test("a window reported only as primary is still a candidate")
    func primaryOnlyIsACandidate() {
        let summary = quota([], primary: window("5-hour", 0.5))

        #expect(CapacityDockGlanceWindow.window(.burst, quota: summary)?.label == "5-hour")
    }

    // MARK: - Fallbacks

    @Test("a provider with one window shows it whichever horizon is stored")
    func singleWindowFallsBack() {
        // Cursor-shaped: one monthly window and nothing shorter.
        let monthly = window("Monthly", 0.55)
        let summary = quota([monthly], primary: monthly, filter: .cursor)

        #expect(CapacityDockGlanceWindow.resolvedKind(preferred: .burst, quota: summary) == .billing)
        #expect(
            CapacityDockGlanceWindow.resolvedWindow(preferred: .burst, quota: summary) == monthly
        )
        #expect(
            CapacityDockGlanceWindow.resolvedWindow(preferred: .billing, quota: summary) == monthly
        )
        #expect(!CapacityDockGlanceWindow.isSwitchable(quota: summary))
    }

    @Test("a provider that only reports a short window resolves to it from either preference")
    func burstOnlyFallsBack() {
        // With no weekly or monthly row the headline rule picks the busiest
        // window, which here is the 5-hour one: both horizons agree, so there
        // is nothing to switch.
        let summary = quota([window("5-hour", 0.42)])

        #expect(CapacityDockGlanceWindow.resolvedWindow(preferred: .billing, quota: summary)?.label == "5-hour")
        #expect(CapacityDockGlanceWindow.resolvedWindow(preferred: .burst, quota: summary)?.label == "5-hour")
        #expect(!CapacityDockGlanceWindow.isSwitchable(quota: summary))
    }

    @Test("no quota at all stays unknown instead of inventing a window")
    func missingQuotaStaysUnknown() {
        #expect(CapacityDockGlanceWindow.resolvedWindow(preferred: .billing, quota: nil) == nil)
        #expect(CapacityDockGlanceWindow.resolvedWindow(preferred: .burst, quota: nil) == nil)
        #expect(!CapacityDockGlanceWindow.isSwitchable(quota: nil))
        // A disconnected provider has no windows yet; the click must not store
        // a horizon the user cannot see the effect of.
        let empty = QuotaSummary(
            providerFilter: .claude,
            connection: .disconnected,
            primary: nil,
            details: [],
            planLabel: nil,
            footerLines: []
        )
        #expect(CapacityDockGlanceWindow.next(after: .billing, quota: empty) == .billing)
    }

    // MARK: - Toggle policy

    @Test("the click alternates the two horizons for a provider that has both")
    func clickAlternates() {
        let claude = claudeQuota()

        let first = CapacityDockGlanceWindow.next(after: .billing, quota: claude)
        #expect(first == .burst)
        #expect(CapacityDockGlanceWindow.window(first, quota: claude)?.label == "5-hour")

        let second = CapacityDockGlanceWindow.next(after: first, quota: claude)
        #expect(second == .billing)
        #expect(CapacityDockGlanceWindow.window(second, quota: claude)?.label == "Weekly")
    }

    @Test("the click is a no-op when the provider has a single window")
    func clickIsNoOpWithOneWindow() {
        let monthly = window("Monthly", 0.55)
        let summary = quota([monthly], primary: monthly, filter: .cursor)

        #expect(CapacityDockGlanceWindow.next(after: .billing, quota: summary) == .billing)
        // A stored burst preference this provider cannot honour normalizes to
        // what is actually drawn rather than flipping to a blank gauge.
        #expect(CapacityDockGlanceWindow.next(after: .burst, quota: summary) == .billing)
    }

    @Test("a stored horizon the provider stopped reporting switches back to a real one")
    func staleStoredHorizonRecovers() {
        // The user chose the 5-hour window, then moved to a plan that reports
        // only the weekly limit and a new 5-hour row later returns.
        let weeklyOnly = quota([window("Weekly", 0.3)])
        #expect(CapacityDockGlanceWindow.resolvedKind(preferred: .burst, quota: weeklyOnly) == .billing)
        #expect(CapacityDockGlanceWindow.next(after: .burst, quota: weeklyOnly) == .billing)

        let restored = claudeQuota()
        #expect(CapacityDockGlanceWindow.resolvedKind(preferred: .burst, quota: restored) == .burst)
    }

    // MARK: - Persistence

    private func defaults() -> UserDefaults {
        let suiteName = "CodeBurnMenubarTests.CapacityDockGlance.\(UUID().uuidString)"
        return UserDefaults(suiteName: suiteName)!
    }

    @Test("the glance window defaults to the billing horizon for every provider")
    func defaultsToBilling() {
        let defaults = defaults()

        let snapshot = CapacityDockPreferences.load(defaults: defaults)
        #expect(snapshot.glanceWindows.isEmpty)
        #expect(snapshot.glanceWindow(for: .claude) == .billing)
        #expect(snapshot.glanceWindow(for: .codex) == .billing)
    }

    @Test("the glance window round-trips per provider")
    func roundTripsPerProvider() {
        let defaults = defaults()

        CapacityDockPreferences.setGlanceWindow(.burst, for: .claude, defaults: defaults)
        var snapshot = CapacityDockPreferences.load(defaults: defaults)
        #expect(snapshot.glanceWindow(for: .claude) == .burst)
        // One provider's choice must not move another's.
        #expect(snapshot.glanceWindow(for: .codex) == .billing)

        CapacityDockPreferences.setGlanceWindow(.burst, for: .codex, defaults: defaults)
        CapacityDockPreferences.setGlanceWindow(.billing, for: .claude, defaults: defaults)
        snapshot = CapacityDockPreferences.load(defaults: defaults)
        #expect(snapshot.glanceWindow(for: .claude) == .billing)
        #expect(snapshot.glanceWindow(for: .codex) == .burst)
    }

    @Test("the glance window persists independently of the other dock preferences")
    func persistsIndependently() {
        let defaults = defaults()

        CapacityDockPreferences.setGlanceWindow(.burst, for: .claude, defaults: defaults)
        CapacityDockPreferences.setGaugeShape(.circle, defaults: defaults)
        CapacityDockPreferences.setPreferredProvider(.claude, defaults: defaults)

        let snapshot = CapacityDockPreferences.load(defaults: defaults)
        #expect(snapshot.glanceWindow(for: .claude) == .burst)
        #expect(snapshot.gaugeShape == .circle)
        #expect(snapshot.theme == .graphite)
    }

    @Test("stored entries for unknown providers and unknown horizons are dropped")
    func ignoresForeignStoredValues() {
        let defaults = defaults()

        let stored: [String: Any] = [
            "claude": "burst",
            "not-a-provider": "burst",
            "codex": "fortnightly",
            "gemini": 7,
        ]
        defaults.set(stored, forKey: CapacityDockPreferences.glanceWindowsKey)

        let snapshot = CapacityDockPreferences.load(defaults: defaults)
        #expect(snapshot.glanceWindows == ["claude": .burst])
        #expect(snapshot.glanceWindow(for: .codex) == .billing)
        #expect(snapshot.glanceWindow(for: .gemini) == .billing)
    }
}
