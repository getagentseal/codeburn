import AppKit
import Foundation

/// User-selectable UI language. macOS resolves an app's language from the
/// per-app `AppleLanguages` default (System Settings › Language & Region ›
/// Applications sets the same key), so a choice here only takes effect after
/// the app relaunches.
enum AppLanguage: String, CaseIterable, Identifiable {
    case system
    case english = "en"
    case simplifiedChinese = "zh-Hans"

    private static let appleLanguagesKey = "AppleLanguages"

    var id: String { rawValue }

    /// Shown in the picker in its own language so it is recognisable whatever
    /// the current UI language is.
    var displayName: String {
        switch self {
        case .system: L("System default")
        case .english: "English"
        case .simplifiedChinese: "简体中文"
        }
    }

    static var current: AppLanguage {
        guard let stored = UserDefaults.standard.stringArray(forKey: appleLanguagesKey)?.first else {
            return .system
        }
        return allCases.first { $0 != .system && stored.hasPrefix($0.rawValue) } ?? .system
    }

    /// The language the running process actually resolved to.
    static var effective: AppLanguage {
        let preferred = Bundle.main.preferredLocalizations.first ?? "en"
        return allCases.first { $0 != .system && preferred.hasPrefix($0.rawValue) } ?? .english
    }

    static func select(_ language: AppLanguage) {
        let defaults = UserDefaults.standard
        if language == .system {
            defaults.removeObject(forKey: appleLanguagesKey)
        } else {
            defaults.set([language.rawValue], forKey: appleLanguagesKey)
        }
    }

    /// Relaunches the app so the new language is applied.
    @MainActor
    static func relaunch() {
        let bundlePath = Bundle.main.bundlePath
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/sh")
        task.arguments = ["-c", "sleep 0.6; /usr/bin/open -n \"$0\"", bundlePath]
        try? task.run()
        NSApp.terminate(nil)
    }
}
