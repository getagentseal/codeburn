import Foundation

/// How the menu bar flame is colored. `monochrome` renders it as a template
/// image (black on a light menu bar, white on a dark one) like Apple's own
/// status icons; `quotaTinted` is the upstream behavior that turns the flame
/// yellow / orange / red as the worst provider quota fills up.
enum MenubarIconStyle: String, CaseIterable, Identifiable {
    case monochrome
    case quotaTinted

    static let key = "CodeBurnMenubarIconStyle"
    static let changed = Notification.Name("com.codeburn.menubarIconStyleDidChange")

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .monochrome: L("Monochrome (system style)")
        case .quotaTinted: L("Colored by quota level")
        }
    }

    static var current: MenubarIconStyle {
        UserDefaults.standard.string(forKey: key).flatMap(MenubarIconStyle.init(rawValue:)) ?? .monochrome
    }

    static func select(_ style: MenubarIconStyle) {
        UserDefaults.standard.set(style.rawValue, forKey: key)
        NotificationCenter.default.post(name: changed, object: nil)
    }
}
