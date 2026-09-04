import Foundation

/// Stable Capacity Dock identity backed by the audited provider catalog.
///
/// This is a value type rather than a 69-case enum so the provider inventory has
/// one source of truth. Existing CodeBurn quota adapters retain their
/// `ProviderFilter` bridge; the remaining providers are fetched through the
/// CodeBurn-owned provider adapter at runtime.
struct CapacityDockProvider: RawRepresentable, CaseIterable, Identifiable, Hashable, Sendable {
    let rawValue: String

    init?(rawValue: String) {
        guard ProviderConnectionCatalog.providers.contains(where: { $0.id == rawValue }) else {
            return nil
        }
        self.rawValue = rawValue
    }

    private init(known rawValue: String) {
        self.rawValue = rawValue
    }

    var id: String { rawValue }

    static var allCases: [CapacityDockProvider] {
        ProviderConnectionCatalog.providers.map { CapacityDockProvider(known: $0.id) }
    }

    static let codex = CapacityDockProvider(known: "codex")
    static let claude = CapacityDockProvider(known: "claude")
    static let gemini = CapacityDockProvider(known: "gemini")
    static let copilot = CapacityDockProvider(known: "copilot")
    static let kimiCode = CapacityDockProvider(known: "kimi")
    static let antigravity = CapacityDockProvider(known: "antigravity")

    var catalogEntry: ProviderConnectionCatalogEntry {
        ProviderConnectionCatalog.providers.first { $0.id == rawValue }!
    }

    var legacyFilter: ProviderFilter? {
        switch rawValue {
        case Self.claude.rawValue: .claude
        case Self.codex.rawValue: .codex
        case Self.gemini.rawValue: .gemini
        case Self.copilot.rawValue: .copilot
        case Self.kimiCode.rawValue: .kimiCode
        case Self.antigravity.rawValue: .antigravity
        default: nil
        }
    }

    var displayName: String { catalogEntry.displayName }

    /// The CLI's provider id for this dock provider, used to find its row in the
    /// payload's `providerDetails`. Catalog ids and CLI ids agree everywhere the
    /// dock has no legacy bridge; where it has one the bridge is the authority,
    /// because the dock's `kimi` entry is Kimi Code, which the CLI calls
    /// `kimicode` (its `kimi` is a different provider).
    var payloadProviderID: String { legacyFilter?.cliArg ?? rawValue }

    /// Every payload provider this one tile stands for. A tile is an account the
    /// user recognises; the CLI splits some accounts across more than one provider
    /// row, and a tile that reads only the first row reports zero while the account
    /// was busy. Cursor is the case in hand: one subscription, but sessions land
    /// under `cursor` for the editor and `cursor-agent` for the agent.
    var payloadProviderIDs: [String] {
        switch payloadProviderID {
        // One subscription, two rows: the editor and the agent.
        case "cursor": ["cursor", "cursor-agent"]
        // The tile is the Factory account, which the CLI records under its
        // product name. Without this the Droid tile reads zero while Droid works.
        case "factory": ["droid"]
        // The ClinePass plan pays for both Cline surfaces, and the CLI records
        // the extension and the command line tool as separate rows.
        case "clinepass": ["cline", "cline-cli"]
        default: [payloadProviderID]
        }
    }

    var iconName: String {
        switch rawValue {
        case Self.codex.rawValue, "openai", "azureopenai": "codex"
        case Self.gemini.rawValue: "gemini"
        case Self.copilot.rawValue: "copilot"
        case "alibabatokenplan": "alibaba"
        case "moonshot": "kimi"
        default: rawValue
        }
    }
}

enum CapacityDockEdge: String, CaseIterable, Sendable {
    case left
    case right
    case top
    case bottom

    var isVertical: Bool { self == .left || self == .right }

    var opposite: CapacityDockEdge {
        switch self {
        case .left: .right
        case .right: .left
        case .top: .bottom
        case .bottom: .top
        }
    }
}

enum CapacityDockTheme: String, CaseIterable, Sendable {
    case graphite
    case liquidGlass

    var displayName: String {
        switch self {
        case .graphite: L("Graphite")
        case .liquidGlass: L("Liquid Glass")
        }
    }
}

enum CapacityDockGaugeShape: String, CaseIterable, Sendable {
    case circle
    case squircle

    var displayName: String {
        switch self {
        case .circle: L("Circle")
        case .squircle: L("Squircle")
        }
    }
}

