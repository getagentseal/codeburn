import Foundation

/// On-disk badge backstop. The app writes `menubar-status.json` on each successful
/// refresh and reads it back as a badge fallback after a restart, before the live
/// loop has produced a payload. Shares the `MenubarPayload` model with the live
/// path — no separate data model.
struct MenubarStatusCache {
    let statusPath: String

    /// Default location under `~/.cache/codeburn/`.
    static func standard() -> MenubarStatusCache {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return MenubarStatusCache(statusPath: "\(home)/.cache/codeburn/menubar-status.json")
    }

    struct BadgeRead {
        let payload: MenubarPayload
        let ageSeconds: TimeInterval
    }

    /// Decodes the status file and returns it with its age (from the file's
    /// mtime). Returns nil when the file is missing, corrupt, unreadable, or
    /// older than `maxAgeSeconds` — every failure mode silently falls back to
    /// the in-memory payload, never crashes.
    func readBadgePayload(maxAgeSeconds: TimeInterval) -> BadgeRead? {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: statusPath),
              let mtime = attrs[.modificationDate] as? Date else {
            return nil
        }
        let age = Date().timeIntervalSince(mtime)
        guard age >= 0, age <= maxAgeSeconds else { return nil }
        guard let data = try? SafeFile.read(from: statusPath),
              let payload = try? JSONDecoder().decode(MenubarPayload.self, from: data) else {
            return nil
        }
        return BadgeRead(payload: payload, ageSeconds: age)
    }

    func writeStatus(_ payload: MenubarPayload) throws {
        let data = try JSONEncoder().encode(payload)
        try SafeFile.write(data, to: statusPath, mode: 0o600)
    }
}
