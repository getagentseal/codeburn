import AppKit
import SwiftUI

@MainActor
final class CapacityDockController {
    private let store: AppStore
    private let defaults: UserDefaults
    private let model: CapacityDockViewModel

    private var railPanel: CapacityDockPanel?
    private var detailPanel: CapacityDockPanel?
    private var preferencesObserver: NSObjectProtocol?
    private var screenObserver: NSObjectProtocol?
    private var wakeObserver: NSObjectProtocol?
    private var localEventMonitor: Any?
    private var globalMouseMonitor: Any?
    private var hoverPollTimer: Timer?
    private var pointerMonitoringSession = CapacityDockPointerMonitoringSession()

    private var expansionWork: DispatchWorkItem?
    private var collapseWork: DispatchWorkItem?
    private var detailWork: DispatchWorkItem?
    private var detailExitWork: DispatchWorkItem?
    private var pointerInsideRail = false
    private var pointerInsideDetail = false
    private var hoveredRowProvider: CapacityDockProvider?
    /// True while the resting rail is tucked beyond its screen edge (auto-hide).
    /// Hover then keys off the visible sliver rather than the rail silhouette.
    private var railIsTucked = false
    private var dragStartFrame: CGRect?
    private var dragVisibleFrame: CGRect?
    private var dragScreenFrame: CGRect?
    private var dragStartAttachmentProgress: CGFloat?
    private var dragStartDockedEdge: CapacityDockEdge?
    private var dragStartPointerLocation: CGPoint?
    private var suppressProviderClicksUntil: TimeInterval = 0
    private var railMotionGeneration = 0
    private var detailMotionGeneration = 0
    private var lastKnownRailTop: CGFloat?
    private var reduceMotion = false
    private var accessibilityObserver: NSObjectProtocol?
    private var railMotion: CapacityDockMotionRun?
    private var detailMotion: CapacityDockMotionRun?
    private var detailIsDismissing = false

    init(store: AppStore, defaults: UserDefaults = .standard) {
        self.store = store
        self.defaults = defaults
        self.model = CapacityDockViewModel(preferences: CapacityDockPreferences.load(defaults: defaults))
    }

