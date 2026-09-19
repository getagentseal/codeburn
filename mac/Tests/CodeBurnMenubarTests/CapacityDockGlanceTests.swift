import AppKit
import Foundation
import Testing
@testable import CodeBurnMenubar

private func window(
    _ label: String,
    _ percent: Double,
    resetsAt: Date? = nil,
    windowSeconds: Int? = nil
) -> QuotaSummary.Window {
    QuotaSummary.Window(label: label, percent: percent, resetsAt: resetsAt, windowSeconds: windowSeconds)
}

private func quota(
    _ details: [QuotaSummary.Window],
    primary: QuotaSummary.Window? = nil,
    connection: QuotaSummary.Connection = .connected
) -> QuotaSummary {
    QuotaSummary(
        providerFilter: .all,
        connection: connection,
        primary: primary,
        details: details,
        planLabel: "Max 20x",
        footerLines: []
    )
}

@Suite("Capacity Dock glance popover")
struct CapacityDockGlanceTests {
    @Test("Window columns keep the provider's own order and cap at four")
    func windowOrderAndCap() {
        let five = window("5-hour", 0.16)
        let weekly = window("Weekly", 0.14)
        let fable = window("Fable", 0.25)
        #expect(CapacityDockGlance.windows(quota([five, weekly, fable])) == [five, weekly, fable])
        let many = (0..<6).map { window("w\($0)", Double($0) / 10) }
        #expect(CapacityDockGlance.windows(quota(many)).count == CapacityDockGlance.maxWindowColumns)
    }

    @Test("The staleness notice is a section the panel reserves height for")
    func noticeIsReserved() {
        let windows = [window("5-hour", 0.2), window("Weekly", 0.95)]
        func height(_ connection: QuotaSummary.Connection) -> CGFloat {
            CapacityDockMetrics.detailHeight(
                quota: quota(windows, connection: connection),
                provider: .claude,
                sessionCount: 2,
                hasToday: true,
                tailEdge: .right,
                scale: 1
            )
        }
        // The line is drawn between the header and the sections below it. Without its
        // own reserved height it squeezed every block under it, because the panel frame
        // is computed rather than fitted.
        let connected = height(.connected)
        for stale in [QuotaSummary.Connection.stale, .transientFailure, .loading] {
            #expect(CapacityDockGlance.drawsNotice(stale))
            #expect(height(stale) == connected + CapacityDockGlance.noticeHeight)
        }
        // Disconnected and reconnect draw their own blocks with an action button.
        #expect(!CapacityDockGlance.drawsNotice(.disconnected))
        // Reconnect draws its own block and is accounted for separately.
        #expect(height(.terminalFailure(reason: nil)) > connected)
        for scale in [0.9, 1.0, 1.25] {
            let h = CapacityDockMetrics.detailHeight(
                quota: quota(windows, connection: .stale),
                provider: .claude,
                sessionCount: 2,
                hasToday: true,
                tailEdge: .right,
                scale: CGFloat(scale)
            )
            #expect(h == h.rounded())
        }
    }

    @Test("A provider with only a primary window still draws one column")
    func windowsFallBackToPrimary() {
        let primary = window("30-day", 0.21)
        #expect(CapacityDockGlance.windows(quota([], primary: primary)) == [primary])
    }

    @Test("No windows at all leaves the row empty, so the budget line takes over")
    func windowsAbsent() {
        #expect(CapacityDockGlance.windows(quota([])).isEmpty)
    }

