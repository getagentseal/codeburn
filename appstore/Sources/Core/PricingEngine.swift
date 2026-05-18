import Foundation

enum PricingEngine {
    struct ModelCosts {
        let inputPerToken: Double
        let outputPerToken: Double
        let cacheWritePerToken: Double
        let cacheReadPerToken: Double
        let fastMultiplier: Double
    }

    private static let oneHourCacheWriteMultiplier = 1.6

    private static let fastMultipliers: [String: Double] = [
        "claude-opus-4-7": 6,
        "claude-opus-4-6": 6,
    ]

    private static let builtinAliases: [String: String] = [
        "claude-4.6-opus": "claude-opus-4-6",
        "claude-4.6-opus-fast-mode": "claude-opus-4-6",
        "claude-4.6-opus-high": "claude-opus-4-6",
        "claude-4.6-opus-low": "claude-opus-4-6",
        "claude-4.6-opus-medium": "claude-opus-4-6",
        "claude-4.6-opus-high-thinking": "claude-opus-4-6",
        "claude-4.7-opus": "claude-opus-4-7",
        "claude-opus-4-7-thinking-high": "claude-opus-4-7",
        "claude-4.5-opus": "claude-opus-4-5",
        "claude-4.5-opus-high": "claude-opus-4-5",
        "claude-4.5-opus-low": "claude-opus-4-5",
        "claude-4.5-opus-medium": "claude-opus-4-5",
        "claude-4.5-opus-high-thinking": "claude-opus-4-5",
        "claude-4-opus": "claude-opus-4",
        "anthropic--claude-4.6-opus": "claude-opus-4-6",
        "anthropic--claude-4.5-opus": "claude-opus-4-5",
        "claude-opus-4.7": "claude-opus-4-7",
        "claude-opus-4.6": "claude-opus-4-6",
        "claude-opus-4.5": "claude-opus-4-5",
    ]

    private static let snapshot: [String: ModelCosts] = {
        guard let url = Bundle.main.url(forResource: "litellm-snapshot", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return [:] }

        var map: [String: ModelCosts] = [:]
        for (name, raw) in dict {
            guard let arr = raw as? [Any], arr.count >= 2,
                  let input = arr[0] as? Double, input >= 0,
                  let output = arr[1] as? Double, output >= 0
            else { continue }
            let cacheWrite = (arr.count > 2 ? arr[2] as? Double : nil) ?? (input * 1.25)
            let cacheRead = (arr.count > 3 ? arr[3] as? Double : nil) ?? (input * 0.1)
            map[name] = ModelCosts(
                inputPerToken: input,
                outputPerToken: output,
                cacheWritePerToken: cacheWrite,
                cacheReadPerToken: cacheRead,
                fastMultiplier: fastMultipliers[name] ?? 1
            )
        }
        return map
    }()

    private static let sortedKeys: [String] = {
        Array(snapshot.keys).sorted { $0.count > $1.count }
    }()

    static func cost(
        model: String,
        input: Int,
        output: Int,
        cacheRead: Int = 0,
        cacheWrite: Int = 0,
        oneHourCacheWrite: Int = 0,
        speed: String = "standard"
    ) -> Double {
        guard let costs = lookup(model) else { return 0 }

        let multiplier = speed == "fast" ? costs.fastMultiplier : 1.0

        let safeOneHour = max(0, oneHourCacheWrite)
        let totalCW = max(max(0, cacheWrite), safeOneHour)
        let fiveMinCW = max(0, totalCW - safeOneHour)

        return multiplier * (
            Double(max(0, input)) * costs.inputPerToken
            + Double(max(0, output)) * costs.outputPerToken
            + Double(fiveMinCW) * costs.cacheWritePerToken
            + Double(safeOneHour) * costs.cacheWritePerToken * oneHourCacheWriteMultiplier
            + Double(max(0, cacheRead)) * costs.cacheReadPerToken
        )
    }

    private static func lookup(_ model: String) -> ModelCosts? {
        let stripped = model
            .replacingOccurrences(of: #"@.*$"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"-\d{8}$"#, with: "", options: .regularExpression)
        if let costs = snapshot[stripped] { return costs }

        let canonical = resolveCanonical(stripped)
        if let costs = snapshot[canonical] { return costs }

        for key in sortedKeys {
            if canonical == key || canonical.hasPrefix(key + "-") {
                return snapshot[key]
            }
        }
        return nil
    }

    private static func resolveCanonical(_ model: String) -> String {
        var name = model
        if let slashRange = name.range(of: "/") {
            name = String(name[slashRange.upperBound...])
        }
        if let resolved = builtinAliases[name] { return resolved }
        return name
    }
}
