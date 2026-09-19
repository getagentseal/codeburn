import CoreGraphics
import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("Capacity Dock presentation")
struct CapacityDockPresentationTests {
    @Test("Reference-scale rail uses compact instrument proportions")
    func compactRailMetrics() {
        #expect(CapacityDockMetrics.railWidth(scale: 1) == 88)
        #expect(CapacityDockMetrics.horizontalRailWidth(scale: 1) == 106)
        #expect(CapacityDockMetrics.edgeFlareWidth(scale: 1) == 22)
        #expect(CapacityDockMetrics.edgeShoulderDepth(scale: 1) == 52)
        #expect(CapacityDockMetrics.rowHeight(scale: 1) == 84)
        #expect(CapacityDockMetrics.rowSpacing(scale: 1) == 12)
        #expect(CapacityDockMetrics.railAlongPad(scale: 1) == 20)
        #expect(CapacityDockMetrics.railCrossPad(scale: 1) == 12)
        #expect(CapacityDockMetrics.ringSize(scale: 1) == 52)
        #expect(CapacityDockMetrics.ringStrokeWidth(scale: 1) == 4)
        #expect(CapacityDockMetrics.ringLabelSpacing(scale: 1) == 6)
        #expect(CapacityDockMetrics.providerIconSize(scale: 1) == 26)
        #expect(CapacityDockMetrics.percentageTextSize(scale: 1) == 17)
    }

    @MainActor
    @Test("rail body length follows presentation progress instead of snapping to interaction state")
    func presentationLengthInterpolates() {
        let suite = "CodeBurnMenubarTests.CapacityDock.Presentation.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        CapacityDockPreferences.setSelectedProviders([.codex, .claude, .gemini], defaults: defaults)
        let model = CapacityDockViewModel(preferences: CapacityDockPreferences.load(defaults: defaults))
        model.interaction.setRailHovered(true)
        model.isRailPresentationExpanded = true
        model.railPresentationProgress = 0.5

        let resting = CapacityDockMetrics.railHeight(providerCount: 1, alongPad: model.railAlongPad, scale: model.scale)
        let expanded = CapacityDockMetrics.railHeight(providerCount: 3, alongPad: model.railAlongPad, scale: model.scale)
        #expect(abs(model.bodyLength - (resting + expanded) / 2) < 0.000_001)
        #expect(model.displayedProviders.first == .codex)
    }

    @MainActor
    @Test("Resting provider stays at the reveal anchor")
    func restingProviderFollowsExpansionAnchor() {
        let suite = "CodeBurnMenubarTests.CapacityDock.AnchorOrder.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        CapacityDockPreferences.setSelectedProviders([.codex, .claude, .gemini], defaults: defaults)
        let model = CapacityDockViewModel(preferences: CapacityDockPreferences.load(defaults: defaults))
        model.isRailPresentationExpanded = true

        model.expansionAnchor = .start
        #expect(model.displayedProviders == [.codex, .claude, .gemini])
        model.expansionAnchor = .end
        #expect(model.displayedProviders == [.gemini, .claude, .codex])
    }

    @MainActor
    @Test("Attachment morphs inside the body without changing the panel size")
    func attachmentKeepsPanelSizeStable() {
        let suite = "CodeBurnMenubarTests.CapacityDock.EdgeSpread.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        CapacityDockPreferences.setScale(1.2, defaults: defaults)
        let model = CapacityDockViewModel(preferences: CapacityDockPreferences.load(defaults: defaults))

        model.attachmentEdge = .right
        let vertical = model.targetPanelSize(forAttachmentProgress: 1)
        #expect(vertical.width == CapacityDockMetrics.railWidth(scale: 1.2))
        #expect(vertical.height == model.targetBodyLength)

        model.attachmentEdge = .top
        let horizontal = model.targetPanelSize(forAttachmentProgress: 1)
        #expect(horizontal.width == model.targetBodyLength)
        #expect(horizontal.height == CapacityDockMetrics.horizontalRailWidth(scale: 1.2))
    }

