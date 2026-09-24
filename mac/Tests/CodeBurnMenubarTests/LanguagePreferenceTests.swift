import Foundation
import Testing
@testable import CodeBurnMenubar

/// The #1244 bug in one sentence: reading `AppleLanguages` off
/// `UserDefaults.standard` falls through to the global domain, so a Mac set to
/// English reports "English" as CodeBurn's own override and the picker can
/// never show System. `current(defaults:bundleID:)` reads the app's own
/// persistent domain instead, which is also the domain System Settings writes.
@Suite("Language preference")
struct LanguagePreferenceTests {
    // One domain per test: the suite runs in parallel and these all write
    // AppleLanguages.
    private func domain(_ name: String) -> String {
        "org.agentseal.codeburn-menubar.tests.language.\(name)"
    }

    private func store(_ languages: [String]?, in domain: String) {
        UserDefaults.standard.setPersistentDomain(
            languages.map { [LanguagePreference.defaultsKey: $0] } ?? [:],
            forName: domain
        )
    }

    private func read(_ domain: String) -> LanguagePreference {
        LanguagePreference.current(defaults: .standard, bundleID: domain)
    }

    @Test("nothing stored in the app's own domain reads as System")
    func unsetIsSystem() {
        let domain = domain("unset")
        defer { TestDefaults.forget(domain) }
        store(nil, in: domain)
        // Every real Mac carries a language in the global domain. Falling
        // through to it is the bug; System has to survive that.
        #expect(UserDefaults.standard.array(forKey: LanguagePreference.defaultsKey) != nil)
        #expect(read(domain) == .system)
    }

    @Test("each shipped choice round-trips")
    func roundTrip() {
        let domain = domain("roundtrip")
        defer { TestDefaults.forget(domain) }
        for choice in [LanguagePreference.english, .chineseSimplified] {
            store([choice.rawValue], in: domain)
            #expect(read(domain) == choice)
        }
        store(nil, in: domain)
        #expect(read(domain) == .system)
    }

    @Test("a language the app does not ship reads as System")
    func unknownIsSystem() {
        let domain = domain("unknown")
        defer { TestDefaults.forget(domain) }
        store(["fr-CA"], in: domain)
        #expect(read(domain) == .system)
        store(nil, in: domain)
    }

    @Test("apply writes the key macOS reads, and System clears it")
    func applyWritesAppleLanguages() {
        let domain = domain("apply")
        defer { TestDefaults.forget(domain) }
        let scratch = UserDefaults(suiteName: domain)!
        LanguagePreference.apply(.chineseSimplified, defaults: scratch)
        #expect(read(domain) == .chineseSimplified)
        LanguagePreference.apply(.system, defaults: scratch)
        // Cleared from this app's own domain, so the bundle falls back to the
        // system list again.
        #expect(UserDefaults.standard.persistentDomain(forName: domain)?[LanguagePreference.defaultsKey] == nil)
        #expect(read(domain) == .system)
    }

    @Test("every choice the picker offers is a shipped localization")
    func choicesMatchCatalog() {
        let shipped = Set(L10n.supportedLocalizations)
        for choice in LanguagePreference.allCases where choice != .system {
            #expect(shipped.contains(choice.rawValue))
        }
        #expect(shipped.count == LanguagePreference.allCases.count - 1)
    }
}
