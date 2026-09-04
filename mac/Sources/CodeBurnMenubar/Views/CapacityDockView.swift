import AppKit
import Observation
import SwiftUI

private extension String {
    /// `asCompactTokens` prints an uppercase K; the glance popover uses the
    /// lowercase form (182k) beside the uppercase M and B.
    func lowercasedThousands() -> String { replacingOccurrences(of: "K", with: "k") }
}

private extension View {
    /// Hairline between glance sections, drawn as an overlay so it never adds a
    /// point the computed panel height did not reserve.
    func dividerBelow() -> some View {
        overlay(alignment: .bottom) {
            Rectangle()
                .fill(Color.white.opacity(0.08))
                .frame(height: 0.5)
                .padding(.horizontal, CapacityDockGlance.contentInset)
        }
    }
}

private extension Color {
    /// Warm off-white for Capacity Dock text: a very mild orange tint so bright
    /// labels on the dark card read softer than pure white and do not stress the eyes.
    static let capacityDockText = Color(red: 0.98, green: 0.95, blue: 0.90)
}

enum CapacityDockMetrics {
    private static let baseRailWidth: CGFloat = 88
    // Horizontal rails stack the ring above its label, so their cross-extent (the
    // pill height) needs more room than a vertical rail's width to give the same
    // top/bottom breathing space around the gauge.
    private static let baseHorizontalRailWidth: CGFloat = 106
    private static let baseEdgeFlareWidth: CGFloat = 22
    private static let baseEdgeShoulderDepth: CGFloat = 52
    private static let baseRowHeight: CGFloat = 84
    private static let baseRowSpacing: CGFloat = 12
    private static let baseRailAlongPad: CGFloat = 20
    private static let baseRailCrossPad: CGFloat = 12
    private static let baseRingSize: CGFloat = 52
    private static let baseRingStrokeWidth: CGFloat = 4
    private static let baseRingLabelSpacing: CGFloat = 6
    private static let baseProviderIconSize: CGFloat = 26
    private static let basePercentageTextSize: CGFloat = 17
    private static let baseDetailWidth: CGFloat = 350
    private static let baseAutoHidePeek: CGFloat = 16

    /// Every dock dimension lands on a whole point. Fractional sizes (85%
    /// of 88 is 74.8) made SwiftUI's fitted content disagree with the
    /// pixel-aligned panel frame on every layout pass, so the hosting view
    /// re-laid itself out at display cadence forever: 5 to 7 percent idle CPU
    /// at any scale except 100%.
    private static func points(_ base: CGFloat, _ scale: CGFloat) -> CGFloat {
        max(1, (base * scale).rounded())
    }

    static func railWidth(scale: CGFloat) -> CGFloat { points(baseRailWidth, scale) }
    static func horizontalRailWidth(scale: CGFloat) -> CGFloat { points(baseHorizontalRailWidth, scale) }
    static func edgeFlareWidth(scale: CGFloat) -> CGFloat { points(baseEdgeFlareWidth, scale) }
    static func edgeShoulderDepth(scale: CGFloat) -> CGFloat { points(baseEdgeShoulderDepth, scale) }
    static func rowHeight(scale: CGFloat) -> CGFloat { points(baseRowHeight, scale) }
    static func rowSpacing(scale: CGFloat) -> CGFloat { points(baseRowSpacing, scale) }
    static func railAlongPad(scale: CGFloat) -> CGFloat { points(baseRailAlongPad, scale) }
    static func railCrossPad(scale: CGFloat) -> CGFloat { points(baseRailCrossPad, scale) }
    static func ringSize(scale: CGFloat) -> CGFloat { points(baseRingSize, scale) }
    static func ringStrokeWidth(scale: CGFloat) -> CGFloat { points(baseRingStrokeWidth, scale) }
    static func ringLabelSpacing(scale: CGFloat) -> CGFloat { points(baseRingLabelSpacing, scale) }
    static func providerIconSize(scale: CGFloat) -> CGFloat { points(baseProviderIconSize, scale) }
    static func percentageTextSize(scale: CGFloat) -> CGFloat { points(basePercentageTextSize, scale) }
    /// Visible sliver of an auto-hidden rail; the hover target that slides it out.
    static func autoHidePeek(scale: CGFloat) -> CGFloat { points(baseAutoHidePeek, scale) }
    static func detailWidth(scale: CGFloat) -> CGFloat { points(baseDetailWidth, scale) }

    static func railHeight(providerCount: Int, alongPad: CGFloat, scale: CGFloat) -> CGFloat {
        let count = max(providerCount, 1)
        return alongPad
            + CGFloat(count) * rowHeight(scale: scale)
            + CGFloat(max(0, count - 1)) * rowSpacing(scale: scale)
            + alongPad
    }

    /// The glance popover's height is the sum of its blocks, not a fitted size:
    /// the hosting view has intrinsic sizing off, so every block below carries
    /// the same explicit frame height in `CapacityDockDetailView`. Keep the two
    /// in step, and keep every term a whole number of points (see `points`).
    static func detailHeight(
        quota: QuotaSummary?,
        sessionCount: Int?,
        hasToday: Bool,
        tailEdge: CapacityDockEdge,
        scale: CGFloat
    ) -> CGFloat {
        guard let quota else { return 186 * scale }
        // Each section carries its own padding, so the panel adds none.
        var height = CapacityDockGlance.headerHeight
        // The tail only eats vertical room when it points up or down.
        if !tailEdge.isVertical { height += CapacityDockGlance.tailAllowance }
        if let sessionCount { height += CapacityDockGlance.sessionsHeight(count: sessionCount) }
        if hasToday { height += CapacityDockGlance.todayHeight }
        if CapacityDockGlance.drawsWindows(quota) {
            height += CapacityDockGlance.windows(quota).isEmpty
                ? CapacityDockGlance.windowsEmptyHeight
                : CapacityDockGlance.windowsHeight
        }
        height += CapacityDockConnectionAction.resolve(quota: quota) == nil ? 0 : 38
        let connectionExtra: CGFloat = switch quota.connection {
        case .terminalFailure: 90
        case .disconnected: 18
        // The staleness line is a section like any other, so it needs a section's
        // height. It used to get 16, a bare 10pt line box with no padding, which is
        // why it sat crammed against the header with the blocks below pushed into it.
        case .loading, .stale, .transientFailure: CapacityDockGlance.noticeHeight
        case .connected: 0
        }
        height += connectionExtra
        return (height * scale).rounded()
    }
}

/// Fixed block heights shared by the glance popover's layout and its panel
/// size, plus the ramps its numbers and rings use. Every section owns its own
/// padding, so the panel itself only insets horizontally.
enum CapacityDockGlance {
    /// The panel's padding on all four sides. Horizontally it is applied by each
    /// section rather than the panel, so group fills can still run edge to edge.
    static let contentInset: CGFloat = 16
    static let tailAllowance: CGFloat = 18

