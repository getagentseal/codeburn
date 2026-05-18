import Foundation

enum SessionDiscovery {
    static func discoverAll(under root: URL, modifiedAfter cutoff: Date) -> [(String, [URL])] {
        var results: [(String, [URL])] = []

        for spec in providerSpecs {
            let paths = spec.discover(root, cutoff)
            if !paths.isEmpty {
                results.append((spec.name, paths))
            }
        }

        return results
    }

    private static let providerSpecs: [ProviderSpec] = [
        .claude, .codex, .copilotLegacy, .copilotVSCode,
        .cursor, .gemini, .cline, .rooCode, .kiloCode,
    ]
}

struct ProviderSpec: Sendable {
    let name: String
    let discover: @Sendable (URL, Date) -> [URL]
}

extension ProviderSpec {
    static let claude = ProviderSpec(name: "claude") { root, cutoff in
        let dir = root.appendingPathComponent(".claude/projects")
        return findJSONLFiles(under: dir, maxDepth: 4, modifiedAfter: cutoff)
    }

    static let codex = ProviderSpec(name: "codex") { root, cutoff in
        let dir = root.appendingPathComponent(".codex")
        return findJSONLFiles(under: dir, maxDepth: 6, modifiedAfter: cutoff)
    }

    static let copilotLegacy = ProviderSpec(name: "copilot") { root, cutoff in
        let dir = root.appendingPathComponent(".copilot/session-state")
        return findJSONLFiles(under: dir, maxDepth: 3, modifiedAfter: cutoff)
    }

    static let copilotVSCode = ProviderSpec(name: "copilot") { root, cutoff in
        let base = root.appendingPathComponent("Library/Application Support/Code/User/workspaceStorage")
        guard FileManager.default.fileExists(atPath: base.path) else { return [] }
        var results: [URL] = []
        let fm = FileManager.default
        guard let workspaces = try? fm.contentsOfDirectory(at: base, includingPropertiesForKeys: nil) else { return results }
        for ws in workspaces {
            let transcripts = ws.appendingPathComponent("GitHub.copilot-chat/transcripts")
            results.append(contentsOf: findJSONLFiles(under: transcripts, maxDepth: 1, modifiedAfter: cutoff))
        }
        return results
    }

    static let cursor = ProviderSpec(name: "cursor") { root, _ in
        let paths = [
            root.appendingPathComponent("Library/Application Support/Cursor/User/globalStorage/cursor.db"),
            root.appendingPathComponent(".cursor/globalStorage/cursor.db"),
        ]
        return paths.filter { FileManager.default.fileExists(atPath: $0.path) }
    }

    static let gemini = ProviderSpec(name: "gemini") { root, cutoff in
        let dir = root.appendingPathComponent(".gemini/sessions")
        return findJSONFiles(under: dir, maxDepth: 2, modifiedAfter: cutoff)
    }

    static let cline = ProviderSpec(name: "cline") { root, cutoff in
        let base = root.appendingPathComponent("Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/tasks")
        return findJSONFiles(under: base, maxDepth: 2, modifiedAfter: cutoff, named: "ui_messages.json")
    }

    static let rooCode = ProviderSpec(name: "roo-code") { root, cutoff in
        let base = root.appendingPathComponent("Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks")
        return findJSONFiles(under: base, maxDepth: 2, modifiedAfter: cutoff, named: "ui_messages.json")
    }

    static let kiloCode = ProviderSpec(name: "kilo-code") { root, cutoff in
        let base = root.appendingPathComponent("Library/Application Support/Code/User/globalStorage/kilocode.kilo-code/tasks")
        return findJSONFiles(under: base, maxDepth: 2, modifiedAfter: cutoff, named: "ui_messages.json")
    }
}

private func findJSONLFiles(under dir: URL, maxDepth: Int, modifiedAfter cutoff: Date) -> [URL] {
    findFiles(under: dir, maxDepth: maxDepth, extensions: ["jsonl"], modifiedAfter: cutoff)
}

private func findJSONFiles(under dir: URL, maxDepth: Int, modifiedAfter cutoff: Date, named: String? = nil) -> [URL] {
    findFiles(under: dir, maxDepth: maxDepth, extensions: ["json"], modifiedAfter: cutoff, named: named)
}

private func findFiles(under dir: URL, maxDepth: Int, extensions: [String], modifiedAfter cutoff: Date, named: String? = nil) -> [URL] {
    let fm = FileManager.default
    guard fm.fileExists(atPath: dir.path) else { return [] }

    var results: [URL] = []
    guard let enumerator = fm.enumerator(
        at: dir,
        includingPropertiesForKeys: [.isRegularFileKey, .contentModificationDateKey],
        options: [.skipsHiddenFiles]
    ) else { return [] }

    for case let url as URL in enumerator {
        if enumerator.level > maxDepth { enumerator.skipDescendants(); continue }
        if let named, url.lastPathComponent != named { continue }
        guard extensions.contains(url.pathExtension) else { continue }
        if let modDate = try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate,
           modDate < cutoff { continue }
        results.append(url)
    }
    return results.sorted { a, b in
        let aDate = (try? a.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
        let bDate = (try? b.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
        return aDate > bDate
    }
}
