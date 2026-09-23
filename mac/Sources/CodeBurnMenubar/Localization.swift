import Foundation
import Observation

/// Localization for the menubar app (#1219). No third-party library: one
/// `Localizable.strings` table per locale, shipped as SwiftPM target resources
/// and resolved against the chosen language by `L10n.use(_:)`.
///
/// # Why every lookup is explicit
///
/// SwiftPM emits target resources into a *sibling* bundle
/// (`CodeBurnMenubar_CodeBurnMenubar.bundle`, copied into the app's
/// `Contents/Resources` by the packaging scripts), never into the app
/// bundle's resource root. `Bundle.main` therefore has no `.lproj` at all, so
/// the implicit `LocalizedStringKey` path that SwiftUI uses for
/// `Text("literal")` would always miss. Routing every string through `L(_:)`,
/// which names `Bundle.module`, is the one form that resolves identically in
/// `swift run`, in `swift test`, and in the packaged `.app`.
///
/// # Keys are the English copy
///
/// The key *is* the English string (`"Refresh Now"`, `"%lld sessions"`), so
/// English stays the development language: a key with no translation renders
/// as correct English rather than a visible identifier, and `en.lproj` is an
/// identity table kept only so the bundle advertises `en` as a localization
/// and so `LocalizationCatalogTests` can diff the two tables.
///
/// # What is not translated
///
/// Provider and model names (`Claude`, `Codex`, `Gemini`, `Sonnet`), units
/// (`tok/s`, `ACU`, `%`), currency codes, shell commands, and anything the
/// `codeburn` CLI itself produces (payload labels, activity and project names,
/// error text forwarded from the subprocess) stay verbatim. Numbers, dates,
/// and currency keep going through the locale-aware formatters they already
/// used — `L(_:_:)` only substitutes already-formatted values.
enum L10n {
    /// The bundle that carries `en.lproj` / `zh-Hans.lproj`.
    static let bundle: Bundle = .module

    /// Table name, i.e. `Localizable.strings`.
    static let table = "Localizable"

    /// Locales shipped today. Mirrored by `CFBundleLocalizations` in the two
    /// packaging scripts and asserted by `LocalizationCatalogTests`.
    static let supportedLocalizations = ["en", "fr", "ja", "ko", "zh-Hans", "zh-Hant"]

    private static let lock = NSLock()
    private nonisolated(unsafe) static var resolved: Bundle?

    /// The single `.lproj` sub-bundle `L(_:)` reads from. Naming the sub-bundle
    /// rather than `bundle` is what makes a language change land without a
    /// restart: CFBundle picks its localization once, the first time a table is
    /// resolved, and never revisits it — so a live `AppleLanguages` change is
    /// invisible to `bundle.localizedString(...)`, which is why the app used to
    /// have to relaunch. An explicit sub-bundle has no such cache.
    static var active: Bundle {
        lock.withLock {
            if let resolved { return resolved }
            let bundle = subbundle(for: LanguagePreference.current())
            resolved = bundle
            return bundle
        }
    }

    /// Point every later `L(_:)` at `preference`'s table.
    ///
    /// The `AppleLanguages` observer is the only caller in the app: the picker
    /// persists the preference and the observer applies it, so one pick is one
    /// rebuild. A write that does not move the resolved language — the picker
    /// re-choosing what is already in force, or a global-domain change while an
    /// override is set — returns without bumping, because a bump tears the
    /// Settings window and the dock rail down and builds them again.
    @MainActor
    static func use(_ preference: LanguagePreference) {
        let bundle = subbundle(for: preference)
        let changed = lock.withLock { () -> Bool in
            guard resolved?.bundlePath != bundle.bundlePath else { return false }
            resolved = bundle
            return true
        }
        guard changed else { return }
        LanguageGeneration.shared.bump()
    }

    /// The OS language order, read straight from the global domain. Neither
    /// `Locale.preferredLanguages` nor `Bundle.preferredLocalizations` can be
    /// used for this: both honour an `AppleLanguages` override in the app's own
    /// domain, so with one set they would report the override as the system
    /// language and "System" could never mean "follow the OS" again.
    static var systemPreferredLanguages: [String] {
        UserDefaults.standard.persistentDomain(forName: UserDefaults.globalDomain)?[LanguagePreference.defaultsKey] as? [String]
            ?? Locale.preferredLanguages
    }

