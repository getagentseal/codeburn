import Foundation

// Banked limit-reset credits ("goodwill resets"): OpenAI grants a Codex account
// a credit that restores a rate-limit window early. They arrive without warning
// from the app's point of view — the only evidence we have is that a new credit
// appears in the `rate-limit-reset-credits` inventory we already fetch on the
// existing usage cadence. Nothing here polls, and nothing here ever spends a
// credit: this is a notice, not an action.

// MARK: - Persisted state

/// What we have already seen, so a credit announces itself exactly once — across
/// refreshes, across a failed fetch, and across a relaunch.
///
/// Persisted with the same mechanism `SubscriptionSnapshotStore` uses (one JSON
/// document in the CodeBurn cache directory, written through `SafeFile`), not a
/// second one.
struct CodexBankedResetState: Codable, Sendable, Equatable {
    struct SeenCredit: Codable, Sendable, Equatable {
        let id: String
        let firstSeenAt: Date
    }

    /// Nil until the first successful observation. Its absence is what makes
    /// that first observation a baseline instead of a burst of notifications
    /// for every credit the account already held.
    var baselineAt: Date?
    var credits: [SeenCredit]

    init(baselineAt: Date? = nil, credits: [SeenCredit] = []) {
        self.baselineAt = baselineAt
        self.credits = credits
    }
}

// MARK: - Detection

/// Pure: takes an observation and the state it is judged against, returns the
/// events and the state to persist. No clock, no disk, no network.
enum CodexBankedResetDetector {
    /// Ids of credits that are gone from the payload are kept this long before
    /// being forgotten, so a credit that flickers out of one response and back
    /// into the next cannot announce itself twice. Mirrors the 30-day retention
    /// `SubscriptionSnapshotStore` prunes to.
    static let retentionSeconds: TimeInterval = 30 * 24 * 3600

    struct Outcome: Equatable {
        /// Credits observed for the first time, in payload order. Empty for a
        /// baseline observation, for an unchanged inventory, and for every
        /// observation we have no opinion about.
        let events: [CodexUsage.ResetCredits.Grant]
        let state: CodexBankedResetState
    }

    /// `observed == nil` means the credits payload was absent or malformed. That
    /// is "no opinion", never an event and never a state change: a reconnect
    /// after a failed fetch must not re-baseline, and a schema drift must not
    /// silently forget every credit we have already announced.
    static func evaluate(
        observed: CodexUsage.ResetCredits?,
        state: CodexBankedResetState,
        now: Date
    ) -> Outcome {
        guard let observed else { return Outcome(events: [], state: state) }
        // Only credits the parser could give a stable identity to are in here;
        // an unidentifiable credit still counts toward `availableCount` but can
        // never be told apart from the next one, so it never fires.
        let grants = observed.grants

        guard state.baselineAt != nil else {
            // First-ever observation: everything the account holds is history,
            // not news.
            return Outcome(
                events: [],
                state: CodexBankedResetState(
                    baselineAt: now,
                    credits: grants.map { .init(id: $0.id, firstSeenAt: now) }
                )
            )
        }

        var knownIDs = Set(state.credits.map(\.id))
        var credits = state.credits
        var events: [CodexUsage.ResetCredits.Grant] = []
        for grant in grants where knownIDs.insert(grant.id).inserted {
            events.append(grant)
            credits.append(.init(id: grant.id, firstSeenAt: now))
        }

        // A credit that disappears was consumed or expired — never an event. Its
        // id is held for the retention window so it cannot come back as news.
        let observedIDs = Set(grants.map(\.id))
        let cutoff = now.addingTimeInterval(-retentionSeconds)
        credits = credits.filter { observedIDs.contains($0.id) || $0.firstSeenAt >= cutoff }

        return Outcome(events: events, state: CodexBankedResetState(baselineAt: state.baselineAt, credits: credits))
    }
}

// MARK: - Wording

/// The one place the banked-reset wording lives. `src/quota/codex.ts` carries a
/// line-for-line mirror of `detail` and `compactAge` so the CLI and the menubar
/// say the same sentence.
enum CodexBankedResetPresentation {
    /// Label the detail hangs off, in the Plan tab and in front of the detail on
    /// every other surface.
    static let rowLabel = "Limit resets"

