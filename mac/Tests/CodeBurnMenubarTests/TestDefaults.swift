import Foundation

/// Fully forgets a scratch `UserDefaults` suite (or `setPersistentDomain`
/// named domain) created for one test.
///
/// `removePersistentDomain(forName:)` only clears the in-memory domain --
/// cfprefsd still leaves the backing `~/Library/Preferences/<name>.plist`
/// (and sometimes a `.lockfile` beside it) on disk. Every test that hands out
/// a throwaway suite or domain name must call this instead of
/// `removePersistentDomain` directly -- typically via `defer { TestDefaults.forget(suiteName) }`
/// right after creating it -- so a full `swift test` run does not grow the
/// file count under Preferences.
enum TestDefaults {
    static func forget(_ suiteName: String) {
        // A `UserDefaults` instance scoped to the suite -- not `.standard` --
        // so `synchronize()` below flushes *this* domain's own dirty state.
        let scoped = UserDefaults(suiteName: suiteName)
        scoped?.removePersistentDomain(forName: suiteName)
        // cfprefsd flushes a cleared domain to disk asynchronously; without
        // forcing that flush now, it can land *after* the delete below and
        // resurrect an empty `<suiteName>.plist`.
        scoped?.synchronize()
        let preferences = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Preferences", isDirectory: true)
        for suffix in ["plist", "plist.lockfile"] {
            try? FileManager.default.removeItem(
                at: preferences.appendingPathComponent("\(suiteName).\(suffix)")
            )
        }
    }
}
