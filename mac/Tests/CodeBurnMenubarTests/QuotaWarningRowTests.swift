import Foundation
import Testing
@testable import CodeBurnMenubar

/// The popover's quota warning banner: that it can be read in both colour
/// schemes, and that it says which limit it is warning about.
@Suite("Quota warning banner")
struct QuotaWarningRowTests {
    typealias Palette = QuotaWarningPalette

    static let now = Date(timeIntervalSince1970: 1_800_000_000)
    /// 3h 12m out, the reset in the report that prompted this.
    static let fiveHourReset = now.addingTimeInterval(3 * 3600 + 12 * 60)

    // MARK: - Legibility

    @Test("the contrast ratio matches WCAG's reference values")
    func contrastRatioMatchesReferenceValues() {
        let black = Palette.RGB(0, 0, 0)
        let white = Palette.RGB(255, 255, 255)
        #expect(abs(Palette.contrastRatio(black, white) - 21) < 0.001)
        #expect(abs(Palette.contrastRatio(white, black) - 21) < 0.001)
        #expect(abs(Palette.contrastRatio(white, white) - 1) < 0.001)
        // #767676 on white is the usual 4.54:1 grey at the AA boundary.
        #expect(abs(Palette.contrastRatio(Palette.RGB(0x76, 0x76, 0x76), white) - 4.54) < 0.01)
    }

