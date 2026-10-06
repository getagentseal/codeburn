import Foundation

/// The CLI's `cursorSync` switch in `~/.config/codeburn/config.json` (absent
/// means on), written under the same flock as `CLIClaudeConfig`.
enum CLICursorSyncConfig {
    static let defaultDir = (NSHomeDirectory() as NSString).appendingPathComponent(".config/codeburn")

    static func load(configDir: String = defaultDir) -> Bool {
        guard
            let data = try? SafeFile.read(from: (configDir as NSString).appendingPathComponent("config.json")),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return true
        }
        return (json["cursorSync"] as? Bool) != false
    }

    /// On clears the key, matching the CLI default. A config that exists but does
    /// not parse is left alone rather than replaced.
    static func persist(enabled: Bool, configDir: String = defaultDir) throws {
        let configPath = (configDir as NSString).appendingPathComponent("config.json")
        try SafeFile.withExclusiveLock(at: (configDir as NSString).appendingPathComponent(".config.lock")) {
            var config: [String: Any] = [:]
            if FileManager.default.fileExists(atPath: configPath) {
                guard let parsed = try JSONSerialization.jsonObject(with: SafeFile.read(from: configPath)) as? [String: Any] else {
                    throw CocoaError(.fileReadCorruptFile)
                }
                config = parsed
            }
            if enabled {
                config.removeValue(forKey: "cursorSync")
            } else {
                config["cursorSync"] = false
            }
            let data = try JSONSerialization.data(withJSONObject: config, options: [.prettyPrinted, .sortedKeys])
            try SafeFile.write(data, to: configPath, mode: 0o600)
        }
    }
}
