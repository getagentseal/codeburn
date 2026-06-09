import Foundation

/// Reads and writes the CLI's `claudeConfigDirs` list in
/// `~/.config/codeburn/config.json`. The menubar is a GUI app that doesn't
/// inherit the user's shell environment, so it can't rely on `CLAUDE_CONFIG_DIRS`
/// to aggregate usage across multiple Claude config directories (work / personal
/// accounts). Persisting to the shared config file instead means every `codeburn`
/// invocation honors the list — whether the menubar spawns it directly or the
/// user launches `codeburn report` in a terminal — without injecting environment
/// variables through the shell/AppleScript paths (which only accept a strict
/// metacharacter-free allowlist that arbitrary directory paths can't satisfy).
///
/// Shares the same on-disk flock as `CLICurrencyConfig` so a concurrent
/// `codeburn` write from a terminal can't race the menubar and drop the other's
/// changes (TOCTOU on config.json).
enum CLIClaudeConfig {
    private static var configDir: String {
        (NSHomeDirectory() as NSString).appendingPathComponent(".config/codeburn")
    }
    private static var configPath: String {
        (configDir as NSString).appendingPathComponent("config.json")
    }
    private static var lockPath: String {
        (configDir as NSString).appendingPathComponent(".config.lock")
    }

    /// Returns the persisted config directories, or an empty array when none are
    /// set (the CLI then falls back to `~/.claude`).
    static func load() -> [String] {
        guard
            let data = try? SafeFile.read(from: configPath),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let dirs = json["claudeConfigDirs"] as? [Any]
        else {
            return []
        }
        return dirs.compactMap { $0 as? String }.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
    }

    /// Persists the given directories. An empty list removes the key entirely so
    /// the CLI reverts to its default `~/.claude` behavior. Entries are trimmed
    /// and blanks dropped; order is preserved.
    static func persist(dirs: [String]) {
        let cleaned = dirs
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }

        do {
            try SafeFile.withExclusiveLock(at: lockPath) {
                var existing: [String: Any] = [:]
                if let data = try? SafeFile.read(from: configPath),
                   let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    existing = parsed
                }

                if cleaned.isEmpty {
                    existing.removeValue(forKey: "claudeConfigDirs")
                } else {
                    existing["claudeConfigDirs"] = cleaned
                }

                guard let data = try? JSONSerialization.data(
                    withJSONObject: existing,
                    options: [.prettyPrinted, .sortedKeys]
                ) else {
                    return
                }
                try SafeFile.write(data, to: configPath, mode: 0o600)
            }
        } catch {
            NSLog("CodeBurn: failed to persist claudeConfigDirs config: \(error)")
        }
    }
}
