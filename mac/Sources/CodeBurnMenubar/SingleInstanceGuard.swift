import AppKit

/// Keeps exactly one copy of the app running.
///
/// A second copy is not a harmless duplicate the way a second text editor is:
/// each one puts its own flame in the menu bar and pins its own Capacity Dock
/// to a screen edge. Two copies are easy to end up with — `~/Applications`
/// (where `codeburn menubar` installs) and `/Applications` (a copy dragged out
/// of a download, or Finder's "Keep Both") are separate bundle paths, so the
/// system starts each as its own process and each registers its own login
/// item, which is how both come up at once at login.
///
/// One instance wins outright: the newest start, which is the right way round
/// while developing.
///
/// The order is read from the kernel (`KERN_PROC_PID` → `p_starttime`), not from
/// `NSRunningApplication.launchDate`, and not from the pid. Both sides read the
/// same kernel value for the same process, so they agree on the order by
/// observation rather than by each side reasoning from what it can see; a pid is
/// only the tie-break, and pids are reused, so a pid that wrapped around says
/// nothing about which copy started first. A start time the kernel will not
/// report leaves that copy out of the comparison entirely — it is neither
/// retired nor able to retire — so the worst case is two flames, which a person
/// can see and fix, and never zero.
///
/// "Keep Both" is Finder's copy dialog, not a setting this app stores: it is a
/// choice about files on disk, and this is about processes. `--keep-both` on
/// the command line opts a single launch out of the guard, for the one case
/// where running two on purpose is the point.
enum SingleInstanceGuard {
    /// Opt out for one launch: `open -n CodeBurnMenubar.app --args --keep-both`.
    static let keepBothFlag = "--keep-both"

    /// Grace period before an instance that ignored `terminate()` is killed.
    private static let forceTerminateDelay: Duration = .seconds(3)

    enum Decision: Equatable {
        /// This instance is the one that stays; the older copies are asked to go.
        case retire([pid_t])
        /// A newer copy is already up, so this one goes instead.
        case yieldToNewer
    }

    /// `startedAt` is `kernelStartTime(pid:)` for each copy, self included; nil for a
    /// process the kernel would not answer for.
    static func decide(
        running: [(pid: pid_t, startedAt: UInt64?)],
        ownPID: pid_t,
        ownStartedAt: UInt64?
    ) -> Decision {
        // With no start time of our own we have no place in the order at all: stay up,
        // and take nobody with us.
        guard let ownStartedAt else { return .retire([]) }
        // A peer the kernel would not place is left out both ways round. Guessing in
        // either direction is what lets two copies each conclude the other should go.
        let ranked = running.compactMap { peer -> (pid: pid_t, startedAt: UInt64)? in
            guard peer.pid != ownPID, let startedAt = peer.startedAt else { return nil }
            return (pid: peer.pid, startedAt: startedAt)
        }
        let outranked = ranked.contains { ($0.startedAt, $0.pid) > (ownStartedAt, ownPID) }
        return outranked ? .yieldToNewer : .retire(ranked.map(\.pid))
    }

    /// When the kernel says a process started, in microseconds since the epoch. Readable
    /// for any process of the same user, and the same number whichever process asks,
    /// which is the whole point: the two copies rank each other off one shared fact.
    static func kernelStartTime(pid: pid_t) -> UInt64? {
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        guard sysctl(&mib, u_int(mib.count), &info, &size, nil, 0) == 0,
              size == MemoryLayout<kinfo_proc>.stride else { return nil }
        let started = info.kp_proc.p_starttime
        guard started.tv_sec > 0 else { return nil }
        return UInt64(started.tv_sec) * 1_000_000 + UInt64(max(0, started.tv_usec))
    }

    /// False when this launch has stood down for a copy that is already up, in
    /// which case the caller must stop setting the app up.
    @MainActor
    static func enforceSingleInstance() -> Bool {
        guard !CommandLine.arguments.contains(keepBothFlag) else { return true }
        let peers = runningPeers()
        let ownPID = ProcessInfo.processInfo.processIdentifier
        let decision = decide(
            running: peers.map { (pid: $0.processIdentifier, startedAt: kernelStartTime(pid: $0.processIdentifier)) },
            ownPID: ownPID,
            ownStartedAt: kernelStartTime(pid: ownPID)
        )
        guard case .retire(let doomed) = decision else {
            NSLog("CodeBurn: a newer instance is already running - quitting this one")
            NSApp.terminate(nil)
            return false
        }
        let victims = peers.filter { doomed.contains($0.processIdentifier) }
        guard !victims.isEmpty else { return true }

        for victim in victims {
            NSLog("CodeBurn: retiring older instance (pid %d)", victim.processIdentifier)
            // A polite terminate lets the older copy tear its dock windows down
            // and release its status item; forceTerminate is only for a copy
            // that never answers.
            if !victim.terminate() { victim.forceTerminate() }
        }
        Task { @MainActor in
            try? await Task.sleep(for: forceTerminateDelay)
            for victim in victims where !victim.isTerminated {
                NSLog("CodeBurn: older instance (pid %d) ignored terminate - forcing", victim.processIdentifier)
                victim.forceTerminate()
            }
        }
        return true
    }

    /// Every running copy of this app, matched on the executable as well as on
    /// the bundle id: a bundle whose Info.plist identity did not survive its
    /// install is missing from `runningApplications(withBundleIdentifier:)`
    /// entirely, and that copy is exactly the zombie flame nothing could retire.
    private static func runningPeers() -> [NSRunningApplication] {
        let identifier = Bundle.main.bundleIdentifier
        let executable = Bundle.main.executableURL?.lastPathComponent
        return NSWorkspace.shared.runningApplications.filter { app in
            if let identifier, app.bundleIdentifier == identifier { return true }
            return executable != nil && app.executableURL?.lastPathComponent == executable
        }
    }
}
