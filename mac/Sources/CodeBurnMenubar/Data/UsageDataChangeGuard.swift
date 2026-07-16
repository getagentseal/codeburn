import Foundation

struct UsageDataSnapshot: Equatable, Sendable {
    let modificationDates: [String: Date]
}

/// Cheap change detection for the background menubar usage refresh. This is
/// deliberately not a recursive session scan: a 30s timer must not replace a
/// full Node parse with a full Swift walk of the same corpus.
enum UsageDataChangeGuard {
    /// Unchanged-skips are honored for at most this long after the last
    /// successful fetch. The root list below tracks the CLI's provider
    /// discovery by hand, so a provider missing from it must degrade to
    /// "refreshes every 30 minutes", never "stale forever".
    static let maxSkipIntervalSeconds: TimeInterval = 30 * 60

    static func shouldSkip(
        current: UsageDataSnapshot,
        lastSuccessful: UsageDataSnapshot?,
        lastSuccessAt: Date?,
        now: Date = Date(),
        force: Bool
    ) -> Bool {
        guard !force, let lastSuccessful, let lastSuccessAt else { return false }
        guard now.timeIntervalSince(lastSuccessAt) < maxSkipIntervalSeconds else { return false }
        return current == lastSuccessful
    }

    static func snapshot(
        fileManager: FileManager = .default,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        homeDirectory: String = NSHomeDirectory()
    ) -> UsageDataSnapshot {
        var dates: [String: Date] = [:]
        var roots: [UsageDataRoot] = []

        func add(_ path: String, scanFirstLevelDirectories: Bool = true) {
            let root = UsageDataRoot(path: path, scanFirstLevelDirectories: scanFirstLevelDirectories)
            guard !path.isEmpty, !roots.contains(root) else { return }
            roots.append(root)
        }

        // These are the exact configurable roots used by the menubar's CLI
        // payload path. Claude's projects directories are the normal session
        // roots; the desktop root is included because its project directories
        // are discovered below a Claude-managed workspace hierarchy.
        for configDir in claudeConfigDirectories(environment: environment, homeDirectory: homeDirectory) {
            add(path(configDir, "projects"))
        }
        add(environment["CODEBURN_DESKTOP_SESSIONS_DIR"] ?? path(homeDirectory, "Library", "Application Support", "Claude", "local-agent-mode-sessions"))

        let codexHome = expand(environment["CODEX_HOME"] ?? path(homeDirectory, ".codex"), homeDirectory: homeDirectory)
        add(path(codexHome, "sessions"))
        add(path(codexHome, "archived_sessions"))

        let cursorUser = path(homeDirectory, "Library", "Application Support", "Cursor", "User")
        add(path(cursorUser, "globalStorage", "state.vscdb"), scanFirstLevelDirectories: false)
        add(path(cursorUser, "workspaceStorage"))
        let cursorAgentHome = path(homeDirectory, ".cursor")
        add(path(cursorAgentHome, "projects"))
        add(path(cursorAgentHome, "ai-tracking", "ai-code-tracking.db"), scanFirstLevelDirectories: false)

        let xdgData = environment["XDG_DATA_HOME"] ?? path(homeDirectory, ".local", "share")
        let xdgConfig = environment["XDG_CONFIG_HOME"] ?? path(homeDirectory, ".config")
        let applicationSupport = path(homeDirectory, "Library", "Application Support")

        // Several providers use nested workspace/session layouts or SQLite
        // files. Their stable top directories/files are cheap to stat, but this
        // intentionally does not descend to individual transcript files; an
        // in-place edit can therefore wait for the next directory-entry change
        // or an interactive refresh. The tradeoff avoids a deep idle walk.
        add(expand(environment["CODEWHALE_HOME"] ?? path(homeDirectory, ".codewhale"), homeDirectory: homeDirectory), scanFirstLevelDirectories: false)
        add(path(homeDirectory, ".deepseek", "sessions"), scanFirstLevelDirectories: false)
        add(path(homeDirectory, ".cline", "data"), scanFirstLevelDirectories: false)
        add(expand(environment["CODEBUFF_DATA_DIR"] ?? path(xdgConfig, "manicode"), homeDirectory: homeDirectory), scanFirstLevelDirectories: false)
        let factoryHome = expand(environment["FACTORY_DIR"] ?? path(homeDirectory, ".factory"), homeDirectory: homeDirectory)
        add(path(factoryHome, "sessions"), scanFirstLevelDirectories: false)
        add(path(homeDirectory, ".gemini", "tmp"), scanFirstLevelDirectories: false)
        add(path(homeDirectory, ".gemini", "antigravity", "conversations"), scanFirstLevelDirectories: false)
        add(path(homeDirectory, ".gemini", "antigravity-cli", "conversations"), scanFirstLevelDirectories: false)
        add(path(homeDirectory, ".gemini", "antigravity-cli", "implicit"), scanFirstLevelDirectories: false)
        add(path(homeDirectory, ".gemini", "antigravity-ide", "conversations"), scanFirstLevelDirectories: false)
        add(path(homeDirectory, ".gemini", "antigravity-ide", "implicit"), scanFirstLevelDirectories: false)
        let hermesHome = expand(environment["HERMES_HOME"] ?? path(homeDirectory, ".hermes"), homeDirectory: homeDirectory)
        add(hermesHome, scanFirstLevelDirectories: false)
        add(path(applicationSupport, "IBM Bob", "User", "globalStorage", "ibm.bob-code"), scanFirstLevelDirectories: false)
        add(path(applicationSupport, "Bob-IDE", "User", "globalStorage", "ibm.bob-code"), scanFirstLevelDirectories: false)
        add(path(homeDirectory, ".kiro"), scanFirstLevelDirectories: false)
        add(path(applicationSupport, "Kiro", "User", "globalStorage", "kiro.kiroagent"), scanFirstLevelDirectories: false)
        add(path(applicationSupport, "Kiro", "User", "workspaceStorage"), scanFirstLevelDirectories: false)
        let kimiHome = expand(environment["KIMI_SHARE_DIR"] ?? path(homeDirectory, ".kimi"), homeDirectory: homeDirectory)
        add(path(kimiHome, "sessions"), scanFirstLevelDirectories: false)
        add(path(homeDirectory, ".lingtai"), scanFirstLevelDirectories: false)
        add(path(homeDirectory, ".lingtai-tui"), scanFirstLevelDirectories: false)
        let vibeHome = expand(environment["VIBE_HOME"] ?? path(homeDirectory, ".vibe"), homeDirectory: homeDirectory)
        add(path(vibeHome, "logs", "session"), scanFirstLevelDirectories: false)
        let muxHome = expand(environment["CODEBURN_MUX_DIR"] ?? environment["MUX_ROOT"] ?? path(homeDirectory, ".mux"), homeDirectory: homeDirectory)
        add(muxHome, scanFirstLevelDirectories: false)
        for name in [".openclaw", ".clawdbot", ".moltbot", ".moldbot"] {
            add(path(homeDirectory, name, "agents"), scanFirstLevelDirectories: false)
        }
        add(path(applicationSupport, "Open Design"), scanFirstLevelDirectories: false)
        add(path(homeDirectory, ".pi", "agent", "sessions"), scanFirstLevelDirectories: false)
        add(path(homeDirectory, ".omp", "agent", "sessions"), scanFirstLevelDirectories: false)
        add(expand(environment["QWEN_DATA_DIR"] ?? path(homeDirectory, ".qwen", "projects"), homeDirectory: homeDirectory), scanFirstLevelDirectories: false)
        let grokHome = expand(environment["GROK_HOME"] ?? path(homeDirectory, ".grok"), homeDirectory: homeDirectory)
        add(path(grokHome, "sessions"), scanFirstLevelDirectories: false)
        add(expand(environment["ZS_DATA_DIR"] ?? path(applicationSupport, "zerostack"), homeDirectory: homeDirectory), scanFirstLevelDirectories: false)
        add(expand(environment["OPENCODE_DATA_DIR"] ?? path(xdgData, "opencode"), homeDirectory: homeDirectory), scanFirstLevelDirectories: false)
        add(path(xdgData, "kilo"), scanFirstLevelDirectories: false)
        add(expand(environment["GOOSE_PATH_ROOT"] ?? path(xdgData, "goose"), homeDirectory: homeDirectory), scanFirstLevelDirectories: false)
        add(expand(environment["CRUSH_GLOBAL_DATA"] ?? path(xdgData, "crush"), homeDirectory: homeDirectory), scanFirstLevelDirectories: false)
        add(environment["WARP_DB_PATH"] ?? path(homeDirectory, "Library", "Group Containers", "group.warp", "Library", "Application Support", "dev.warp.Warp-Stable", "warp.sqlite"), scanFirstLevelDirectories: false)
        add(path(homeDirectory, ".forge", ".forge.db"), scanFirstLevelDirectories: false)
        add(path(homeDirectory, ".zcode", "cli", "db", "db.sqlite"), scanFirstLevelDirectories: false)
        add(path(applicationSupport, "Zed", "threads", "threads.db"), scanFirstLevelDirectories: false)
        add(path(xdgConfig, "github-copilot"), scanFirstLevelDirectories: false)
        add(path(homeDirectory, ".copilot", "session-state"), scanFirstLevelDirectories: false)
        add(path(applicationSupport, "Code", "User", "globalStorage", "github.copilot-chat", "agent-traces.db"), scanFirstLevelDirectories: false)
        add(path(applicationSupport, "Code - Insiders", "User", "globalStorage", "github.copilot-chat", "agent-traces.db"), scanFirstLevelDirectories: false)
        add(path(applicationSupport, "VSCodium", "User", "globalStorage", "github.copilot-chat", "agent-traces.db"), scanFirstLevelDirectories: false)

        // A changed menubar config can change the roots above, so keep its
        // mtime in the snapshot even when the configured directory list is the
        // same. Network-only providers have no local data root to fingerprint.
        add(path(homeDirectory, ".config", "codeburn", "config.json"), scanFirstLevelDirectories: false)

        for root in roots {
            dates[root.path] = modificationDate(atPath: root.path, fileManager: fileManager)
            guard root.scanFirstLevelDirectories,
                  dates[root.path] != nil,
                  let entries = try? fileManager.contentsOfDirectory(atPath: root.path) else { continue }
            for entry in entries {
                let child = path(root.path, entry)
                var isDirectory = ObjCBool(false)
                guard fileManager.fileExists(atPath: child, isDirectory: &isDirectory), isDirectory.boolValue else { continue }
                dates[child] = modificationDate(atPath: child, fileManager: fileManager)
            }
        }
        return UsageDataSnapshot(modificationDates: dates)
    }