    @Test(
        "every severity's text clears WCAG AA over its pill, in light and dark mode",
        arguments: Palette.Tone.allCases
    )
    func textClearsAA(_ tone: Palette.Tone) {
        for scheme in Palette.Scheme.allCases {
            for surface in Palette.surfaces(scheme) {
                let background = Palette.pillBackground(tone, scheme, over: surface)
                let ratio = Palette.contrastRatio(Palette.foreground(tone, scheme), background)
                #expect(
                    ratio >= Palette.minimumContrast,
                    "\(tone) text in \(scheme) mode is \(ratio):1 on \(background) (pill over \(surface))"
                )
            }
        }
    }

    @Test("severity maps onto the banner's tones, and normal has none")
    func severityMapsToTone() {
        #expect(Palette.Tone(.normal) == nil)
        #expect(Palette.Tone(.warning) == .warning)
        #expect(Palette.Tone(.critical) == .critical)
        #expect(Palette.Tone(.danger) == .danger)
    }

    // MARK: - Which limit

    @Test("the worst window wins and brings its own label and reset")
    func worstWindowCarriesLabelAndReset() {
        let weeklyReset = Self.now.addingTimeInterval(4 * 86_400)
        let warning = QuotaWarning.worst(name: "Claude", windows: [
            .init(label: "5-hour", percent: 71, resetsAt: Self.fiveHourReset),
            .init(label: "Weekly", percent: 34, resetsAt: weeklyReset),
            .init(label: "Weekly · Opus", percent: nil, resetsAt: nil),
            .init(label: "Weekly · Sonnet", percent: 43, resetsAt: weeklyReset),
        ])
        #expect(warning == QuotaWarning(
            name: "Claude",
            percent: 71,
            windowLabel: "5-hour",
            resetsAt: Self.fiveHourReset
        ))
    }

    @Test("a tie keeps the earlier window, as the bare max() did")
    func tieKeepsEarlierWindow() {
        let warning = QuotaWarning.worst(name: "Codex", windows: [
            .init(label: "5-hour", percent: 80, resetsAt: Self.fiveHourReset),
            .init(label: "Weekly", percent: 80, resetsAt: nil),
        ])
        #expect(warning?.windowLabel == "5-hour")
        #expect(warning?.resetsAt == Self.fiveHourReset)
    }

    @Test("a provider with nothing above zero does not warn")
    func nothingAboveZeroIsNil() {
        #expect(QuotaWarning.worst(name: "Codex", windows: []) == nil)
        #expect(QuotaWarning.worst(name: "Codex", windows: [
            .init(label: "5-hour", percent: 0, resetsAt: nil),
            .init(label: "Weekly", percent: nil, resetsAt: nil),
            .init(label: "Broken", percent: .nan, resetsAt: nil),
        ]) == nil)
    }

    @Test("severity still follows the worst provider, and only providers at 70% or more warn")
    func aggregateKeepsSeverityAndThreshold() {
        let claude = QuotaWarning(name: "Claude", percent: 88, windowLabel: "5-hour", resetsAt: Self.fiveHourReset)
        let codex = QuotaWarning(name: "Codex", percent: 75, windowLabel: "Weekly")
        let gemini = QuotaWarning(name: "Gemini", percent: 40, windowLabel: "Daily")
        let copilot = QuotaWarning(name: "Copilot", percent: 70, windowLabel: "Monthly")

        let result = QuotaWarningPresentation.aggregate([codex, gemini, claude, copilot])
        #expect(result.severity == .critical)
        #expect(result.warnings == [claude, codex, copilot])

        let none = QuotaWarningPresentation.aggregate([])
        #expect(none.severity == .normal)
        #expect(none.warnings.isEmpty)
    }

    // MARK: - The sentence

    @Test("one provider names its window, percentage and reset")
    func singleProviderSentence() {
        let warning = QuotaWarning(name: "Claude", percent: 71, windowLabel: "5-hour", resetsAt: Self.fiveHourReset)
        #expect(
            QuotaWarningPresentation.message(for: [warning], now: Self.now)
                == "Claude · 5-hour 71% · resets in 3h 12m"
        )
    }

    @Test("a window past its limit says so, with the window and the reset")
    func overLimitSentence() {
        let warning = QuotaWarning(name: "Claude", percent: 105, windowLabel: "5-hour", resetsAt: Self.fiveHourReset)
        #expect(
            QuotaWarningPresentation.message(for: [warning], now: Self.now)
                == "Claude · 5-hour over limit (105%) · resets in 3h 12m"
        )
    }

    @Test("the 90-99% danger band is not called over the limit")
    func dangerBandBelowLimitIsNotOverLimit() {
        let reset = Self.now.addingTimeInterval(2 * 86_400 + 3 * 3600)
        let warning = QuotaWarning(name: "Claude", percent: 93, windowLabel: "Weekly", resetsAt: reset)
        let message = QuotaWarningPresentation.message(for: [warning], now: Self.now)
        #expect(message == "Claude · Weekly 93% · resets in 2d 3h")
        #expect(!message.contains("over limit"))
    }

    @Test("no reset instant prints no countdown")
    func nilResetOmitsCountdown() {
        let warning = QuotaWarning(name: "Claude", percent: 80, windowLabel: "Weekly", resetsAt: nil)
        let message = QuotaWarningPresentation.message(for: [warning], now: Self.now)
        #expect(message == "Claude · Weekly 80%")
        #expect(!message.contains("resets in"))

        let over = QuotaWarning(name: "Claude", percent: 104, windowLabel: "Weekly", resetsAt: nil)
        #expect(QuotaWarningPresentation.message(for: [over], now: Self.now) == "Claude · Weekly over limit (104%)")
    }

    @Test("a reset already passed prints no countdown rather than a zero one")
    func pastResetOmitsCountdown() {
        for reset in [Self.now.addingTimeInterval(-3600), Self.now] {
            let warning = QuotaWarning(name: "Claude", percent: 71, windowLabel: "5-hour", resetsAt: reset)
            let message = QuotaWarningPresentation.message(for: [warning], now: Self.now)
            #expect(message == "Claude · 5-hour 71%")
            #expect(!message.contains("0m"))
        }
    }

    @Test("a reset under a minute away reads <1m, never 0m")
    func imminentResetIsUnderAMinute() {
        let warning = QuotaWarning(
            name: "Claude",
            percent: 71,
            windowLabel: "5-hour",
            resetsAt: Self.now.addingTimeInterval(30)
        )
        let message = QuotaWarningPresentation.message(for: [warning], now: Self.now)
        #expect(message == "Claude · 5-hour 71% · resets in <1m")
        #expect(!message.contains("0m"))
    }

    @Test("the countdown is the Capacity Dock's own wording")
    func countdownMatchesDock() {
        let reset = Self.now.addingTimeInterval(183_900) // 2d 3h 5m
        let dock = QuotaPacePresentation.countdownLabel(from: Self.now, to: reset)
        let warning = QuotaWarning(name: "Codex", percent: 72, windowLabel: "Weekly", resetsAt: reset)
        #expect(dock == "2d 3h")
        #expect(
            QuotaWarningPresentation.message(for: [warning], now: Self.now)
                == "Codex · Weekly 72% · resets in \(dock)"
        )
    }

    @Test("several providers get a line each, every one with its own window")
    func multipleProvidersOneLineEach() {
        let codexReset = Self.now.addingTimeInterval(2 * 86_400 + 3 * 3600)
        let warnings = [
            QuotaWarning(name: "Claude", percent: 88, windowLabel: "5-hour", resetsAt: Self.fiveHourReset),
            QuotaWarning(name: "Codex", percent: 101, windowLabel: "Weekly", resetsAt: codexReset),
            QuotaWarning(name: "Gemini", percent: 70, windowLabel: "Daily", resetsAt: nil),
        ]
        #expect(
            QuotaWarningPresentation.message(for: warnings, now: Self.now)
                == """
                Claude · 5-hour 88% · resets in 3h 12m
                Codex · Weekly over limit (101%) · resets in 2d 3h
                Gemini · Daily 70%
                """
        )
    }

    @Test("a provider that reports no window label still reads cleanly")
    func missingWindowLabel() {
        for label in [nil, "", "  "] as [String?] {
            let warning = QuotaWarning(name: "Kimi Code", percent: 72, windowLabel: label)
            #expect(QuotaWarningPresentation.message(for: [warning], now: Self.now) == "Kimi Code 72%")
        }
        let over = QuotaWarning(name: "Kimi Code", percent: 101, windowLabel: nil)
        #expect(QuotaWarningPresentation.message(for: [over], now: Self.now) == "Kimi Code over limit (101%)")
    }
}