    @MainActor
    @Test("Supported settled scales and edges compose integral panel dimensions")
    func supportedSettledGeometryIsIntegral() {
        let suite = "CodeBurnMenubarTests.CapacityDock.IntegralGeometry.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        CapacityDockPreferences.setSelectedProviders([.codex, .claude, .gemini], defaults: defaults)

        for step in 0...12 {
            let scale = 0.6 + Double(step) * 0.05
            CapacityDockPreferences.setScale(scale, defaults: defaults)

            for edge in CapacityDockEdge.allCases {
                CapacityDockPreferences.setPlacement(
                    dockedEdge: edge,
                    attachmentEdge: edge,
                    normalizedHorizontalOffset: 0.5,
                    normalizedVerticalOffset: 0.5,
                    defaults: defaults
                )
                let model = CapacityDockViewModel(
                    preferences: CapacityDockPreferences.load(defaults: defaults)
                )

                let resting = model.targetPanelSize(forAttachmentProgress: 1)
                #expect(resting.width.rounded() == resting.width)
                #expect(resting.height.rounded() == resting.height)
                #expect(model.railAlongPad.rounded() == model.railAlongPad)

                model.interaction.setRailHovered(true)
                let expanded = model.targetPanelSize(forAttachmentProgress: 1)
                #expect(expanded.width.rounded() == expanded.width)
                #expect(expanded.height.rounded() == expanded.height)

                #expect(model.detailWidth.rounded() == model.detailWidth)
                // The glance popover's own height is asserted whole across scales by
                // CapacityDockGlanceTests.heightIsAlwaysWhole, against the signature it
                // grew when the glance replaced the old row-counted popover.
            }
        }
    }

    @Test("Docked silhouette flares smoothly into one flush contact chord without horns")
    func dockedRailSilhouette() {
        let path = CapacityDockRailShape(bodyWidth: 88, bodyLength: 356, attachmentProgress: 1, edge: .right)
            .path(in: CGRect(x: 0, y: 0, width: 88, height: 356))

        // Free (left) corners and the necked long-axis ends stay open; the flush
        // contact chord fills the right edge along the body's full-width span.
        #expect(!path.contains(CGPoint(x: 2, y: 2)))
        #expect(!path.contains(CGPoint(x: 2, y: 354)))
        #expect(!path.contains(CGPoint(x: 44, y: 2)))
        #expect(!path.contains(CGPoint(x: 44, y: 354)))
        #expect(path.contains(CGPoint(x: 82, y: 178)))
        #expect(path.contains(CGPoint(x: 82, y: 300)))
        #expect(path.contains(CGPoint(x: 86, y: 30)))
        #expect(path.contains(CGPoint(x: 86, y: 178)))
        #expect(path.contains(CGPoint(x: 86, y: 326)))
    }

    @Test("Meniscus contact grows outward from the center of the attached edge")
    func meniscusContactGrowth() {
        let rect = CGRect(x: 0, y: 0, width: 88, height: 112)
        let detached = CapacityDockRailShape(bodyWidth: 88, attachmentProgress: 0, edge: .right)
            .path(in: rect)
        let halfAttached = CapacityDockRailShape(bodyWidth: 88, attachmentProgress: 0.5, edge: .right)
            .path(in: rect)
        let attached = CapacityDockRailShape(bodyWidth: 88, attachmentProgress: 1, edge: .right)
            .path(in: rect)

        // Detached: a rounded pill — filled across the top center, empty at the corners.
        #expect(detached.contains(CGPoint(x: 44, y: 2)))
        #expect(!detached.contains(CGPoint(x: 86, y: 2)))
        // Half attached: the right edge begins flushing against the surface at center height.
        #expect(halfAttached.contains(CGPoint(x: 86, y: rect.midY)))
        #expect(!halfAttached.contains(CGPoint(x: 86, y: 2)))
        // Fully attached: the contact holds at the center of the edge while the neck
        // pulls the top center away from it.
        #expect(attached.contains(CGPoint(x: 86, y: rect.midY)))
        #expect(!attached.contains(CGPoint(x: 44, y: 2)))
    }

