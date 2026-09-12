import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("Update notifications")
@MainActor
struct UpdateNotificationTests {
    @Test("same version pair notifies once, a newer one notifies again")
    func dedupesUntilVersionChanges() async throws {
        try await withIsolatedChecker { checker, notifier, _ in
            await checker.notifyIfUpdateAvailable(appVersion: "0.9.25", cliVersion: nil)
            await checker.notifyIfUpdateAvailable(appVersion: "0.9.25", cliVersion: nil)

            #expect(notifier.posts.count == 1)

            await checker.notifyIfUpdateAvailable(appVersion: "0.9.26", cliVersion: nil)

            #expect(notifier.posts.count == 2)
        }
    }

    @Test("dedupe survives a fresh checker over the same defaults")
    func dedupePersists() async throws {
        try await withIsolatedChecker { checker, notifier, defaults in
            await checker.notifyIfUpdateAvailable(appVersion: "0.9.25", cliVersion: "0.9.25")

            let relaunched = UpdateChecker(defaults: defaults, makeNotifier: { notifier })
            await relaunched.notifyIfUpdateAvailable(appVersion: "0.9.25", cliVersion: "0.9.25")

            #expect(notifier.posts.count == 1)
        }
    }

    @Test("toggle off posts nothing and never asks for authorization")
    func toggleOffStaysSilent() async throws {
        try await withIsolatedChecker { checker, notifier, defaults in
            defaults.set(false, forKey: UpdateNotificationPreference.defaultsKey)

            await checker.notifyIfUpdateAvailable(appVersion: "0.9.25", cliVersion: "0.9.25")

            #expect(notifier.posts.isEmpty)
            #expect(notifier.authorizationRequests == 0)
        }
    }

    @Test("denied authorization posts nothing")
    func deniedAuthorizationPostsNothing() async throws {
        try await withIsolatedChecker { checker, notifier, _ in
            notifier.authorized = false

            await checker.notifyIfUpdateAvailable(appVersion: "0.9.25", cliVersion: nil)

            #expect(notifier.posts.isEmpty)
            #expect(notifier.authorizationRequests == 1)
        }
    }

    @Test("no update available posts nothing")
    func nothingAvailablePostsNothing() async throws {
        try await withIsolatedChecker { checker, notifier, _ in
            await checker.notifyIfUpdateAvailable(appVersion: nil, cliVersion: nil)

            #expect(notifier.posts.isEmpty)
            #expect(notifier.authorizationRequests == 0)
        }
    }

    @Test("app-only copy names the app version")
    func appOnlyCopy() async throws {
        try await withIsolatedChecker { checker, notifier, _ in
            await checker.notifyIfUpdateAvailable(appVersion: "0.9.25", cliVersion: nil)

            #expect(notifier.posts.first?.title == "CodeBurn v0.9.25 available")
            #expect(notifier.posts.first?.body == "Click to install the update.")
        }
    }

    @Test("cli-only copy names the CLI")
    func cliOnlyCopy() async throws {
        try await withIsolatedChecker { checker, notifier, _ in
            await checker.notifyIfUpdateAvailable(appVersion: nil, cliVersion: "0.9.25")

            #expect(notifier.posts.first?.title == "CodeBurn CLI v0.9.25 available")
            #expect(notifier.posts.first?.body == "Click to install the update.")
        }
    }

    @Test("both-available copy mentions app and CLI")
    func bothCopy() async throws {
        try await withIsolatedChecker { checker, notifier, _ in
            await checker.notifyIfUpdateAvailable(appVersion: "0.9.25", cliVersion: "0.9.24")

            #expect(notifier.posts.first?.title == "CodeBurn v0.9.25 available")
            #expect(notifier.posts.first?.body == "App and CLI v0.9.24 updates are ready. Click to install.")
        }
    }
}

@MainActor
private func withIsolatedChecker(
    _ body: @MainActor (UpdateChecker, RecordingUpdateNotifier, UserDefaults) async throws -> Void
) async throws {
    let suiteName = "codeburn.update.notifications.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suiteName))
    defaults.removePersistentDomain(forName: suiteName)
    defer { defaults.removePersistentDomain(forName: suiteName) }

    let notifier = RecordingUpdateNotifier()
    let checker = UpdateChecker(defaults: defaults, makeNotifier: { notifier })
    try await body(checker, notifier, defaults)
}

@MainActor
private final class RecordingUpdateNotifier: UpdateNotifier {
    var authorized = true
    var authorizationRequests = 0
    var posts: [(title: String, body: String, identifier: String)] = []

    func requestAuthorizationIfNeeded() async -> Bool {
        authorizationRequests += 1
        return authorized
    }

    func post(title: String, body: String, identifier: String) {
        posts.append((title, body, identifier))
    }
}