    /// 16 top + 20 title + 8 bottom.
    static let headerHeight: CGFloat = 44
    static let sectionPadTop: CGFloat = 8
    static let sectionPadBottom: CGFloat = 10
    /// A 10.5pt caption's line box, shared by every section header.
    static let captionLine: CGFloat = 13
    /// Content driven: 8 padding + a 12pt line + 2 + a 10.5pt line + 8 padding.
    /// Held as a constant because the panel frame is computed, not fitted.
    static let pillHeight: CGFloat = 46
    static let pillGap: CGFloat = 6
    /// Three stacked lines, 13 + 13 + 12, with two 3pt gaps. Taller than the
    /// 17pt burned figure beside it, so it sets the row.
    static let todayContentHeight: CGFloat = 44
    /// 8 top + 24 percent + 2 + 13 label + 2 + 12 reset + 16 bottom.
    static let windowsHeight: CGFloat = 77
    /// 8 top + one secondary line + 16 bottom.
    static let windowsEmptyHeight: CGFloat = 37
    /// The staleness or reconnect line under the header. It is a section like any
    /// other, so the panel has to reserve its height: the frame is computed, not
    /// fitted, and an unreserved line squeezes every block below it.
    /// 6 top + a 10pt line box + 8 bottom.
    static let noticeHeight: CGFloat = 27
    /// Whether the band is drawn as its own padded section. Disconnected and
    /// reconnect draw their own blocks with an action button instead.
    static func drawsNotice(_ connection: QuotaSummary.Connection) -> Bool {
        switch connection {
        case .connected, .disconnected, .terminalFailure: return false
        case .loading, .stale, .transientFailure: return true
        }
    }

    /// The list scrolls past this many pills rather than truncating.
    static let maxVisibleSessionRows = 4
    static let maxWindowColumns = 4

    /// Height of the scrolling pill list: every pill up to the visible cap, then
    /// the list scrolls inside that.
    static func sessionListHeight(count: Int) -> CGFloat {
        let visible = min(count, maxVisibleSessionRows)
        guard visible > 0 else { return 0 }
        return CGFloat(visible) * pillHeight + CGFloat(visible - 1) * pillGap
    }

    static func sessionsHeight(count: Int) -> CGFloat {
        var height = sectionPadTop + captionLine + sectionPadBottom
        if count > 0 { height += pillGap + sessionListHeight(count: count) }
        return height
    }

    static let todayHeight: CGFloat = sectionPadTop + captionLine + pillGap
        + todayContentHeight + sectionPadBottom

    /// Four bands, matching the rail's own sense of escalation: comfortable,
    /// watch it, nearly out, over. Rings start green because a ring with no
    /// colour reads as broken.
    static func severityColor(_ fraction: Double) -> Color {
        if fraction >= 0.9 { return .red }
        if fraction >= 0.8 { return .orange }
        if fraction >= 0.7 { return .yellow }
        return .green
    }

    /// Share of the pill the tint covers. Anything outside 0...1 is a bad
    /// context reading, not a reason to paint past the pill.
    static func gaugeFillFraction(_ fraction: Double) -> Double {
        min(max(fraction, 0), 1)
    }

    /// Where the tint starts fading, as a share of the filled band. The fade is
    /// a fixed 12pt tail, so a short band fades over its whole length instead of
    /// inverting.
    static func pillFadeStart(filledWidth: CGFloat, scale: CGFloat) -> CGFloat {
        let fade = 12 * scale
        guard filledWidth > fade else { return 0 }
        return (filledWidth - fade) / filledWidth
    }

    /// How far the reveal edge leans, as a share of the text's height.
    static let gaugeSlantRatio: CGFloat = 0.35

    /// Where the slanted reveal edge crosses the top and bottom of the text box.
    /// The edge starts fully off the left and ends fully past the right, so 0
    /// reveals nothing and 1 fills every glyph. Both values are clamped into the
    /// box, which turns the parallelogram into a triangle at the two extremes
    /// rather than letting it fold over itself.
    static func gaugeRevealEdge(
        fraction: Double,
        width: CGFloat,
        height: CGFloat
    ) -> (top: CGFloat, bottom: CGFloat) {
        let clamped = min(max(fraction, 0), 1)
        let slant = height * gaugeSlantRatio
        let bottom = (width + slant) * clamped
        let clamp = { (value: CGFloat) in min(max(value, 0), width) }
        return (clamp(bottom - slant), clamp(bottom))
    }

    /// A provider that is not connected has no quota and no spend to stand in for
    /// one, so the windows row gives way to the reconnect guidance entirely.
    static func drawsWindows(_ quota: QuotaSummary) -> Bool {
        switch quota.connection {
        case .disconnected, .terminalFailure: return false
        case .connected, .loading, .stale, .transientFailure: return true
        }
    }

    /// The windows the row draws, in the order the provider service reported them.
    static func windows(_ quota: QuotaSummary) -> [QuotaSummary.Window] {
        let ordered = quota.details.isEmpty ? [quota.primary].compactMap { $0 } : quota.details
        return Array(ordered.prefix(maxWindowColumns))
    }
}

@MainActor
@Observable
final class CapacityDockViewModel {
    var preferences: CapacityDockPreferences.Snapshot
    var interaction = CapacityDockInteractionState()
    var hoveredProvider: CapacityDockProvider?
    var detailHeight: CGFloat = 164
    var isRailPresentationExpanded = false
    var railPresentationProgress: CGFloat = 0
    var dockedEdge: CapacityDockEdge?
    var attachmentEdge: CapacityDockEdge
    var attachmentProgress: CGFloat
    var detailTailEdge: CapacityDockEdge = .right
    var detailTailPosition: CGFloat = 0.5
    var expansionAnchor: CapacityDockExpansionAnchor = .start

    init(preferences: CapacityDockPreferences.Snapshot) {
        self.preferences = preferences
        self.dockedEdge = preferences.dockedEdge
        self.attachmentEdge = preferences.attachmentEdge
        self.attachmentProgress = preferences.dockedEdge == nil ? 0 : 1
    }

    var displayedProviders: [CapacityDockProvider] {
        guard isRailPresentationExpanded else { return [preferences.preferredProvider] }
        let preferred = preferences.preferredProvider
        let providers = [preferred] + preferences.selectedProviders.filter { $0 != preferred }
        return expansionAnchor == .start ? providers : providers.reversed()
    }

    var restingBodyLength: CGFloat {
        CapacityDockMetrics.railHeight(providerCount: 1, alongPad: railAlongPad, scale: scale)
    }
    var expandedBodyLength: CGFloat {
        CapacityDockMetrics.railHeight(
            providerCount: preferences.selectedProviders.count,
            alongPad: railAlongPad,
            scale: scale
        )
    }
    var targetBodyLength: CGFloat {
        interaction.isExpanded ? expandedBodyLength : restingBodyLength
    }
    var bodyLength: CGFloat {
        restingBodyLength
            + (expandedBodyLength - restingBodyLength)
            * min(max(railPresentationProgress, 0), 1)
    }

