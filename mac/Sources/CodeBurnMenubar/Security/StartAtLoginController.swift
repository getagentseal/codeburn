import Foundation

enum StartAtLoginController {
    private static let defaultsKey = "codeburn.startAtLogin.enabled"

    static var isEnabled: Bool {
        get {
            guard UserDefaults.standard.object(forKey: defaultsKey) != nil else {
                return false
            }
            return UserDefaults.standard.bool(forKey: defaultsKey)
        }
        set {
            UserDefaults.standard.set(newValue, forKey: defaultsKey)
            apply(enabled: newValue)
        }
    }

    static func applyCurrentSetting() {
        guard UserDefaults.standard.object(forKey: defaultsKey) != nil else { return }
        apply(enabled: isEnabled)
    }

    private static func apply(enabled: Bool) {
        let appPath = Bundle.main.bundlePath
        let appName = Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String ?? "CodeBurn"
        let script: String
        if enabled {
            script = """
            tell application "System Events"
                repeat with itemRef in login items
                    if path of itemRef is \(appleScriptStringLiteral(appPath)) then return
                end repeat
                make login item at end with properties {path:\(appleScriptStringLiteral(appPath)), hidden:false}
            end tell
            """
        } else {
            script = """
            tell application "System Events"
                repeat with itemRef in login items
                    if path of itemRef is \(appleScriptStringLiteral(appPath)) or name of itemRef is \(appleScriptStringLiteral(appName)) then delete itemRef
                end repeat
            end tell
            """
        }

        let process = Process()
        process.launchPath = "/usr/bin/osascript"
        process.arguments = ["-e", script]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
            process.waitUntilExit()
            if process.terminationStatus != 0 {
                NSLog("CodeBurn: start-at-login update exited with status %d", process.terminationStatus)
            }
        } catch {
            NSLog("CodeBurn: start-at-login update failed: \(error)")
        }
    }

    private static func appleScriptStringLiteral(_ value: String) -> String {
        var escaped = value.replacingOccurrences(of: "\\", with: "\\\\")
        escaped = escaped.replacingOccurrences(of: "\"", with: "\\\"")
        escaped = escaped.replacingOccurrences(of: "\r", with: "")
        escaped = escaped.replacingOccurrences(of: "\n", with: "")
        return "\"\(escaped)\""
    }
}
