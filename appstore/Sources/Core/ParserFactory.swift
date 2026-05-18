import Foundation

enum ParserFactory {
    static func parser(for provider: String) -> SessionParser {
        switch provider {
        case "claude": ClaudeParser()
        case "codex": CodexParser()
            case "copilot": CopilotParser()
        default: GenericJSONLParser(provider: provider)
        }
    }
}

protocol SessionParser {
    func parseSessions(at paths: [URL], in dateRange: ClosedRange<Date>) -> [ParsedSession]
}

// MARK: - Claude JSONL parser

struct ClaudeParser: SessionParser {
    func parseSessions(at paths: [URL], in dateRange: ClosedRange<Date>) -> [ParsedSession] {
        paths.compactMap { parseClaudeSession(at: $0, in: dateRange) }
    }

    private func parseClaudeSession(at url: URL, in dateRange: ClosedRange<Date>) -> ParsedSession? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        guard let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size < 100_000_000 else { return nil }
        guard let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .utf8)
        else { return nil }

        let lines = text.components(separatedBy: .newlines).filter { !$0.isEmpty }
        var turns: [ParsedTurn] = []
        var firstTimestamp: Date?

        let isoFormatter = ISO8601DateFormatter()
        isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        for line in lines {
            guard let json = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { continue }
            guard let message = json["message"] as? [String: Any],
                  let role = message["role"] as? String, role == "assistant"
            else { continue }

            let timestamp = (json["timestamp"] as? String).flatMap { isoFormatter.date(from: $0) }
                ?? (message["timestamp"] as? String).flatMap { isoFormatter.date(from: $0) }
                ?? Date()
            if firstTimestamp == nil { firstTimestamp = timestamp }

            guard dateRange.contains(timestamp) else { continue }

            let usage = message["usage"] as? [String: Any] ?? [:]
            let inputTokens = usage["input_tokens"] as? Int ?? 0
            let outputTokens = usage["output_tokens"] as? Int ?? 0
            let cacheRead = usage["cache_read_input_tokens"] as? Int ?? 0
            let cacheWrite = usage["cache_creation_input_tokens"] as? Int ?? 0
            let speed = usage["speed"] as? String ?? "standard"

            let cacheCreation = usage["cache_creation"] as? [String: Any]
            let oneHourCacheWrite = cacheCreation?["ephemeral_1h_input_tokens"] as? Int ?? 0

            let model = message["model"] as? String ?? "unknown"
            let cost = PricingEngine.cost(
                model: model, input: inputTokens, output: outputTokens,
                cacheRead: cacheRead, cacheWrite: cacheWrite,
                oneHourCacheWrite: oneHourCacheWrite, speed: speed
            )

            let toolUse = (message["content"] as? [[String: Any]])?.compactMap { $0["name"] as? String } ?? []

            turns.append(ParsedTurn(
                timestamp: timestamp, model: model,
                inputTokens: inputTokens, outputTokens: outputTokens,
                cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
                cost: cost, toolCalls: toolUse
            ))
        }

        guard !turns.isEmpty else { return nil }

        let project = url.deletingLastPathComponent().lastPathComponent
        return ParsedSession(
            id: url.lastPathComponent,
            project: project,
            provider: "claude",
            startDate: firstTimestamp ?? Date(),
            calls: turns.count,
            cost: turns.reduce(0) { $0 + $1.cost },
            inputTokens: turns.reduce(0) { $0 + $1.inputTokens },
            outputTokens: turns.reduce(0) { $0 + $1.outputTokens },
            cacheReadTokens: turns.reduce(0) { $0 + $1.cacheReadTokens },
            cacheWriteTokens: turns.reduce(0) { $0 + $1.cacheWriteTokens },
            model: turns.first?.model ?? "unknown",
            turns: turns
        )
    }
}

// MARK: - Codex JSONL parser

