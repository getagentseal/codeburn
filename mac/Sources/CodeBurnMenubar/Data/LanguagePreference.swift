import Foundation

/// The per-app language override, written where macOS already looks for it.
///
/// System Settings > General > Language & Region > Applications writes
/// `AppleLanguages` into the application's own preferences domain, and CFBundle
/// builds its language search list from exactly that. Settings writes the same
/// key, so the two surfaces are one setting rather than two, and `L(_:)` (which
/// resolves against `Bundle.module`) follows either.
///
/// The current value is read back from the app's own persistent domain, never
/// from `UserDefaults.standard.array(forKey:)`: that read falls through to the
/// global domain and would report the *system* language as this app's override,
/// so `.system` could never be shown as selected (#1244).
enum LanguagePreference: String, CaseIterable, Identifiable, Sendable {
    case system
    case english = "en"
    case french = "fr"
    case japanese = "ja"
    case korean = "ko"
    case chineseSimplified = "zh-Hans"
    case chineseTraditional = "zh-Hant"

    var id: String { rawValue }

    var displayLabel: String {
        switch self {
        case .system: L("System")
        // Each language names itself: a picker a user opens because the UI is
        // in a language they cannot read is no use in that language.
        case .english: "English"
        case .french: "Français"
        case .japanese: "日本語"
        case .korean: "한국어"
        case .chineseSimplified: "简体中文"
        case .chineseTraditional: "繁體中文"
        }
    }

    static let defaultsKey = "AppleLanguages"

    /// What the app's own domain currently says. Absent means "follow the
    /// system", and a language the app does not ship also reads as system:
    /// that is what the bundle will actually resolve to.
    static func current(defaults: UserDefaults = .standard, bundleID: String? = Bundle.main.bundleIdentifier) -> LanguagePreference {
        guard let bundleID,
              let stored = defaults.persistentDomain(forName: bundleID)?[defaultsKey] as? [String],
              let first = stored.first,
              let match = allCases.first(where: { $0 != .system && $0.rawValue == first })
        else { return .system }
        return match
    }

    static func apply(_ preference: LanguagePreference, defaults: UserDefaults = .standard) {
        switch preference {
        case .system: defaults.removeObject(forKey: defaultsKey)
        default: defaults.set([preference.rawValue], forKey: defaultsKey)
        }
    }
}
