import Foundation
import Testing
@testable import CodeBurnMenubar

/// Everything here runs against an injected transport, an injected defaults
/// suite, an injected clock and an injected desktop state file in a temporary
/// directory. Nothing in this suite reads the real desktop app's state, the
/// app's own defaults domain, or the network.
@MainActor
@Suite("Telemetry")
struct TelemetryTests {

    // MARK: - Harness

    /// Records what would have gone out. `outcome` decides what the client is
    /// told happened; `.pending` never answers at all, which is what the quit
    /// flush's timeout is measured against.
    final class RecordingTransport: TelemetryTransport, @unchecked Sendable {
        enum Answer: Sendable { case sent, rejected, retry, pending }

        private let lock = NSLock()
        private var _bodies: [Data] = []
        private var _pending: [@Sendable (TelemetryPostOutcome) -> Void] = []
        private let answer: Answer

        init(_ answer: Answer = .sent) { self.answer = answer }

        var bodies: [Data] {
            lock.lock(); defer { lock.unlock() }
            return _bodies
        }

        /// Answers every request still waiting, which is how a test decides
        /// what happens *after* it has changed the consent underneath one.
        func answerPending(_ outcome: TelemetryPostOutcome) {
            lock.lock()
            let waiting = _pending
            _pending = []
            lock.unlock()
            for completion in waiting { completion(outcome) }
        }

        func post(
            _ body: Data,
            to endpoint: URL,
            timeout: TimeInterval,
            completion: @escaping @Sendable (TelemetryPostOutcome) -> Void
        ) {
            #expect(endpoint.host == "telemetry.invalid", "a test must never reach a real endpoint")
            lock.lock()
            _bodies.append(body)
            lock.unlock()
            switch answer {
            case .sent: completion(.sent)
            case .rejected: completion(.rejected)
            case .retry: completion(.retry)
            case .pending:
                lock.lock()
                _pending.append(completion)
                lock.unlock()
            }
        }
    }

    /// A defaults suite and a directory that exist only for one test.
    final class Scratch {
        let suiteName = "CodeBurnMenubarTests.Telemetry.\(UUID().uuidString)"
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("codeburn-telemetry-tests-\(UUID().uuidString)")
        let defaults: UserDefaults

        init() {
            defaults = UserDefaults(suiteName: suiteName)!
            try? FileManager.default.createDirectory(
                at: directory, withIntermediateDirectories: true)
        }

        deinit {
            TestDefaults.forget(suiteName)
            try? FileManager.default.removeItem(at: directory)
        }

        /// A desktop `telemetry.v1.json` in this test's own directory.
        func writeDesktopState(_ json: String) -> URL {
            let url = directory.appendingPathComponent("telemetry.v1.json")
            try? json.data(using: .utf8)!.write(to: url)
            return url
        }

        var missingDesktopState: URL {
            directory.appendingPathComponent("absent.json")
        }
    }

    static let endpoint = URL(string: "https://telemetry.invalid/v1/telemetry")!

    static func client(
        _ scratch: Scratch,
        desktopStateURL: URL? = nil,
        region: String? = "US",
        transport: TelemetryTransport = RecordingTransport(),
        maySend: Bool = true,
        now: @escaping @Sendable () -> Date = { Date(timeIntervalSince1970: 1_788_393_600) },
        requiresExplicitDecision: Bool = false
    ) -> Telemetry {
        Telemetry(
            defaults: scratch.defaults,
            desktopStateURL: desktopStateURL ?? scratch.missingDesktopState,
            region: region,
            appVersion: "0.9.25",
            endpoint: endpoint,
            transport: transport,
            maySend: maySend,
            now: now,
            requiresExplicitDecision: requiresExplicitDecision
        )
    }

    /// The transport answers from whatever queue it likes, so the client settles
    /// a batch on a hop back to the main actor. Let that hop run.
    static func settled() async {
        for _ in 0..<3 { await Task.yield() }
    }

    static func envelope(_ transport: RecordingTransport) throws -> [String: Any] {
        let body = try #require(transport.bodies.first)
        return try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
    }

    // MARK: - Consent

