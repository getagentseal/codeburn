import Foundation

/// Closed set of terminal emulators CodeBurn knows how to drive (#877).
///
/// SECURITY: this type exists specifically so that a *user preference* can never become a
/// free-form string inside an AppleScript. The preference is persisted as a raw value that is
/// parsed back through `init(rawValue:)`; anything unrecognised collapses to `.default`. Every
/// application name that reaches `osascript` is a hardcoded literal in `script(command:)` --
/// never a stored or interpolated string. The only interpolated value is the command, which
/// callers must have already validated token-by-token with `CodeburnCLI.isSafe`.
///
/// Only terminals with a real "run this in an interactive session and leave the window open"
/// scripting verb are listed. Terminal.app has `do script`; iTerm2 has
/// `write text` on a session. Ghostty, WezTerm, Warp, Alacritty and kitty expose no equivalent
/// AppleScript verb -- launching them with `-e <cmd>` tears the window down the moment the
/// command exits, which would make "Full Report" flash and vanish, so they intentionally stay
/// out of this enum rather than shipping broken.
enum PreferredTerminal: String, CaseIterable, Identifiable, Sendable {
    case terminal
    case iTerm2 = "iterm2"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .terminal: return L("Terminal (macOS default)")
        case .iTerm2: return "iTerm2"
        }
    }

    /// Bundle locations probed with a plain `fileExists` check, mirroring the pre-#877
    /// behaviour.
    ///
    /// This is a simplicity/determinism choice, NOT a security boundary. A fixed list needs no
    /// LaunchServices database state, gives the same answer on every machine, and keeps the
    /// Settings "(not installed)" hint honest without a framework round-trip.
    ///
    /// It is worth being precise about what it does *not* buy, because an earlier version of
    /// this comment overstated it. `NSWorkspace.urlForApplication(withBundleIdentifier:)` does
    /// register and resolve bundles outside the standard folders -- an app dropped in
    /// ~/Downloads is picked up within seconds -- but when a copy also exists in /Applications,
    /// LaunchServices ranks /Applications first, and it still does so when the ~/Downloads copy
    /// advertises a *higher* CFBundleShortVersionString. So on a normally installed machine the
    /// two approaches resolve to the same bundle; the fixed list only differs by declining to
    /// find an install the user put somewhere unusual, in which case we fall back to
    /// Terminal.app rather than driving a bundle from a transient location such as a mounted
    /// DMG. Neither approach checks a code signature or team ID, so neither authenticates the
    /// app it drives.
    var appPaths: [String] {
        switch self {
        case .terminal:
            return [
                "/System/Applications/Utilities/Terminal.app",
                "/Applications/Utilities/Terminal.app",
            ]
        case .iTerm2:
            let home = FileManager.default.homeDirectoryForCurrentUser.path
            return [
                "/Applications/iTerm.app",
                "\(home)/Applications/iTerm.app",
            ]
        }
    }

    var isInstalled: Bool {
        appPaths.contains(where: FileManager.default.fileExists(atPath:))
    }

    /// AppleScript that brings the terminal forward, opens a window and runs `command`.
    ///
    /// `command` is the ONLY interpolated value; callers guarantee it is whitespace-joined argv
    /// where every token passed `CodeburnCLI.isSafe` (no quotes, no `$`, no backticks, no `;`),
    /// or a hardcoded literal. The `tell application` target is a compile-time literal per case.
    func script(command: String) -> String {
        switch self {
        case .terminal:
            return """
            tell application "Terminal"
                activate
                do script "\(command)"
            end tell
            """
        case .iTerm2:
            // iTerm2 has no `do script`. A window must be created from a profile first, then
            // text is written into its session.
            //
            // The target MUST be "iTerm", not "iTerm2", even though the app calls itself iTerm2
            // and its CFBundleName is "iTerm2". AppleScript resolves the name of a *not yet
            // running* app through LaunchServices by bundle file name, and the bundle is
            // `iTerm.app`. Measured on iTerm2 3.6.11: with the app quit,
            // `tell application "iTerm2"` fails to even compile (-2741, "expected , but found
            // class name" -- `text` binds to the built-in class because iTerm2's terminology
            // never loads) while `tell application "iTerm"` compiles, cold-launches the app and
            // runs the command. `"iTerm2"` only works while iTerm2 already happens to be
            // running, which made the bug easy to miss when testing interactively.
            return """
            tell application "iTerm"
                activate
                set newWindow to (create window with default profile)
                tell current session of newWindow
                    write text "\(command)"
                end tell
            end tell
            """
        }
    }

    // MARK: - Persistence

    static let defaultsKey = "CodeBurnPreferredTerminal"

    /// Terminal.app, i.e. exactly the pre-#877 behaviour, so users who never open Settings
    /// see no change.
    static let `default`: PreferredTerminal = .terminal

    static func saved(defaults: UserDefaults = .standard) -> PreferredTerminal {
        guard let raw = defaults.string(forKey: defaultsKey) else { return .default }
        return PreferredTerminal(rawValue: raw) ?? .default
    }

    func persist(defaults: UserDefaults = .standard) {
        defaults.set(rawValue, forKey: Self.defaultsKey)
    }
}