    @Test("Meniscus interpolation changes continuously while staying inside the panel")
    func meniscusInterpolationIsContinuous() {
        let rect = CGRect(x: 0, y: 0, width: 88, height: 112)
        let sampleProgress: [CGFloat] = [0, 0.25, 0.5, 0.75, 1]
        let contactSpans = sampleProgress.map { progress in
            let path = CapacityDockRailShape(
                bodyWidth: 88,
                attachmentProgress: progress,
                edge: .right
            ).path(in: rect)
            return stride(from: 1, through: 111, by: 1).filter { y in
                path.contains(CGPoint(x: 87, y: CGFloat(y)))
            }.count
        }

        // The deepening neck at full attachment settles the near-edge span slightly,
        // so contact is not strictly monotonic; it still grows from detached to
        // attached, every attached state exceeds the detached widget, and each step
        // stays continuous (no jumps).
        #expect(contactSpans.first! < contactSpans.last!)
        #expect(contactSpans.dropFirst(2).allSatisfy { $0 > contactSpans[0] })
        #expect(zip(contactSpans, contactSpans.dropFirst()).allSatisfy { current, next in
            abs(next - current) < 44
        })
    }

    @Test("Detached silhouette retracts into a fully rounded widget")
    func detachedRailSilhouette() {
        let path = CapacityDockRailShape(bodyWidth: 88, attachmentProgress: 0, edge: .right)
            .path(in: CGRect(x: 0, y: 0, width: 88, height: 112))

        #expect(!path.contains(CGPoint(x: 3, y: 3)))
        #expect(!path.contains(CGPoint(x: 85, y: 3)))
        #expect(path.contains(CGPoint(x: 44, y: 3)))
        #expect(path.contains(CGPoint(x: 85, y: 56)))
    }

    @Test("Surface-tension silhouette mirrors across every screen edge")
    func edgeAttachmentMirrors() {
        let right = CapacityDockRailShape(bodyWidth: 88, bodyLength: 356, attachmentProgress: 1, edge: .right)
            .path(in: CGRect(x: 0, y: 0, width: 88, height: 356))
        let left = CapacityDockRailShape(bodyWidth: 88, bodyLength: 356, attachmentProgress: 1, edge: .left)
            .path(in: CGRect(x: 0, y: 0, width: 88, height: 356))
        let top = CapacityDockRailShape(bodyWidth: 88, bodyLength: 356, attachmentProgress: 1, edge: .top)
            .path(in: CGRect(x: 0, y: 0, width: 356, height: 88))
        let bottom = CapacityDockRailShape(bodyWidth: 88, bodyLength: 356, attachmentProgress: 1, edge: .bottom)
            .path(in: CGRect(x: 0, y: 0, width: 356, height: 88))

        // Each edge flushes its contact chord along the full-width span at mid-length
        // while the long-axis ends neck open — so the flush side is identified by a
        // near-edge mid-length point being filled and the free side staying empty.
        #expect(!right.contains(CGPoint(x: 44, y: 2)))
        #expect(right.contains(CGPoint(x: 82, y: 178)))
        #expect(left.contains(CGPoint(x: 2, y: 178)))
        #expect(left.contains(CGPoint(x: 6, y: 300)))
        #expect(!left.contains(CGPoint(x: 86, y: 2)))
        #expect(!left.contains(CGPoint(x: 44, y: 2)))
        #expect(top.contains(CGPoint(x: 178, y: 2)))
        #expect(top.contains(CGPoint(x: 300, y: 6)))
        #expect(!top.contains(CGPoint(x: 2, y: 86)))
        #expect(!top.contains(CGPoint(x: 2, y: 44)))
        #expect(bottom.contains(CGPoint(x: 178, y: 86)))
        #expect(bottom.contains(CGPoint(x: 300, y: 82)))
        #expect(!bottom.contains(CGPoint(x: 2, y: 2)))
        #expect(!bottom.contains(CGPoint(x: 2, y: 44)))
    }

    @MainActor
    @Test("Selected provider identity remains stable throughout reveal and retraction")
    func selectedProviderIdentityStaysStable() {
        let suite = "CodeBurnMenubarTests.CapacityDock.Identity.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        CapacityDockPreferences.setSelectedProviders([.codex, .claude, .gemini], defaults: defaults)
        CapacityDockPreferences.setPreferredProvider(.codex, defaults: defaults)
        let model = CapacityDockViewModel(preferences: CapacityDockPreferences.load(defaults: defaults))
        model.hoveredProvider = .codex
        model.isRailPresentationExpanded = true

        for progress: CGFloat in [0, 0.25, 0.5, 0.75, 1] {
            model.railPresentationProgress = progress
            #expect(model.displayedProviders.first == .codex)
            #expect(model.hoveredProvider == .codex)
        }

        model.isRailPresentationExpanded = false
        model.railPresentationProgress = 0
        #expect(model.displayedProviders == [.codex])
        #expect(model.hoveredProvider == .codex)
    }

    @MainActor
    @Test("Resting provider stays visible when the rail expands toward its start edge")
    func restingProviderNeverFlashesToAnotherIcon() {
        let suite = "CodeBurnMenubarTests.CapacityDock.NoIconFlash.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        CapacityDockPreferences.setSelectedProviders([.codex, .claude, .gemini], defaults: defaults)
        CapacityDockPreferences.setPreferredProvider(.codex, defaults: defaults)
        let model = CapacityDockViewModel(preferences: CapacityDockPreferences.load(defaults: defaults))
        model.isRailPresentationExpanded = true
        model.expansionAnchor = .end
        model.railPresentationProgress = 0

        #expect(model.displayedProviders == [.gemini, .claude, .codex])
        #expect(model.presentationOpacity(for: .codex) == 1)
        #expect(model.presentationOpacity(for: .gemini) == 0)
        #expect(model.presentationOpacity(for: .claude) == 0)
    }

    @Test("Squircle gauge keeps the channel inset while using continuous corners")
    func squircleGaugePath() {
        let rect = CGRect(x: 0, y: 0, width: 52, height: 52)
        let path = CapacityDockGaugePath(kind: .squircle).path(in: rect)

        #expect(path.contains(CGPoint(x: 26, y: 1)))
        #expect(path.contains(CGPoint(x: 1, y: 26)))
        #expect(!path.contains(CGPoint(x: 1, y: 1)))
    }

    @Test("Detail card pointer grows from a broad curved neck")
    func detailPointerNeck() {
        let path = CapacityDockBubbleShape(tailEdge: .right)
            .path(in: CGRect(x: 0, y: 0, width: 350, height: 220))

        #expect(path.contains(CGPoint(x: 331, y: 85)))
        #expect(path.contains(CGPoint(x: 346, y: 110)))
        #expect(path.contains(CGPoint(x: 331, y: 135)))
        #expect(!path.contains(CGPoint(x: 346, y: 80)))
    }

    @Test("Clamped detail pointer remains aligned to the provider row")
    func detailPointerOffset() {
        let rect = CGRect(x: 0, y: 0, width: 350, height: 220)
        let path = CapacityDockBubbleShape(tailEdge: .right, tailPosition: 0.25)
            .path(in: rect)

        #expect(path.contains(CGPoint(x: 346, y: 55)))
        #expect(!path.contains(CGPoint(x: 346, y: 110)))
    }

    @Test("Long provider quota labels preserve their time window")
    func compactQuotaLabels() {
        #expect(CapacityDockQuotaPresentation.displayLabel("Gemini Models · Five-hour") == "Gemini · 5-hour")
        #expect(CapacityDockQuotaPresentation.displayLabel("Gemini Models · Weekly") == "Gemini · Weekly")
        #expect(CapacityDockQuotaPresentation.displayLabel("Claude and GPT models · Five-hour") == "Claude + GPT · 5-hour")
        #expect(CapacityDockQuotaPresentation.displayLabel("Claude and GPT models · Weekly") == "Claude + GPT · Weekly")
        #expect(CapacityDockQuotaPresentation.displayLabel("Weekly") == "Weekly")
    }

    @Test("terminal diagnostics are not repeated in the footer")
    func terminalFooterDeduplicates() {
        let reason = "No available fetch strategy for clinepass."
        let lines = CapacityDockQuotaPresentation.visibleFooterLines(
            [reason, "Source: ClinePass"],
            connection: .terminalFailure(reason: reason)
        )

        #expect(lines == ["Source: ClinePass"])
    }

    @Test("terminal recovery cards fit their guidance and the action with no surplus")
    func terminalCardHeight() {
        let reason = "No available fetch strategy for clinepass."
        func height(_ reason: String) -> CGFloat {
            CapacityDockMetrics.detailHeight(
                quota: QuotaSummary(
                    providerFilter: .all,
                    connection: .terminalFailure(reason: reason),
                    primary: nil,
                    details: [],
                    planLabel: nil,
                    footerLines: [reason]
                ),
                provider: .claude,
                sessionCount: nil,
                hasToday: false,
                tailEdge: .right,
                scale: 1
            )
        }

        // The card is the header, the guidance block as it actually wraps, and
        // the action row — nothing more. A worst-case reserve would not clip,
        // but the panel frame is computed, so its surplus lands as dead space
        // above the button instead of shrinking the card.
        let block = CapacityDockGlance.connectionBlockHeight(
            .terminalFailure(reason: reason),
            provider: .claude,
            width: 350 - 2 * CapacityDockGlance.contentInset
        )
        #expect(
            height(reason)
                == CapacityDockGlance.headerHeight + block + CapacityDockGlance.actionRowHeight
        )
        // And the block really is measured: a reason that wraps reserves the
        // second line rather than clipping it.
        #expect(height(String(repeating: "fetch strategy unavailable ", count: 6)) > height(reason))
    }

    @MainActor
    @Test("Curated vectors win while existing CodeBurn artwork remains a fallback")
    func bundledArtworkWins() {
        let candidates = ProviderIconCache.resourceCandidates(for: "antigravity")
        #expect(candidates.first?.name == "provider-antigravity")
        #expect(candidates.first?.fileExtension == "svg")
        #expect(candidates.last?.name == "antigravity")
        #expect(candidates.last?.fileExtension == "png")
    }

    @Test("Dock selection candidates contain only eligible providers")
    func connectedSelectionCandidates() {
        let eligibleIDs: Set<String> = ["codex", "claude", "antigravity"]
        let providers = CapacityDockProviderSelection.eligibleProviders {
            eligibleIDs.contains($0.id)
        }

        #expect(providers.map(\.id) == ["codex", "claude", "antigravity"])
        #expect(!providers.contains { $0.id == "clinepass" })
    }

    @Test("saved credentials only make implemented adapters dock-eligible")
    func unsupportedCredentialsAreNotConnections() {
        let clinePass = CapacityDockProvider(rawValue: "clinepass")!
        let openRouter = CapacityDockProvider(rawValue: "openrouter")!

        #expect(CapacityDockProviderSelection.isDockEligible(
            clinePass,
            isConnected: false,
            hasSavedCredential: true
        ))
        #expect(!CapacityDockProviderSelection.isDockEligible(
            openRouter,
            isConnected: false,
            hasSavedCredential: true
        ))
    }

    @Test("Selected providers remain manageable when their live connection breaks")
    func selectedProvidersRemainManageable() {
        let selected: [CapacityDockProvider] = [.codex, CapacityDockProvider(rawValue: "clinepass")!]
        let providers = CapacityDockProviderSelection.manageableProviders(
            selected: selected,
            isConnected: { $0 == .codex || $0 == .claude }
        )

        #expect(providers.map(\.id) == ["codex", "claude", "clinepass"])
        #expect(CapacityDockProviderSelection.canDeselect(
            CapacityDockProvider(rawValue: "clinepass")!,
            selected: selected,
            isConnected: { $0 == .codex }
        ))
        #expect(!CapacityDockProviderSelection.canDeselect(
            .codex,
            selected: [.codex],
            isConnected: { $0 == .codex }
        ))
    }

    @Test("Credential-only providers receive an actionable connection instruction")
    func apiCredentialGuidance() {
        let provider = CapacityDockProvider(rawValue: "clinepass")!
        #expect(ProviderConnectionGuidance.instruction(for: provider) ==
            "Enter an API key or token below, then press Save & Connect.")
    }

    @Test("Browser-session providers receive an actionable connection instruction")
    func browserSessionGuidance() {
        let provider = CapacityDockProvider(rawValue: "commandcode")!
        #expect(ProviderConnectionGuidance.instruction(for: provider) ==
            "Sign in to Command Code in a supported browser, then click Retry.")
    }

    @Test("Grok Build offers direct one-click local login discovery")
    func grokBuildConnectionGuidance() {
        let provider = CapacityDockProvider(rawValue: "grok")!
        #expect(ProviderConnectionGuidance.instruction(for: provider) ==
            "Sign in with the Grok app or CLI, then click Retry.")
        #expect(ProviderConnectionSubmissionPolicy.resolve(
            credential: CapacityDockProviderCredential(),
            savedCredential: CapacityDockProviderCredential(),
            requiresExplicitCredential: false
        ) == .connect)
    }

    @Test("Connect saves edited credentials before fetching")
    func connectionSubmissionPolicy() {
        let empty = CapacityDockProviderCredential()
        let edited = CapacityDockProviderCredential(sourceMode: "api", apiKey: "synthetic")

        #expect(ProviderConnectionSubmissionPolicy.resolve(
            credential: edited,
            savedCredential: empty,
            requiresExplicitCredential: true
        ) == .saveAndConnect)
        #expect(ProviderConnectionSubmissionPolicy.resolve(
            credential: edited,
            savedCredential: edited,
            requiresExplicitCredential: true
        ) == .connect)
        #expect(ProviderConnectionSubmissionPolicy.resolve(
            credential: empty,
            savedCredential: empty,
            requiresExplicitCredential: true
        ) == .requiresCredential)
    }
}