    func start() {
        guard preferencesObserver == nil else { return }

        preferencesObserver = NotificationCenter.default.addObserver(
            forName: .capacityDockPreferencesDidChange,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in self?.preferencesDidChange() }
        }
        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in self?.reposition() }
        }
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.screensDidWakeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in self?.reposition() }
        }
        reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        accessibilityObserver = NotificationCenter.default.addObserver(
            forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
                if self.reduceMotion {
                    self.stopRailMotion()
                    self.stopDetailMotion()
                    self.layoutRail(animate: false)
                    if let provider = self.model.hoveredProvider {
                        self.layoutDetail(for: provider, transaction: .immediate)
                    }
                }
            }
        }

        preferencesDidChange()
    }

    func stop() {
        expansionWork?.cancel()
        collapseWork?.cancel()
        detailWork?.cancel()
        detailExitWork?.cancel()
        stopRailMotion()
        stopDetailMotion()

        if let preferencesObserver {
            NotificationCenter.default.removeObserver(preferencesObserver)
            self.preferencesObserver = nil
        }
        if let screenObserver {
            NotificationCenter.default.removeObserver(screenObserver)
            self.screenObserver = nil
        }
        if let wakeObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(wakeObserver)
            self.wakeObserver = nil
        }
        if let accessibilityObserver {
            NotificationCenter.default.removeObserver(accessibilityObserver)
            self.accessibilityObserver = nil
        }
        stopEventMonitoring()
        pointerInsideRail = false
        pointerInsideDetail = false
        hoveredRowProvider = nil

        completeDetailDismissal()
        railPanel?.orderOut(nil)
        railPanel = nil
        lastKnownRailTop = nil
    }

    func refreshQuotaPresentation() {
        guard model.preferences.isEnabled else { return }
        if let provider = model.hoveredProvider {
            model.detailHeight = glanceDetailHeight(for: provider)
            layoutDetail(for: provider, transaction: .immediate)
        }
    }

    /// Panel height for the glance popover, measured from the same store content
    /// `CapacityDockDetailView` renders.
    private func glanceDetailHeight(for provider: CapacityDockProvider) -> CGFloat {
        return CapacityDockMetrics.detailHeight(
            quota: store.capacityDockQuotaSummary(for: provider),
            sessionCount: store.capacityDockLiveSessions(for: provider)?.count,
            hasToday: store.capacityDockToday(for: provider) != nil,
            tailEdge: model.detailTailEdge,
            scale: model.detailScale
        )
    }

    func reposition() {
        guard model.preferences.isEnabled, !model.interaction.isDragging else { return }
        layoutRail(preserveCurrentTop: false, animate: false)
        if let provider = model.hoveredProvider {
            layoutDetail(for: provider, transaction: .immediate)
        }
    }

    private func preferencesDidChange() {
        let snapshot = CapacityDockPreferences.load(defaults: defaults)
        model.preferences = snapshot
        if !model.interaction.isDragging {
            model.dockedEdge = snapshot.dockedEdge
            model.attachmentEdge = snapshot.attachmentEdge
        }

        if let hovered = model.hoveredProvider,
           !snapshot.selectedProviders.contains(hovered) {
            hideDetail(animated: false)
        } else if let hovered = model.hoveredProvider {
            model.detailHeight = glanceDetailHeight(for: hovered)
        }

        guard snapshot.isEnabled else {
            stopEventMonitoring()
            pointerInsideRail = false
            pointerInsideDetail = false
            hoveredRowProvider = nil
            model.interaction.dismiss()
            hideDetail(animated: false)
            stopRailMotion()
            model.railPresentationProgress = 0
            model.isRailPresentationExpanded = false
            railPanel?.orderOut(nil)
            lastKnownRailTop = nil
            return
        }

        startEventMonitoring()
        ensureRailPanel()
        layoutRail(animate: false)
        railPanel?.orderFrontRegardless()
    }

    private func ensureRailPanel() {
        guard railPanel == nil else { return }

        let view = CapacityDockView(
            model: model,
            quota: { [weak self] provider in
                self?.store.capacityDockQuotaSummary(for: provider)
            },
            onProviderClick: { [weak self] provider in
                self?.providerClicked(provider)
            },
            onHide: { [weak self] in
                self?.hideDock()
            },
            onDock: { [weak self] edge in
                self?.dock(to: edge)
            },
            onDragChanged: { [weak self] pointerLocation, translation in
                self?.dragChanged(pointerLocation: pointerLocation, initialTranslation: translation)
            },
            onDragEnded: { [weak self] in
                self?.dragEnded()
            }
        )
        let panel = CapacityDockPanel()
        let hosting = CapacityDockHostingView(rootView: view.environment(store))
        // Panel geometry has one owner; intrinsic resizing races the frame animator.
        hosting.sizingOptions = []
        hosting.autoresizingMask = [.width, .height]
        // At the top edge the menu-bar/notch safe-area inset would push the rail
        // down, leaving a gap the bottom edge never shows. Opt the rail out of
        // safe area so it sits flush at the physical top like the system notch.
        hosting.safeAreaRegions = []
        hosting.interactiveShapeContains = { [weak model] point, bounds in
            guard let model else { return false }
            let swiftUIPoint = CGPoint(x: point.x, y: bounds.height - point.y)
            return CapacityDockRailShape(
                bodyWidth: model.railWidth,
                bodyLength: model.bodyLength,
                shoulderDepth: CapacityDockMetrics.edgeShoulderDepth(scale: model.scale),
                attachmentProgress: model.attachmentProgress,
                edge: model.attachmentEdge
            )
            .path(in: bounds)
            .contains(swiftUIPoint)
        }
        panel.contentView = hosting
        panel.makeContentTransparent()
        panel.acceptsMouseMovedEvents = true
        hosting.clipsToBounds = true
        railPanel = panel
    }

    /// The bubble is cheap to rebuild and expensive to keep: a hidden, ordered-out
    /// bubble panel left the app re-laying it out at display cadence for as long
    /// as it lived (0.1 percent idle CPU before the first hover, 6 percent after).
    /// Every completed dismissal, animated or immediate, converges here.
    private func completeDetailDismissal() {
        model.hoveredProvider = nil
        detailIsDismissing = false
        detailPanel?.orderOut(nil)
        detailPanel = nil
    }

    private func ensureDetailPanel() {
        guard detailPanel == nil else { return }

        let view = CapacityDockDetailView(
            model: model,
            quota: { [weak self] provider in
                self?.store.capacityDockQuotaSummary(for: provider)
            },
            onConnect: { [weak self] provider in
                self?.connect(provider)
            }
        )
        let panel = CapacityDockPanel()
        let hosting = CapacityDockHostingView(rootView: view.environment(store))
        // Panel geometry has one owner; intrinsic resizing races the frame animator.
        hosting.sizingOptions = []
        hosting.autoresizingMask = [.width, .height]
        hosting.interactiveShapeContains = { [weak model] point, bounds in
            guard let model else { return false }
            let swiftUIPoint = CGPoint(x: point.x, y: bounds.height - point.y)
            return CapacityDockBubbleShape(
                tailEdge: model.detailTailEdge,
                tailPosition: model.detailTailPosition
            )
            .path(in: bounds)
            .contains(swiftUIPoint)
        }
        panel.contentView = hosting
        panel.makeContentTransparent()
        panel.acceptsMouseMovedEvents = true
        hosting.clipsToBounds = true
        panel.alphaValue = 0
        detailPanel = panel
    }

    private func startEventMonitoring() {
        guard localEventMonitor == nil, globalMouseMonitor == nil else { return }
        let monitoringGeneration = pointerMonitoringSession.start()
        // Global .mouseMoved monitors only deliver while the frontmost app
        // itself requests mouse-moved events (Chrome does, Finder and Terminal
        // don't), so the monitors alone leave hover dead over most apps. Poll
        // the pointer as the activation-independent fallback. All three paths
        // feed one coalescer so a monitor event and its following poll do not
        // publish the same point twice.
        let timer = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.enqueuePointerUpdate(
                    at: NSEvent.mouseLocation,
                    monitoringGeneration: monitoringGeneration
                )
            }
        }
        timer.tolerance = 0.05
        RunLoop.main.add(timer, forMode: .common)
        hoverPollTimer = timer
        localEventMonitor = NSEvent.addLocalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown, .keyDown, .mouseMoved]
        ) { [weak self] event in
            guard let self,
                  self.pointerMonitoringSession.isCurrent(monitoringGeneration) else { return event }
            if event.type == .mouseMoved {
                self.enqueuePointerUpdate(
                    at: NSEvent.mouseLocation,
                    monitoringGeneration: monitoringGeneration
                )
            } else if event.type == .keyDown, event.keyCode == 53 {
                if self.model.interaction.handleEscape() {
                    self.hideDetail(animated: false)
                    self.layoutRail(animate: false)
                }
            } else if event.type == .leftMouseDown || event.type == .rightMouseDown {
                let point = NSEvent.mouseLocation
                self.flushPendingPointerUpdate(
                    at: point,
                    monitoringGeneration: monitoringGeneration
                )
                self.dismissIfOutside(point: point)
            }
            return event
        }
        globalMouseMonitor = NSEvent.addGlobalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown, .mouseMoved]
        ) { [weak self] event in
            DispatchQueue.main.async { [weak self] in
                guard let self,
                      self.pointerMonitoringSession.isCurrent(monitoringGeneration) else { return }
                let point = NSEvent.mouseLocation
                if event.type == .mouseMoved {
                    self.enqueuePointerUpdate(
                        at: point,
                        monitoringGeneration: monitoringGeneration
                    )
                } else {
                    self.flushPendingPointerUpdate(
                        at: point,
                        monitoringGeneration: monitoringGeneration
                    )
                    self.updateMouseEventPassthrough(at: point)
                    self.dismissIfOutside(point: point)
                }
            }
        }
    }

    private func stopEventMonitoring() {
        pointerMonitoringSession.stop()
        railPanel?.ignoresMouseEvents = false
        detailPanel?.ignoresMouseEvents = false
        hoverPollTimer?.invalidate()
        hoverPollTimer = nil
        if let localEventMonitor {
            NSEvent.removeMonitor(localEventMonitor)
            self.localEventMonitor = nil
        }
        if let globalMouseMonitor {
            NSEvent.removeMonitor(globalMouseMonitor)
            self.globalMouseMonitor = nil
        }
    }

    private func enqueuePointerUpdate(
        at point: CGPoint,
        monitoringGeneration: CapacityDockPointerMonitoringSession.Generation
    ) {
        guard pointerMonitoringSession.enqueue(
            point,
            generation: monitoringGeneration
        ) == .scheduleDrain else { return }
        DispatchQueue.main.async { [weak self] in
            self?.drainPointerUpdate(monitoringGeneration: monitoringGeneration)
        }
    }

    private func drainPointerUpdate(
        monitoringGeneration: CapacityDockPointerMonitoringSession.Generation
    ) {
        guard let point = pointerMonitoringSession.drain(
            generation: monitoringGeneration
        ) else { return }
        updateMouseEventPassthrough(at: point)
        syncPointerHover(at: point)
    }

    /// Makes a mouse-down authoritative without publishing hover changes before
    /// AppKit delivers the local event to its target view.
    private func flushPendingPointerUpdate(
        at point: CGPoint,
        monitoringGeneration: CapacityDockPointerMonitoringSession.Generation
    ) {
        _ = pointerMonitoringSession.flush(
            with: point,
            generation: monitoringGeneration
        )
    }

    /// `NSHostingView.hitTest` can reject a transparent pixel, but AppKit still
    /// routes that click to the owning window. Make the whole panel ignore mouse
    /// events while the pointer is over one of those pixels; the global movement
    /// monitor turns interaction back on as soon as the pointer reaches the
    /// visible silhouette again.
    private func updateMouseEventPassthrough(at point: CGPoint = NSEvent.mouseLocation) {
        let dragging = model.interaction.isDragging
        if let railPanel {
            let shouldIgnore = railPanel.isVisible
                && railPanel.frame.contains(point)
                && !railContains(screenPoint: point)
                && !dragging
            if railPanel.ignoresMouseEvents != shouldIgnore {
                railPanel.ignoresMouseEvents = shouldIgnore
            }
        }
        if let detailPanel {
            let shouldIgnore = detailPanel.isVisible
                && detailPanel.frame.contains(point)
                && !detailContains(screenPoint: point)
                && !dragging
            if detailPanel.ignoresMouseEvents != shouldIgnore {
                detailPanel.ignoresMouseEvents = shouldIgnore
            }
        }
    }

    /// SwiftUI's onHover rides on NSTrackingAreas that only deliver while the
    /// app is active. An accessory app behind a nonactivating panel loses
    /// activation on the first outside click and can never win it back, so
    /// hover enter/exit is synthesized here from the event monitors, which
    /// observe the pointer regardless of activation.
    private func syncPointerHover(at point: CGPoint = NSEvent.mouseLocation) {
        guard model.preferences.isEnabled,
              model.interaction.acceptsHoverTransitions,
              railPanel != nil else { return }
        let insideRail = railContains(screenPoint: point)
        let insideDetail = detailPanel?.isVisible == true && detailContains(screenPoint: point)
        let row = insideRail ? providerRow(at: point) : nil

        if insideDetail != pointerInsideDetail {
            pointerInsideDetail = insideDetail
            detailHoverChanged(insideDetail)
        }
        if insideRail != pointerInsideRail {
            railHoverChanged(insideRail)
        }
        if row != hoveredRowProvider {
            let previous = hoveredRowProvider
            hoveredRowProvider = row
            if let previous { providerHoverChanged(previous, hovering: false) }
            if let row { providerHoverChanged(row, hovering: true) }
        }
    }

    private func providerRow(at screenPoint: CGPoint) -> CapacityDockProvider? {
        guard let railPanel else { return nil }
        let frame = railPanel.frame
        let alongOffset: CGFloat = if model.isVertical {
            model.expansionAnchor == .start
                ? frame.maxY - model.railTopPadding - screenPoint.y
                : screenPoint.y - frame.minY - model.railBottomPadding
        } else {
            model.expansionAnchor == .start
                ? screenPoint.x - frame.minX - model.railTopPadding
                : frame.maxX - model.railBottomPadding - screenPoint.x
        }
        let providers = model.displayedProviders
        guard let index = CapacityDockPlacement.providerRowIndex(
            alongOffset: alongOffset,
            rowHeight: model.rowHeight,
            rowSpacing: model.rowSpacing,
            rowCount: providers.count,
            expansionAnchor: model.expansionAnchor
        ) else { return nil }
        return providers[index]
    }

    private func railHoverChanged(_ hovering: Bool) {
        pointerInsideRail = hovering
        guard model.interaction.acceptsHoverTransitions else { return }
        expansionWork?.cancel()
        collapseWork?.cancel()

        if hovering {
            let work = DispatchWorkItem { [weak self] in
                guard let self, self.pointerInsideRail else { return }
                self.model.interaction.setRailHovered(true)
                self.layoutRail()
            }
            expansionWork = work
            DispatchQueue.main.asyncAfter(
                deadline: .now() + CapacityDockMotion.railHoverOpenDelay,
                execute: work
            )
        } else {
            model.interaction.beginRailExitGrace()
            scheduleCollapse()
        }
    }

    private func providerHoverChanged(_ provider: CapacityDockProvider, hovering: Bool) {
        guard model.interaction.acceptsHoverTransitions else { return }
        detailWork?.cancel()
        detailExitWork?.cancel()

        if hovering {
            // Re-entering a row aborts a pending collapse; a row exit must NOT
            // touch collapseWork, or it clobbers the collapse the rail exit
            // just scheduled and strands the rail expanded.
            collapseWork?.cancel()
            let work = DispatchWorkItem { [weak self] in
                guard let self else { return }
                self.showDetail(for: provider)
            }
            detailWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.18, execute: work)
        } else if model.hoveredProvider == provider {
            let work = DispatchWorkItem { [weak self] in
                guard let self, !self.model.interaction.isDetailHovered else { return }
                self.hideDetail(animated: true)
                self.scheduleCollapse()
            }
            detailExitWork = work
            // Leave enough time to cross the narrow transparent gap into the
            // separate detail panel. If the fade has already begun, entering
            // the card reverses it from its current frame and alpha.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.24, execute: work)
        }
    }

    private func detailHoverChanged(_ hovering: Bool) {
        guard model.interaction.acceptsHoverTransitions else { return }
        collapseWork?.cancel()
        detailExitWork?.cancel()
        model.interaction.setDetailHovered(hovering)
        if hovering, model.interaction.isExpanded {
            // Re-entering during a scheduled or in-flight collapse must restore
            // the expanded host frame as well as reversing the card fade.
            layoutRail()
        }
        if hovering, detailIsDismissing, let provider = model.hoveredProvider {
            stopDetailMotion()
            detailIsDismissing = false
            layoutDetail(for: provider, transaction: .detailFollow)
        } else if !hovering {
            scheduleCollapse()
        }
    }

    private func providerClicked(_ provider: CapacityDockProvider) {
        guard !model.interaction.isDragging else { return }
        guard ProcessInfo.processInfo.systemUptime >= suppressProviderClicksUntil else { return }
        expansionWork?.cancel()
        collapseWork?.cancel()

        if provider != model.preferences.preferredProvider {
            CapacityDockPreferences.setPreferredProvider(provider, defaults: defaults)
            if !model.interaction.isPinned {
                model.interaction.togglePinned()
            }
        } else {
            model.interaction.togglePinned()
        }
        layoutRail()
        showDetail(for: provider)
    }

    private func connect(_ provider: CapacityDockProvider) {
        Task { [weak self] in
            guard let self else { return }
            guard provider.catalogEntry.hasLiveCodeBurnQuotaAdapter else {
                NotificationCenter.default.post(
                    name: .capacityDockOpenProviderSettings,
                    object: provider.id
                )
                return
            }
            if provider.catalogEntry.authMethods == [.apiTokenOrCloudCredentials],
               await self.store.capacityDockCredential(for: provider).apiKey
                .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                NotificationCenter.default.post(
                    name: .capacityDockOpenProviderSettings,
                    object: provider.id
                )
                return
            }
            await self.store.connectCapacityDockProvider(provider)
            self.refreshQuotaPresentation()
            guard self.store.capacityDockQuotaSummary(for: provider)?.connection != .connected else {
                return
            }
            NotificationCenter.default.post(
                name: .capacityDockOpenProviderSettings,
                object: provider.id
            )
        }
    }

    private func showDetail(for provider: CapacityDockProvider) {
        guard model.preferences.isEnabled,
              model.preferences.selectedProviders.contains(provider) else { return }
        let wasShowingDetail = detailPanel?.isVisible == true && model.hoveredProvider != nil
        detailIsDismissing = false
        model.hoveredProvider = provider
        model.detailHeight = glanceDetailHeight(for: provider)
        ensureDetailPanel()
        layoutDetail(for: provider, transaction: wasShowingDetail ? .detailFollow : .detailPresent)
        // A panel that lost its all-spaces membership returns to the desktop space alone,
        // so hovering inside a full-screen app presented the popover where it could not be
        // seen. The rail escapes this by never being ordered out.
        detailPanel?.reassertSpaceMembership()
        detailPanel?.orderFrontRegardless()
    }

    private func hideDetail(animated: Bool = true) {
        let provider = model.hoveredProvider
        model.interaction.setDetailHovered(false)
        guard let provider, detailPanel?.isVisible == true else {
            completeDetailDismissal()
            return
        }
        if animated {
            dismissDetail(for: provider)
        } else {
            stopDetailMotion()
            completeDetailDismissal()
        }
    }

    private func scheduleCollapse() {
        collapseWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.model.interaction.completeCollapseGrace()
            guard self.model.interaction.canCollapse else { return }
            self.hideDetail()
            self.layoutRail()
        }
        collapseWork = work
        DispatchQueue.main.asyncAfter(
            deadline: .now() + CapacityDockMotion.railHoverCloseDelay,
            execute: work
        )
    }

    private func dismissIfOutside(point: CGPoint) {
        guard model.interaction.isExpanded else { return }
        let insideRail = railContains(screenPoint: point)
        let insideDetail = detailPanel?.isVisible == true && detailContains(screenPoint: point)
        guard !insideRail, !insideDetail else { return }
        model.interaction.dismiss()
        hideDetail()
        layoutRail()
    }

    private func dragChanged(pointerLocation: CGPoint, initialTranslation: CGSize) {
        guard let railPanel else { return }
        if dragStartFrame == nil {
            guard let screen = targetScreen else { return }
            expansionWork?.cancel()
            collapseWork?.cancel()
            detailWork?.cancel()
            detailExitWork?.cancel()
            stopRailMotion()
            stopDetailMotion()
            model.interaction.beginDragging()
            railPanel.ignoresMouseEvents = false
            hideDetail(animated: false)
            hoveredRowProvider = nil
            pointerInsideDetail = false
            dragStartFrame = railPanel.frame
            dragVisibleFrame = screen.visibleFrame
            dragScreenFrame = screen.frame
            dragStartAttachmentProgress = model.attachmentProgress
            dragStartDockedEdge = model.dockedEdge
            // The first SwiftUI drag update occurs before the panel moves, so
            // its translation is safe to use exactly once to recover the
            // mouse-down point in AppKit's stable screen coordinate space.
            dragStartPointerLocation = CGPoint(
                x: pointerLocation.x - initialTranslation.width,
                y: pointerLocation.y + initialTranslation.height
            )
        }
        guard let startFrame = dragStartFrame,
              let startPointer = dragStartPointerLocation else { return }

        // Follow the pointer across displays. Capturing the launch screen for
        // the whole gesture made the panel stick to the first display's bounds.
        let screens = NSScreen.screens
        let activeScreen = CapacityDockPlacement.screenIndex(
            containing: pointerLocation,
            frames: screens.map(\.frame)
        )
        .map { screens[$0] }
            ?? railPanel.screen
            ?? targetScreen
        guard let activeScreen else { return }
        let visibleFrame = activeScreen.visibleFrame
        let screenFrame = activeScreen.frame
        dragVisibleFrame = visibleFrame
        dragScreenFrame = screenFrame

        let pointerDelta = CGSize(
            width: pointerLocation.x - startPointer.x,
            height: pointerLocation.y - startPointer.y
        )
        if hypot(pointerDelta.width, pointerDelta.height) > 3 {
            suppressProviderClicksUntil = ProcessInfo.processInfo.systemUptime + 0.2
        }

        var frame = CapacityDockPlacement.pointerAnchoredDragFrame(
            startFrame: startFrame,
            startPointer: startPointer,
            currentPointer: pointerLocation,
            size: model.panelSize
        )
        frame = CapacityDockPlacement.clampedDragFrame(
            frame,
            screenFrame: screenFrame,
            visibleFrame: visibleFrame
        )
        if var candidate = CapacityDockPlacement.attachmentCandidate(
            railFrame: frame,
            screenFrame: screenFrame,
            visibleFrame: visibleFrame
        ) {
            if model.attachmentEdge != candidate.edge {
                model.attachmentEdge = candidate.edge
                frame = CapacityDockPlacement.pointerAnchoredDragFrame(
                    startFrame: startFrame,
                    startPointer: startPointer,
                    currentPointer: pointerLocation,
                    size: model.panelSize
                )
                frame = CapacityDockPlacement.clampedDragFrame(
                    frame,
                    screenFrame: screenFrame,
                    visibleFrame: visibleFrame
                )
                candidate = CapacityDockPlacement.attachmentCandidate(
                    railFrame: frame,
                    screenFrame: screenFrame,
                    visibleFrame: visibleFrame
                ) ?? candidate
            }
            model.attachmentProgress = candidate.progress
            model.dockedEdge = candidate.progress >= 0.999 ? candidate.edge : nil
        } else {
            model.attachmentProgress = 0
            model.dockedEdge = nil
        }
        if model.attachmentProgress >= 0.999 {
            frame = frame.aligned(
                to: model.attachmentEdge,
                screenFrame: screenFrame,
                visibleFrame: visibleFrame
            )
        }
        railPanel.setFrame(frame, display: false)
        railPanel.contentView?.needsDisplay = true
        updateMouseEventPassthrough(at: pointerLocation)
        lastKnownRailTop = frame.maxY
    }

    private func hideDock() {
        model.interaction.dismiss()
        hideDetail(animated: false)
        CapacityDockPreferences.setEnabled(false, defaults: defaults)
    }

    private func dock(to edge: CapacityDockEdge) {
        guard let railPanel, let screen = targetScreen else { return }
        model.dockedEdge = edge
        model.attachmentEdge = edge
        let normalizedHorizontal = CapacityDockPlacement.normalizedHorizontalOffset(
            railFrame: railPanel.frame,
            visibleFrame: screen.visibleFrame
        )
        let normalizedVertical = CapacityDockPlacement.normalizedTopOffset(
            railFrame: railPanel.frame,
            visibleFrame: screen.visibleFrame
        )
        CapacityDockPreferences.setPlacement(
            dockedEdge: edge,
            attachmentEdge: edge,
            normalizedHorizontalOffset: normalizedHorizontal,
            normalizedVerticalOffset: normalizedVertical,
            defaults: defaults
        )
    }

    private func dragEnded() {
        defer {
            dragStartFrame = nil
            dragVisibleFrame = nil
            dragScreenFrame = nil
            dragStartAttachmentProgress = nil
            dragStartDockedEdge = nil
            dragStartPointerLocation = nil
        }
        guard let railPanel,
              let visibleFrame = dragVisibleFrame,
              let screenFrame = dragScreenFrame else { return }
        model.interaction.endDragging()

        let dockedEdge = CapacityDockPlacement.nearestDockEdge(
            railFrame: railPanel.frame,
            screenFrame: screenFrame,
            visibleFrame: visibleFrame
        )
        var settledFrame = railPanel.frame
        if dockedEdge == nil {
            model.dockedEdge = nil
            settledFrame.size = model.bodySize
            settledFrame = CapacityDockPlacement.clampedDragFrame(
                settledFrame,
                screenFrame: screenFrame,
                visibleFrame: visibleFrame
            )
        } else if let dockedEdge {
            model.dockedEdge = dockedEdge
            model.attachmentEdge = dockedEdge
            model.expansionAnchor = CapacityDockPlacement.expansionAnchor(
                railFrame: settledFrame,
                visibleFrame: visibleFrame,
                edge: dockedEdge
            )
        }
        // Keep direct dragging exactly mouse-anchored. Once the pointer is
        // released, settle the panel onto physical pixels so a later hover
        // animation does not begin with a one-pixel correction.
        settledFrame = CapacityDockMotion.pixelAlignedRailFrame(
            settledFrame,
            backingScale: railPanel.screen?.backingScaleFactor ?? 2,
            dockedEdge: dockedEdge,
            expansionAnchor: model.expansionAnchor,
            isVertical: model.isVertical
        )
        if railPanel.frame != settledFrame {
            railPanel.setFrame(settledFrame, display: false)
        }
        lastKnownRailTop = settledFrame.maxY
        let normalizedVertical = CapacityDockPlacement.normalizedTopOffset(
            railFrame: settledFrame,
            visibleFrame: visibleFrame
        )
        let normalizedHorizontal = CapacityDockPlacement.normalizedHorizontalOffset(
            railFrame: settledFrame,
            visibleFrame: visibleFrame
        )
        CapacityDockPreferences.setPlacement(
            dockedEdge: dockedEdge,
            attachmentEdge: model.attachmentEdge,
            normalizedHorizontalOffset: normalizedHorizontal,
            normalizedVerticalOffset: normalizedVertical,
            defaults: defaults
        )

        let hovering = railContains(screenPoint: NSEvent.mouseLocation)
        updateMouseEventPassthrough()
        pointerInsideRail = hovering
        if hovering {
            if !model.interaction.isRailHovered {
                railHoverChanged(true)
            }
        } else {
            model.interaction.beginRailExitGrace()
            scheduleCollapse()
        }
        // The drag cleared the row cache; a pointer resting on a row at drop
        // gets no further mouseMoved event, so re-derive the row hover here.
        syncPointerHover()
    }

    private func layoutRail(preserveCurrentTop: Bool = true, animate: Bool = true) {
        guard let railPanel, let screen = targetScreen else { return }
        let wantsExpandedPresentation = model.interaction.isExpanded
        if wantsExpandedPresentation {
            model.isRailPresentationExpanded = true
        }
        if let dockedEdge = model.dockedEdge {
            model.attachmentEdge = dockedEdge
            model.expansionAnchor = CapacityDockPlacement.expansionAnchor(
                railFrame: railPanel.frame,
                visibleFrame: screen.visibleFrame,
                edge: dockedEdge
            )
        }
        let floatingAnchors: CapacityDockMotion.FloatingRailAnchors? = if preserveCurrentTop,
                                                                          model.dockedEdge == nil,
                                                                          railPanel.frame.width > 0,
                                                                          railPanel.frame.height > 0
        {
            CapacityDockMotion.floatingRailAnchors(
                frame: railPanel.frame,
                preservedTop: lastKnownRailTop,
                isVertical: model.isVertical,
                expansionAnchor: model.expansionAnchor
            )
        } else {
            nil
        }
        let anchoredTop = floatingAnchors?.top
        let anchoredLeading = floatingAnchors?.leading
        let anchoredAxisCoordinate: CGFloat? = if preserveCurrentTop,
                                                    let dockedEdge = model.dockedEdge,
                                                    railPanel.frame.width > 0,
                                                    railPanel.frame.height > 0
        {
            if dockedEdge.isVertical {
                model.expansionAnchor == .start ? railPanel.frame.maxY : railPanel.frame.minY
            } else {
                model.expansionAnchor == .start ? railPanel.frame.minX : railPanel.frame.maxX
            }
        } else {
            floatingAnchors?.axisCoordinate
        }
        let targetAttachment: CGFloat = model.dockedEdge == nil ? 0 : 1
        let targetPanelSize = model.targetPanelSize(forAttachmentProgress: targetAttachment)
        let rawTarget = CapacityDockPlacement.railFrame(
            screenFrame: screen.frame,
            visibleFrame: screen.visibleFrame,
            size: targetPanelSize,
            dockedEdge: model.dockedEdge,
            normalizedHorizontalOffset: model.preferences.normalizedHorizontalOffset,
            normalizedTopOffset: model.preferences.normalizedVerticalOffset,
            anchoredTop: anchoredTop,
            anchoredLeading: anchoredLeading,
            anchoredAxisCoordinate: anchoredAxisCoordinate,
            expansionAnchor: model.expansionAnchor
        )
        let alignedTarget = CapacityDockMotion.pixelAlignedRailFrame(
            rawTarget,
            backingScale: screen.backingScaleFactor,
            dockedEdge: model.dockedEdge,
            expansionAnchor: model.expansionAnchor,
            isVertical: model.isVertical
        )
        // Auto-hide: a resting docked rail parks beyond the edge, leaving a
        // thin sliver on screen as the hover target that slides it back out.
        let shouldTuck = model.preferences.isAutoHideEnabled
            && model.dockedEdge != nil
            && !wantsExpandedPresentation
            && !model.interaction.isDragging
        let target: CGRect = if shouldTuck, let dockedEdge = model.dockedEdge {
            CapacityDockPlacement.tuckedFrame(
                alignedTarget,
                edge: dockedEdge,
                peek: CapacityDockMetrics.autoHidePeek(scale: model.scale)
            )
        } else {
            alignedTarget
        }
        railIsTucked = shouldTuck
        lastKnownRailTop = target.maxY
        var transaction = CapacityDockMotion.railTransaction(
            fromFrame: railPanel.frame,
            toFrame: target,
            attachmentFrom: model.attachmentProgress,
            attachmentTo: targetAttachment
        )
        // A single-provider rail keeps its size when it tucks or slides out, so
        // the pure translation must still animate as an expand/collapse.
        if transaction == .immediate,
           model.preferences.isAutoHideEnabled,
           railPanel.frame.origin != target.origin {
            transaction = wantsExpandedPresentation ? .railExpand : .railCollapse
        }
        if animate,
           !model.interaction.isDragging,
           railPanel.isVisible,
           CapacityDockMotion.shouldAnimate(transaction, reduceMotion: reduceMotion) {
            animateRail(to: target, transaction: transaction)
        } else {
            stopRailMotion()
            model.isRailPresentationExpanded = wantsExpandedPresentation
            model.railPresentationProgress = wantsExpandedPresentation ? 1 : 0
            model.attachmentProgress = targetAttachment
            railPanel.setFrame(target, display: true)
        }
        if model.preferences.isEnabled { railPanel.orderFrontRegardless() }
        updateMouseEventPassthrough()
        if !detailIsDismissing, let provider = model.hoveredProvider {
            layoutDetail(for: provider)
        }
        // A stationary pointer gets no mouseMoved event when the rail resizes
        // or moves beneath it; re-derive hover from the settled geometry.
        syncPointerHover()
    }

    private func layoutDetail(
        for provider: CapacityDockProvider,
        transaction: CapacityDockMotion.Transaction = .detailFollow
    ) {
        guard let detailPanel, let railPanel, let screen = targetScreen,
              let index = model.displayedProviders.firstIndex(of: provider) else { return }

        let providerAxisMidpoint: CGFloat
        if model.isVertical {
            if model.expansionAnchor == .start {
                providerAxisMidpoint = railPanel.frame.maxY
                    - model.railTopPadding
                    - model.rowHeight / 2
                    - CGFloat(index) * (model.rowHeight + model.rowSpacing)
            } else {
                providerAxisMidpoint = railPanel.frame.minY
                    + model.railBottomPadding
                    + model.rowHeight / 2
                    + CGFloat(model.displayedProviders.count - 1 - index)
                    * (model.rowHeight + model.rowSpacing)
            }
        } else {
            if model.expansionAnchor == .start {
                providerAxisMidpoint = railPanel.frame.minX
                    + model.railTopPadding
                    + model.rowHeight / 2
                    + CGFloat(index) * (model.rowHeight + model.rowSpacing)
            } else {
                providerAxisMidpoint = railPanel.frame.maxX
                    - model.railBottomPadding
                    - model.rowHeight / 2
                    - CGFloat(model.displayedProviders.count - 1 - index)
                    * (model.rowHeight + model.rowSpacing)
            }
        }
        let side = CapacityDockPlacement.preferredDetailSide(
            railFrame: railPanel.frame,
            visibleFrame: screen.visibleFrame,
            dockedEdge: model.dockedEdge,
            preferredEdge: model.attachmentEdge
        )
        model.detailTailEdge = side.opposite
        // The tail's own allowance is part of the content insets, so the height
        // is only exact once the side is known.
        model.detailHeight = glanceDetailHeight(for: provider)
        let target = CapacityDockPlacement.detailFrame(
            size: CGSize(width: model.detailWidth, height: model.detailHeight),
            railFrame: railPanel.frame,
            providerRowMidY: providerAxisMidpoint,
            visibleFrame: screen.visibleFrame,
            side: side
        )
        let tailAxisPosition = side.isVertical
            ? providerAxisMidpoint - target.minY
            : providerAxisMidpoint - target.minX
        let tailAxisLength = side.isVertical ? target.height : target.width
        model.detailTailPosition = tailAxisLength > 0
            ? min(max(tailAxisPosition / tailAxisLength, 0.18), 0.82)
            : 0.5
        if CapacityDockMotion.shouldAnimate(transaction, reduceMotion: reduceMotion),
           !model.interaction.isDragging {
            let start = detailPanel.isVisible
                ? detailPanel.frame
                : CapacityDockMotion.detailPresentationStartFrame(from: target, side: side)
            if !detailPanel.isVisible {
                detailPanel.alphaValue = 0
                detailPanel.setFrame(start, display: true)
                detailPanel.orderFrontRegardless()
            }
            animateDetail(from: start, to: target, transaction: transaction, fadeOut: false)
        } else {
            stopDetailMotion()
            detailPanel.alphaValue = 1
            detailPanel.setFrame(target, display: true)
            updateMouseEventPassthrough()
        }
    }

    private func animateRail(to target: CGRect, transaction: CapacityDockMotion.Transaction) {
        guard let railPanel else { return }
        stopRailMotion()
        railMotionGeneration &+= 1
        let generation = railMotionGeneration
        let start = railPanel.frame
        let duration = CapacityDockMotion.duration(for: transaction, reduceMotion: reduceMotion)
        let revealFrom = model.railPresentationProgress
        let revealTo: CGFloat = model.interaction.isExpanded ? 1 : 0
        let attachmentFrom = model.attachmentProgress
        let attachmentTo: CGFloat = model.dockedEdge == nil ? 0 : 1
        let backingScale = railPanel.screen?.backingScaleFactor ?? 2
        let isVertical = model.isVertical
        let expansionAnchor = model.expansionAnchor
        let attachedEdge = if transaction == .dockAttach || transaction == .dockDetach {
            model.attachmentEdge
        } else {
            model.dockedEdge
        }
        var lastAppliedFrame: CGRect?
        var lastAppliedReveal: CGFloat?
        var lastAppliedAttachment: CGFloat?
        railMotion = CapacityDockMotionRun(
            from: start,
            to: target,
            fromAlpha: railPanel.alphaValue,
            toAlpha: 1,
            duration: duration,
            transaction: transaction,
            topAnchored: true,
            attachedEdge: attachedEdge,
            expansionAnchor: expansionAnchor,
            update: { [weak self, weak railPanel] frame, alpha, progress in
                guard let self else { return }
                let sample = CapacityDockMotion.alignedRailSample(
                    frame,
                    fromFrame: start,
                    toFrame: target,
                    fromPresentationProgress: revealFrom,
                    toPresentationProgress: revealTo,
                    backingScale: backingScale,
                    dockedEdge: attachedEdge,
                    expansionAnchor: expansionAnchor,
                    isVertical: isVertical
                )
                let attachment = CapacityDockMotion.interpolateAlpha(
                    from: attachmentFrom,
                    to: attachmentTo,
                    progress: progress
                )

                // Multiple timer callbacks can resolve to one backing-pixel
                // frame near an ease curve's endpoints. Skip that duplicate
                // publication unless the attachment silhouette is changing.
                guard lastAppliedFrame != sample.frame
                        || lastAppliedReveal != sample.presentationProgress
                        || lastAppliedAttachment != attachment
                else { return }
                lastAppliedFrame = sample.frame
                lastAppliedReveal = sample.presentationProgress
                lastAppliedAttachment = attachment

                // Publish geometry derived from the snapped frame before
                // resizing the host. SwiftUI and AppKit now see one sample.
                if self.model.railPresentationProgress != sample.presentationProgress {
                    self.model.railPresentationProgress = sample.presentationProgress
                }
                if self.model.attachmentProgress != attachment {
                    self.model.attachmentProgress = attachment
                }
                if railPanel?.frame != sample.frame {
                    railPanel?.setFrame(sample.frame, display: false)
                }
                railPanel?.contentView?.needsDisplay = true
                railPanel?.alphaValue = alpha
                self.updateMouseEventPassthrough()
            },
            completion: { [weak self] in
                guard let self, generation == self.railMotionGeneration,
                      !self.model.interaction.isDragging else { return }
                self.railMotion = nil
                if self.railPanel?.frame != target {
                    self.railPanel?.setFrame(target, display: false)
                    self.railPanel?.contentView?.needsDisplay = true
                }
                self.lastKnownRailTop = target.maxY
                if !self.model.interaction.isExpanded {
                    if self.model.railPresentationProgress != 0 {
                        self.model.railPresentationProgress = 0
                    }
                    self.model.isRailPresentationExpanded = false
                } else {
                    if self.model.railPresentationProgress != 1 {
                        self.model.railPresentationProgress = 1
                    }
                }
                if self.model.attachmentProgress != attachmentTo {
                    self.model.attachmentProgress = attachmentTo
                }
                self.updateMouseEventPassthrough()
                if !self.detailIsDismissing, let provider = self.model.hoveredProvider {
                    self.layoutDetail(for: provider, transaction: .detailFollow)
                }
                self.syncPointerHover()
            }
        )
        railMotion?.start()
        // Keep the exact top anchor even if AppKit rounds an intermediate frame.
        if abs(start.maxY - target.maxY) < 0.5 { lastKnownRailTop = target.maxY }
    }

    private func animateDetail(
        from start: CGRect,
        to target: CGRect,
        transaction: CapacityDockMotion.Transaction,
        fadeOut: Bool
    ) {
        guard let detailPanel else { return }
        stopDetailMotion()
        detailMotionGeneration &+= 1
        let generation = detailMotionGeneration
        detailPanel.setFrame(start, display: true)
        detailMotion = CapacityDockMotionRun(
            from: start,
            to: target,
            fromAlpha: detailPanel.alphaValue,
            toAlpha: fadeOut ? 0 : 1,
            duration: CapacityDockMotion.duration(for: transaction, reduceMotion: reduceMotion),
            transaction: transaction,
            topAnchored: false,
            update: { [weak self, weak detailPanel] frame, alpha, _ in
                detailPanel?.setFrame(frame, display: false)
                detailPanel?.contentView?.needsDisplay = true
                detailPanel?.alphaValue = alpha
                self?.updateMouseEventPassthrough()
            },
            completion: { [weak self] in
                guard let self, generation == self.detailMotionGeneration else { return }
                self.detailMotion = nil
                if fadeOut {
                    self.completeDetailDismissal()
                } else {
                    self.detailPanel?.setFrame(target, display: true)
                    self.detailPanel?.alphaValue = 1
                }
                self.updateMouseEventPassthrough()
                self.syncPointerHover()
            }
        )
        detailMotion?.start()
    }

    private func dismissDetail(for _: CapacityDockProvider) {
        guard let detailPanel else { return }
        detailIsDismissing = true
        let target = CapacityDockMotion.detailDismissalFrame(
            from: detailPanel.frame,
            side: model.detailTailEdge.opposite
        )
        if CapacityDockMotion.shouldAnimate(.detailDismiss, reduceMotion: reduceMotion),
           !model.interaction.isDragging {
            animateDetail(
                from: detailPanel.frame,
                to: target,
                transaction: .detailDismiss,
                fadeOut: true
            )
        } else {
            stopDetailMotion()
            completeDetailDismissal()
        }
    }

    private func stopRailMotion() {
        railMotionGeneration &+= 1
        railMotion?.cancel()
        railMotion = nil
    }

    private func stopDetailMotion() {
        detailMotionGeneration &+= 1
        detailMotion?.cancel()
        detailMotion = nil
    }

    private var targetScreen: NSScreen? {
        if let screen = railPanel?.screen { return screen }
        let point = NSEvent.mouseLocation
        return NSScreen.screens.first { $0.frame.contains(point) } ?? NSScreen.main ?? NSScreen.screens.first
    }

    private func railContains(screenPoint: CGPoint) -> Bool {
        guard let railPanel, railPanel.frame.contains(screenPoint) else { return false }
        // Tucked rail: only a sliver is on screen and the silhouette's rounded
        // corners would leave almost nothing to hover, so the whole visible
        // strip counts as the rail.
        if railIsTucked { return true }
        let local = swiftUILocalPoint(screenPoint, in: railPanel.frame)
        return CapacityDockRailShape(
            bodyWidth: model.railWidth,
            bodyLength: model.bodyLength,
            shoulderDepth: CapacityDockMetrics.edgeShoulderDepth(scale: model.scale),
            attachmentProgress: model.attachmentProgress,
            edge: model.attachmentEdge
        )
        .path(in: CGRect(origin: .zero, size: railPanel.frame.size))
        .contains(local)
    }

    private func detailContains(screenPoint: CGPoint) -> Bool {
        guard let detailPanel, detailPanel.frame.contains(screenPoint) else { return false }
        let local = swiftUILocalPoint(screenPoint, in: detailPanel.frame)
        return CapacityDockBubbleShape(
            tailEdge: model.detailTailEdge,
            tailPosition: model.detailTailPosition
        )
        .path(in: CGRect(origin: .zero, size: detailPanel.frame.size))
        .contains(local)
    }

    private func swiftUILocalPoint(_ screenPoint: CGPoint, in frame: CGRect) -> CGPoint {
        CGPoint(x: screenPoint.x - frame.minX, y: frame.maxY - screenPoint.y)
    }
}