    /// `2 available · 1 usable now · latest weekly reset granted 2h ago · next expires in 16h`
    /// Nil when the account holds nothing — the row hides rather than printing a zero.
    static func detail(_ credits: CodexUsage.ResetCredits, now: Date) -> String? {
        guard credits.availableCount > 0 else { return nil }
        var parts = ["\(credits.availableCount) available"]
        // Only worth saying when it disagrees with the headline count: equal
        // numbers would just be the same fact twice.
        if let applicable = credits.applicableAvailableCount, applicable != credits.availableCount {
            parts.append("\(applicable) usable now")
        }
        if let grant = credits.latestGrant, let grantedAt = grant.grantedAt {
            let type = resetTypeLabel(grant.resetType)
            parts.append(grantedAt > now
                ? "next \(type) lands \(compactAge(of: grantedAt, now: now))"
                : "latest \(type) granted \(compactAge(of: grantedAt, now: now))")
        }
        if let expiry = credits.nextExpiresAt {
            parts.append("next expires \(compactAge(of: expiry, now: now))")
        }
        return parts.joined(separator: " · ")
    }

    /// `Limit resets · 2 available · …`, the single-string form the quota hover
    /// card and `codeburn quota` both print.
    static func line(_ credits: CodexUsage.ResetCredits, now: Date) -> String? {
        detail(credits, now: now).map { "\(rowLabel) · \($0)" }
    }

    /// Notification copy for one newly observed credit: what was granted, when,
    /// and how many the account can use. Never the credit id — it is an account
    /// identifier of sorts and says nothing to the user.
    static func notice(
        for grant: CodexUsage.ResetCredits.Grant,
        credits: CodexUsage.ResetCredits,
        now: Date
    ) -> (title: String, body: String) {
        let type = resetTypeLabel(grant.resetType)
        var body: String
        if let grantedAt = grant.grantedAt {
            body = grantedAt > now
                ? "A \(type) lands \(compactAge(of: grantedAt, now: now))."
                : "A \(type) was added to your account \(compactAge(of: grantedAt, now: now))."
        } else {
            body = "A \(type) was added to your account."
        }
        // `applicable_available_count` is the number that answers "can I use one
        // right now"; the plain count is the fallback when it is absent.
        let usable = credits.applicableAvailableCount ?? credits.availableCount
        body += " You have \(usable) available to use."
        return ("Codex banked a limit reset", body)
    }

    /// "weekly" -> "weekly reset". An absent or empty `reset_type` degrades to
    /// the bare noun rather than inventing a scope the payload did not state.
    static func resetTypeLabel(_ resetType: String?) -> String {
        let raw = (resetType ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .lowercased()
        return raw.isEmpty ? "limit reset" : "\(raw) reset"
    }

    /// Deliberately not `RelativeDateTimeFormatter`: this string has to come out
    /// character-identical in Swift and in TypeScript, so the rules are spelled
    /// out instead of delegated to a locale-aware formatter.
    static func compactAge(of date: Date, now: Date) -> String {
        let elapsed = now.timeIntervalSince(date)
        if elapsed >= 0 {
            if elapsed < 60 { return "just now" }
            if elapsed < 3600 { return "\(Int(elapsed / 60))m ago" }
            if elapsed < 86_400 { return "\(Int(elapsed / 3600))h ago" }
            return "\(Int(elapsed / 86_400))d ago"
        }
        let ahead = -elapsed
        if ahead < 60 { return "in under a minute" }
        if ahead < 3600 { return "in \(Int(ahead / 60))m" }
        if ahead < 86_400 { return "in \(Int(ahead / 3600))h" }
        return "in \(Int(ahead / 86_400))d"
    }
}

// MARK: - Persistence

protocol CodexBankedResetStateStoring: Sendable {
    func load() async -> CodexBankedResetState
    func save(_ state: CodexBankedResetState) async
}

private let bankedResetFilename = "codex-banked-resets.json"

private func bankedResetPath() -> String {
    (CodeBurnCacheDirectory.resolve() as NSString).appendingPathComponent(bankedResetFilename)
}

private actor BankedResetLock {
    static let shared = BankedResetLock()
    func run<T>(_ fn: () throws -> T) rethrows -> T { try fn() }
}

/// Same shape as `SubscriptionSnapshotStore`: one JSON document in the CodeBurn
/// cache directory, serialized behind an actor, written 0600 through `SafeFile`
/// (which refuses a symlinked target and does the tmp+rename dance).
struct CodexBankedResetStore: CodexBankedResetStateStoring {
    func load() async -> CodexBankedResetState {
        await BankedResetLock.shared.run {
            let path = bankedResetPath()
            guard FileManager.default.fileExists(atPath: path),
                  let data = try? SafeFile.read(from: path) else { return CodexBankedResetState() }
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            return (try? decoder.decode(CodexBankedResetState.self, from: data)) ?? CodexBankedResetState()
        }
    }