enum CapacityDockProviderSelection {
    static func isDockEligible(
        _ provider: CapacityDockProvider,
        isConnected: Bool,
        hasSavedCredential: Bool
    ) -> Bool {
        isConnected || (
            provider.catalogEntry.hasLiveCodeBurnQuotaAdapter && hasSavedCredential
        )
    }

    static func eligibleProviders(
        from providers: [CapacityDockProvider] = CapacityDockPreferences.supportedProviders,
        isEligible: (CapacityDockProvider) -> Bool
    ) -> [CapacityDockProvider] {
        providers.filter(isEligible)
    }

    static func manageableProviders(
        from providers: [CapacityDockProvider] = CapacityDockPreferences.supportedProviders,
        selected: [CapacityDockProvider],
        isConnected: (CapacityDockProvider) -> Bool
    ) -> [CapacityDockProvider] {
        let selectedSet = Set(selected)
        return providers.filter { selectedSet.contains($0) || isConnected($0) }
    }

    static func canDeselect(
        _ provider: CapacityDockProvider,
        selected: [CapacityDockProvider],
        isConnected: (CapacityDockProvider) -> Bool
    ) -> Bool {
        guard selected.contains(provider) else { return true }
        let connectedSelection = selected.filter(isConnected)
        return !isConnected(provider) || connectedSelection.count > 1
    }
}

enum CapacityDockPreferences {
    static let enabledKey = "CodeBurnCapacityDockEnabled"
    static let selectedProvidersKey = "CodeBurnCapacityDockProviders"
    static let preferredProviderKey = "CodeBurnCapacityDockPreferredProvider"
    static let dockEdgeKey = "CodeBurnCapacityDockEdge"
    static let attachmentEdgeKey = "CodeBurnCapacityDockAttachmentEdge"
    static let legacyDockedKey = "CodeBurnCapacityDockDocked"
    static let normalizedHorizontalOffsetKey = "CodeBurnCapacityDockHorizontalOffset"
    static let normalizedVerticalOffsetKey = "CodeBurnCapacityDockVerticalOffset"
    static let scaleKey = "CodeBurnCapacityDockScale"
    static let themeKey = "CodeBurnCapacityDockTheme"
    static let gaugeShapeKey = "CodeBurnCapacityDockGaugeShape"
    static let manualSelectionKey = "CodeBurnCapacityDockManualSelection"
    static let autoHideKey = "CodeBurnCapacityDockAutoHide"

    static let defaultProvider: CapacityDockProvider = .codex
    static let supportedProviders = CapacityDockProvider.allCases
    static let maxAutoProviders = 5
    static let defaultScale = 0.6
    static let scaleRange = 0.6 ... 1.2

    struct Snapshot: Equatable, Sendable {
        let isEnabled: Bool
        let selectedProviders: [CapacityDockProvider]
        let preferredProvider: CapacityDockProvider
        let dockedEdge: CapacityDockEdge?
        let attachmentEdge: CapacityDockEdge
        let normalizedHorizontalOffset: Double?
        let normalizedVerticalOffset: Double?
        let scale: Double
        let theme: CapacityDockTheme
        let gaugeShape: CapacityDockGaugeShape
        /// Tuck the docked rail into its screen edge while resting and slide
        /// it out when the pointer reaches the edge. Ignored for floating rails.
        var isAutoHideEnabled: Bool = false
    }