private extension CGRect {
    func aligned(
        to edge: CapacityDockEdge,
        screenFrame: CGRect,
        visibleFrame: CGRect
    ) -> CGRect {
        var result = self
        switch edge {
        case .left: result.origin.x = screenFrame.minX
        case .right: result.origin.x = screenFrame.maxX - width
        case .top: result.origin.y = screenFrame.maxY - height
        case .bottom: result.origin.y = screenFrame.minY
        }
        return result
    }
}

/// Main-run-loop frame driver. It is explicitly invalidated on hover reversal,
/// drag, screen reposition, and teardown, so no stale AppKit animation or
/// completion can repaint a panel after the interaction state has changed.
@MainActor
private final class CapacityDockMotionRun: NSObject {
    private let from: CGRect
    private let to: CGRect
    private let fromAlpha: CGFloat
    private let toAlpha: CGFloat
    private let duration: TimeInterval
    private let transaction: CapacityDockMotion.Transaction
    private let topAnchored: Bool
    private let attachedEdge: CapacityDockEdge?
    private let expansionAnchor: CapacityDockExpansionAnchor
    private let update: (CGRect, CGFloat, CGFloat) -> Void
    private let completion: () -> Void
    private var startedAt: TimeInterval?
    private var timer: Timer?
    private var isFinished = false

