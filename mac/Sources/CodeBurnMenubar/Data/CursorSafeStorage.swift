import Foundation
import CommonCrypto

/// Unlocks Cursor 3.27's `cursor-safe-storage:v1:` access token. The blob is
/// Chromium safe-storage v10, not an expired JWT. The password is the login
/// keychain item `Cursor Safe Storage` / `Cursor Key` (older builds used
/// account `Cursor`). Plaintext tokens pass through. The secret is never logged.
enum CursorSafeStorage {
    static let prefix = "cursor-safe-storage:"
    static let consentKey = "codeburn.cursor.keychainConsent"
    private static let service = "Cursor Safe Storage"
    private static let accounts = ["Cursor Key", "Cursor"]
    private static let lock = NSLock()
    // The token a stored blob opened to, so a background refresh reads each blob once.
    private nonisolated(unsafe) static var opened: (stored: String, jwt: String)?

    /// Keychain consent is user-initiated, as for Claude: `allowPrompt` is a
    /// Retry or Reconnect click. A background refresh reads only after such a
    /// read succeeded, and its first locked read turns that off again.
    static func unlock(_ stored: String, allowPrompt: Bool, defaults: UserDefaults = .standard) throws -> String {
        guard stored.hasPrefix(prefix) else { return stored }
        if !allowPrompt, let last = lock.withLock({ opened }), last.stored == stored { return last.jwt }
        guard allowPrompt || defaults.bool(forKey: consentKey),
              let jwt = readPassword().flatMap({ decrypt(stored, password: $0) }) else {
            defaults.removeObject(forKey: consentKey)
            throw CursorSubscriptionService.FetchError.safeStorageLocked
        }
        defaults.set(true, forKey: consentKey)
        lock.withLock { opened = (stored: stored, jwt: jwt) }
        return jwt
    }

    static func forget(defaults: UserDefaults) {
        defaults.removeObject(forKey: consentKey)
        lock.withLock { opened = nil }
    }

    /// PBKDF2-HMAC-SHA1(password, "saltysalt", 1003, 16) + AES-128-CBC, IV 16 spaces.
    static func decrypt(_ stored: String, password: String) -> String? {
        guard stored.hasPrefix(prefix) else { return stored }
        let rest = stored.dropFirst(prefix.count)
        guard let sep = rest.firstIndex(of: ":"), rest[..<sep] == "v1" else { return nil }
        let encoded = String(rest[rest.index(after: sep)...])
        guard let blob = Data(base64Encoded: encoded),
              blob.count > 3,
              blob.prefix(3) == Data("v10".utf8) else { return nil }
        let ciphertext = [UInt8](blob.dropFirst(3))
        let passwordBytes = Array(password.utf8)
        let salt = Array("saltysalt".utf8)
        var key = [UInt8](repeating: 0, count: kCCKeySizeAES128)
        let derived = CCKeyDerivationPBKDF(
            CCPBKDFAlgorithm(kCCPBKDF2),
            passwordBytes, passwordBytes.count,
            salt, salt.count,
            CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA1),
            1003,
            &key, key.count
        )
        guard derived == kCCSuccess else { return nil }
        let iv = [UInt8](repeating: 0x20, count: kCCBlockSizeAES128)
        var out = [UInt8](repeating: 0, count: ciphertext.count + kCCBlockSizeAES128)
        var moved = 0
        let status = CCCrypt(
            CCOperation(kCCDecrypt),
            CCAlgorithm(kCCAlgorithmAES),
            CCOptions(kCCOptionPKCS7Padding),
            key, key.count,
            iv,
            ciphertext, ciphertext.count,
            &out, out.count,
            &moved
        )
        guard status == kCCSuccess, moved > 0 else { return nil }
        let jwt = String(bytes: out.prefix(moved), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let jwt, !jwt.isEmpty else { return nil }
        return jwt
    }

    private static func readPassword() -> String? {
        for account in accounts {
            if let value = securityPassword(account: account) { return value }
        }
        // No service-only lookup: after a Deny it finds the same item and asks again.
        return nil
    }

    private static func securityPassword(account: String) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        process.arguments = ["find-generic-password", "-s", service, "-a", account, "-w"]
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
