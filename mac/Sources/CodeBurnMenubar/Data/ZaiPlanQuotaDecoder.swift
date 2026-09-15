import Foundation

/// Shared decoder for Z.ai's `usage/quota/limit` response body. The Z.ai
/// adapter (Pi CLI credential, bare Authorization header) and the ZCode
/// adapter (coding-plan app login, Bearer token) hit the same endpoint with
/// different credentials and receive byte-identical bodies, so the window
/// extraction lives here once and each service maps the outcome onto its own
/// `FetchError` vocabulary.
enum ZaiPlanQuotaDecoder {
    enum DecodeError: Error, Equatable, Sendable {
        case authenticationRejected
        case parseFailure
    }

    /// The endpoint answers HTTP 200 even for a dead login, with a
    /// business-level `code` of 401/403 in the body — that code is the only
    /// expiry signal either adapter gets.
    static func decode(_ data: Data) throws -> QuotaSummary {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw DecodeError.parseFailure
        }
        let bodyCode = jsonNumber(root["code"]).map(Int.init)
        if bodyCode == 401 || bodyCode == 403 { throw DecodeError.authenticationRejected }
        if root["success"] as? Bool == false { throw DecodeError.parseFailure }

        let payload = (root["data"] as? [String: Any]) ?? root
        guard let limits = payload["limits"] as? [Any] else { throw DecodeError.parseFailure }

        var fiveHour: QuotaSummary.Window?
        var weekly: QuotaSummary.Window?

        for raw in limits {
            guard let limit = raw as? [String: Any],
                  let type = limit["type"] as? String,
                  type == "CREDIT_LIMIT" || type == "TOKENS_LIMIT",
                  let unit = jsonNumber(limit["unit"]),
                  let count = jsonNumber(limit["number"]) else { continue }

            let label: String
            /// Fixed cycle length derived from the unit/count enum the payload
            /// carries — provider metadata, not the label. 5-hour and weekly
            /// windows reset on fixed instants (the unit enum says so), which
            /// is what the early-reset monitor's windowSeconds contract needs:
            /// an adapter that cannot vouch for fixed cycling passes no length.
            let cycleSeconds: Int
            if unit == 3, count == 5 {
                label = "5-hour"
                cycleSeconds = 5 * 3600
            } else if unit == 6, count == 1 {
                label = "Weekly"
                cycleSeconds = 7 * 24 * 3600
            } else {
                continue
            }

            var usedPercent = jsonNumber(limit["percentage"])
            if usedPercent == nil,
               let current = jsonNumber(limit["currentValue"]),
               let total = jsonNumber(limit["usage"]), total > 0 {
                usedPercent = current / total * 100
            }
            guard let usedPercent else { continue }

            let window = QuotaSummary.Window(
                label: label,
                percent: min(1, max(0, usedPercent / 100)),
                resetsAt: parseReset(limit["nextResetTime"]),
                windowSeconds: cycleSeconds
            )
            if label == "Weekly" { weekly = window } else { fiveHour = window }
        }

        let details = [fiveHour, weekly].compactMap { $0 }
        guard !details.isEmpty else { throw DecodeError.parseFailure }
        return QuotaSummary(
            providerFilter: .all,
            connection: .connected,
            primary: weekly ?? fiveHour,
            details: details,
            planLabel: planLabel(payload["level"]),
            footerLines: ["Source: Z.ai Coding Plan"]
        )
    }

    private static func jsonNumber(_ value: Any?) -> Double? {
        if let value = value as? Double, value.isFinite { return value }
        if let value = value as? NSNumber { return value.doubleValue }
        if let value = value as? String, let number = Double(value), number.isFinite { return number }
        return nil
    }

    private static func parseReset(_ value: Any?) -> Date? {
        if let number = jsonNumber(value) {
            let seconds = number < 1_000_000_000_000 ? number : number / 1000
            return seconds.isFinite ? Date(timeIntervalSince1970: seconds) : nil
        }
        guard let value = value as? String else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }

    private static func planLabel(_ value: Any?) -> String? {
        guard let value = value as? String else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return trimmed.replacingOccurrences(of: "_", with: " ").lowercased().capitalized
    }
}