    static func load(defaults: UserDefaults = .standard) -> Snapshot {
        let selected = normalizedProviders(
            rawIdentifiers: defaults.stringArray(forKey: selectedProvidersKey)
        )
        let storedPreferred = defaults.string(forKey: preferredProviderKey)
            .flatMap(CapacityDockProvider.init(rawValue:))
        let preferred = normalizedPreferred(storedPreferred, selected: selected)

        let horizontalOffset: Double?
        if defaults.object(forKey: normalizedHorizontalOffsetKey) != nil {
            let stored = defaults.double(forKey: normalizedHorizontalOffsetKey)
            horizontalOffset = stored.isFinite ? clamp(stored) : nil
        } else {
            horizontalOffset = nil
        }

        let verticalOffset: Double?
        if defaults.object(forKey: normalizedVerticalOffsetKey) != nil {
            let stored = defaults.double(forKey: normalizedVerticalOffsetKey)
            verticalOffset = stored.isFinite ? clamp(stored) : nil
        } else {
            verticalOffset = nil
        }

        let dockedEdge: CapacityDockEdge?
        if let rawEdge = defaults.string(forKey: dockEdgeKey),
           let storedEdge = CapacityDockEdge(rawValue: rawEdge) {
            dockedEdge = storedEdge
        } else if defaults.object(forKey: legacyDockedKey) != nil,
                  !defaults.bool(forKey: legacyDockedKey) {
            dockedEdge = nil
        } else {
            dockedEdge = .right
        }
        let attachmentEdge = defaults.string(forKey: attachmentEdgeKey)
            .flatMap(CapacityDockEdge.init(rawValue:))
            ?? dockedEdge
            ?? .right

        return Snapshot(
            isEnabled: defaults.bool(forKey: enabledKey),
            selectedProviders: selected,
            preferredProvider: preferred,
            dockedEdge: dockedEdge,
            attachmentEdge: attachmentEdge,
            normalizedHorizontalOffset: horizontalOffset,
            normalizedVerticalOffset: verticalOffset,
            scale: normalizedScale(
                defaults.object(forKey: scaleKey) == nil
                    ? defaultScale
                    : defaults.double(forKey: scaleKey)
            ),
            theme: defaults.string(forKey: themeKey)
                .flatMap(CapacityDockTheme.init(rawValue:)) ?? .graphite,
            gaugeShape: defaults.string(forKey: gaugeShapeKey)
                .flatMap(CapacityDockGaugeShape.init(rawValue:)) ?? .squircle,
            isAutoHideEnabled: defaults.bool(forKey: autoHideKey)
        )
    }

    static func setAutoHide(_ enabled: Bool, defaults: UserDefaults = .standard) {
        defaults.set(enabled, forKey: autoHideKey)
        notifyChanged()
    }

    static func setEnabled(_ enabled: Bool, defaults: UserDefaults = .standard) {
        defaults.set(enabled, forKey: enabledKey)
        notifyChanged()
    }

    static func setSelectedProviders(
        _ providers: [CapacityDockProvider],
        defaults: UserDefaults = .standard
    ) {
        let identifiers = providers.map(\.rawValue)
        let normalized = normalizedProviders(rawIdentifiers: identifiers)
        let currentPreferred = defaults.string(forKey: preferredProviderKey)
            .flatMap(CapacityDockProvider.init(rawValue:))
        let preferred = normalizedPreferred(currentPreferred, selected: normalized)
        defaults.set(normalized.map(\.rawValue), forKey: selectedProvidersKey)
        defaults.set(preferred.rawValue, forKey: preferredProviderKey)
        // The user has taken over the dock provider set, so stop auto-seeding
        // from connected subscriptions and respect their choice from now on.
        defaults.set(true, forKey: manualSelectionKey)
        notifyChanged()
    }

    /// Drops one provider from the persisted dock selection without latching
    /// manual-selection mode. Disconnect needs this: a credential-less
    /// adapter (Cursor) left in the selection would silently reconnect on the
    /// next scheduled refresh.
    static func removeProvider(
        _ provider: CapacityDockProvider,
        defaults: UserDefaults = .standard
    ) {
        let stored = defaults.stringArray(forKey: selectedProvidersKey) ?? []
        let remaining = stored.filter { $0 != provider.rawValue }
        guard remaining.count != stored.count else { return }
        defaults.set(remaining, forKey: selectedProvidersKey)
        let preferred = normalizedPreferred(
            defaults.string(forKey: preferredProviderKey).flatMap(CapacityDockProvider.init(rawValue:)),
            selected: normalizedProviders(rawIdentifiers: remaining)
        )
        defaults.set(preferred.rawValue, forKey: preferredProviderKey)
        notifyChanged()
    }

    /// Until the user manually edits the dock set, mirror the connected
    /// subscriptions (capped) so a fresh install shows what's actually active.
    /// No-ops once `manualSelectionKey` latches or the set already matches.
    static func autoSeedFromConnected(
        _ connected: [CapacityDockProvider],
        defaults: UserDefaults = .standard
    ) {
        guard !defaults.bool(forKey: manualSelectionKey) else { return }
        let desired = supportedProviders
            .filter(connected.contains)
            .prefix(maxAutoProviders)
        let desiredIDs = desired.map(\.rawValue)
        guard !desiredIDs.isEmpty else { return }  // nothing active yet — wait
        guard defaults.stringArray(forKey: selectedProvidersKey) != desiredIDs else { return }
        defaults.set(desiredIDs, forKey: selectedProvidersKey)
        let preferred = normalizedPreferred(
            defaults.string(forKey: preferredProviderKey).flatMap(CapacityDockProvider.init(rawValue:)),
            selected: Array(desired)
        )
        defaults.set(preferred.rawValue, forKey: preferredProviderKey)
        notifyChanged()
    }