    @Test("Up to three windows share one row; a fourth wraps to a second")
    func multiWindowGridGeometry() {
        let plainThree = quota([
            window("5-hour", 0.2),
            window("Weekly · Opus", 0.5),
            window("Weekly · Sonnet", 0.7),
        ])
        let plainFour = quota([
            window("5-hour", 0.2),
            window("Weekly", 0.5),
            window("Weekly · Opus", 0.7),
            window("Weekly · Sonnet", 0.9),
        ])
        #expect(CapacityDockGlance.windowColumnCount(for: 1) == 1)
        #expect(CapacityDockGlance.windowColumnCount(for: 2) == 2)
        #expect(CapacityDockGlance.windowColumnCount(for: 3) == 3)
        #expect(CapacityDockGlance.windowColumnCount(for: 4) == 3)
        #expect(CapacityDockGlance.windowRowCount(for: 1) == 1)
        #expect(CapacityDockGlance.windowRowCount(for: 2) == 1)
        #expect(CapacityDockGlance.windowRowCount(for: 3) == 1)
        #expect(CapacityDockGlance.windowRowCount(for: 4) == 2)
        #expect(CapacityDockGlance.windowsHeight(for: plainThree) == CapacityDockGlance.windowsHeight)
        #expect(abs(CapacityDockGlance.windowsGridHeight(for: plainFour) - (2 * 53 + 6)) < 0.001)
        #expect(abs(CapacityDockGlance.windowsHeight(for: plainFour) - (8 + 2 * 53 + 6 + 16)) < 0.001)
        // One and two windows retain the original compact one-row geometry.
        #expect(CapacityDockGlance.windowsHeight(for: quota([window("Weekly", 0.5)])) == CapacityDockGlance.windowsHeight)
        #expect(CapacityDockGlance.windowsHeight(for: quota([window("5-hour", 0.2), window("Weekly", 0.5)])) == CapacityDockGlance.windowsHeight)
    }

    @Test("The pill tint ramps green, yellow, orange, red at 60, 70 and 95 percent, like the flame")
    func severityRamp() {
        #expect(CapacityDockGlance.severityColor(0.0) == .green)
        #expect(CapacityDockGlance.severityColor(0.59) == .green)
        #expect(CapacityDockGlance.severityColor(0.60) == .yellow)
        #expect(CapacityDockGlance.severityColor(0.69) == .yellow)
        #expect(CapacityDockGlance.severityColor(0.70) == .orange)
        #expect(CapacityDockGlance.severityColor(0.94) == .orange)
        #expect(CapacityDockGlance.severityColor(0.95) == .red)
        #expect(CapacityDockGlance.severityColor(1.5) == .red)
    }

    @Test("The pill fill fraction clamps into 0...1 so the tint cannot overrun")
    func pillFillFractionClamps() {
        #expect(CapacityDockGlance.gaugeFillFraction(0) == 0)
        #expect(CapacityDockGlance.gaugeFillFraction(0.73) == 0.73)
        #expect(CapacityDockGlance.gaugeFillFraction(1) == 1)
        // A bad context reading must not paint past the pill, or short of it.
        #expect(CapacityDockGlance.gaugeFillFraction(-0.4) == 0)
        #expect(CapacityDockGlance.gaugeFillFraction(2.5) == 1)
    }

    @Test("The tint's fade tail never inverts on a short fill")
    func pillFadeStart() {
        // A long band keeps a 12pt tail, so the fade starts near its end.
        #expect(abs(CapacityDockGlance.pillFadeStart(filledWidth: 112, scale: 1) - 100.0 / 112.0) < 1e-9)
        // Shorter than the tail, the whole band is the fade.
        #expect(CapacityDockGlance.pillFadeStart(filledWidth: 8, scale: 1) == 0)
        #expect(CapacityDockGlance.pillFadeStart(filledWidth: 0, scale: 1) == 0)
        // The tail scales with the panel.
        #expect(CapacityDockGlance.pillFadeStart(filledWidth: 48, scale: 2) == 0.5)
    }

    @Test("The reveal is empty at zero, full at one, and slanted between")
    func gaugeRevealEdges() {
        let width: CGFloat = 40
        let height: CGFloat = 20
        func edge(_ fraction: Double) -> (top: CGFloat, bottom: CGFloat) {
            CapacityDockGlance.gaugeRevealEdge(fraction: fraction, width: width, height: height)
        }
        // Nothing coloured at 0, every glyph coloured at 1.
        #expect(edge(0) == (top: 0, bottom: 0))
        #expect(edge(1) == (top: width, bottom: width))
        // Mid-run the bottom leads the top, which is what makes the wipe diagonal.
        let mid = edge(0.5)
        #expect(mid.bottom > mid.top)
        #expect(mid.bottom - mid.top == height * CapacityDockGlance.gaugeSlantRatio)
        #expect(mid.bottom > 0 && mid.bottom < width)
    }