    /// The language whose `.lproj` should serve lookups. A language the bundle
    /// does not ship falls back to the development language, which is English
    /// and therefore the key text itself.
    static func language(
        for preference: LanguagePreference,
        available: [String],
        development: String,
        systemPreferred: [String]
    ) -> String {
        guard preference == .system else {
            return available.contains(preference.rawValue) ? preference.rawValue : development
        }
        return Bundle.preferredLocalizations(from: available, forPreferences: systemPreferred).first ?? development
    }

    static func subbundle(
        for preference: LanguagePreference,
        in base: Bundle = L10n.bundle,
        systemPreferred: [String]? = nil
    ) -> Bundle {
        let development = base.developmentLocalization ?? "en"
        let chosen = language(
            for: preference,
            // `supportedLocalizations`, not `base.localizations`: NSBundle
            // lowercases what it reports, and `zh-hans` matches neither the
            // preference's raw value nor the `zh-Hans.lproj` on disk. The two
            // lists are held equal by `LocalizationCatalogTests`, and a
            // disagreement only costs the fallback below.
            available: supportedLocalizations,
            development: development,
            systemPreferred: systemPreferred ?? systemPreferredLanguages
        )
        return lproj(chosen, in: base) ?? lproj(development, in: base) ?? base
    }

    /// The lookup `L(_:)` performs, with the bundle named rather than taken from
    /// `active`. Tests assert a language's table through this, so checking what
    /// French renders as never has to repoint the process-wide bundle that every
    /// other suite is reading at the same time.
    static func lookup(_ key: String, in bundle: Bundle) -> String {
        bundle.localizedString(forKey: key, value: key, table: table)
    }

    /// SwiftPM writes the resource bundle's directories all lowercase, so
    /// `zh-Hans.lproj` in the source tree is `zh-hans.lproj` in the build
    /// product. `path(forResource:ofType:)` matches the name literally where
    /// CFBundle's own localization matching does not, so both spellings are
    /// tried. Getting this wrong is silent: the lookup falls through to English.
    private static func lproj(_ language: String, in base: Bundle) -> Bundle? {
        for candidate in [language, language.lowercased()] {
            if let path = base.path(forResource: candidate, ofType: "lproj"),
               let resolved = Bundle(path: path) {
                return resolved
            }
        }
        return nil
    }
}

/// Bumped whenever `L(_:)` starts answering in a different language. SwiftUI
/// views that outlive a language change (the Settings window, the Capacity Dock
/// rail) read it so their bodies re-run; the popover is rebuilt on every show
/// and needs nothing.
@MainActor
@Observable
final class LanguageGeneration {
    static let shared = LanguageGeneration()
    private(set) var value = 0
    fileprivate func bump() { value += 1 }
}

/// Localized copy for `key`, falling back to the key (its English text) when a
/// translation is missing.
func L(_ key: String) -> String {
    L10n.lookup(key, in: L10n.active)
}

/// Localized format string for `key`, filled with `arguments`.
///
/// The specifiers in the key are part of the contract between the tables:
/// `%@` for an already-formatted value (currency, token count, provider name),
/// `%lld` for a plain `Int`. Deliberately formatted without a locale so the
/// substituted values keep exactly the grouping the existing formatters chose
/// — re-grouping a `%lld` here would disagree with the
/// `asCurrency()` / `asThousandsSeparated()` output next to it.
func L(_ key: String, _ arguments: CVarArg...) -> String {
    String(format: L(key), arguments: arguments)
}

/// A quota window's label. Provider adapters hand these over in English and most
/// are passed through verbatim (a vendor's own wording, per `QuotaCrossing`);
/// the generic billing period the app itself composes is the one the dock and
/// the menu bar translate, so it does not read English amid localized copy.
func localizedWindowLabel(_ label: String) -> String {
    switch label {
    case "Monthly": return L("Monthly")
    default: return label
    }
}