    var scale: CGFloat { CGFloat(preferences.scale) }
    var detailScale: CGFloat { max(scale, 0.9) }
    var railWidth: CGFloat {
        isVertical
            ? CapacityDockMetrics.railWidth(scale: scale)
            : CapacityDockMetrics.horizontalRailWidth(scale: scale)
    }
    var edgeFlareWidth: CGFloat { CapacityDockMetrics.edgeFlareWidth(scale: scale) }
    var isDocked: Bool { dockedEdge != nil }
    var isVertical: Bool { attachmentEdge.isVertical }
    var bodySize: CGSize {
        isVertical
            ? CGSize(width: railWidth, height: bodyLength)
            : CGSize(width: bodyLength, height: railWidth)
    }
    var panelSize: CGSize {
        panelSize(forAttachmentProgress: attachmentProgress)
    }
    func panelSize(forAttachmentProgress progress: CGFloat) -> CGSize {
        panelSize(bodyLength: bodyLength, attachmentProgress: progress)
    }
    func targetPanelSize(forAttachmentProgress progress: CGFloat) -> CGSize {
        panelSize(bodyLength: targetBodyLength, attachmentProgress: progress)
    }
    private func panelSize(bodyLength: CGFloat, attachmentProgress progress: CGFloat) -> CGSize {
        return isVertical
            ? CGSize(width: railWidth, height: bodyLength)
            : CGSize(width: bodyLength, height: railWidth)
    }
    var rowHeight: CGFloat { CapacityDockMetrics.rowHeight(scale: scale) }
    var rowSpacing: CGFloat { CapacityDockMetrics.rowSpacing(scale: scale) }
    // Along-axis content padding: small when floating, plus the docked concave
    // flare depth so content never crowds a necked edge. Cross-axis is a small
    // fixed margin. railTop/BottomPadding stay as the names the controller's
    // detail-tail math reads.
    var flareCompensation: CGFloat {
        let p = min(max(attachmentProgress, 0), 1)
        let eased = p * p * (3 - 2 * p)
        return CapacityDockMetrics.edgeShoulderDepth(scale: scale) * 0.6 * eased
    }
    // Rounded after the flare is added, not before: the panel's length is built from this
    // padding, and a fractional length re-runs the window's layout at display cadence for
    // as long as the dock is up. `points` rounds the base, the eased flare then reintroduced
    // the fraction for the whole attach animation.
    var railAlongPad: CGFloat {
        (CapacityDockMetrics.railAlongPad(scale: scale) + flareCompensation).rounded()
    }
    var railCrossPad: CGFloat { CapacityDockMetrics.railCrossPad(scale: scale) }
    var railTopPadding: CGFloat { railAlongPad }
    var railBottomPadding: CGFloat { railAlongPad }
    var detailWidth: CGFloat { CapacityDockMetrics.detailWidth(scale: detailScale) }

    func presentationOpacity(for provider: CapacityDockProvider) -> CGFloat {
        provider == preferences.preferredProvider ? 1 : railPresentationProgress
    }
}

struct CapacityDockView: View {
    let model: CapacityDockViewModel
    let quota: (CapacityDockProvider) -> QuotaSummary?
    let onProviderClick: (CapacityDockProvider) -> Void
    let onHide: () -> Void
    let onDock: (CapacityDockEdge) -> Void
    let onDragChanged: (CGPoint, CGSize) -> Void
    let onDragEnded: () -> Void

    var body: some View {
        let railShape = CapacityDockRailShape(
            bodyWidth: model.railWidth,
            bodyLength: model.bodyLength,
            shoulderDepth: CapacityDockMetrics.edgeShoulderDepth(scale: model.scale),
            attachmentProgress: model.attachmentProgress,
            edge: model.attachmentEdge
        )
        let providerLayout = model.isVertical
            ? AnyLayout(VStackLayout(spacing: model.rowSpacing))
            : AnyLayout(HStackLayout(spacing: model.rowSpacing))
        providerLayout {
            ForEach(Array(model.displayedProviders.enumerated()), id: \.element.id) { index, provider in
                CapacityDockProviderRow(
                    provider: provider,
                    quota: quota(provider),
                    scale: model.scale,
                    gaugeShape: model.preferences.gaugeShape,
                    onClick: { onProviderClick(provider) }
                )
                .frame(
                    width: model.isVertical ? model.railWidth : model.rowHeight,
                    height: model.isVertical ? model.rowHeight : model.railWidth
                )
                .opacity(model.presentationOpacity(for: provider))
                .offset(
                    x: model.isVertical || provider == model.preferences.preferredProvider
                        ? 0
                        : -8 * model.scale * (1 - model.railPresentationProgress),
                    y: !model.isVertical || provider == model.preferences.preferredProvider
                        ? 0
                        : -8 * model.scale * (1 - model.railPresentationProgress)
                )
            }
        }
        .padding(.top, model.isVertical ? model.railAlongPad : model.railCrossPad)
        .padding(.bottom, model.isVertical ? model.railAlongPad : model.railCrossPad)
        .padding(.leading, model.isVertical ? model.railCrossPad : model.railAlongPad)
        .padding(.trailing, model.isVertical ? model.railCrossPad : model.railAlongPad)
        // Keep the preferred row pinned to the reveal origin. Without an
        // explicit axis alignment, SwiftUI centers the already-expanded stack
        // inside the interpolating frame and makes the first ring look as if it
        // is being redrawn from the middle with the incoming rows.
        .frame(
            width: model.bodySize.width,
            height: model.bodySize.height,
            alignment: revealAlignment
        )
        .frame(
            width: model.panelSize.width,
            height: model.panelSize.height,
            alignment: contentAlignment
        )
        .background(CapacityDockSurface(shape: railShape, theme: model.preferences.theme))
        .clipShape(railShape)
        .overlay {
            if model.preferences.theme == .graphite {
                railShape
                    .stroke(
                        LinearGradient(
                            stops: [
                                .init(color: .white.opacity(0.05), location: 0),
                                .init(color: .white.opacity(0.09), location: 0.55),
                                .init(color: .white.opacity(0.14), location: 0.86),
                                .init(color: .white.opacity(0.08), location: 1),
                            ],
                            startPoint: .top,
                            endPoint: .bottom
                        ),
                        lineWidth: max(0.6, model.scale * 0.8)
                    )
            }
        }
        .clipShape(railShape)
        .contentShape(railShape)
        .contextMenu {
            Menu("Dock to Edge") {
                Button("Left") { onDock(.left) }
                Button("Right") { onDock(.right) }
                Button("Top") { onDock(.top) }
                Button("Bottom") { onDock(.bottom) }
            }
            Button("Hide Capacity Dock", action: onHide)
        }
        .simultaneousGesture(
            DragGesture(minimumDistance: 3, coordinateSpace: .global)
                .onChanged { onDragChanged(NSEvent.mouseLocation, $0.translation) }
                .onEnded { _ in onDragEnded() }
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Capacity Dock")
    }

    private var contentAlignment: Alignment {
        switch model.attachmentEdge {
        case .left: .trailing
        case .right: .leading
        case .top: .bottom
        case .bottom: .top
        }
    }

    private var revealAlignment: Alignment {
        if model.isVertical {
            return model.expansionAnchor == .start ? .top : .bottom
        }
        return model.expansionAnchor == .start ? .leading : .trailing
    }
}

private struct CapacityDockProviderRow: View {
    let provider: CapacityDockProvider
    let quota: QuotaSummary?
    let scale: CGFloat
    let gaugeShape: CapacityDockGaugeShape
    let onClick: () -> Void