struct CodexParser: SessionParser {
    func parseSessions(at paths: [URL], in dateRange: ClosedRange<Date>) -> [ParsedSession] {
        paths.compactMap { parseCodexSession(at: $0, in: dateRange) }
    }

    private func parseCodexSession(at url: URL, in dateRange: ClosedRange<Date>) -> ParsedSession? {
        guard let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .utf8)
        else { return nil }

        let lines = text.components(separatedBy: .newlines).filter { !$0.isEmpty }
        var turns: [ParsedTurn] = []
        var firstTimestamp: Date?
        var sessionModel = "unknown"
        var currentModel = "unknown"
        var prevInput = 0, prevCached = 0, prevOutput = 0

        let isoFormatter = ISO8601DateFormatter()
        isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        for line in lines {
            guard let json = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
                  let type = json["type"] as? String
            else { continue }

            let payload = json["payload"] as? [String: Any] ?? [:]

            if type == "session_meta" {
                if let m = payload["model"] as? String, !m.isEmpty { sessionModel = m; currentModel = m }
                let originator = (payload["originator"] as? String ?? "").lowercased()
                guard originator.hasPrefix("codex") else { return nil }
                continue
            }

            if type == "turn_context" {
                if let m = payload["model"] as? String, !m.isEmpty { currentModel = m }
                continue
            }

            guard type == "event_msg",
                  let payloadType = payload["type"] as? String, payloadType == "token_count"
            else { continue }

            let ts = (json["timestamp"] as? String).flatMap { isoFormatter.date(from: $0) } ?? Date()
            if firstTimestamp == nil { firstTimestamp = ts }
            guard dateRange.contains(ts) else { continue }

            let info = payload["info"] as? [String: Any] ?? [:]

            let inputTokens: Int
            let cachedTokens: Int
            let outputTokens: Int

            if let last = info["last_token_usage"] as? [String: Any] {
                inputTokens = last["input_tokens"] as? Int ?? 0
                cachedTokens = last["cached_input_tokens"] as? Int ?? 0
                outputTokens = last["output_tokens"] as? Int ?? 0
            } else if let total = info["total_token_usage"] as? [String: Any] {
                let totalIn = total["input_tokens"] as? Int ?? 0
                let totalCached = total["cached_input_tokens"] as? Int ?? 0
                let totalOut = total["output_tokens"] as? Int ?? 0
                inputTokens = max(0, totalIn - prevInput)
                cachedTokens = max(0, totalCached - prevCached)
                outputTokens = max(0, totalOut - prevOutput)
                prevInput = totalIn
                prevCached = totalCached
                prevOutput = totalOut
            } else {
                continue
            }

            let uncachedInput = max(0, inputTokens - cachedTokens)
            let cost = PricingEngine.cost(
                model: currentModel, input: uncachedInput, output: outputTokens,
                cacheRead: cachedTokens
            )

            turns.append(ParsedTurn(
                timestamp: ts, model: currentModel,
                inputTokens: uncachedInput, outputTokens: outputTokens,
                cacheReadTokens: cachedTokens, cacheWriteTokens: 0,
                cost: cost, toolCalls: []
            ))
        }

        guard !turns.isEmpty else { return nil }
        let project = url.deletingLastPathComponent().lastPathComponent
        return ParsedSession(
            id: url.lastPathComponent, project: project, provider: "codex",
            startDate: firstTimestamp ?? Date(), calls: turns.count,
            cost: turns.reduce(0) { $0 + $1.cost },
            inputTokens: turns.reduce(0) { $0 + $1.inputTokens },
            outputTokens: turns.reduce(0) { $0 + $1.outputTokens },
            cacheReadTokens: turns.reduce(0) { $0 + $1.cacheReadTokens },
            cacheWriteTokens: 0,
            model: sessionModel, turns: turns
        )
    }
}

// MARK: - Copilot parser

struct CopilotParser: SessionParser {
    private static let charsPerToken = 4