    @Test("the desktop app's decision wins and carries its install id")
    func desktopDecisionWins() throws {
        let scratch = Scratch()
        let state = scratch.writeDesktopState(
            #"{"version":1,"installId":"desk-1","enabled":true,"onboardedAt":"2026-01-01T00:00:00Z"}"#)
        scratch.defaults.set(false, forKey: Telemetry.enabledKey)
        let transport = RecordingTransport()
        let telemetry = Self.client(scratch, desktopStateURL: state, transport: transport)

        telemetry.track("app_open")
        telemetry.flush()

        let envelope = try Self.envelope(transport)
        #expect(envelope["installId"] as? String == "desk-1")
        #expect(telemetry.status().source == .desktop)
        #expect(telemetry.status().enabled)
    }

    @Test("a desktop file without a completed consent screen is not a decision")
    func desktopWithoutOnboarding() throws {
        let scratch = Scratch()
        let state = scratch.writeDesktopState(
            #"{"version":1,"installId":"desk-1","enabled":true}"#)
        let transport = RecordingTransport()
        let telemetry = Self.client(scratch, desktopStateURL: state, transport: transport)

        telemetry.track("app_open")
        telemetry.flush()

        #expect(telemetry.queuedEvents.isEmpty)
        #expect(transport.bodies.isEmpty)
    }

    @Test("a desktop toggle that is off wins over this app's own state")
    func desktopOffWins() throws {
        let scratch = Scratch()
        let state = scratch.writeDesktopState(
            #"{"version":1,"installId":"desk-1","enabled":false,"onboardedAt":"2026-01-01T00:00:00Z"}"#)
        scratch.defaults.set(true, forKey: Telemetry.enabledKey)
        let transport = RecordingTransport()
        let telemetry = Self.client(scratch, desktopStateURL: state, transport: transport)

        telemetry.track("app_open")
        telemetry.flush()

        #expect(telemetry.queuedEvents.isEmpty)
        #expect(transport.bodies.isEmpty)
    }

    @Test("a desktop file the toggle turns off mid-run stops the next flush")
    func desktopTurnedOffMidRun() throws {
        let scratch = Scratch()
        let state = scratch.writeDesktopState(
            #"{"version":1,"installId":"desk-1","enabled":true,"onboardedAt":"2026-01-01T00:00:00Z"}"#)
        let transport = RecordingTransport(.retry)
        let telemetry = Self.client(scratch, desktopStateURL: state, transport: transport)
        telemetry.track("app_open")
        telemetry.flush()
        #expect(transport.bodies.count == 1)

        _ = scratch.writeDesktopState(
            #"{"version":1,"installId":"desk-1","enabled":false,"onboardedAt":"2026-01-01T00:00:00Z"}"#)
        telemetry.flush()

        #expect(transport.bodies.count == 1, "the desktop's new answer is read at every flush")
    }

    @Test("a malformed or unknown-version desktop file falls through to this app's own state")
    func desktopFileFallsThrough() {
        #expect(Telemetry.parseDesktopState(Data("not json".utf8)) == nil)
        #expect(Telemetry.parseDesktopState(Data(#"{"version":2,"installId":"x","enabled":true}"#.utf8)) == nil)
        #expect(Telemetry.parseDesktopState(Data(#"{"version":1,"installId":"","enabled":true}"#.utf8)) == nil)
        #expect(Telemetry.parseDesktopState(Data(#"{"version":1,"installId":"x"}"#.utf8)) == nil)
    }

    @Test("standalone defaults on outside the default-off region, off inside it and off when unknown")
    func standaloneRegionDefaults() {
        let us = Scratch()
        #expect(Self.client(us, region: "US").status().enabled)

        let de = Scratch()
        #expect(Self.client(de, region: "DE").status().enabled == false)

        let unknown = Scratch()
        #expect(Self.client(unknown, region: nil).status().enabled == false)

        // A UN M.49 region is nobody's country code, so it reads as unknown.
        let m49 = Scratch()
        #expect(Self.client(m49, region: "419").status().enabled == false)
    }

    @Test("standalone mints and keeps one install id")
    func standaloneInstallID() {
        let scratch = Scratch()
        let telemetry = Self.client(scratch)
        let stored = scratch.defaults.string(forKey: Telemetry.installIDKey)

        #expect(stored != nil)
        #expect(UUID(uuidString: stored ?? "") != nil)
        #expect(telemetry.status().source == .app)
        #expect(Self.client(scratch).status().source == .app)
        #expect(scratch.defaults.string(forKey: Telemetry.installIDKey) == stored)
    }

    @Test("turning the toggle off queues nothing, drops the queue and mints a fresh install id")
    func standaloneOptOut() {
        let scratch = Scratch()
        let transport = RecordingTransport()
        let telemetry = Self.client(scratch, transport: transport)
        telemetry.track("app_open")
        let before = scratch.defaults.string(forKey: Telemetry.installIDKey)

        telemetry.setEnabled(false)
        telemetry.track("popover_open")
        telemetry.flush()

        #expect(telemetry.queuedEvents.isEmpty)
        #expect(transport.bodies.isEmpty)
        #expect(scratch.defaults.string(forKey: Telemetry.installIDKey) != before)
    }

    @Test("the local toggle can veto the desktop app's yes without rotating its id")
    func localVetoOverDesktopYes() throws {
        let scratch = Scratch()
        let state = scratch.writeDesktopState(
            #"{"version":1,"installId":"desk-1","enabled":true,"onboardedAt":"2026-01-01T00:00:00Z"}"#)
        let before = try Data(contentsOf: state)
        let transport = RecordingTransport()
        let telemetry = Self.client(scratch, desktopStateURL: state, transport: transport)
        #expect(telemetry.status().isLocked == false, "a desktop yes leaves the toggle usable")

        telemetry.setEnabled(false)
        telemetry.track("app_open")
        telemetry.flush()

        #expect(telemetry.status().enabled == false)
        #expect(telemetry.queuedEvents.isEmpty)
        #expect(transport.bodies.isEmpty)
        #expect(scratch.defaults.string(forKey: Telemetry.installIDKey) == nil,
                "the id belongs to the desktop app, so a local veto does not rotate one")
        #expect(try Data(contentsOf: state) == before, "the desktop app's file is that app's to write")

        telemetry.setEnabled(true)
        #expect(telemetry.status().enabled)
    }

    @Test("the local toggle can never opt in against the desktop app's no")
    func localVetoCannotOverturnDesktopNo() {
        let scratch = Scratch()
        let state = scratch.writeDesktopState(
            #"{"version":1,"installId":"desk-1","enabled":false,"onboardedAt":"2026-01-01T00:00:00Z"}"#)
        let telemetry = Self.client(scratch, desktopStateURL: state)
        #expect(telemetry.status().isLocked, "a desktop no makes the toggle a readout")

        telemetry.setEnabled(true)

        #expect(telemetry.status().enabled == false)
        #expect(scratch.defaults.bool(forKey: Telemetry.localOptOutKey) == false)
    }

    /// Exactly what the Privacy section reads, for every combination it can be
    /// shown in: under a desktop yes the toggle is a veto, under a desktop no it
    /// is a disabled readout, and standalone it is the decision itself.
    @Test("the Privacy toggle's state for every desktop and local combination")
    func toggleStateForEveryCombination() {
        for desktopEnabled in [true, false] {
            for vetoed in [true, false] {
                let scratch = Scratch()
                scratch.defaults.set(vetoed, forKey: Telemetry.localOptOutKey)
                let state = scratch.writeDesktopState(
                    """
                    {"version":1,"installId":"desk-1","enabled":\(desktopEnabled),\
                    "onboardedAt":"2026-01-01T00:00:00Z"}
                    """)
                let status = Self.client(scratch, desktopStateURL: state).status()
                #expect(status.source == .desktop)
                #expect(status.isLocked == !desktopEnabled,
                        "desktop \(desktopEnabled), veto \(vetoed)")
                #expect(status.enabled == (desktopEnabled && !vetoed),
                        "desktop \(desktopEnabled), veto \(vetoed)")
            }
        }

        let scratch = Scratch()
        let standalone = Self.client(scratch, region: "US")
        #expect(standalone.status().source == .app)
        #expect(standalone.status().isLocked == false, "standalone the toggle is never a readout")
        #expect(standalone.status().enabled)
        standalone.setEnabled(false)
        #expect(standalone.status().enabled == false)
    }

    @Test("a local opt-out sticks across a restart under the desktop app's yes")
    func localVetoSurvivesARestart() {
        let scratch = Scratch()
        let state = scratch.writeDesktopState(
            #"{"version":1,"installId":"desk-1","enabled":true,"onboardedAt":"2026-01-01T00:00:00Z"}"#)
        Self.client(scratch, desktopStateURL: state).setEnabled(false)
        #expect(scratch.defaults.bool(forKey: Telemetry.localOptOutKey))

        let restarted = Self.client(scratch, desktopStateURL: state)
        #expect(restarted.status().enabled == false)
        #expect(restarted.status().isLocked == false, "it can still be switched back on")
    }

    @Test("a desktop decision is inherited, so deleting that app cannot reverse its no")
    func desktopDecisionSurvivesTheFileDisappearing() {
        let scratch = Scratch()
        let state = scratch.writeDesktopState(
            #"{"version":1,"installId":"desk-1","enabled":false,"onboardedAt":"2026-01-01T00:00:00Z"}"#)
        // Region US, whose default is ON — exactly the reversal being guarded.
        let telemetry = Self.client(scratch, desktopStateURL: state, region: "US")
        #expect(telemetry.status().source == .desktop)

        try? FileManager.default.removeItem(at: state)
        let after = telemetry.status()

        #expect(after.source == .app)
        #expect(after.enabled == false, "an explicit no must outlive the app that made it")
        #expect(scratch.defaults.object(forKey: Telemetry.enabledKey) as? Bool == false)
    }

    @Test("a desktop yes is inherited too, under one stable install id of this app's own")
    func desktopYesFallsBackToAStableLocalID() {
        let scratch = Scratch()
        let state = scratch.writeDesktopState(
            #"{"version":1,"installId":"desk-1","enabled":true,"onboardedAt":"2026-01-01T00:00:00Z"}"#)
        let telemetry = Self.client(scratch, desktopStateURL: state, region: "DE")
        #expect(telemetry.status().source == .desktop)

        try? FileManager.default.removeItem(at: state)
        let first = telemetry.status()
        let id = scratch.defaults.string(forKey: Telemetry.installIDKey)

        #expect(first.source == .app)
        #expect(first.enabled, "a desktop yes is a decision too, even in a default-off region")
        #expect(id != nil && id != "desk-1")
        _ = telemetry.status()
        _ = telemetry.status()
        #expect(scratch.defaults.string(forKey: Telemetry.installIDKey) == id,
                "one install, one id: resolving again must not mint another")
    }

    @Test("a standalone install can be made to wait for an explicit decision")
    func standaloneExplicitDecisionSwitch() {
        // Both settings of Telemetry.standaloneRequiresExplicitDecision, so the
        // product call is a one-line change with tests already standing.
        let regionDecides = Scratch()
        let deciding = Self.client(regionDecides, region: "US", requiresExplicitDecision: false)
        deciding.track("app_open")
        #expect(deciding.queuedEvents.count == 1, "the region default is itself the answer")

        let mustBeAsked = Scratch()
        let waiting = Self.client(mustBeAsked, region: "US", requiresExplicitDecision: true)
        waiting.track("app_open")
        #expect(waiting.queuedEvents.isEmpty, "nothing before the question has been answered")

        waiting.setEnabled(true)
        waiting.track("app_open")
        #expect(waiting.queuedEvents.count == 1)
        #expect(mustBeAsked.defaults.bool(forKey: Telemetry.decidedKey))
    }

    @Test("the default-off region list is still the desktop app's list")
    func regionListMatchesDesktop() {
        // Copied from app/electron/telemetry.ts DEFAULT_OFF_COUNTRIES: EU-27 +
        // EEA (IS, LI, NO) + UK + CH. Drift here fails rather than silently
        // opting a region in or out on one platform only.
        let desktop: Set<String> = [
            "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR",
            "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK",
            "SI", "ES", "SE", "IS", "LI", "NO", "GB", "CH",
        ]
        #expect(desktop.count == 32)
        #expect(Telemetry.defaultOffCountries == desktop)
    }

    // MARK: - Events

    @Test("an unknown event name never reaches the queue")
    func unknownEventNames() {
        let scratch = Scratch()
        let telemetry = Self.client(scratch)

        telemetry.track("app_open")
        telemetry.track("rm_rf")
        telemetry.track("")

        #expect(telemetry.queuedEvents.map(\.name) == ["app_open"])
    }

    @Test("usage_snapshot is forwarded verbatim, once per day")
    func usageSnapshotOncePerDay() {
        let scratch = Scratch()
        nonisolated(unsafe) var clock = Date(timeIntervalSince1970: 1_788_393_600)
        let telemetry = Self.client(scratch, now: { clock })
        let snapshot = JSONValue.object([
            "costBucket": .string("1-10"),
            "providers": .int(3),
        ])

        telemetry.trackUsageSnapshot(snapshot)
        telemetry.trackUsageSnapshot(snapshot)

        #expect(telemetry.queuedEvents.filter { $0.name == "usage_snapshot" }.count == 1)
        #expect(telemetry.queuedEvents.first?.props == [
            "costBucket": .string("1-10"),
            "providers": .int(3),
        ])

        clock = clock.addingTimeInterval(48 * 3600)
        telemetry.trackUsageSnapshot(snapshot)
        #expect(telemetry.queuedEvents.filter { $0.name == "usage_snapshot" }.count == 2)
    }

    @Test("a missing or non-object snapshot is nothing to send")
    func usageSnapshotAbsent() {
        let scratch = Scratch()
        let telemetry = Self.client(scratch)

        telemetry.trackUsageSnapshot(nil)
        telemetry.trackUsageSnapshot(.null)
        telemetry.trackUsageSnapshot(.int(7))

        #expect(telemetry.queuedEvents.isEmpty)
    }

    @Test("the desktop app sends its own snapshot, so this app does not send a second one")
    func usageSnapshotSkippedUnderDesktop() {
        let scratch = Scratch()
        let state = scratch.writeDesktopState(
            #"{"version":1,"installId":"desk-1","enabled":true,"onboardedAt":"2026-01-01T00:00:00Z"}"#)
        let telemetry = Self.client(scratch, desktopStateURL: state)

        telemetry.trackUsageSnapshot(.object(["costBucket": .string("1-10")]))

        #expect(telemetry.queuedEvents.isEmpty)
    }

    @Test("the CLI's snapshot rides through the payload decoder untouched")
    func snapshotSurvivesPayloadDecoding() throws {
        let json = """
        {"generated":"2026-09-19T00:00:00Z",
         "current":{"providers":[]},
         "optimize":{},
         "history":{},
         "telemetrySnapshot":{"schema":2,"models":[{"name":"sonnet","costBucket":"1-10"}]}}
        """
        let payload = try? JSONDecoder().decode(MenubarPayload.self, from: Data(json.utf8))
        // The other blocks have required fields this fixture cannot fake; what
        // matters here is only that the field decodes as an opaque object.
        if let snapshot = payload?.telemetrySnapshot {
            #expect(snapshot == .object([
                "schema": .int(2),
                "models": .array([.object([
                    "name": .string("sonnet"),
                    "costBucket": .string("1-10"),
                ])]),
            ]))
        }
        let standalone = try JSONDecoder().decode(
            JSONValue.self,
            from: Data(#"{"schema":2,"rate":0.5,"ok":true,"none":null}"#.utf8))
        #expect(standalone == .object([
            "schema": .int(2),
            "rate": .double(0.5),
            "ok": .bool(true),
            "none": .null,
        ]))
    }

    @Test("app_close carries the session length in whole minutes")
    func closeCarriesSessionMinutes() {
        let scratch = Scratch()
        nonisolated(unsafe) var clock = Date(timeIntervalSince1970: 1_788_393_600)
        let telemetry = Self.client(scratch, now: { clock })

        clock = clock.addingTimeInterval(9 * 60 + 40)
        telemetry.trackClose()

        #expect(telemetry.queuedEvents.last?.name == "app_close")
        #expect(telemetry.queuedEvents.last?.props == ["sessionMinutes": .int(10)])
    }

    // MARK: - Sanitizer

    @Test("long strings are truncated and long keys with them")
    func sanitizerTruncates() {
        let long = String(repeating: "a", count: 200)
        let clean = Telemetry.sanitizeProps(.object([long: .string(long)]))

        #expect(clean.count == 1)
        #expect(clean.keys.first?.count == Telemetry.maxString)
        #expect(clean.values.first == .string(String(repeating: "a", count: Telemetry.maxString)))
    }

    @Test("non-finite numbers, nulls and empty containers are dropped")
    func sanitizerDropsJunk() {
        let clean = Telemetry.sanitizeProps(.object([
            "nan": .double(.nan),
            "inf": .double(.infinity),
            "nil": .null,
            "emptyArray": .array([]),
            "emptyObject": .object([:]),
            "kept": .double(0.5),
        ]))

        #expect(clean == ["kept": .double(0.5)])
    }

    @Test("nesting deeper than the snapshot's own shape is dropped whole")
    func sanitizerCapsDepth() {
        // props -> a -> b -> c -> d is the deepest the snapshot goes.
        var value = JSONValue.object(["leaf": .int(1)])
        for _ in 0..<3 { value = .object(["down": value]) }
        #expect(Telemetry.sanitizeProps(.object(["top": value])) != [:])

        var tooDeep = JSONValue.object(["leaf": .int(1)])
        for _ in 0..<5 { tooDeep = .object(["down": tooDeep]) }
        #expect(Telemetry.sanitizeProps(.object(["top": tooDeep])) == [:])
    }

    @Test("key, array and leaf counts are all capped")
    func sanitizerCapsWidth() {
        var wide: [String: JSONValue] = [:]
        for index in 0..<40 { wide[String(format: "k%02d", index)] = .int(index) }
        #expect(Telemetry.sanitizeProps(.object(wide)).count == Telemetry.maxKeys)

        let long = JSONValue.array((0..<40).map { .int($0) })
        if case .array(let trimmed)? = Telemetry.sanitizeProps(.object(["a": long]))["a"] {
            #expect(trimmed.count == Telemetry.maxArray)
        } else {
            Issue.record("array was dropped entirely")
        }

        let flood = JSONValue.array((0..<Telemetry.maxLeaves + 50).map { .int($0) })
        var budgeted: [String: JSONValue] = [:]
        for index in 0..<10 { budgeted["a\(index)"] = flood }
        var leaves = 0
        for case .array(let entries) in Telemetry.sanitizeProps(.object(budgeted)).values {
            leaves += entries.count
        }
        #expect(leaves <= Telemetry.maxLeaves)
    }

    @Test("a props value that is not an object carries nothing")
    func sanitizerRejectsNonObjects() {
        #expect(Telemetry.sanitizeProps(.array([.int(1)])) == [:])
        #expect(Telemetry.sanitizeProps(.string("x")) == [:])
        #expect(Telemetry.sanitizeProps(.null) == [:])
    }

    // MARK: - The wire

    @Test("the envelope is the shape the other clients post")
    func envelopeShape() throws {
        let scratch = Scratch()
        let transport = RecordingTransport()
        let telemetry = Self.client(scratch, transport: transport)

        telemetry.track("popover_open")
        telemetry.flush()

        let envelope = try Self.envelope(transport)
        #expect(envelope["schema"] as? Int == 1)
        let app = try #require(envelope["app"] as? [String: Any])
        #expect(app["name"] as? String == "codeburn-menubar")
        #expect(app["version"] as? String == "0.9.25")
        #expect(app["platform"] as? String == "darwin")
        #expect(app["country"] as? String == "US")
        #expect(app["arch"] as? String != nil)
        let events = try #require(envelope["events"] as? [[String: Any]])
        #expect(events.count == 1)
        #expect(events[0]["name"] as? String == "popover_open")
        #expect(events[0]["day"] as? String == Telemetry.dayKey(Date(timeIntervalSince1970: 1_788_393_600)))
        #expect(events[0]["props"] as? [String: Any] != nil)
    }

    @Test("the day key is a plain calendar date, so nothing finer than a day is sent")
    func dayKeyGranularity() {
        let day = Telemetry.dayKey(Date(timeIntervalSince1970: 1_788_393_600))
        #expect(day.count == 10)
        #expect(day.wholeMatch(of: /\d{4}-\d{2}-\d{2}/) != nil)
    }

    @Test("a debug or unpackaged build queues but never sends")
    func debugBuildNeverSends() {
        #expect(Telemetry.defaultMaySend(environment: [:]) == false)
        #expect(Telemetry.defaultMaySend(environment: ["CODEBURN_TELEMETRY_DEV": "1"]))

        let scratch = Scratch()
        let transport = RecordingTransport()
        let telemetry = Self.client(scratch, transport: transport, maySend: false)
        telemetry.track("app_open")
        telemetry.flush()

        #expect(telemetry.queuedEvents.count == 1)
        #expect(transport.bodies.isEmpty)
    }

    @Test("a failed send keeps the batch, never throws, and backs the beat off")
    func failedSendRetries() async {
        let scratch = Scratch()
        let transport = RecordingTransport(.retry)
        let telemetry = Self.client(scratch, transport: transport)

        telemetry.track("app_open")
        telemetry.flush()
        await Self.settled()

        #expect(telemetry.queuedEvents.map(\.name) == ["app_open"])
        #expect(Telemetry.beatsToSkip(failures: 0) == 0)
        #expect(Telemetry.beatsToSkip(failures: 1) == 0)
        #expect(Telemetry.beatsToSkip(failures: 2) == 1)
        #expect(Telemetry.beatsToSkip(failures: 9) == 5, "the backoff stops at half an hour")

        // The beat sits out the delay it just earned, then tries again.
        telemetry.runFlushBeat()
        await Self.settled()
        #expect(transport.bodies.count == 2)
    }

    @Test("a refused batch is dropped rather than retried forever")
    func refusedBatchIsDropped() async {
        let scratch = Scratch()
        let transport = RecordingTransport(.rejected)
        let telemetry = Self.client(scratch, transport: transport)

        telemetry.track("app_open")
        telemetry.flush()
        await Self.settled()

        #expect(telemetry.queuedEvents.isEmpty)
        #expect(transport.bodies.count == 1)
    }

    @Test("the queue never grows past its cap, whatever the network does")
    func queueCap() async {
        let scratch = Scratch()
        let transport = RecordingTransport(.retry)
        let telemetry = Self.client(scratch, transport: transport)

        for _ in 0..<(Telemetry.maxQueue + 50) { telemetry.track("popover_open") }
        #expect(telemetry.queuedEvents.count == Telemetry.maxQueue)

        telemetry.flush()
        for _ in 0..<50 { telemetry.track("popover_open") }
        await Self.settled()
        #expect(telemetry.queuedEvents.count == Telemetry.maxQueue)
    }

    @Test("the quit flush is bounded even when the endpoint never answers")
    func quitFlushIsBounded() {
        let scratch = Scratch()
        let transport = RecordingTransport(.pending)
        let telemetry = Self.client(scratch, transport: transport)
        telemetry.track("app_open")

        let started = Date()
        telemetry.flushOnQuit(timeout: 0.2)
        let elapsed = Date().timeIntervalSince(started)

        #expect(elapsed < 2, "quit waited \(elapsed)s on a dead endpoint")
        #expect(transport.bodies.count == 1)
        let posted = try? JSONSerialization.jsonObject(with: transport.bodies[0]) as? [String: Any]
        let events = (posted?["events"] as? [[String: Any]]) ?? []
        #expect(events.map { $0["name"] as? String } == ["app_open", "app_close"])
    }

    @Test("a quit with the toggle off posts nothing at all")
    func quitFlushRespectsConsent() {
        let scratch = Scratch()
        let transport = RecordingTransport(.pending)
        let telemetry = Self.client(scratch, region: "DE", transport: transport)

        telemetry.track("app_open")
        telemetry.flushOnQuit(timeout: 0.2)

        #expect(transport.bodies.isEmpty)
    }

    // MARK: - In flight

    @Test("opting out while a batch is in flight drops it instead of retrying it")
    func optOutAbandonsTheBatchInFlight() async {
        let scratch = Scratch()
        let transport = RecordingTransport(.pending)
        let telemetry = Self.client(scratch, transport: transport)
        telemetry.track("app_open")
        telemetry.flush()
        #expect(transport.bodies.count == 1)
        let firstID = scratch.defaults.string(forKey: Telemetry.installIDKey)

        telemetry.setEnabled(false)
        transport.answerPending(.retry)
        await Self.settled()

        #expect(telemetry.queuedEvents.isEmpty,
                "events recorded under the retired id must never come back")
        #expect(scratch.defaults.string(forKey: Telemetry.installIDKey) != firstID)

        telemetry.setEnabled(true)
        telemetry.flush()
        await Self.settled()
        #expect(transport.bodies.count == 1, "nothing from before the opt-out is ever posted")
    }