    private var headline: QuotaSummary.Window? { quota?.headlineWindow }
    private var percent: Double? { headline?.percent }

    var body: some View {
        Button(action: onClick) {
            VStack(spacing: CapacityDockMetrics.ringLabelSpacing(scale: scale)) {
                ZStack {
                    CapacityDockUsageRing(
                        progress: percent,
                        color: headlineRingColor,
                        scale: scale,
                        gaugeShape: gaugeShape
                    )

                    if let image = ProviderIconCache.image(named: provider.iconName) {
                        Image(nsImage: image)
                            .resizable()
                            .scaledToFit()
                            .foregroundStyle(.white)
                            .frame(
                                width: CapacityDockMetrics.providerIconSize(scale: scale),
                                height: CapacityDockMetrics.providerIconSize(scale: scale)
                            )
                    } else {
                        Image(systemName: "circle.dotted")
                            .font(.system(size: 21 * scale, weight: .medium))
                            .foregroundStyle(.white)
                    }

                    if case .terminalFailure = quota?.connection {
                        Image(systemName: "exclamationmark.circle.fill")
                            .font(.system(size: 12 * scale, weight: .bold))
                            .foregroundStyle(.red)
                            .background(Circle().fill(.black))
                            .offset(x: 19 * scale, y: -19 * scale)
                    }
                }
                .frame(
                    width: CapacityDockMetrics.ringSize(scale: scale),
                    height: CapacityDockMetrics.ringSize(scale: scale)
                )

                Text(headline?.percentLabel ?? "--")
                    .font(.system(
                        size: CapacityDockMetrics.percentageTextSize(scale: scale),
                        weight: .medium
                    ))
                    .monospacedDigit()
                    .foregroundStyle(headlinePercentColor)
                    .contentTransition(.numericText())
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(provider.displayName) usage")
        .accessibilityValue(headline?.percentLabel ?? "Unknown")
        .accessibilityHint("Click to keep Capacity Dock expanded")
    }

    private var headlinePercentColor: Color {
        guard let percent else { return Color.capacityDockText.opacity(0.72) }
        switch QuotaSummary.severity(for: percent) {
        case .normal: return Color.capacityDockText
        case .warning: return .yellow
        case .critical: return .orange
        case .danger: return .red
        }
    }

    // The ring reflects the weekly (else monthly) limit's status, not a brand
    // colour: green while there is headroom, stepping to red as it is exhausted.
    private var headlineRingColor: Color {
        guard let percent else { return Color.capacityDockText.opacity(0.35) }
        switch QuotaSummary.severity(for: percent) {
        case .normal: return .green
        case .warning: return .yellow
        case .critical: return .orange
        case .danger: return .red
        }
    }
}

private struct CapacityDockUsageRing: View {
    let progress: Double?
    let color: Color
    let scale: CGFloat
    let gaugeShape: CapacityDockGaugeShape

    private var strokeWidth: CGFloat {
        CapacityDockMetrics.ringStrokeWidth(scale: scale)
    }

    var body: some View {
        ZStack {
            // A recessed track makes the progress read as light filling a
            // physical channel instead of a flat vector stroke.
            CapacityDockGaugePath(kind: gaugeShape)
                .stroke(Color.black.opacity(0.74), lineWidth: strokeWidth + 2 * scale)
            CapacityDockGaugePath(kind: gaugeShape)
                .stroke(
                    LinearGradient(
                        colors: [.white.opacity(0.16), .white.opacity(0.07), .white.opacity(0.12)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    ),
                    lineWidth: strokeWidth + 0.6 * scale
                )

            if let progress {
                let amount = min(max(progress, 0), 1)
                // Plain solid progress arc, no neon glow or gradient sheen.
                CapacityDockGaugePath(kind: gaugeShape)
                    .trim(from: 0, to: amount)
                    .stroke(
                        color,
                        style: StrokeStyle(lineWidth: strokeWidth, lineCap: .round)
                    )
                    .rotationEffect(.degrees(-90))
            } else {
                CapacityDockGaugePath(kind: gaugeShape)
                    .stroke(
                        Color.white.opacity(0.24),
                        style: StrokeStyle(
                            lineWidth: 2 * scale,
                            dash: [3 * scale, 4 * scale]
                        )
                    )
            }
        }
    }
}

struct CapacityDockGaugePath: Shape {
    let kind: CapacityDockGaugeShape

    func path(in rect: CGRect) -> Path {
        switch kind {
        case .circle:
            Path(ellipseIn: rect)
        case .squircle:
            RoundedRectangle(
                cornerRadius: min(rect.width, rect.height) * 0.30,
                style: .continuous
            )
            .path(in: rect)
        }
    }
}

enum CapacityDockQuotaPresentation {
    static func displayLabel(_ label: String) -> String {
        label
            .replacingOccurrences(of: "Claude and GPT models", with: "Claude + GPT", options: .caseInsensitive)
            .replacingOccurrences(of: "Gemini Models", with: "Gemini", options: .caseInsensitive)
            .replacingOccurrences(of: "Five-hour", with: "5-hour", options: .caseInsensitive)
    }

    static func visibleFooterLines(
        _ lines: [String],
        connection: QuotaSummary.Connection
    ) -> [String] {
        guard case let .terminalFailure(reason) = connection,
              let reason,
              !reason.isEmpty else { return lines }
        let normalizedReason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        return lines.filter {
            $0.trimmingCharacters(in: .whitespacesAndNewlines)
                .localizedCaseInsensitiveCompare(normalizedReason) != .orderedSame
        }
    }
}

struct CapacityDockDetailView: View {
    let model: CapacityDockViewModel
    let quota: (CapacityDockProvider) -> QuotaSummary?
    let onConnect: (CapacityDockProvider) -> Void
    @Environment(AppStore.self) private var store

    var body: some View {
        let bubbleShape = CapacityDockBubbleShape(
            tailEdge: model.detailTailEdge,
            tailPosition: model.detailTailPosition
        )
        Group {
            if let provider = model.hoveredProvider {
                detail(for: provider, quota: quota(provider))
            }
        }
        .padding(detailInsets)
        .frame(
            width: model.detailWidth,
            height: model.detailHeight,
            alignment: .topLeading
        )
        .background(CapacityDockSurface(shape: bubbleShape, theme: model.preferences.theme))
        .overlay {
            if model.preferences.theme == .graphite {
                bubbleShape
                    .stroke(Color.white.opacity(0.09), lineWidth: max(0.5, model.detailScale))
            }
        }
        .contentShape(bubbleShape)
        .accessibilityElement(children: .contain)
    }

    private var detailInsets: EdgeInsets {
        let tailAllowance = CapacityDockGlance.tailAllowance * model.detailScale
        // Every section carries its own padding, so the panel adds only the tail's
        // allowance on whichever side the tail points.
        return EdgeInsets(
            top: model.detailTailEdge == .top ? tailAllowance : 0,
            leading: model.detailTailEdge == .left ? tailAllowance : 0,
            bottom: model.detailTailEdge == .bottom ? tailAllowance : 0,
            trailing: model.detailTailEdge == .right ? tailAllowance : 0
        )
    }

    @ViewBuilder
    private func detail(for provider: CapacityDockProvider, quota: QuotaSummary?) -> some View {
        if let quota {
            glance(for: provider, quota: quota)
        } else {
            VStack(alignment: .leading, spacing: 11 * model.detailScale) {
                header(provider, plan: nil)
                Text(ProviderConnectionGuidance.dockInstruction(for: provider))
                    .font(.system(size: 12))
                    .foregroundStyle(Color.capacityDockText.opacity(0.62))
                    .fixedSize(horizontal: false, vertical: true)
                connectButton(provider, quota: nil)
            }
        }
    }

    /// Sections stack at fixed heights that mirror `CapacityDockMetrics.detailHeight`,
    /// because the panel frame is computed rather than fitted. Separators are
    /// overlays so a hairline never adds a point the height did not reserve.
    @ViewBuilder
    private func glance(for provider: CapacityDockProvider, quota: QuotaSummary) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            headerSection(provider, plan: quota.planLabel).dividerBelow()
            noticeSection(quota.connection, provider: provider)
            if !CapacityDockGlance.drawsNotice(quota.connection) {
                connectionLabel(quota.connection, provider: provider)
            }
            if let sessions = store.capacityDockLiveSessions(for: provider) {
                sessionsSection(sessions).dividerBelow()
            }
            if let today = store.capacityDockToday(for: provider) {
                todaySection(today).dividerBelow()
            }
            if CapacityDockGlance.drawsWindows(quota) { windowsSection(quota) }
            Spacer(minLength: 0)
            connectButton(provider, quota: quota)
        }
    }

    @ViewBuilder
    private func headerSection(_ provider: CapacityDockProvider, plan: String?) -> some View {
        let s = model.detailScale
        header(provider, plan: plan)
            .padding(.top, CapacityDockGlance.contentInset * s)
            .padding(.bottom, 8 * s)
            .padding(.horizontal, CapacityDockGlance.contentInset * s)
    }

    /// The notice carries the same horizontal inset as every other section, its own
    /// vertical padding, and a divider, so it reads as a band rather than as text
    /// crammed against the header.
    @ViewBuilder
    private func noticeSection(
        _ connection: QuotaSummary.Connection,
        provider: CapacityDockProvider
    ) -> some View {
        let s = model.detailScale
        if CapacityDockGlance.drawsNotice(connection) {
            connectionLabel(connection, provider: provider)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 6 * s)
                .padding(.bottom, 8 * s)
                .padding(.horizontal, CapacityDockGlance.contentInset * s)
                .dividerBelow()
        }
    }

