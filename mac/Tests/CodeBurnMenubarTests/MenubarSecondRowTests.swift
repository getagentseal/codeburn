import AppKit
import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("Menubar second row")
struct MenubarSecondRowTests {
    private let now = Date(timeIntervalSince1970: 1_700_000_000)

    private func snapshot(
        quota: MenubarQuotaCandidate? = nil,
        todayCost: Double? = nil,
        todayTotalTokens: Int? = nil,
        activeSessionCount: Int? = nil,
        currencySymbol: String = "$",
        currencyRate: Double = 1
    ) -> MenubarRowSnapshot {
        MenubarRowSnapshot(
            quota: quota,
            todayCost: todayCost,
            todayTotalTokens: todayTotalTokens,
            activeSessionCount: activeSessionCount,
            currencySymbol: currencySymbol,
            currencyRate: currencyRate
        )
    }

    private func settings(
        _ enabled: Bool,
        _ metric: MenubarSecondRowMetric = .quotaRemaining
    ) -> MenubarRowSettings {
        MenubarRowSettings(isSecondRowEnabled: enabled, secondRowMetric: metric)
    }

    // MARK: - Off state

    @Test("off state returns the first row alone, whatever the snapshot holds")
    func offStateRendersOneRow() {
        let full = snapshot(
            quota: MenubarQuotaCandidate(label: "Claude", percentUsed: 0.4, resetsAt: now.addingTimeInterval(3600)),
            todayCost: 12.34,
            todayTotalTokens: 1_500_000,
            activeSessionCount: 3
        )
        for metric in MenubarSecondRowMetric.allCases {
            let off = settings(false, metric)
            #expect(MenubarRowFormatter.secondRow(settings: off, snapshot: full, now: now) == nil)
            #expect(MenubarRowFormatter.rows(firstRow: "$12.34", settings: off, snapshot: full, now: now) == ["$12.34"])
        }
    }