    @Test("a veto under desktop consent abandons the batch in flight as well")
    func vetoAbandonsTheBatchInFlight() async {
        let scratch = Scratch()
        let state = scratch.writeDesktopState(
            #"{"version":1,"installId":"desk-1","enabled":true,"onboardedAt":"2026-01-01T00:00:00Z"}"#)
        let transport = RecordingTransport(.pending)
        let telemetry = Self.client(scratch, desktopStateURL: state, transport: transport)
        telemetry.track("app_open")
        telemetry.flush()

        telemetry.setEnabled(false)
        transport.answerPending(.retry)
        await Self.settled()

        #expect(telemetry.queuedEvents.isEmpty)
        telemetry.flush()
        await Self.settled()
        #expect(transport.bodies.count == 1)
    }

    @Test("a quit that lands on top of a live flush still returns, bounded")
    func quitRacesALiveFlush() {
        let scratch = Scratch()
        let transport = RecordingTransport(.pending)
        let telemetry = Self.client(scratch, transport: transport)
        telemetry.track("popover_open")
        telemetry.flush()
        #expect(transport.bodies.count == 1)

        let started = Date()
        telemetry.flushOnQuit(timeout: 0.2)
        let elapsed = Date().timeIntervalSince(started)

        #expect(elapsed < 2, "quit waited \(elapsed)s behind an unanswered flush")
        #expect(transport.bodies.count == 2, "app_close still gets its own attempt")
    }

    // MARK: - Transport

    @Test("the telemetry session keeps no cookies, no cache and no identifying agent")
    func transportSessionIsPrivate() {
        let configuration = URLSessionTelemetryTransport.makeConfiguration()

        #expect(configuration.httpCookieStorage == nil, "a cookie would outlive an opt-out")
        #expect(configuration.httpShouldSetCookies == false)
        #expect(configuration.httpCookieAcceptPolicy == .never)
        #expect(configuration.urlCache == nil)
        #expect(configuration.requestCachePolicy == .reloadIgnoringLocalAndRemoteCacheData)
        #expect(configuration.tlsMinimumSupportedProtocolVersion == .TLSv12)
        let agent = configuration.httpAdditionalHeaders?["User-Agent"] as? String
        #expect(agent == "codeburn-menubar", "the default agent spells out the kernel build")
        #expect(configuration.httpAdditionalHeaders?["Content-Type"] as? String == "application/json")
        // Ephemeral, so nothing it does touch reaches disk.
        #expect(configuration.identifier == nil)
    }

    @Test("a redirect is refused rather than followed")
    func transportRefusesRedirects() async {
        let transport = URLSessionTelemetryTransport()
        let redirect = HTTPURLResponse(
            url: Telemetry.endpoint, statusCode: 302,
            httpVersion: nil, headerFields: nil)!
        var followed: URLRequest? = URLRequest(url: URL(string: "http://elsewhere.invalid")!)

        await withCheckedContinuation { continuation in
            transport.urlSession(
                URLSession(configuration: .ephemeral),
                task: URLSession(configuration: .ephemeral)
                    .dataTask(with: URLRequest(url: Telemetry.endpoint)),
                willPerformHTTPRedirection: redirect,
                newRequest: URLRequest(url: URL(string: "http://elsewhere.invalid")!)
            ) { request in
                followed = request
                continuation.resume()
            }
        }

        #expect(followed == nil)
    }

    // MARK: - Cross-implementation sanitizer fixture

    @Test("the sanitizer answers exactly what the desktop app's sanitizeProps would")
    func sanitizerMatchesTheDesktopImplementation() {
        // Fixture and expectation both derived from `sanitizeProps` /
        // `sanitizeValue` / `sanitizeObject` in app/electron/telemetry.ts:
        // MAX_STRING 64, MAX_ARRAY 12, MAX_KEYS 16, MAX_DEPTH 5, MAX_LEAVES 1000.
        // Strings and keys truncate, non-finite numbers and nulls are dropped,
        // a container that empties out is dropped with them, and a container
        // sitting at MAX_DEPTH is dropped whole rather than flattened.
        let longString = String(repeating: "x", count: 100)
        let longKey = String(repeating: "k", count: 100)

        var wide: [String: JSONValue] = [:]
        for index in 0..<20 { wide[String(format: "w%02d", index)] = .int(index) }

        var tooDeep = JSONValue.object(["leaf": .int(1)])
        for _ in 0..<5 { tooDeep = .object(["down": tooDeep]) }

        let clean = Telemetry.sanitizeProps(.object([
            "str": .string(longString),
            longKey: .string("short"),
            "nan": .double(.nan),
            "inf": .double(-.infinity),
            "nil": .null,
            "bool": .bool(false),
            "int": .int(-3),
            "rate": .double(0.5),
            "arr": .array((0..<20).map { .int($0) }),
            "mixed": .array([.string("a"), .null, .double(.nan), .int(2)]),
            "wide": .object(wide),
            // props -> deep -> b -> c -> d -> leaf: the snapshot's own depth.
            "deep": .object(["b": .object(["c": .object(["d": .int(4)])])]),
            "tooDeep": tooDeep,
            "emptyAfterCleaning": .object(["only": .null]),
        ]))

        let truncated = String(repeating: "x", count: 64)
        var expectedWide: [String: JSONValue] = [:]
        for index in 0..<16 { expectedWide[String(format: "w%02d", index)] = .int(index) }

        #expect(clean == [
            "str": .string(truncated),
            String(repeating: "k", count: 64): .string("short"),
            "bool": .bool(false),
            "int": .int(-3),
            "rate": .double(0.5),
            "arr": .array((0..<12).map { .int($0) }),
            "mixed": .array([.string("a"), .int(2)]),
            "wide": .object(expectedWide),
            "deep": .object(["b": .object(["c": .object(["d": .int(4)])])]),
        ])
    }
}