    init(
        from: CGRect,
        to: CGRect,
        fromAlpha: CGFloat,
        toAlpha: CGFloat,
        duration: TimeInterval,
        transaction: CapacityDockMotion.Transaction,
        topAnchored: Bool,
        attachedEdge: CapacityDockEdge? = nil,
        expansionAnchor: CapacityDockExpansionAnchor = .start,
        update: @escaping (CGRect, CGFloat, CGFloat) -> Void,
        completion: @escaping () -> Void
    ) {
        self.from = from
        self.to = to
        self.fromAlpha = fromAlpha
        self.toAlpha = toAlpha
        self.duration = duration
        self.transaction = transaction
        self.topAnchored = topAnchored
        self.attachedEdge = attachedEdge
        self.expansionAnchor = expansionAnchor
        self.update = update
        self.completion = completion
    }

    func start() {
        guard !isFinished else { return }
        if duration <= 0 {
            finish()
            return
        }
        startedAt = ProcessInfo.processInfo.systemUptime
        update(from, fromAlpha, 0)
        let timer = Timer(
            timeInterval: 1.0 / 60.0,
            target: self,
            selector: #selector(step),
            userInfo: nil,
            repeats: true
        )
        self.timer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    func cancel() {
        guard !isFinished else { return }
        isFinished = true
        timer?.invalidate()
        timer = nil
    }

    @objc private func step() {
        guard !isFinished, let startedAt else { return }
        let elapsed = ProcessInfo.processInfo.systemUptime - startedAt
        let linear = min(max(elapsed / duration, 0), 1)
        if linear >= 1 {
            finish()
            return
        }
        let progress = CapacityDockMotion.easedProgress(
            for: transaction,
            linear: CGFloat(linear)
        )
        let frame: CGRect
        if let attachedEdge {
            frame = CapacityDockMotion.interpolateAttachedEdge(
                from: from,
                to: to,
                edge: attachedEdge,
                expansionAnchor: expansionAnchor,
                progress: progress
            )
        } else if topAnchored {
            frame = CapacityDockMotion.interpolateRail(
                from: from,
                to: to,
                dockedEdge: nil,
                expansionAnchor: expansionAnchor,
                progress: progress
            )
        } else {
            frame = CapacityDockMotion.interpolate(from: from, to: to, progress: progress)
        }
        let alpha = CapacityDockMotion.interpolateAlpha(
            from: fromAlpha,
            to: toAlpha,
            progress: progress
        )
        update(frame, alpha, progress)
    }

    private func finish() {
        guard !isFinished else { return }
        isFinished = true
        timer?.invalidate()
        timer = nil
        update(to, toAlpha, 1)
        completion()
    }

}

private final class CapacityDockPanel: NSPanel {
    init() {
        super.init(
            contentRect: .zero,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        // The system menu bar sits above .mainMenu levels on recent macOS, so a
        // top-docked rail was clipped below it. Use the shielding level (as the
        // system notch apps do) so the rail can render flush at the very top edge.
        isFloatingPanel = true
        level = NSWindow.Level(rawValue: Int(CGShieldingWindowLevel()))
        backgroundColor = .clear
        isOpaque = false
        hasShadow = false
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        isMovable = false
        isExcludedFromWindowsMenu = true
        becomesKeyOnlyIfNeeded = true
        animationBehavior = .none
        collectionBehavior = Self.spaceBehavior
    }

    /// Membership of every space, including the one a full-screen app owns. The window
    /// server drops it from a panel across a display sleep or a display reconfiguration,
    /// and writing it again is what re-registers the window, so this is re-asserted
    /// before each presentation rather than only at init.
    static let spaceBehavior: NSWindow.CollectionBehavior =
        [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]

    func reassertSpaceMembership() {
        collectionBehavior = Self.spaceBehavior
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    /// Auto-hide parks the rail partly beyond the screen edge; AppKit must not
    /// pull it back on screen.
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
        frameRect
    }

    func makeContentTransparent() {
        contentView?.wantsLayer = true
        contentView?.layer?.backgroundColor = NSColor.clear.cgColor
    }
}

/// Floating nonactivating panels do not get an ordinary first click. Opting the
/// SwiftUI host into first-mouse delivery keeps provider rows and the direct
/// Connect button responsive without making CodeBurn the active application.
private final class CapacityDockHostingView<Content: View>: NSHostingView<Content> {
    var interactiveShapeContains: ((CGPoint, CGRect) -> Bool)?

    override func acceptsFirstMouse(for _: NSEvent?) -> Bool { true }

    override func hitTest(_ point: NSPoint) -> NSView? {
        if let interactiveShapeContains,
           !interactiveShapeContains(point, bounds) {
            return nil
        }
        return super.hitTest(point)
    }
}