    func parseSessions(at paths: [URL], in dateRange: ClosedRange<Date>) -> [ParsedSession] {
        paths.compactMap { parseCopilotSession(at: $0, in: dateRange) }
    }

    private func parseCopilotSession(at url: URL, in dateRange: ClosedRange<Date>) -> ParsedSession? {
        guard let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .utf8)
        else { return nil }

        let lines = text.components(separatedBy: .newlines).filter { !$0.isEmpty }
        var turns: [ParsedTurn] = []
        var firstTimestamp: Date?

        for line in lines {
            guard let json = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { continue }
            guard let type = json["type"] as? String else { continue }

            let data = json["data"] as? [String: Any] ?? [:]
            let ts = (json["timestamp"] as? TimeInterval).map { Date(timeIntervalSince1970: $0 / 1000) }
                ?? (json["timestamp"] as? String).flatMap { ISO8601DateFormatter().date(from: $0) }
                ?? Date()

            if firstTimestamp == nil { firstTimestamp = ts }
            guard dateRange.contains(ts) else { continue }

            if type == "response" || type == "assistant" {
                let content = data["content"] as? String ?? ""
                let outputTokens = data["outputTokens"] as? Int ?? (content.count + Self.charsPerToken - 1) / Self.charsPerToken
                let model = inferModel(from: data)
                let cost = PricingEngine.cost(model: model, input: 0, output: outputTokens)

                turns.append(ParsedTurn(
                    timestamp: ts, model: model,
                    inputTokens: 0, outputTokens: outputTokens,
                    cacheReadTokens: 0, cacheWriteTokens: 0,
                    cost: cost, toolCalls: []
                ))
            }
        }

        guard !turns.isEmpty else { return nil }
        let project = url.deletingLastPathComponent().lastPathComponent
        return ParsedSession(
            id: url.lastPathComponent, project: project, provider: "copilot",
            startDate: firstTimestamp ?? Date(), calls: turns.count,
            cost: turns.reduce(0) { $0 + $1.cost },
            inputTokens: 0,
            outputTokens: turns.reduce(0) { $0 + $1.outputTokens },
            cacheReadTokens: 0, cacheWriteTokens: 0,
            model: turns.first?.model ?? "copilot-auto", turns: turns
        )
    }

    private func inferModel(from data: [String: Any]) -> String {
        if let model = data["model"] as? String, !model.isEmpty { return model }
        let toolRequests = data["toolRequests"] as? [[String: Any]] ?? []
        for req in toolRequests {
            if let id = req["id"] as? String {
                if id.hasPrefix("toolu_") { return "copilot-anthropic-auto" }
                if id.hasPrefix("call_") { return "copilot-openai-auto" }
            }
        }
        return "copilot-auto"
    }
}

// MARK: - Generic fallback

struct GenericJSONLParser: SessionParser {
    let provider: String

    func parseSessions(at paths: [URL], in dateRange: ClosedRange<Date>) -> [ParsedSession] {
        paths.compactMap { path in
            guard let data = try? Data(contentsOf: path),
                  let text = String(data: data, encoding: .utf8)
            else { return nil }

            let lines = text.components(separatedBy: .newlines).filter { !$0.isEmpty }
            var cost = 0.0
            var calls = 0

            for line in lines {
                guard let json = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { continue }
                let usage = json["usage"] as? [String: Any] ?? [:]
                let input = usage["input_tokens"] as? Int ?? 0
                let output = usage["output_tokens"] as? Int ?? 0
                let model = json["model"] as? String ?? "unknown"
                cost += PricingEngine.cost(model: model, input: input, output: output)
                calls += 1
            }

            guard calls > 0 else { return nil }
            return ParsedSession(
                id: path.lastPathComponent, project: path.deletingLastPathComponent().lastPathComponent,
                provider: provider, startDate: Date(), calls: calls, cost: cost,
                inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
                model: "unknown", turns: []
            )
        }
    }
}
