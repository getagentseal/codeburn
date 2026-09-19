import Foundation

/// Pure decision for a command the desktop app's Plugins card writes into
/// `CodeBurnApp.remoteCommandKey`. Kept separate from `handleRemoteCommand()`
/// so the quit/uninstall/settings behaviour is testable without an NSApp.
enum MenubarRemoteCommand: String {
    case quit
    case uninstall
    case settings

    /// Whether this command should call `SMAppService.mainApp.unregister()`.
    var unregistersLoginItem: Bool {
        self == .uninstall
    }

    /// Whether this command should terminate the app. `settings` instead opens
    /// the settings window and activates the app.
    var terminates: Bool {
        self == .quit || self == .uninstall
    }
}
