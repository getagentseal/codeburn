import Foundation

/// Runs `EarlyQuotaResetDetector` over each successful quota fetch, remembers
/// what it has already announced, and posts through the same notifier the
/// update check uses. It adds no polling: the caller invokes it from the
/// existing refresh lifecycle.
///
/// State lives in `UserDefaults`, one JSON record per provider:
/// - the readings from the previous successful fetch only, so a window that
///   was absent last time has no baseline and a baseline is never older than
///   one fetch. The snapshot store keeps each cycle's highest reading instead,
///   which is right for "what did the cycle end at" and wrong for "what did the
///   last fetch say": read as a baseline, it would re-announce a usage-drop
///   reset on every later fetch of the same cycle;
/// - the plan label seen at that fetch;
/// - the scheduled reset time of every announcement already made, matched with
///   the detector's own skew tolerance, so a vendor that briefly serves the old
///   cycle again — possibly from a replica whose timestamp differs by a minute
///   or two — cannot announce the same reset twice, across relaunches included;
/// - the latest event, for the Capacity Dock band;
/// - one reset time per observed cycle, for the 30-day history summary.
///
/// Every key is scoped to one provider by the record it lives in, so an early
/// reset on one provider cannot move another's baseline, dedupe record, band or
/// history. The record's defaults key is unchanged from the one this feature
/// first shipped with, so a Claude event a user has already been notified about
/// is still recognised as announced after the update.
@MainActor
final class EarlyQuotaResetMonitor {
    struct Observation: Equatable {
        let windowKey: String
        let windowName: String
        let windowSeconds: Int?
        /// Absolute usage in the provider's units, when reported; folded into
        /// the stored reading so signal 2 can tell a cleared counter from a
        /// raised limit.
        var usedUnits: Double? { reading?.usedUnits }
        /// Nil when the window was not in this fetch.
        let reading: EarlyQuotaResetReading?
    }

    struct ProviderState: Codable, Equatable {
        var planLabel: String?
        var windows: [String: EarlyQuotaResetReading]
        /// Scheduled reset times already announced, per window key.
        var announced: [String: [Date]]
        var latestEvent: EarlyQuotaResetEvent?
        /// One entry per observed cycle, per window key, oldest first, pruned to
        /// the same 30-day horizon. The history summary is read from here for
        /// every provider but Claude, which has the snapshot store on disk.
        ///
        /// Optional so a record written before this key existed still decodes:
        /// a missing ledger is an empty one, not a corrupt state.
        var observedResets: [String: [Date]]?
    }

    /// Announcements older than the snapshot store's horizon are dropped.
    static let firedRetentionSeconds: TimeInterval = 30 * 24 * 3600
    static let defaultsKeyPrefix = "codeburn.quota.earlyReset.state."

    private let defaults: UserDefaults
    private let makeNotifier: () -> any UpdateNotifier
    private var notifier: (any UpdateNotifier)?

    init(
        defaults: UserDefaults = .standard,
        makeNotifier: @escaping () -> any UpdateNotifier = { SystemUpdateNotifier() }
    ) {
        self.defaults = defaults
        self.makeNotifier = makeNotifier
    }

    /// Evaluates one successful fetch and returns the event it announced, if
    /// any. At most one notification per provider per fetch: a goodwill reset
    /// that empties several windows at once is one event, named after the
    /// longest window. Every window's identity is still recorded so a later
    /// fetch cannot announce the others.
    @discardableResult
    func record(
        providerID: String,
        providerName: String,
        planLabel: String?,
        baselineIsTrusted: Bool,
        observations: [Observation],
        now: Date = Date()
    ) async -> EarlyQuotaResetEvent? {
        let stored = loadState(providerID: providerID)
        var announced = stored?.announced ?? [:]

        var fresh: [(event: EarlyQuotaResetEvent, windowSeconds: Int)] = []
        if let stored {
            for observation in observations {
                let context = EarlyQuotaResetDetector.Context(
                    providerID: providerID,
                    providerName: providerName,
                    windowKey: observation.windowKey,
                    windowName: observation.windowName,
                    windowSeconds: observation.windowSeconds,
                    previousPlanLabel: stored.planLabel,
                    currentPlanLabel: planLabel,
                    baselineIsTrusted: baselineIsTrusted
                )
                guard let event = EarlyQuotaResetDetector.detect(
                    previous: stored.windows[observation.windowKey],
                    current: observation.reading,
                    context: context
                ) else { continue }
                guard !Self.wasAnnounced(event, in: announced) else { continue }
                announced[event.windowKey, default: []].append(event.scheduledResetAt)
                fresh.append((event, observation.windowSeconds ?? 0))
            }
        }

        let headline = fresh.max { lhs, rhs in
            lhs.windowSeconds != rhs.windowSeconds
                ? lhs.windowSeconds < rhs.windowSeconds
                : lhs.event.earlyBySeconds < rhs.event.earlyBySeconds
        }?.event

        var windows: [String: EarlyQuotaResetReading] = [:]
        for observation in observations {
            if let reading = observation.reading { windows[observation.windowKey] = reading }
        }
        let cutoff = now.addingTimeInterval(-Self.firedRetentionSeconds)
        saveState(
            ProviderState(
                planLabel: planLabel,
                windows: windows,
                announced: announced
                    .mapValues { $0.filter { $0 >= cutoff } }
                    .filter { !$0.value.isEmpty },
                latestEvent: headline ?? stored?.latestEvent,
                observedResets: Self.recordCycles(
                    observations,
                    into: stored?.observedResets ?? [:],
                    cutoff: cutoff
                )
            ),
            providerID: providerID
        )

        guard let headline else { return nil }
        // Persisted before delivery: an event is one-shot even when the user has
        // notifications off or denied, and the dock band still shows it.
        await post(headline)
        return headline
    }

