import Foundation
import Testing
@testable import CodeBurnMenubar

/// The language switch is applied in-process (#1219 follow-up). It used to
/// restart the app, and macOS resets the "access data from other apps" consent
/// every time a process goes, so a Warp user was re-prompted on every change.
/// What these tests pin is the part that made the restart unnecessary: the
/// `.lproj` sub-bundle `L(_:)` reads from is chosen explicitly, for "System"
/// included, so nothing depends on CFBundle's launch-time pick.
///
/// Nothing here repoints the process-wide bundle at a language other than the
/// English every other suite asserts against: a table is checked by naming its
/// sub-bundle through `L10n.lookup(_:in:)`, which is exactly what `L(_:)` does
/// with `L10n.active`. Suites run in parallel, and a French global for the width
/// of one test is a CI flake waiting to happen.
@Suite("Runtime language switch")
struct LocalizationSwitchTests {
    private static let shipped = L10n.supportedLocalizations

    private static func table(_ preference: LanguagePreference) -> Bundle {
        L10n.subbundle(for: preference, in: L10n.bundle, systemPreferred: [])
    }

    @Test("an explicit language names its own table")
    func explicitLanguage() {
        #expect(L10n.language(for: .french, available: Self.shipped, development: "en", systemPreferred: ["ja-JP"]) == "fr")
        #expect(L10n.language(for: .chineseTraditional, available: Self.shipped, development: "en", systemPreferred: []) == "zh-Hant")
        #expect(L10n.language(for: .english, available: Self.shipped, development: "en", systemPreferred: ["fr-FR"]) == "en")
    }

    @Test("a language the bundle does not ship falls back to the development language")
    func unshippedLanguage() {
        #expect(L10n.language(for: .korean, available: ["en", "fr"], development: "en", systemPreferred: ["ko-KR"]) == "en")
    }

    @Test("System follows the OS order", arguments: [
        (["fr-FR", "en-US"], "fr"),
        (["en-GB", "fr-FR"], "en"),
        (["ja-JP"], "ja"),
        (["ko-KR"], "ko"),
        (["zh-Hans-CN"], "zh-Hans"),
        (["zh-Hant-TW", "zh-Hans-CN"], "zh-Hant"),
        // Nothing in common: the development language, which is the key text.
        (["de-DE"], "en"),
        ([], "en"),
    ])
    func systemFollowsTheOS(preferences: [String], expected: String) {
        #expect(L10n.language(for: .system, available: Self.shipped, development: "en", systemPreferred: preferences) == expected)
    }

    @Test("every shipped language resolves to its own lproj")
    func everyShippedLanguageResolves() throws {
        for preference in LanguagePreference.allCases where preference != .system {
            let resolved = Self.table(preference)
            #expect(resolved != L10n.bundle, "\(preference.rawValue) did not resolve to a sub-bundle")
            // SwiftPM lowercases the directory it writes, so compare that way.
            #expect(resolved.bundlePath.lowercased().hasSuffix("/\(preference.rawValue.lowercased()).lproj"))
        }
    }

    @Test("a bundle with no lproj at all still answers, in the key's own English")
    func missingLprojFallsBackToTheBundle() throws {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("CodeBurnMenubarTests.\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let empty = try #require(Bundle(path: directory.path))
        let resolved = L10n.subbundle(for: .french, in: empty, systemPreferred: ["fr-FR"])
        #expect(resolved == empty)
        #expect(L10n.lookup("Refresh Now", in: resolved) == "Refresh Now")
    }

    @Test("a key with no translation renders as its English self")
    func missingKeyFallsBackToEnglish() {
        let absent = "codeburn.test.key.that.is.not.in.any.table"
        #expect(L10n.lookup(absent, in: Self.table(.french)) == absent)
    }

    /// The Chinese pair is what a case-mismatched lproj lookup drops to English
    /// without saying anything: SwiftPM writes `zh-hans.lproj`, the preference
    /// spells it `zh-Hans`, and `path(forResource:ofType:)` matches literally.
    @Test("each table answers in its own language")
    func eachTableAnswersInItsOwnLanguage() {
        #expect(L10n.lookup("Refresh Now", in: Self.table(.french)) == "Actualiser maintenant")
        #expect(L10n.lookup("Refresh Now", in: Self.table(.japanese)) == "今すぐ更新")
        #expect(L10n.lookup("Refresh Now", in: Self.table(.chineseSimplified)) == "立即刷新")
        #expect(L10n.lookup("Refresh Now", in: Self.table(.chineseTraditional)) == "立即重新整理")
        // English is the development language, so the key is its own copy.
        #expect(L10n.lookup("Refresh Now", in: Self.table(.english)) == "Refresh Now")
    }

    @Test("a format string switches with everything else")
    func formatStringsSwitchToo() {
        #expect(String(format: L10n.lookup("%lld%% left", in: Self.table(.french)), 42) == "42% restant")
        #expect(String(format: L10n.lookup("%lld%% left", in: Self.table(.english)), 42) == "42% left")
    }

    /// `use(_:)` is what makes a change land without a restart, so what it writes
    /// has to be what `L(_:)` reads. Asserted with English, which is what the
    /// process already resolves to, so no other suite can see this happen.
    @MainActor
    @Test("use() repoints what L() reads")
    func useRepointsTheActiveBundle() {
        L10n.use(.english)
        #expect(L10n.active.bundlePath == Self.table(.english).bundlePath)
        #expect(L("Refresh Now") == L10n.lookup("Refresh Now", in: Self.table(.english)))
    }

    /// A bump tears the Settings window and the dock rail down and builds them
    /// again, so a write that does not move the resolved language must not cause
    /// one: the picker re-choosing what is in force, or a global-domain change
    /// while an override is set.
    @MainActor
    @Test("re-applying the language already in force rebuilds nothing")
    func redundantUseDoesNotRebuild() {
        L10n.use(.english)
        let generation = LanguageGeneration.shared.value
        L10n.use(.english)
        #expect(LanguageGeneration.shared.value == generation)
        // .system resolves to English on a machine whose tests assert English,
        // so this is the "same resolved language by another name" case.
        L10n.use(.system)
        #expect(LanguageGeneration.shared.value == generation)
    }
}