    static func setPreferredProvider(
        _ provider: CapacityDockProvider,
        defaults: UserDefaults = .standard
    ) {
        let selected = load(defaults: defaults).selectedProviders
        let normalized = normalizedPreferred(provider, selected: selected)
        defaults.set(normalized.rawValue, forKey: preferredProviderKey)
        notifyChanged()
    }

    static func setNormalizedVerticalOffset(
        _ offset: Double?,
        defaults: UserDefaults = .standard
    ) {
        if let offset, offset.isFinite {
            defaults.set(clamp(offset), forKey: normalizedVerticalOffsetKey)
        } else {
            defaults.removeObject(forKey: normalizedVerticalOffsetKey)
        }
        notifyChanged()
    }

    static func setPlacement(
        dockedEdge: CapacityDockEdge?,
        attachmentEdge: CapacityDockEdge? = nil,
        normalizedHorizontalOffset: Double?,
        normalizedVerticalOffset: Double?,
        defaults: UserDefaults = .standard
    ) {
        if let dockedEdge {
            defaults.set(dockedEdge.rawValue, forKey: dockEdgeKey)
            defaults.removeObject(forKey: legacyDockedKey)
        } else {
            defaults.removeObject(forKey: dockEdgeKey)
            // Absence means a fresh install, whose product default is the
            // right edge. Retain an explicit false marker so a deliberately
            // detached rail survives relaunch and screen changes.
            defaults.set(false, forKey: legacyDockedKey)
        }
        let retainedAttachmentEdge = attachmentEdge
            ?? dockedEdge
            ?? defaults.string(forKey: attachmentEdgeKey).flatMap(CapacityDockEdge.init(rawValue:))
            ?? .right
        defaults.set(retainedAttachmentEdge.rawValue, forKey: attachmentEdgeKey)
        if let normalizedHorizontalOffset,
           normalizedHorizontalOffset.isFinite {
            defaults.set(clamp(normalizedHorizontalOffset), forKey: normalizedHorizontalOffsetKey)
        } else {
            defaults.removeObject(forKey: normalizedHorizontalOffsetKey)
        }
        if let normalizedVerticalOffset, normalizedVerticalOffset.isFinite {
            defaults.set(clamp(normalizedVerticalOffset), forKey: normalizedVerticalOffsetKey)
        } else {
            defaults.removeObject(forKey: normalizedVerticalOffsetKey)
        }
        notifyChanged()
    }

    static func setScale(_ scale: Double, defaults: UserDefaults = .standard) {
        defaults.set(normalizedScale(scale), forKey: scaleKey)
        notifyChanged()
    }

    static func setTheme(_ theme: CapacityDockTheme, defaults: UserDefaults = .standard) {
        defaults.set(theme.rawValue, forKey: themeKey)
        notifyChanged()
    }

    static func setGaugeShape(
        _ gaugeShape: CapacityDockGaugeShape,
        defaults: UserDefaults = .standard
    ) {
        defaults.set(gaugeShape.rawValue, forKey: gaugeShapeKey)
        notifyChanged()
    }

    private static func normalizedProviders(rawIdentifiers: [String]?) -> [CapacityDockProvider] {
        let identifiers = Set(rawIdentifiers ?? [defaultProvider.rawValue])
        let normalized = supportedProviders.filter { identifiers.contains($0.rawValue) }
        return normalized.isEmpty ? [defaultProvider] : normalized
    }

    private static func normalizedPreferred(
        _ preferred: CapacityDockProvider?,
        selected: [CapacityDockProvider]
    ) -> CapacityDockProvider {
        if let preferred, selected.contains(preferred) { return preferred }
        if selected.contains(defaultProvider) { return defaultProvider }
        return selected.first ?? defaultProvider
    }

    private static func clamp(_ value: Double) -> Double {
        min(max(value, 0), 1)
    }

    private static func normalizedScale(_ value: Double) -> Double {
        guard value.isFinite else { return defaultScale }
        return min(max(value, scaleRange.lowerBound), scaleRange.upperBound)
    }

    private static func notifyChanged() {
        NotificationCenter.default.post(name: .capacityDockPreferencesDidChange, object: nil)
    }
}

extension Notification.Name {
    static let capacityDockPreferencesDidChange = Notification.Name("com.codeburn.capacityDockPreferencesDidChange")
    static let capacityDockOpenProviderSettings = Notification.Name("com.codeburn.capacityDockOpenProviderSettings")
}
