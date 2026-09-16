import AppKit

/// Retires copies of the app that were already running when this one launched.
///
/// A second copy is not a harmless duplicate the way a second text editor is:
/// the Capacity Dock is a window pinned to a screen edge, so a second instance
/// stacks a second dock on top of the first. A build in `.build`, a staged
/// release and `/Applications` are separate bundle paths, so the system starts
/// each as its own process rather than activating the one already up.
///
/// The newcomer wins deliberately — quitting the *new* copy would be the wrong
/// way round while developing. Only *strictly* older instances are asked to go,
/// which is what keeps two simultaneous launches from terminating each other
/// and leaving none.
enum SingleInstanceGuard {
    /// Grace period before an instance that ignored `terminate()` is killed.
    private static let forceTerminateDelay: Duration = .seconds(3)

    static func pidsToTerminate(
        running: [(pid: pid_t, launchDate: Date?)],
        ownPID: pid_t,
        ownLaunchDate: Date
    ) -> [pid_t] {
        running
            .filter { $0.pid != ownPID && ($0.launchDate ?? .distantPast) < ownLaunchDate }
            .map(\.pid)
    }

    @MainActor
    static func retireOlderInstances() {
        guard let identifier = Bundle.main.bundleIdentifier else { return }
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: identifier)
        let doomed = pidsToTerminate(
            running: running.map { (pid: $0.processIdentifier, launchDate: $0.launchDate) },
            ownPID: ProcessInfo.processInfo.processIdentifier,
            ownLaunchDate: NSRunningApplication.current.launchDate ?? Date()
        )
        let victims = running.filter { doomed.contains($0.processIdentifier) }
        guard !victims.isEmpty else { return }

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
    }
}
