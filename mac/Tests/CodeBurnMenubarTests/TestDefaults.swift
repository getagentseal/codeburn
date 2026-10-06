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
    /// A `UserDefaults` suite named `name`, paired with that name for
    /// `forget(_:)`. `name` must be fixed, not a uuid: cfprefsd can still
    /// write a cleared domain's plist back to disk after `forget(_:)`
    /// deletes it, and a fixed name lands that write on the same file every
    /// run instead of a new one. A shared helper, a loop, or a parameterized
    /// test must fold something distinguishing -- the caller's `#function`,
    /// an index, an argument -- into `name` so no two tests share one.
    static func make(_ name: String) -> (UserDefaults, String) {
        (open(name), name)
    }

    /// Opens a suite/domain name as `UserDefaults`, for call sites that
    /// already have their own name instead of calling `make(_:)`. Forgets it
    /// first, so a fixed name starts clean even after a run that got killed
    /// before its own `forget(_:)` ran.
    static func open(_ suiteName: String) -> UserDefaults {
        forget(suiteName)
        return UserDefaults(suiteName: suiteName)!
    }

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
