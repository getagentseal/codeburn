import Foundation

/// The cursor-agent CLI keeps the same WorkOS session JWT the Cursor app
/// stores in state.vscdb inside a login-keychain generic-password item. A
/// CLI-only install has no state.vscdb at all, so this item is the only
/// session source for users who never installed the Cursor IDE.
///
/// Keychain consent is user-initiated, exactly like CursorSafeStorage:
/// `allowPrompt` is a Retry or Reconnect click, one granted read is
/// remembered until a later read is refused, and a refused read drops that
/// memory again. Lookup is by account only — the service string belongs to
/// the CLI and is not part of the contract. No SecItemCopyMatching: it would
/// raise an interactive prompt a menu-bar agent cannot anchor.
enum CursorCLISession {
    static let consentKey = "codeburn.cursor.cliKeychainConsent"
    private static let account = "cursor-user"

    /// `read` is the keychain seam; live code shells out to the Apple-signed
    /// /usr/bin/security binary, the same path CursorSafeStorage takes.
    static func loadToken(
        allowPrompt: Bool,
        defaults: UserDefaults = .standard,
        read: () -> String? = readTokenFromKeychain
    ) throws -> String? {
        guard allowPrompt || defaults.bool(forKey: consentKey) else {
            throw CursorSubscriptionService.FetchError.cliSessionLocked
        }
        guard let token = read() else {
            defaults.removeObject(forKey: consentKey)
            return nil
        }
        defaults.set(true, forKey: consentKey)
        return token
    }

    static func forget(defaults: UserDefaults) {
        defaults.removeObject(forKey: consentKey)
    }

    private static func readTokenFromKeychain() -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        process.arguments = ["find-generic-password", "-a", account, "-w"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { return nil }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let text = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard let text, !text.isEmpty else { return nil }
            return text
        } catch {
            return nil
        }
    }
}