    @Test("The reveal never goes backwards or escapes the text box")
    func gaugeRevealIsMonotonicAndClamped() {
        let width: CGFloat = 40
        let height: CGFloat = 20
        var previous: (top: CGFloat, bottom: CGFloat) = (0, 0)
        for step in 0...20 {
            let edge = CapacityDockGlance.gaugeRevealEdge(
                fraction: Double(step) / 20,
                width: width,
                height: height
            )
            #expect(edge.top >= previous.top)
            #expect(edge.bottom >= previous.bottom)
            #expect(edge.top >= 0 && edge.top <= width)
            #expect(edge.bottom >= 0 && edge.bottom <= width)
            #expect(edge.bottom >= edge.top)
            previous = edge
        }
    }

    @Test("Out-of-range percentages clamp rather than overdraw")
    func gaugeRevealClampsOutOfRange() {
        let width: CGFloat = 40
        #expect(CapacityDockGlance.gaugeRevealEdge(fraction: -0.5, width: width, height: 20).bottom == 0)
        #expect(CapacityDockGlance.gaugeRevealEdge(fraction: 1.8, width: width, height: 20).top == width)
    }

    @Test("A low percentage colours only the start of the run")
    func gaugeRevealAtLowPercent() {
        // 16% of a two-glyph run reaches into the second glyph and no further.
        let edge = CapacityDockGlance.gaugeRevealEdge(fraction: 0.16, width: 40, height: 20)
        #expect(edge.bottom > 0)
        #expect(edge.bottom < 40 * 0.3)
    }