    @Test("default settings are off and never produce a second row")
    func defaultSettingsAreOff() {
        #expect(MenubarRowSettings.default.isSecondRowEnabled == false)
        #expect(MenubarRowSettings().isSecondRowEnabled == false)
        #expect(MenubarRowSettings.default.secondRowMetric == .quotaRemaining)
        #expect(
            MenubarRowFormatter.rows(
                firstRow: "$1.00",
                settings: .default,
                snapshot: snapshot(todayCost: 1, activeSessionCount: 2),
                now: now
            ) == ["$1.00"]
        )
    }

    // MARK: - Quota remaining

    @Test("quota row pairs remaining percent with the reset countdown")
    func quotaRowRendersRemainingAndCountdown() {
        let rows = MenubarRowFormatter.rows(
            firstRow: "$12.34",
            settings: settings(true, .quotaRemaining),
            snapshot: snapshot(
                quota: MenubarQuotaCandidate(
                    label: "Claude",
                    percentUsed: 0.58,
                    resetsAt: now.addingTimeInterval(3 * 3600 + 12 * 60)
                )
            ),
            now: now
        )
        #expect(rows == ["$12.34", "Claude 42% left · 3h 12m"])
    }

    @Test("quota row drops the countdown when the provider reports no reset")
    func quotaRowWithoutReset() {
        let row = MenubarRowFormatter.secondRow(
            settings: settings(true, .quotaRemaining),
            snapshot: snapshot(
                quota: MenubarQuotaCandidate(label: "Codex", percentUsed: 0.0, resetsAt: nil)
            ),
            now: now
        )
        #expect(row == "Codex 100% left")
    }

    @Test("quota row clamps an over-limit window to zero remaining")
    func quotaRowClampsOverLimit() {
        let row = MenubarRowFormatter.secondRow(
            settings: settings(true, .quotaRemaining),
            snapshot: snapshot(
                quota: MenubarQuotaCandidate(label: "Gemini", percentUsed: 1.4, resetsAt: nil)
            ),
            now: now
        )
        #expect(row == "Gemini 0% left")
    }

    @Test("no connected provider quota degrades to one line")
    func quotaRowUnavailable() {
        let settings = settings(true, .quotaRemaining)
        #expect(MenubarRowFormatter.secondRow(settings: settings, snapshot: snapshot(), now: now) == nil)
        #expect(
            MenubarRowFormatter.rows(
                firstRow: "$12.34",
                settings: settings,
                snapshot: snapshot(),
                now: now
            ) == ["$12.34"]
        )
    }

    @Test("reset countdown uses the same shape as the popover quota rows")
    func resetCountdownShape() {
        #expect(MenubarRowFormatter.resetCountdown(nil, now: now) == nil)
        #expect(MenubarRowFormatter.resetCountdown(now.addingTimeInterval(30), now: now) == "now")
        #expect(MenubarRowFormatter.resetCountdown(now.addingTimeInterval(-600), now: now) == "now")
        #expect(MenubarRowFormatter.resetCountdown(now.addingTimeInterval(45 * 60), now: now) == "45m")
        #expect(MenubarRowFormatter.resetCountdown(now.addingTimeInterval(2 * 3600 + 11 * 60), now: now) == "2h 11m")
        #expect(MenubarRowFormatter.resetCountdown(now.addingTimeInterval(3 * 86400 + 14 * 3600), now: now) == "3d 14h")
    }

    // MARK: - Today's cost

    @Test("today cost row formats in the display currency")
    func todayCostRow() {
        #expect(
            MenubarRowFormatter.secondRow(
                settings: settings(true, .todayCost),
                snapshot: snapshot(todayCost: 12.3456),
                now: now
            ) == "$12.35 today"
        )
        #expect(
            MenubarRowFormatter.secondRow(
                settings: settings(true, .todayCost),
                snapshot: snapshot(todayCost: 10, currencySymbol: "€", currencyRate: 0.9),
                now: now
            ) == "€9.00 today"
        )
        #expect(
            MenubarRowFormatter.secondRow(
                settings: settings(true, .todayCost),
                snapshot: snapshot(todayCost: 0),
                now: now
            ) == "$0.00 today"
        )
    }

    @Test("today cost row degrades to one line before the payload lands")
    func todayCostRowUnavailable() {
        #expect(
            MenubarRowFormatter.secondRow(
                settings: settings(true, .todayCost),
                snapshot: snapshot(),
                now: now
            ) == nil
        )
        #expect(
            MenubarRowFormatter.secondRow(
                settings: settings(true, .todayCost),
                snapshot: snapshot(todayCost: .nan),
                now: now
            ) == nil
        )
    }

    // MARK: - Today's tokens

    @Test("today tokens row uses the menubar token shorthand")
    func todayTokensRow() {
        let enabled = settings(true, .todayTokens)
        #expect(MenubarRowFormatter.secondRow(settings: enabled, snapshot: snapshot(todayTotalTokens: 940), now: now) == "940 tok today")
        #expect(MenubarRowFormatter.secondRow(settings: enabled, snapshot: snapshot(todayTotalTokens: 12_400), now: now) == "12K tok today")
        #expect(MenubarRowFormatter.secondRow(settings: enabled, snapshot: snapshot(todayTotalTokens: 1_540_000), now: now) == "1.5M tok today")
        #expect(MenubarRowFormatter.secondRow(settings: enabled, snapshot: snapshot(todayTotalTokens: 0), now: now) == "0 tok today")
        #expect(MenubarRowFormatter.secondRow(settings: enabled, snapshot: snapshot(), now: now) == nil)
    }

    @Test("token shorthand matches the badge's own thresholds")
    func compactTokensThresholds() {
        #expect(MenubarRowFormatter.compactTokens(999) == "999")
        #expect(MenubarRowFormatter.compactTokens(1_000) == "1K")
        #expect(MenubarRowFormatter.compactTokens(1_000_000) == "1.0M")
        #expect(MenubarRowFormatter.compactTokens(2_500_000_000) == "2.5B")
    }

    // MARK: - Active sessions

    @Test("active sessions row reuses the shared compact session phrasing")
    func activeSessionsRow() {
        let enabled = settings(true, .activeSessions)
        #expect(MenubarRowFormatter.secondRow(settings: enabled, snapshot: snapshot(activeSessionCount: 3), now: now) == "3 sess")
        #expect(MenubarRowFormatter.secondRow(settings: enabled, snapshot: snapshot(activeSessionCount: 1), now: now) == "1 sess")
        #expect(MenubarRowFormatter.secondRow(settings: enabled, snapshot: snapshot(activeSessionCount: 0), now: now) == "0 sess")
        #expect(
            MenubarRowFormatter.secondRow(settings: enabled, snapshot: snapshot(activeSessionCount: 4), now: now)
                == SessionCountLabel.compact(sessions: 4, basis: "identity")
        )
    }

    @Test("a CLI with no live-session block degrades to one line")
    func activeSessionsUnavailable() {
        #expect(
            MenubarRowFormatter.rows(
                firstRow: "$12.34",
                settings: settings(true, .activeSessions),
                snapshot: snapshot(todayCost: 12.34),
                now: now
            ) == ["$12.34"]
        )
    }

    // MARK: - Primary provider selection

    @Test("primary quota is the connected provider nearest its limit")
    func primaryQuotaSelection() {
        let candidates = [
            MenubarQuotaCandidate(label: "Claude", percentUsed: 0.42, resetsAt: nil),
            MenubarQuotaCandidate(label: "Codex", percentUsed: 0.91, resetsAt: nil),
            MenubarQuotaCandidate(label: "Gemini", percentUsed: 0.12, resetsAt: nil),
        ]
        #expect(MenubarQuotaRowSelection.primary(from: candidates)?.label == "Codex")
        #expect(MenubarQuotaRowSelection.primary(from: []) == nil)
    }

    @Test("equal utilization breaks on label so the row does not flip")
    func primaryQuotaTieBreak() {
        let candidates = [
            MenubarQuotaCandidate(label: "Codex", percentUsed: 0.5, resetsAt: nil),
            MenubarQuotaCandidate(label: "Claude", percentUsed: 0.5, resetsAt: nil),
        ]
        #expect(MenubarQuotaRowSelection.primary(from: candidates)?.label == "Claude")
        #expect(MenubarQuotaRowSelection.primary(from: candidates.reversed())?.label == "Claude")
    }

    // MARK: - Preferences

    @Test("settings default to off and round-trip through UserDefaults")
    func preferencesRoundTrip() {
        let suiteName = "CodeBurnMenubarTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }

        #expect(MenubarRowPreferences.load(defaults: defaults) == MenubarRowSettings.default)

        MenubarRowPreferences.setSecondRowEnabled(true, defaults: defaults)
        MenubarRowPreferences.setSecondRowMetric(.todayTokens, defaults: defaults)
        #expect(defaults.bool(forKey: "CodeBurnMenubarSecondRowEnabled"))
        #expect(defaults.string(forKey: "CodeBurnMenubarSecondRowMetric") == "todayTokens")
        let loaded = MenubarRowPreferences.load(defaults: defaults)
        #expect(loaded.isSecondRowEnabled)
        #expect(loaded.secondRowMetric == .todayTokens)

        // An unknown stored metric (older build, manual `defaults write`) falls
        // back to the default rather than dropping the setting.
        defaults.set("bogus", forKey: MenubarRowPreferences.secondRowMetricKey)
        #expect(MenubarRowPreferences.load(defaults: defaults).secondRowMetric == .quotaRemaining)
        #expect(MenubarRowPreferences.load(defaults: defaults).isSecondRowEnabled)

        MenubarRowPreferences.setSecondRowEnabled(false, defaults: defaults)
        #expect(!MenubarRowPreferences.load(defaults: defaults).isSecondRowEnabled)
    }

    @Test("every metric is reachable from the settings picker with a label")
    func metricsAreSelectable() {
        #expect(MenubarSecondRowMetric.allCases == [.quotaRemaining, .todayCost, .todayTokens, .activeSessions])
        for metric in MenubarSecondRowMetric.allCases {
            #expect(!metric.settingsLabel.isEmpty)
            #expect(MenubarSecondRowMetric(rawValue: metric.rawValue) == metric)
        }
    }

    // MARK: - Menu bar geometry

    @Test("two clamped lines fit the standard 22pt menu bar")
    func twoRowsFitMenuBar() {
        #expect(MenubarRowTypography.standardMenuBarThickness == 22)
        #expect(MenubarRowTypography.twoRowTextHeight == 20)
        #expect(MenubarRowTypography.twoRowMaximumHeight == MenubarRowTypography.standardMenuBarThickness)
        #expect(MenubarRowTypography.twoRowMinimumHeight < MenubarRowTypography.twoRowTextHeight)
        #expect(MenubarRowTypography.fitsMenuBar(measuredHeight: 20))
        #expect(MenubarRowTypography.fitsMenuBar(measuredHeight: 21))
        #expect(MenubarRowTypography.fitsMenuBar(measuredHeight: 20, thickness: 20))
        #expect(!MenubarRowTypography.fitsMenuBar(measuredHeight: 20, thickness: 19))
        #expect(!MenubarRowTypography.fitsMenuBar(measuredHeight: 23))
        #expect(!MenubarRowTypography.fitsMenuBar(measuredHeight: 20, thickness: 0))
        #expect(!MenubarRowTypography.fitsMenuBar(measuredHeight: 0))
        // The exact figure moves between macOS releases (20pt on macOS 26, 21pt
        // on the CI runner), so only the band is a contract.
        #expect(MenubarRowTypography.isExpectedTwoRowHeight(20))
        #expect(MenubarRowTypography.isExpectedTwoRowHeight(21))
        #expect(!MenubarRowTypography.isExpectedTwoRowHeight(23))
        #expect(!MenubarRowTypography.isExpectedTwoRowHeight(11))
        // The two-row text must be smaller than the single-row figure, or the
        // pair cannot be centred inside the menu bar at all.
        #expect(MenubarRowTypography.twoRowFontSize < MenubarRowTypography.singleRowFontSize)
        #expect(MenubarRowTypography.twoRowFontSize <= MenubarRowTypography.twoRowLineHeight)
        // The flame is clamped by nothing the paragraph style does, so it must be
        // requested smaller than the text and seated by a negative offset.
        #expect(MenubarRowTypography.twoRowAttachmentPointSize < MenubarRowTypography.twoRowFontSize)
        #expect(MenubarRowTypography.twoRowAttachmentVerticalOffset < 0)
    }

    @Test("the flame is scaled into the clamped line, never past it")
    func attachmentBoundsClampToLineHeight() {
        let clamp = MenubarRowTypography.twoRowLineHeight
        let offset = MenubarRowTypography.twoRowAttachmentVerticalOffset

        // An image at or under the clamp keeps its size.
        let small = MenubarRowTypography.twoRowAttachmentBounds(imageSize: CGSize(width: 8, height: 10))
        #expect(small == CGRect(x: 0, y: offset, width: 8, height: 10))

        // A release whose SF Symbols render taller is scaled down, aspect kept,
        // so line one cannot grow past its clamp.
        let tall = MenubarRowTypography.twoRowAttachmentBounds(imageSize: CGSize(width: 12, height: 15))
        #expect(tall.height == clamp)
        #expect(tall.width == 8)
        #expect(tall.origin.y == offset)

        // Degenerate sizes produce an empty box rather than a division by zero.
        #expect(MenubarRowTypography.twoRowAttachmentBounds(imageSize: .zero) == .zero)
        #expect(MenubarRowTypography.twoRowAttachmentBounds(imageSize: CGSize(width: 8, height: 0)) == .zero)

        // Whatever the image, the box never exceeds the clamp.
        for height in stride(from: CGFloat(1), through: 40, by: 1) {
            let bounds = MenubarRowTypography.twoRowAttachmentBounds(
                imageSize: CGSize(width: height * 0.8, height: height)
            )
            #expect(bounds.height <= clamp)
        }
    }

    @Test("the two rows AppKit lays out fit the menu bar for every row combination")
    func twoRowsFitTheMenuBarForEveryRowCombination() {
        // Same composition the status item renders: an inline flame attachment at
        // the two-row point size, the badge text, then the second row under a
        // paragraph style that clamps both line heights.
        func measuredHeight(first: String, second: String) -> CGFloat {
            let font = NSFont.monospacedDigitSystemFont(
                ofSize: MenubarRowTypography.twoRowFontSize,
                weight: .regular
            )
            let configuration = NSImage.SymbolConfiguration(
                pointSize: MenubarRowTypography.twoRowAttachmentPointSize,
                weight: .medium
            )
            let flame = NSImage(systemSymbolName: "flame.fill", accessibilityDescription: "CodeBurn")?
                .withSymbolConfiguration(configuration)
            let attachment = NSTextAttachment()
            attachment.image = flame
            if let size = flame?.size {
                attachment.bounds = MenubarRowTypography.twoRowAttachmentBounds(imageSize: size)
            }
            let composed = NSMutableAttributedString()
            composed.append(NSAttributedString(attachment: attachment))
            composed.append(NSAttributedString(string: first, attributes: [.font: font]))
            composed.append(NSAttributedString(string: "\n" + second, attributes: [.font: font]))
            let paragraph = NSMutableParagraphStyle()
            paragraph.alignment = .center
            paragraph.lineBreakMode = .byClipping
            paragraph.lineSpacing = 0
            paragraph.paragraphSpacing = 0
            paragraph.minimumLineHeight = MenubarRowTypography.twoRowLineHeight
            paragraph.maximumLineHeight = MenubarRowTypography.twoRowLineHeight
            composed.addAttribute(
                .paragraphStyle,
                value: paragraph,
                range: NSRange(location: 0, length: composed.length)
            )
            return composed.boundingRect(
                with: NSSize(width: 600, height: 200),
                options: [.usesLineFragmentOrigin, .usesFontLeading]
            ).height
        }

        // The figure AppKit reports is release-dependent (20pt on macOS 26, 21pt
        // on the CI runner), and nothing positions the rows off it — the button
        // cell centres whatever it measures. So the contract is the band: it has
        // to fit the bar, and it has to still be two clamped lines.
        let firstRows = [" $12.34", " ↑1.2M ↓340K / wk", " 2.4M / mo", ""]
        let secondRows = ["Claude 42% left · 3h 12m", "$0.00 today", "12 sess", "1.5M tok today"]
        for first in firstRows {
            for second in secondRows {
                let height = measuredHeight(first: first, second: second)
                #expect(MenubarRowTypography.fitsMenuBar(measuredHeight: height))
                #expect(MenubarRowTypography.isExpectedTwoRowHeight(height))
            }
        }
    }
}
