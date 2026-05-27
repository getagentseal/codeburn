import Foundation

struct ProviderStorageEntry: Identifiable, Sendable {
    let id: String
    let provider: String
    let label: String
    let path: String
    let sizeBytes: Int64?
    let exists: Bool

    var sizeLabel: String {
        guard exists, let sizeBytes else { return "Not found" }
        return ByteCountFormatter.string(fromByteCount: sizeBytes, countStyle: .file)
    }
}

private struct ProviderStorageCandidate: Sendable {
    let id: String
    let provider: String
    let label: String
    let path: String
}

enum ProviderStorageProbe {
    static func load() async -> [ProviderStorageEntry] {
        let candidates = makeCandidates()
        return await Task.detached(priority: .utility) {
            candidates.map { candidate in
                let size = allocatedSize(atPath: candidate.path)
                return ProviderStorageEntry(
                    id: candidate.id,
                    provider: candidate.provider,
                    label: candidate.label,
                    path: candidate.path,
                    sizeBytes: size,
                    exists: size != nil
                )
            }
        }.value
    }

    private static func makeCandidates() -> [ProviderStorageCandidate] {
        let fm = FileManager.default
        let env = ProcessInfo.processInfo.environment
        let home = fm.homeDirectoryForCurrentUser.path
        let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?.path
            ?? "\(home)/Library/Application Support"
        let caches = fm.urls(for: .cachesDirectory, in: .userDomainMask).first?.path
            ?? "\(home)/Library/Caches"
        let xdgConfig = env["XDG_CONFIG_HOME"] ?? "\(home)/.config"
        let xdgData = env["XDG_DATA_HOME"] ?? "\(home)/.local/share"
        let codeburnCache = env["CODEBURN_CACHE_DIR"] ?? "\(home)/.cache/codeburn"
        func expandHome(_ path: String) -> String {
            if path == "~" { return home }
            if path.hasPrefix("~/") {
                return "\(home)/\(path.dropFirst(2))"
            }
            return path
        }

        let vibeHome = expandHome(env["VIBE_HOME"] ?? "\(home)/.vibe")
        let goosePath = env["GOOSE_PATH_ROOT"].map { "\($0)/data/sessions/sessions.db" } ?? "\(xdgData)/goose/sessions/sessions.db"

        func codeGlobalStorage(_ extensionID: String) -> [String] {
            [
                "\(support)/Code/User/globalStorage/\(extensionID)",
                "\(support)/Code - Insiders/User/globalStorage/\(extensionID)",
                "\(support)/VSCodium/User/globalStorage/\(extensionID)",
            ]
        }

        func codeWorkspaceStorage() -> [String] {
            [
                "\(support)/Code/User/workspaceStorage",
                "\(support)/Code - Insiders/User/workspaceStorage",
                "\(support)/VSCodium/User/workspaceStorage",
            ]
        }

        var candidates: [ProviderStorageCandidate] = [
            .init(id: "codeburn-config", provider: "CodeBurn", label: "Config", path: "\(xdgConfig)/codeburn"),
            .init(id: "codeburn-support", provider: "CodeBurn", label: "Application Support", path: "\(support)/CodeBurn"),
            .init(id: "codeburn-cache", provider: "CodeBurn", label: "Caches", path: "\(caches)/CodeBurn"),
            .init(id: "codeburn-cli-cache", provider: "CodeBurn", label: "CLI cache", path: codeburnCache),
            .init(id: "claude-home", provider: "Claude", label: "~/.claude", path: env["CLAUDE_CONFIG_DIR"] ?? "\(home)/.claude"),
            .init(id: "claude-desktop", provider: "Claude", label: "Desktop sessions", path: "\(support)/Claude/local-agent-mode-sessions"),
            .init(id: "codex-home", provider: "Codex", label: "~/.codex", path: env["CODEX_HOME"] ?? "\(home)/.codex"),
            .init(id: "cline-home", provider: "Cline", label: "~/.cline/data", path: "\(home)/.cline/data"),
            .init(id: "droid-home", provider: "Droid", label: "~/.factory", path: env["FACTORY_DIR"] ?? "\(home)/.factory"),
            .init(id: "antigravity-app", provider: "Antigravity", label: "Application Support", path: "\(support)/Antigravity"),
            .init(id: "antigravity-google-app", provider: "Antigravity", label: "Google Application Support", path: "\(support)/Google/Antigravity"),
            .init(id: "antigravity-ide-conversations", provider: "Antigravity", label: "IDE conversations", path: "\(home)/.gemini/antigravity/conversations"),
            .init(id: "antigravity-ide-implicit", provider: "Antigravity", label: "IDE implicit", path: "\(home)/.gemini/antigravity/implicit"),
            .init(id: "antigravity-cli", provider: "Antigravity", label: "~/.gemini/antigravity-cli", path: "\(home)/.gemini/antigravity-cli"),
            .init(id: "antigravity-statusline", provider: "Antigravity", label: "Status line cache", path: "\(codeburnCache)/antigravity-statusline.jsonl"),
            .init(id: "copilot-legacy", provider: "Copilot", label: "Legacy CLI", path: "\(home)/.copilot/session-state"),
            .init(id: "gemini-home", provider: "Gemini", label: "~/.gemini", path: "\(home)/.gemini"),
            .init(id: "gemini-tmp", provider: "Gemini", label: "Tmp chats", path: "\(home)/.gemini/tmp"),
            .init(id: "kimi-home", provider: "Kimi", label: "~/.kimi", path: env["KIMI_SHARE_DIR"] ?? "\(home)/.kimi"),
            .init(id: "cursor-user", provider: "Cursor", label: "Cursor User", path: "\(support)/Cursor/User"),
            .init(id: "cursor-cache", provider: "Cursor", label: "Parse cache", path: "\(codeburnCache)/cursor-results.json"),
            .init(id: "cursor-agent", provider: "Cursor Agent", label: "~/.cursor", path: "\(home)/.cursor"),
            .init(id: "kiro-user", provider: "Kiro", label: "Kiro User", path: "\(support)/Kiro/User"),
            .init(id: "kiro-workspace", provider: "Kiro", label: "Workspace Storage", path: "\(support)/Kiro/User/workspaceStorage"),
            .init(id: "openclaw-home", provider: "OpenClaw", label: "~/.openclaw", path: "\(home)/.openclaw"),
            .init(id: "clawdbot-legacy", provider: "OpenClaw", label: "~/.clawdbot", path: "\(home)/.clawdbot"),
            .init(id: "moltbot-legacy", provider: "OpenClaw", label: "~/.moltbot", path: "\(home)/.moltbot"),
            .init(id: "moldbot-legacy", provider: "OpenClaw", label: "~/.moldbot", path: "\(home)/.moldbot"),
            .init(id: "opencode", provider: "OpenCode", label: "Data", path: "\(xdgData)/opencode"),
            .init(id: "pi", provider: "Pi", label: "Sessions", path: "\(home)/.pi/agent/sessions"),
            .init(id: "omp", provider: "OMP", label: "Sessions", path: "\(home)/.omp/agent/sessions"),
            .init(id: "qwen-home", provider: "Qwen", label: "~/.qwen/projects", path: env["QWEN_DATA_DIR"] ?? "\(home)/.qwen/projects"),
            .init(id: "mistral-vibe", provider: "Mistral Vibe", label: "Sessions", path: "\(vibeHome)/logs/session"),
            .init(id: "forge", provider: "Forge", label: "Database", path: "\(home)/.forge/.forge.db"),
            .init(id: "codebuff", provider: "Codebuff", label: "Stable", path: env["CODEBUFF_DATA_DIR"] ?? "\(xdgConfig)/manicode"),
            .init(id: "codebuff-dev", provider: "Codebuff", label: "Dev", path: "\(xdgConfig)/manicode-dev"),
            .init(id: "codebuff-staging", provider: "Codebuff", label: "Staging", path: "\(xdgConfig)/manicode-staging"),
            .init(id: "crush", provider: "Crush", label: "Global data", path: env["CRUSH_GLOBAL_DATA"] ?? "\(xdgData)/crush"),
            .init(id: "goose", provider: "Goose", label: "Sessions database", path: goosePath),
            .init(id: "warp-stable", provider: "Warp", label: "Stable database", path: "\(home)/Library/Group Containers/2BBY89MBSN.dev.warp/Library/Application Support/dev.warp.Warp-Stable/warp.sqlite"),
            .init(id: "warp-preview", provider: "Warp", label: "Preview database", path: "\(home)/Library/Group Containers/2BBY89MBSN.dev.warp/Library/Application Support/dev.warp.Warp-Preview/warp.sqlite"),
        ]

        candidates.append(contentsOf: codeGlobalStorage("saoudrizwan.claude-dev").enumerated().map {
            .init(id: "cline-vscode-\($0.offset)", provider: "Cline", label: "VS Code \($0.offset + 1)", path: $0.element)
        })
        candidates.append(contentsOf: codeGlobalStorage("rooveterinaryinc.roo-cline").enumerated().map {
            .init(id: "roo-vscode-\($0.offset)", provider: "Roo Code", label: "VS Code \($0.offset + 1)", path: $0.element)
        })
        candidates.append(contentsOf: codeGlobalStorage("kilocode.kilo-code").enumerated().map {
            .init(id: "kilo-vscode-\($0.offset)", provider: "KiloCode", label: "VS Code \($0.offset + 1)", path: $0.element)
        })
        candidates.append(contentsOf: codeWorkspaceStorage().enumerated().map {
            .init(id: "copilot-vscode-\($0.offset)", provider: "Copilot", label: "Workspace Storage \($0.offset + 1)", path: $0.element)
        })
        candidates.append(.init(id: "ibm-bob", provider: "IBM Bob", label: "IBM Bob tasks", path: "\(support)/IBM Bob/User/globalStorage/ibm.bob-code"))
        candidates.append(.init(id: "bob-ide", provider: "IBM Bob", label: "Bob-IDE tasks", path: "\(support)/Bob-IDE/User/globalStorage/ibm.bob-code"))
        return candidates
    }