    func save(_ state: CodexBankedResetState) async {
        await BankedResetLock.shared.run {
            do {
                let encoder = JSONEncoder()
                encoder.dateEncodingStrategy = .iso8601
                try SafeFile.write(encoder.encode(state), to: bankedResetPath(), mode: 0o600)
            } catch {
                NSLog("CodeBurn: codex banked-reset state write failed: %@", String(describing: error))
            }
        }
    }

    /// Called on disconnect, so a reconnect under a different account baselines
    /// again instead of announcing that account's whole inventory.
    static func clearAll() async {
        await BankedResetLock.shared.run {
            try? FileManager.default.removeItem(atPath: bankedResetPath())
        }
    }
}

// MARK: - Preference

/// Absent key is true, matching `UpdateNotificationPreference`: existing installs
/// get the notice without visiting Settings first.
enum CodexBankedResetNotificationPreference {
    static let defaultsKey = "codeburn.codex.bankedResetNotificationsEnabled"

    static func isEnabled(defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: defaultsKey) as? Bool ?? true
    }
}

// MARK: - Announcer

/// Wires the pure detector to the existing notification path. Owns no fetch: it
/// is handed whatever the usage refresh already decoded.
@MainActor
final class CodexBankedResetAnnouncer {
    private let defaults: UserDefaults
    private let store: any CodexBankedResetStateStoring
    private let makeNotifier: () -> any UpdateNotifier
    private var notifier: (any UpdateNotifier)?
    private var isObserving = false

    init(
        defaults: UserDefaults = .standard,
        store: any CodexBankedResetStateStoring = CodexBankedResetStore(),
        makeNotifier: @escaping () -> any UpdateNotifier = { SystemUpdateNotifier() }
    ) {
        self.defaults = defaults
        self.store = store
        self.makeNotifier = makeNotifier
    }

    func observe(_ credits: CodexUsage.ResetCredits?, now: Date = Date()) async {
        // The load/save pair spans two awaits; a second refresh landing inside
        // it would judge against pre-save state and post twice. Skipping is
        // free — the next refresh observes the same inventory.
        guard !isObserving else { return }
        isObserving = true
        defer { isObserving = false }

        let state = await store.load()
        let outcome = CodexBankedResetDetector.evaluate(observed: credits, state: state, now: now)
        guard outcome.state != state else { return }
        // Persisted before the post, not after: a notice we drop is a smaller
        // failure than one that repeats on every refresh.
        await store.save(outcome.state)
        guard !outcome.events.isEmpty, let credits else { return }
        // The state is recorded either way, so turning the toggle back on does
        // not release a backlog of grants that landed while it was off.
        guard CodexBankedResetNotificationPreference.isEnabled(defaults: defaults) else { return }
        let notifier = notifier ?? makeNotifier()
        self.notifier = notifier
        guard await notifier.requestAuthorizationIfNeeded() else { return }
        for event in outcome.events {
            let copy = CodexBankedResetPresentation.notice(for: event, credits: credits, now: now)
            notifier.post(title: copy.title, body: copy.body, identifier: "CodexBankedReset.\(event.id)")
        }
    }
}
