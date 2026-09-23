import Foundation
import Testing
@testable import CodeBurnMenubar

/// The link the desktop app's Plugins card depends on: a write to this app's defaults domain
/// from outside must wake the app. `UserDefaults.didChangeNotification` does not carry an
/// external write (verified out of process), KVO does, so the observer is what is tested.
@Suite("Defaults key observer")
struct DefaultsKeyObserverTests {
    private func suite() -> (UserDefaults, String) {
        let name = "CodeBurnMenubarTests.DefaultsKeyObserver.\(UUID().uuidString)"
        return (UserDefaults(suiteName: name)!, name)
    }

    @Test("a change to the watched key calls back")
    func firesOnChange() async throws {
        let (defaults, name) = suite()
        defer { TestDefaults.forget(name) }
        defaults.set(false, forKey: CapacityDockPreferences.enabledKey)

        let fired = Counter()
        let observer = DefaultsKeyObserver(defaults: defaults, key: CapacityDockPreferences.enabledKey) {
            fired.bump()
        }

        defaults.set(true, forKey: CapacityDockPreferences.enabledKey)
        #expect(fired.value == 1)
        #expect(CapacityDockPreferences.load(defaults: defaults).isEnabled)

        defaults.set(false, forKey: CapacityDockPreferences.enabledKey)
        #expect(fired.value == 2)
        _ = observer
    }

    @Test("another key in the same domain is not the dock's business")
    func ignoresOtherKeys() throws {
        let (defaults, name) = suite()
        defer { TestDefaults.forget(name) }

        let fired = Counter()
        let observer = DefaultsKeyObserver(defaults: defaults, key: CapacityDockPreferences.enabledKey) {
            fired.bump()
        }

        defaults.set("graphite", forKey: CapacityDockPreferences.themeKey)
        #expect(fired.value == 0)
        _ = observer
    }

    /// The desktop app's language switch writes nothing but AppleLanguages. Set
    /// and removed (which is what "System" is) both have to wake the app, or it
    /// would be back to restarting to pick the language up.
    @Test("AppleLanguages is watchable, set and cleared")
    func watchesAppleLanguages() throws {
        let (defaults, name) = suite()
        defer { TestDefaults.forget(name) }

        let fired = Counter()
        let observer = DefaultsKeyObserver(defaults: defaults, key: LanguagePreference.defaultsKey) {
            fired.bump()
        }

        defaults.set(["fr"], forKey: LanguagePreference.defaultsKey)
        #expect(fired.value == 1)
        defaults.removeObject(forKey: LanguagePreference.defaultsKey)
        #expect(fired.value == 2)
        _ = observer
    }

    /// The picker persists the choice and the observer applies it. One write has
    /// to mean one apply: applying it in the picker too rebuilt the Settings
    /// window and the dock rail twice for a single pick.
    @Test("one preference write drives exactly one apply")
    func oneWriteOneApply() throws {
        let (defaults, name) = suite()
        defer { TestDefaults.forget(name) }

        let applied = Counter()
        let observer = DefaultsKeyObserver(defaults: defaults, key: LanguagePreference.defaultsKey) {
            applied.bump()
        }

        LanguagePreference.apply(.french, defaults: defaults)
        #expect(applied.value == 1)
        LanguagePreference.apply(.system, defaults: defaults)
        #expect(applied.value == 2)
        _ = observer
    }

    @Test("a released observer stops watching, so a torn-down dock leaves nothing behind")
    func stopsAfterRelease() throws {
        let (defaults, name) = suite()
        defer { TestDefaults.forget(name) }

        let fired = Counter()
        var observer: DefaultsKeyObserver? = DefaultsKeyObserver(
            defaults: defaults,
            key: CapacityDockPreferences.enabledKey
        ) { fired.bump() }
        defaults.set(true, forKey: CapacityDockPreferences.enabledKey)
        #expect(fired.value == 1)

        observer = nil
        _ = observer
        defaults.set(false, forKey: CapacityDockPreferences.enabledKey)
        #expect(fired.value == 1)
    }
}

private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    var value: Int { lock.withLock { count } }
    func bump() { lock.withLock { count += 1 } }
}