    @ViewBuilder
    private func header(_ provider: CapacityDockProvider, plan: String?) -> some View {
        let s = model.detailScale
        HStack(spacing: 8 * s) {
            if let image = ProviderIconCache.image(named: provider.iconName) {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFit()
                    // Matches the 17pt title's cap height plus a little, so the
                    // mark reads as its equal rather than as a bullet.
                    .frame(width: 18 * s, height: 18 * s)
            }
            Text(provider.displayName)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Color.capacityDockText)
            Spacer(minLength: 6)
            if let plan, !plan.isEmpty {
                Text(plan)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(Color.capacityDockText.opacity(0.6))
                    .lineLimit(1)
            }
        }
        .frame(height: 20 * s)
    }

    @ViewBuilder
    private func sectionCaption(_ title: String, trailing: String?) -> some View {
        let s = model.detailScale
        HStack(spacing: 8 * s) {
            Text(title)
                .font(.system(size: 10.5, weight: .semibold))
            if let trailing {
                Spacer(minLength: 8)
                Text(trailing)
                    .font(.system(size: 10.5))
                    .monospacedDigit()
            }
        }
        .foregroundStyle(Color.capacityDockText.opacity(0.6))
        .frame(height: CapacityDockGlance.captionLine * s)
    }

    @ViewBuilder
    private func sessionsSection(_ sessions: [LiveSession]) -> some View {
        let s = model.detailScale
        VStack(alignment: .leading, spacing: 0) {
            sectionCaption("Sessions", trailing: sessionsTrailing(sessions.count))
            if !sessions.isEmpty {
                ScrollView(.vertical) {
                    VStack(spacing: CapacityDockGlance.pillGap * s) {
                        ForEach(sessions) { session in
                            sessionPill(session)
                        }
                    }
                }
                .scrollIndicators(.automatic)
                .frame(height: CapacityDockGlance.sessionListHeight(count: sessions.count) * s)
                .padding(.top, CapacityDockGlance.pillGap * s)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, CapacityDockGlance.sectionPadTop * s)
        .padding(.bottom, CapacityDockGlance.sectionPadBottom * s)
        .padding(.horizontal, CapacityDockGlance.contentInset * s)
    }

    private func sessionsTrailing(_ count: Int) -> String {
        switch count {
        case 0: return "none running"
        case 1: return "1 running"
        default: return "\(count) running"
        }
    }

    @ViewBuilder
    private func sessionPill(_ session: LiveSession) -> some View {
        let s = model.detailScale
        let fraction = session.contextFraction
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 2 * s) {
                Text(session.title)
                    .font(.system(size: 12))
                    .foregroundStyle(Color.capacityDockText)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(height: 15 * s)
                Text(sessionSubtitle(session))
                    .font(.system(size: 10.5))
                    .monospacedDigit()
                    .foregroundStyle(Color.capacityDockText.opacity(0.6))
                    .lineLimit(1)
                    .frame(height: 13 * s)
                    // The model name identifies the row, so the project above it
                    // gives up width first.
                    .layoutPriority(1)
            }
            Spacer(minLength: 12)
            if let fraction {
                VStack(alignment: .trailing, spacing: 2 * s) {
                    PercentGaugeText(
                        label: "\(Int((fraction * 100).rounded()))%",
                        fraction: fraction,
                        font: .system(size: 12)
                    )
                    .frame(height: 15 * s)
                    if let remaining = session.contextRemaining {
                        Text("\(Double(remaining).asCompactTokens().lowercasedThousands()) left")
                            .font(.system(size: 10))
                            .monospacedDigit()
                            .foregroundStyle(Color.capacityDockText.opacity(0.6))
                            .frame(height: 13 * s)
                    }
                }
                .layoutPriority(1)
            }
        }
        .padding(.vertical, 8 * s)
        .padding(.horizontal, 12 * s)
        .frame(height: CapacityDockGlance.pillHeight * s)
        .background(
            ZStack(alignment: .leading) {
                Color.white.opacity(0.06)
                if let fraction {
                    GeometryReader { geometry in
                        pillFill(fraction: fraction, width: geometry.size.width, scale: s)
                    }
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 8 * s, style: .continuous))
        )
        // A session waiting on the user recedes; one that is generating does not.
        .opacity(session.isIdle ? 0.55 : 1)
    }

    /// The pill itself is the context gauge: a tinted band over the first N% of
    /// its width, faded out at the leading edge so the boundary reads as a
    /// gradient rather than a rule.
    @ViewBuilder
    private func pillFill(fraction: Double, width: CGFloat, scale: CGFloat) -> some View {
        let filled = width * CapacityDockGlance.gaugeFillFraction(fraction)
        let colour = CapacityDockGlance.severityColor(fraction)
        LinearGradient(
            stops: [
                .init(color: colour.opacity(0.14), location: 0),
                .init(
                    color: colour.opacity(0.14),
                    location: CapacityDockGlance.pillFadeStart(filledWidth: filled, scale: scale)
                ),
                .init(color: colour.opacity(0), location: 1),
            ],
            startPoint: .leading,
            endPoint: .trailing
        )
        .frame(width: filled)
    }

    private func sessionSubtitle(_ session: LiveSession) -> String {
        [session.model, session.elapsedLabel().isEmpty ? nil : session.elapsedLabel()]
            .compactMap { $0 }
            .joined(separator: " · ")
    }

    @ViewBuilder
    /// Provider scoped: the row belongs to the hovered provider, not the machine.
    /// Its height is the same whether or not the payload carried that provider's
    /// tokens — the column drops out of a fixed frame, so the panel's reserved
    /// `todayHeight` keeps matching what is drawn.
    private func todaySection(_ today: ProviderDetail) -> some View {
        let s = model.detailScale
        VStack(alignment: .leading, spacing: 0) {
            sectionCaption("Today", trailing: nil)
            HStack(alignment: .center, spacing: 8 * s) {
                HStack(alignment: .firstTextBaseline, spacing: 5 * s) {
                    Text(today.cost.asCompactCurrency())
                        .font(.system(size: 17, weight: .semibold))
                        .monospacedDigit()
                        .foregroundStyle(Color.capacityDockText)
                    Text("burned")
                        .font(.system(size: 11.5))
                        .foregroundStyle(Color.capacityDockText.opacity(0.6))
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 3 * s) {
                    // Absent on a CLI that predates per-provider tokens. Showing
                    // the machine-wide pair here would be a wrong number, so the
                    // arrows drop out instead.
                    if let input = today.inputTokens { tokenLine("arrow.down", Double(input)) }
                    if let output = today.outputTokens { tokenLine("arrow.up", Double(output)) }
                    Text("\(today.calls.asThousandsSeparated()) calls")
                        .font(.system(size: 10))
                        .monospacedDigit()
                        .foregroundStyle(Color.capacityDockText.opacity(0.6))
                        .frame(height: 12 * s)
                }
            }
            .frame(height: CapacityDockGlance.todayContentHeight * s)
            .padding(.top, CapacityDockGlance.pillGap * s)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, CapacityDockGlance.sectionPadTop * s)
        .padding(.bottom, CapacityDockGlance.sectionPadBottom * s)
        .padding(.horizontal, CapacityDockGlance.contentInset * s)
    }

    @ViewBuilder
    private func tokenLine(_ symbol: String, _ value: Double) -> some View {
        let s = model.detailScale
        HStack(spacing: 4 * s) {
            Image(systemName: symbol)
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(Color.capacityDockText.opacity(0.6))
            Text(value.asCompactTokens().lowercasedThousands())
                .font(.system(size: 10.5))
                .monospacedDigit()
                .foregroundStyle(Color.capacityDockText)
        }
        .frame(height: 13 * s)
    }

    /// One column per quota window, in the order the provider reported them.
    @ViewBuilder
    private func windowsSection(_ quota: QuotaSummary) -> some View {
        let s = model.detailScale
        let windows = CapacityDockGlance.windows(quota)
        Group {
            if windows.isEmpty {
                budgetLine()
                    .frame(height: CapacityDockGlance.captionLine * s)
            } else {
                // A single window has no siblings to line up with, so it reads as
                // a left-aligned figure rather than a lone centred digit.
                let alignment: HorizontalAlignment = windows.count == 1 ? .leading : .center
                HStack(spacing: 0) {
                    ForEach(Array(windows.enumerated()), id: \.offset) { _, window in
                        windowColumn(window, alignment: alignment)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, CapacityDockGlance.sectionPadTop * s)
        .padding(.bottom, CapacityDockGlance.contentInset * s)
        .padding(.horizontal, CapacityDockGlance.contentInset * s)
    }

    @ViewBuilder
    private func windowColumn(
        _ window: QuotaSummary.Window,
        alignment: HorizontalAlignment
    ) -> some View {
        let s = model.detailScale
        VStack(alignment: alignment, spacing: 0) {
            PercentGaugeText(
                label: window.percentLabel,
                fraction: window.percent,
                font: .system(size: 20, weight: .semibold)
            )
            .frame(height: 24 * s)
            Text(CapacityDockQuotaPresentation.displayLabel(window.label))
                .font(.system(size: 11))
                .foregroundStyle(Color.capacityDockText.opacity(0.6))
                .lineLimit(1)
                .frame(height: CapacityDockGlance.captionLine * s)
                .padding(.top, 2 * s)
            Text(window.resetsInLabel)
                .font(.system(size: 10))
                .monospacedDigit()
                .foregroundStyle(Color.capacityDockText.opacity(0.3))
                .lineLimit(1)
                .frame(height: 12 * s)
                .padding(.top, 2 * s)
        }
        .frame(
            maxWidth: .infinity,
            alignment: alignment == .leading ? .leading : .center
        )
    }

    /// No quota window exists for this provider, so money is the capacity.
    @ViewBuilder
    private func budgetLine() -> some View {
        let spend = store.capacityDockToday?.cost ?? 0
        let budget = store.activeDailyBudget
        Text(budget > 0 ? L("today \(spend.asCompactCurrency()) of \(budget.asCompactCurrency())") : L("no budget set"))
            .font(.system(size: 11))
            .monospacedDigit()
            .foregroundStyle(Color.capacityDockText.opacity(0.6))
    }

    @ViewBuilder
    private func connectButton(_ provider: CapacityDockProvider, quota: QuotaSummary?) -> some View {
        if provider.catalogEntry.hasLiveCodeBurnQuotaAdapter,
           let action = CapacityDockConnectionAction.resolve(quota: quota) {
            let title = action.title(for: provider)
            Button(title) { onConnect(provider) }
                .buttonStyle(.borderedProminent)
                .tint(provider.ringColor)
                .controlSize(.small)
                .accessibilityLabel("\(title) \(provider.displayName)")
        }
    }

    @ViewBuilder
    private func connectionLabel(
        _ connection: QuotaSummary.Connection,
        provider: CapacityDockProvider
    ) -> some View {
        switch connection {
        case .connected:
            EmptyView()
        case .loading:
            Text("Refreshing…")
                .font(.system(size: 10))
                .foregroundStyle(Color.capacityDockText.opacity(0.52))
        case .stale:
            Text("Last known usage · refreshing")
                .font(.system(size: 10))
                .foregroundStyle(.yellow.opacity(0.82))
        case .transientFailure:
            Text("Last known usage · retrying")
                .font(.system(size: 10))
                .foregroundStyle(.orange.opacity(0.86))
        case .disconnected:
            Text("Not connected")
                .font(.system(size: 11))
                .foregroundStyle(Color.capacityDockText.opacity(0.6))
        case .terminalFailure(let reason):
            VStack(alignment: .leading, spacing: 3 * model.detailScale) {
                Text("Reconnect required")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.red)
                if let reason, !reason.isEmpty {
                    Text(reason)
                        .font(.system(size: 10))
                        .foregroundStyle(Color.capacityDockText.opacity(0.58))
                        .lineLimit(2)
                }
                Text(ProviderConnectionGuidance.dockInstruction(for: provider))
                    .font(.system(size: 10))
                    .foregroundStyle(Color.capacityDockText.opacity(0.72))
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// A percentage drawn as its own gauge: the glyphs sit dim, and the value's own
/// severity colour fills them left to right up to the value, wiped off on a
/// slant. One band colour, so the fill says how bad it is and the wipe says how
/// far along it is.
private struct PercentGaugeText: View {
    let label: String
    let fraction: Double
    let font: Font

    var body: some View {
        Text(label)
            .font(font)
            .monospacedDigit()
            .foregroundStyle(Color.white.opacity(0.3))
            .overlay {
                CapacityDockGlance.severityColor(fraction)
                    .clipShape(PercentGaugeReveal(fraction: fraction))
                    .mask {
                        Text(label)
                            .font(font)
                            .monospacedDigit()
                    }
            }
            .accessibilityLabel(label)
    }
}

/// The slanted wipe. An overlay clip only, so it never changes layout size.
private struct PercentGaugeReveal: Shape {
    var fraction: Double

    var animatableData: Double {
        get { fraction }
        set { fraction = newValue }
    }

    func path(in rect: CGRect) -> Path {
        let edge = CapacityDockGlance.gaugeRevealEdge(
            fraction: fraction,
            width: rect.width,
            height: rect.height
        )
        guard edge.bottom > 0 else { return Path() }
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.minX + edge.top, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.minX + edge.bottom, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
        path.closeSubpath()
        return path
    }
}

private struct CapacityDockSurface<S: Shape>: View {
    let shape: S
    let theme: CapacityDockTheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    @ViewBuilder
    var body: some View {
        if theme == .liquidGlass, !reduceTransparency {
            if #available(macOS 26.0, *) {
                CapacityDockNativeGlassSurface(shape: shape)
            } else {
                shape
                    .fill(.ultraThinMaterial)
                    .overlay(shape.fill(Color.black.opacity(0.16)))
            }
        } else {
            ZStack {
                shape.fill(
                    LinearGradient(
                        stops: [
                            .init(color: Color(red: 0.075, green: 0.078, blue: 0.085), location: 0),
                            .init(color: Color(red: 0.034, green: 0.035, blue: 0.040), location: 0.46),
                            .init(color: Color(red: 0.012, green: 0.013, blue: 0.016), location: 1),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                shape.fill(
                    RadialGradient(
                        colors: [.white.opacity(0.055), .clear],
                        center: .topLeading,
                        startRadius: 0,
                        endRadius: 180
                    )
                )
            }
        }
    }
}

@available(macOS 26.0, *)
private struct CapacityDockNativeGlassSurface<S: Shape>: View {
    let shape: S

    var body: some View {
        Color.clear
            .glassEffect(.regular.interactive(), in: shape)
            // Native glass tracks the wallpaper, so over a light background it
            // turns pale and the light text disappears. A gentle dark scrim keeps
            // the surface dark enough for the labels on any background while still
            // reading as glass.
            .overlay(shape.fill(Color.black.opacity(0.24)))
    }
}

struct CapacityDockRailShape: Shape {
    var bodyWidth: CGFloat
    var bodyLength: CGFloat? = nil
    var shoulderDepth: CGFloat = 34
    var attachmentProgress: CGFloat
    var edge: CapacityDockEdge

    var animatableData: CGFloat {
        get { attachmentProgress }
        set { attachmentProgress = newValue }
    }

    func path(in rect: CGRect) -> Path {
        let canonicalRect = CGRect(
            x: 0,
            y: 0,
            width: edge.isVertical ? rect.width : rect.height,
            height: edge.isVertical ? rect.height : rect.width
        )
        let canonical = rightFlarePath(in: canonicalRect)
        let transform: CGAffineTransform
        switch edge {
        case .right:
            transform = CGAffineTransform(translationX: rect.minX, y: rect.minY)
        case .left:
            transform = CGAffineTransform(
                a: -1,
                b: 0,
                c: 0,
                d: 1,
                tx: canonicalRect.width + rect.minX,
                ty: rect.minY
            )
        case .bottom:
            transform = CGAffineTransform(
                a: 0,
                b: 1,
                c: 1,
                d: 0,
                tx: rect.minX,
                ty: rect.minY
            )
        case .top:
            transform = CGAffineTransform(
                a: 0,
                b: -1,
                c: 1,
                d: 0,
                tx: rect.minX,
                ty: canonicalRect.width + rect.minY
            )
        }
        return canonical.applying(transform)
    }

    private func rightFlarePath(in rect: CGRect) -> Path {
        let progress = min(max(attachmentProgress, 0), 1)
        let eased = progress * progress * (3 - 2 * progress)
        // The system-notch technique (Helm / notchi): one quad curve per corner,
        // control point at the corner. Free (left) side has convex rounded
        // corners; the contact (right) side necks concavely into the touched
        // edge when docked. Depth scales with panel length and is clamped below
        // half of it, so a short single-item rail necks gently and never lets the
        // two shoulders meet or swallow the gauge.
        // freeR: convex rounded corners on the free (left) side. contactR: the
        // small concave flare where the body necks out to the flush contact
        // (right) edge — the body is inset from top and bottom by contactR, and
        // the flare connects that inset to the flush corner (Helm's structure).
        let freeR = min(22, rect.height / 2, bodyWidth * 0.45)
        // Not attached to an edge: a plain rounded pill, every corner rounded.
        // The concave contact-edge flares only exist once docked.
        if eased < 0.5 {
            return Path(roundedRect: rect, cornerRadius: freeR)
        }
        let contactR = min(shoulderDepth * 0.6, rect.height * 0.22, max(0, rect.height / 2 - freeR)) * eased

        var path = Path()
        // Flush top-right corner, then concave flare into the inset body top
        path.move(to: CGPoint(x: rect.maxX, y: rect.minY))
        path.addQuadCurve(
            to: CGPoint(x: rect.maxX - contactR, y: rect.minY + contactR),
            control: CGPoint(x: rect.maxX, y: rect.minY + contactR)
        )
        // Body top edge to the free-side top corner (convex)
        path.addLine(to: CGPoint(x: rect.minX + freeR, y: rect.minY + contactR))
        path.addQuadCurve(
            to: CGPoint(x: rect.minX, y: rect.minY + contactR + freeR),
            control: CGPoint(x: rect.minX, y: rect.minY + contactR)
        )
        // Free (left) edge down to the bottom-left corner (convex)
        path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY - contactR - freeR))
        path.addQuadCurve(
            to: CGPoint(x: rect.minX + freeR, y: rect.maxY - contactR),
            control: CGPoint(x: rect.minX, y: rect.maxY - contactR)
        )
        // Body bottom edge, then concave flare out to the flush bottom-right
        path.addLine(to: CGPoint(x: rect.maxX - contactR, y: rect.maxY - contactR))
        path.addQuadCurve(
            to: CGPoint(x: rect.maxX, y: rect.maxY),
            control: CGPoint(x: rect.maxX, y: rect.maxY - contactR)
        )
        // Flush contact (right) edge back up to the start
        path.closeSubpath()
        return path
    }
}

struct CapacityDockBubbleShape: Shape {
    let tailEdge: CapacityDockEdge
    var tailPosition: CGFloat = 0.5

    func path(in rect: CGRect) -> Path {
        let canonicalRect = CGRect(
            x: 0,
            y: 0,
            width: tailEdge.isVertical ? rect.width : rect.height,
            height: tailEdge.isVertical ? rect.height : rect.width
        )
        let canonical = rightTailPath(in: canonicalRect)
        let transform: CGAffineTransform
        switch tailEdge {
        case .right:
            transform = CGAffineTransform(translationX: rect.minX, y: rect.minY)
        case .left:
            transform = CGAffineTransform(
                a: -1,
                b: 0,
                c: 0,
                d: 1,
                tx: canonicalRect.width + rect.minX,
                ty: rect.minY
            )
        case .bottom:
            transform = CGAffineTransform(
                a: 0,
                b: 1,
                c: 1,
                d: 0,
                tx: rect.minX,
                ty: rect.minY
            )
        case .top:
            transform = CGAffineTransform(
                a: 0,
                b: -1,
                c: 1,
                d: 0,
                tx: rect.minX,
                ty: canonicalRect.width + rect.minY
            )
        }
        return canonical.applying(transform)
    }

    private func rightTailPath(in rect: CGRect) -> Path {
        var path = Path()
        let tailWidth = min(22, max(14, rect.width * 0.055))
        let bodyRight = rect.maxX - tailWidth
        let radius = min(20, rect.height * 0.18)
        let midY = rect.minY + rect.height * min(max(tailPosition, 0.18), 0.82)
        let neckHalfHeight = min(32, rect.height * 0.19)

        path.move(to: CGPoint(x: radius, y: rect.minY))
        path.addLine(to: CGPoint(x: bodyRight - radius, y: rect.minY))
        path.addQuadCurve(
            to: CGPoint(x: bodyRight, y: rect.minY + radius),
            control: CGPoint(x: bodyRight, y: rect.minY)
        )
        path.addLine(to: CGPoint(x: bodyRight, y: midY - neckHalfHeight))
        path.addCurve(
            to: CGPoint(x: rect.maxX, y: midY),
            control1: CGPoint(x: bodyRight, y: midY - neckHalfHeight * 0.55),
            control2: CGPoint(x: rect.maxX, y: midY - tailWidth * 0.42)
        )
        path.addCurve(
            to: CGPoint(x: bodyRight, y: midY + neckHalfHeight),
            control1: CGPoint(x: rect.maxX, y: midY + tailWidth * 0.42),
            control2: CGPoint(x: bodyRight, y: midY + neckHalfHeight * 0.55)
        )
        path.addLine(to: CGPoint(x: bodyRight, y: rect.maxY - radius))
        path.addQuadCurve(
            to: CGPoint(x: bodyRight - radius, y: rect.maxY),
            control: CGPoint(x: bodyRight, y: rect.maxY)
        )
        path.addLine(to: CGPoint(x: radius, y: rect.maxY))
        path.addQuadCurve(
            to: CGPoint(x: rect.minX, y: rect.maxY - radius),
            control: CGPoint(x: rect.minX, y: rect.maxY)
        )
        path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + radius))
        path.addQuadCurve(
            to: CGPoint(x: radius, y: rect.minY),
            control: CGPoint(x: rect.minX, y: rect.minY)
        )
        path.closeSubpath()
        return path
    }
}

private extension CapacityDockProvider {
    var ringColor: Color {
        switch self {
        case .claude: return Color(red: 0.98, green: 0.31, blue: 0.08)
        case .codex: return Color(red: 0.12, green: 0.87, blue: 0.55)
        case .gemini: return Color(red: 0.28, green: 0.55, blue: 0.98)
        case .copilot: return Color(red: 0.58, green: 0.48, blue: 0.96)
        case .kimiCode: return Color(red: 0.90, green: 0.94, blue: 0.08)
        case .antigravity: return Color(red: 1.0, green: 0.48, blue: 0.27)
        default:
            // Stable CodeBurn-owned accents keep generated provider sigils
            // recognizable without importing a branding registry.
            let seed = rawValue.utf8.reduce(UInt64(2_166_136_261)) { value, byte in
                (value ^ UInt64(byte)) &* 16_777_619
            }
            return Color(
                hue: Double(seed % 360) / 360,
                saturation: 0.72,
                brightness: 0.94
            )
        }
    }
}