    private struct UsageDataRoot: Hashable {
        let path: String
        let scanFirstLevelDirectories: Bool
    }

    private static func modificationDate(atPath path: String, fileManager: FileManager) -> Date? {
        guard let attributes = try? fileManager.attributesOfItem(atPath: path) else { return nil }
        return attributes[.modificationDate] as? Date
    }

    private static func claudeConfigDirectories(environment: [String: String], homeDirectory: String) -> [String] {
        if let multi = environment["CLAUDE_CONFIG_DIRS"], !multi.isEmpty {
            return multi.split(separator: ":").map { expand(String($0), homeDirectory: homeDirectory) }
        }
        if let single = environment["CLAUDE_CONFIG_DIR"], !single.isEmpty {
            return [expand(single, homeDirectory: homeDirectory)]
        }
        let configured = CLIClaudeConfig.load()
        return configured.isEmpty ? [path(homeDirectory, ".claude")] : configured.map { expand($0, homeDirectory: homeDirectory) }
    }

    private static func expand(_ value: String, homeDirectory: String) -> String {
        guard value == "~" || value.hasPrefix("~/") else { return value }
        return value == "~" ? homeDirectory : path(homeDirectory, String(value.dropFirst(2)))
    }

    private static func path(_ base: String, _ components: String...) -> String {
        components.reduce(base) { ($0 as NSString).appendingPathComponent($1) }
    }
}
