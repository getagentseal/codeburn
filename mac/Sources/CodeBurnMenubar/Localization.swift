import Foundation

/// Localization for the menubar app (#1219). No third-party library: one
/// `Localizable.strings` table per locale, shipped as SwiftPM target resources
/// and resolved by AppKit against the user's system language.
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
    static let supportedLocalizations = ["en", "zh-Hans"]
}

/// Localized copy for `key`, falling back to the key (its English text) when a
/// translation is missing.
func L(_ key: String) -> String {
    L10n.bundle.localizedString(forKey: key, value: key, table: L10n.table)
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
