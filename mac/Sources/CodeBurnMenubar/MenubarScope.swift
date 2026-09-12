import Foundation

private let menubarScopeDefaultsKey = "CodeBurnMenubarScope"

enum MenubarScope: String, CaseIterable, Identifiable, Sendable {
    case local = "Local"
    case combined = "Combined"

    var id: String { rawValue }

    /// What the scope toggle shows. `rawValue` stays the stable identity used
    /// for `id`; only this is translated.
    var displayLabel: String {
        switch self {
        case .local: L("Local")
        case .combined: L("Combined")
        }
    }

    var cliArg: String {
        switch self {
        case .local: "local"
        case .combined: "combined"
        }
    }

    var menubarDefaultsValue: String {
        switch self {
        case .local: "local"
        case .combined: "combined"
        }
    }

    init(menubarDefaultsValue: String?) {
        switch menubarDefaultsValue {
        case "combined": self = .combined
        default: self = .local
        }
    }

    static func savedMenubarScope(defaults: UserDefaults = .standard) -> MenubarScope {
        MenubarScope(menubarDefaultsValue: defaults.string(forKey: menubarScopeDefaultsKey))
    }

    func persistAsMenubarDefault(defaults: UserDefaults = .standard) {
        defaults.set(menubarDefaultsValue, forKey: menubarScopeDefaultsKey)
    }
}