    private static func allocatedSize(atPath path: String) -> Int64? {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) else {
            return nil
        }

        if !isDirectory.boolValue {
            return fileAllocatedSize(URL(fileURLWithPath: path))
        }

        let root = URL(fileURLWithPath: path, isDirectory: true)
        var total: Int64 = 0
        var visited = 0
        let keys: [URLResourceKey] = [
            .isRegularFileKey,
            .isSymbolicLinkKey,
            .fileAllocatedSizeKey,
            .totalFileAllocatedSizeKey,
        ]
        let enumerator = FileManager.default.enumerator(
            at: root,
            includingPropertiesForKeys: keys,
            options: [.skipsPackageDescendants],
            errorHandler: { _, _ in true }
        )

        while let url = enumerator?.nextObject() as? URL {
            visited += 1
            if visited > 100_000 { break }
            let values = try? url.resourceValues(forKeys: Set(keys))
            if values?.isSymbolicLink == true { continue }
            if values?.isRegularFile == true {
                total += Int64(values?.totalFileAllocatedSize ?? values?.fileAllocatedSize ?? 0)
            }
        }
        return total
    }

    private static func fileAllocatedSize(_ url: URL) -> Int64 {
        let keys: Set<URLResourceKey> = [.fileAllocatedSizeKey, .totalFileAllocatedSizeKey]
        let values = try? url.resourceValues(forKeys: keys)
        return Int64(values?.totalFileAllocatedSize ?? values?.fileAllocatedSize ?? 0)
    }
}