    /// The latest announced event for the dock band, while it is still recent.
    func visibleEvent(providerID: String, now: Date = Date()) -> EarlyQuotaResetEvent? {
        guard let event = loadState(providerID: providerID)?.latestEvent else { return nil }
        return EarlyQuotaResetNotice.isVisible(event, now: now) ? event : nil
    }

    /// The reset times this provider's window has been seen carrying, oldest
    /// first, for the 30-day history summary. Empty for a window this Mac has
    /// no record of.
    func observedResets(providerID: String, windowKey: String) -> [Date] {
        loadState(providerID: providerID)?.observedResets?[windowKey] ?? []
    }

    /// Fold this fetch's readings into the per-window cycle ledger. One entry
    /// per cycle, not per fetch: a reset time inside the detector's skew
    /// tolerance of the newest entry is the same cycle re-reported with a
    /// jittered timestamp, and replaces it. A reset time that moved backwards is
    /// skew, and is dropped rather than recorded as a cycle that never ran.
    private static func recordCycles(
        _ observations: [Observation],
        into stored: [String: [Date]],
        cutoff: Date
    ) -> [String: [Date]] {
        var ledger = stored
        for observation in observations {
            guard let reading = observation.reading, reading.isWellFormed else { continue }
            var cycles = ledger[observation.windowKey] ?? []
            if let last = cycles.last {
                let move = reading.resetsAt.timeIntervalSince(last)
                if abs(move) < EarlyQuotaResetDetector.skewTolerance {
                    cycles[cycles.count - 1] = reading.resetsAt
                } else if move > 0 {
                    cycles.append(reading.resetsAt)
                }
            } else {
                cycles.append(reading.resetsAt)
            }
            ledger[observation.windowKey] = cycles.filter { $0 >= cutoff }
        }
        return ledger.filter { !$0.value.isEmpty }
    }

    /// Called on user disconnect so a reconnect, possibly to another account,
    /// starts without a baseline.
    func forget(providerID: String) {
        defaults.removeObject(forKey: Self.defaultsKeyPrefix + providerID)
    }

    /// Whether this cut-short cycle has already been announced. Compared with the
    /// detector's skew tolerance rather than exactly: the same cycle can come back
    /// from the vendor with a slightly different reset timestamp, and that is the
    /// same event, not a second one.
    private static func wasAnnounced(
        _ event: EarlyQuotaResetEvent,
        in announced: [String: [Date]]
    ) -> Bool {
        guard let times = announced[event.windowKey] else { return false }
        // Inclusive: at exactly the tolerance, not announcing twice is the safer
        // side of the boundary.
        return times.contains {
            abs($0.timeIntervalSince(event.scheduledResetAt)) <= EarlyQuotaResetDetector.skewTolerance
        }
    }

    private func post(_ event: EarlyQuotaResetEvent) async {
        guard EarlyQuotaResetPreference.isEnabled(defaults: defaults) else { return }
        let notifier = notifier ?? makeNotifier()
        self.notifier = notifier
        guard await notifier.requestAuthorizationIfNeeded() else { return }
        notifier.post(
            title: event.notificationTitle,
            body: event.notificationBody,
            identifier: "EarlyQuotaReset.\(event.identity)"
        )
    }

    /// A missing or undecodable record is "no opinion": no baseline, no event.
    private func loadState(providerID: String) -> ProviderState? {
        guard let data = defaults.data(forKey: Self.defaultsKeyPrefix + providerID) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        return try? decoder.decode(ProviderState.self, from: data)
    }

    private func saveState(_ state: ProviderState, providerID: String) {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        guard let data = try? encoder.encode(state) else { return }
        defaults.set(data, forKey: Self.defaultsKeyPrefix + providerID)
    }
}