    @Test("Sessions grow by a pill plus its gap up to the visible cap, then scroll")
    func sessionsSectionHeight() {
        let empty = CapacityDockGlance.sessionsHeight(count: 0)
        #expect(
            empty == CapacityDockGlance.sectionPadTop
                + CapacityDockGlance.captionLine
                + CapacityDockGlance.sectionPadBottom
        )
        #expect(CapacityDockGlance.sessionListHeight(count: 0) == 0)
        let step = CapacityDockGlance.pillGap + CapacityDockGlance.pillHeight
        for count in 1...CapacityDockGlance.maxVisibleSessionRows {
            let grown = CapacityDockGlance.sessionsHeight(count: count)
                - CapacityDockGlance.sessionsHeight(count: count - 1)
            #expect(grown == step)
        }
        // Four pills and their three gaps, then the list scrolls inside that.
        let fourPills: CGFloat = 4 * CapacityDockGlance.pillHeight + 3 * CapacityDockGlance.pillGap
        #expect(CapacityDockGlance.sessionListHeight(count: 4) == fourPills)
        #expect(fourPills == 202)
        let capped = CapacityDockGlance.sessionsHeight(count: 4)
        #expect(CapacityDockGlance.sessionsHeight(count: 5) == capped)
        #expect(CapacityDockGlance.sessionsHeight(count: 40) == capped)
    }

    @Test("Height is the exact sum of the sections the view draws")
    func heightIsTheSumOfItsSections() {
        func height(_ count: Int?, hasToday: Bool, windows: [QuotaSummary.Window]) -> CGFloat {
            CapacityDockMetrics.detailHeight(
                quota: quota(windows),
                provider: .claude,
                sessionCount: count,
                hasToday: hasToday,
                tailEdge: .right,
                scale: 1
            )
        }
        let three = [window("Weekly", 0.24), window("5-hour", 0.26), window("Fable", 0.4)]
        let full = height(1, hasToday: true, windows: three)
        #expect(
            full == CapacityDockGlance.headerHeight
                + CapacityDockGlance.sessionsHeight(count: 1)
                + CapacityDockGlance.todayHeight
                + CapacityDockGlance.windowsHeight(for: quota(three))
        )
        // 44 header + 83 sessions + 97 today + 77 one-row windows grid.
        #expect(full == 301)
        // The panel opens and closes on the same 16pt inset it uses sideways.
        let headerParts: CGFloat = CapacityDockGlance.contentInset + 20 + 8
        #expect(CapacityDockGlance.headerHeight == headerParts)
        #expect(
            CapacityDockGlance.windowsHeight
                == CapacityDockGlance.sectionPadTop + 53 + CapacityDockGlance.contentInset
        )
        // Today is four stacked lines (13 + 3 + 13 + 3 + 13 + 3 + 12) inside its
        // padding: the cache-read line joined the input/output pair, and the row
        // keeps one fixed height whether or not that line draws.
        #expect(CapacityDockGlance.todayContentHeight == 60)
        #expect(CapacityDockGlance.todayHeight == 97)
        // Past four sessions the list scrolls, so the panel stops growing.
        let capped = height(4, hasToday: true, windows: three)
        #expect(height(12, hasToday: true, windows: three) == capped)
        #expect(
            capped == 44
                + CapacityDockGlance.sessionsHeight(count: 4)
                + 97
                + CapacityDockGlance.windowsHeight(for: quota(three))
        )
        // Each section is independently droppable.
        #expect(full - height(nil, hasToday: true, windows: three) == CapacityDockGlance.sessionsHeight(count: 1))
        #expect(full - height(1, hasToday: false, windows: three) == CapacityDockGlance.todayHeight)
        #expect(
            height(1, hasToday: true, windows: []) - full
                == CapacityDockGlance.windowsEmptyHeight - CapacityDockGlance.windowsHeight(for: quota(three))
        )
        // Up to three windows share the compact row; a fourth needs the
        // second grid row so every scope remains visible.
        #expect(height(1, hasToday: true, windows: [three[0]]) == full)
        #expect(height(1, hasToday: true, windows: three + [window("Sonnet", 0.5)]) > full)
    }

    @Test("A vertical tail adds its allowance to the panel height")
    func tailAllowance() {
        func height(_ tailEdge: CapacityDockEdge) -> CGFloat {
            CapacityDockMetrics.detailHeight(
                quota: quota([window("5-hour", 0.2)]),
                provider: .claude,
                sessionCount: 2,
                hasToday: true,
                tailEdge: tailEdge,
                scale: 1
            )
        }
        #expect(height(.top) - height(.right) == CapacityDockGlance.tailAllowance)
        #expect(height(.bottom) == height(.top))
        #expect(height(.left) == height(.right))
    }

    @Test("Every scaled height stays a whole point so the panel cannot thrash")
    func heightIsAlwaysWhole() {
        for scale in [0.9, 1.0, 1.15, 1.25, 1.4] {
            let height = CapacityDockMetrics.detailHeight(
                quota: quota([
                    window("5-hour", 0.2),
                    window("Weekly", 0.5),
                    window("Weekly · Opus", 0.7),
                    window("Weekly · Sonnet", 0.9),
                ]),
                provider: .claude,
                sessionCount: 4,
                hasToday: true,
                tailEdge: .bottom,
                scale: CGFloat(scale)
            )
            #expect(height == height.rounded())
        }
    }

    @Test("A session reports its context fraction and what is left")
    func sessionContextMath() {
        let session = LiveSession(
            id: "s1",
            provider: "claude",
            project: "codeburn",
            branch: "feat/dock",
            model: "Opus 4.8",
            contextTokens: 160_000,
            contextWindow: 200_000,
            startedAt: "2026-09-01T10:00:00.000Z",
            lastActivityAt: "2026-09-01T12:00:00.000Z"
        )
        #expect(session.title == "codeburn · feat/dock")
        #expect(session.contextFraction == 0.8)
        #expect(session.contextRemaining == 40_000)
        let now = LiveSession.parseISO8601("2026-09-01T12:04:00.000Z")!
        #expect(session.elapsedLabel(now: now) == "2h 4m")
    }

    @Test("A session with no usage record renders unfilled rather than at zero")
    func sessionWithoutContext() {
        let session = LiveSession(
            id: "s2",
            provider: "codex",
            project: "rakazo",
            branch: nil,
            model: nil,
            contextTokens: nil,
            contextWindow: nil,
            startedAt: "not-a-date",
            lastActivityAt: "2026-09-01T12:00:00.000Z"
        )
        #expect(session.title == "rakazo")
        #expect(session.contextFraction == nil)
        #expect(session.contextRemaining == nil)
        #expect(session.elapsedLabel() == "")
    }

    @Test("A payload without the live-session block decodes as unknown, not as empty")
    func liveSessionsAreOptional() throws {
        let json = """
        {"windowSeconds":120,"sessions":[
          {"id":"a","provider":"claude","project":"codeburn","branch":"main","model":"Opus 4.8",
           "contextTokens":100,"contextWindow":200000,
           "startedAt":"2026-09-01T10:00:00.000Z","lastActivityAt":"2026-09-01T12:00:00.000Z"},
          {"id":"b","provider":"codex","project":"rakazo","branch":null,"model":null,
           "contextTokens":null,"contextWindow":null,
           "startedAt":"2026-09-01T10:00:00.000Z","lastActivityAt":"2026-09-01T12:00:00.000Z"}
        ]}
        """
        let block = try JSONDecoder().decode(LiveSessionsBlock.self, from: Data(json.utf8))
        #expect(block.sessions.count == 2)
        #expect(block.sessions.filter { $0.provider == "claude" }.count == 1)
        #expect(block.sessions[1].contextFraction == nil)
    }

    /// Pins the line box the measured blocks are built on. SwiftUI draws a line
    /// of `.system(size:)` a point taller than either AppKit metric at 10 and
    /// 11pt (13 and 14, not 12 and 13), and a reserve built on the shorter
    /// number clips the last line of every wrapped block.
    @Test("Measured blocks use SwiftUI's line box, not the font's own extent")
    func measuredBlocksMatchSwiftUILineBoxes() {
        let width: CGFloat = 350 - 2 * CapacityDockGlance.contentInset
        func block(_ connection: QuotaSummary.Connection) -> CGFloat {
            CapacityDockGlance.connectionBlockHeight(connection, provider: .claude, width: width)
        }
        // 6 top + an 11pt line (14) + 8 bottom.
        #expect(block(.disconnected) == 28)
        // The same, plus 3 + a one-line 10pt instruction (13).
        #expect(block(.terminalFailure(reason: nil)) == 44)
        // And again plus 3 + a one-line 10pt reason (13).
        #expect(block(.terminalFailure(reason: "Token expired")) == 60)
        // 16 inset + a 20 title row + 11 + a one-line 12pt paragraph (15) + the
        // action row.
        #expect(
            CapacityDockGlance.connectCardHeight(provider: .claude, width: width)
                == 47 + 15 + CapacityDockGlance.actionRowHeight
        )
    }

    @Test("The reconnect block reserves its scaled text at the 0.9 floor, so nothing clips")
    func reconnectBlockDoesNotClipAtFloor() {
        let width: CGFloat = 350 - 2 * CapacityDockGlance.contentInset
        let s: CGFloat = 0.9
        // SwiftUI's line box, the same one connectionBlockHeight measures with.
        func lineBox(_ size: CGFloat, _ weight: NSFont.Weight) -> CGFloat {
            let f = NSFont.systemFont(ofSize: size, weight: weight)
            return max(
                (f.ascender - f.descender + f.leading).rounded(.up),
                f.ascender.rounded(.up) + (-f.descender).rounded(.up)
            )
        }
        func block(_ c: QuotaSummary.Connection, scale: CGFloat) -> CGFloat {
            CapacityDockGlance.connectionBlockHeight(c, provider: .claude, width: width, scale: scale)
        }
        let pads = (CapacityDockGlance.noticeTopPad + CapacityDockGlance.noticeBottomPad) * s

        // The disconnected block is one 11pt line: its reserve must hold the
        // line SwiftUI draws at the SCALED size, not a fixed-size measurement
        // shrunk by the scale.
        #expect(block(.disconnected, scale: s) >= pads + lineBox(11 * s, .regular))
        // And that is strictly more than the old reserve (fixed line box * scale),
        // which fell short of the fixed-size draw and clipped.
        #expect(block(.disconnected, scale: s) > block(.disconnected, scale: 1) * s)

        // The reconnect title is the 11pt semibold line that clipped; its reserve
        // must cover the scaled draw.
        #expect(
            block(.terminalFailure(reason: nil), scale: s)
                >= CapacityDockGlance.noticeTopPad * s + lineBox(11 * s, .semibold)
        )
        #expect(
            block(.terminalFailure(reason: "Token expired"), scale: s)
                >= CapacityDockGlance.noticeTopPad * s + lineBox(11 * s, .semibold)
                    + CapacityDockGlance.noticeRowGap * s + lineBox(10 * s, .regular)
        )
    }
}
