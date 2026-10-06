import Foundation

/// Devin plan quota, read only from the cache the Devin CLI keeps of its last
/// UserStatus response: ~/.cache/devin/cli/user_status.<identity digest>.bin, a
/// JSON envelope whose `payload` is a base64 protobuf. No network call and no
/// API key; the numbers are as fresh as the CLI's last run. Mirrors
/// src/quota/devin.ts.
///
/// The payload also carries the account's email and name. Only the plan status
/// message (field 13) is walked, and only these fields are read from it:
/// 13.1.2 plan name, 13.14 / 13.15 daily / weekly quota remaining percent
/// (-1 = unlimited), 13.17 / 13.18 daily / weekly reset (unix seconds).
enum DevinSubscriptionService {
    private static let maxCacheBytes = 16 * 1024 * 1024
    private static let maxResetAheadSeconds: Int64 = 400 * 86_400
    private static let maxClockSkewSeconds: TimeInterval = 300
    private static let windows: [(label: String, remainingField: Int, resetField: Int)] = [
        ("Daily", 14, 17),
        ("Weekly", 15, 18),
    ]

    enum FetchError: Error, Equatable, LocalizedError, Sendable {
        case noCache
        case unsupportedVersion
        case parseFailure
        case outOfDate

        enum Classification: Equatable, Sendable {
            case terminalAuth
            case transient
            case parseFailure
        }

        var classification: Classification {
            switch self {
            case .noCache: .terminalAuth
            case .outOfDate: .transient
            case .unsupportedVersion, .parseFailure: .parseFailure
            }
        }

        var errorDescription: String? {
            switch self {
            case .noCache:
                "Run the Devin CLI once to sign in, then click Retry."
            case .unsupportedVersion:
                "Devin's quota cache is in a newer format CodeBurn cannot read yet."
            case .parseFailure:
                "Devin's cached plan status was not in the expected format."
            case .outOfDate:
                "Devin's cached quota is from before the last reset; run the Devin CLI to refresh it."
            }
        }
    }

    static var defaultCacheDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".cache/devin/cli", isDirectory: true)
    }

    private struct Envelope: Decodable {
        let version: Int?
        let fetched_at_secs: Int64
        let payload: String?
    }

    static func refresh(cacheDirectory: URL = defaultCacheDirectory, now: Date = Date()) throws -> QuotaSummary {
        let names = ((try? FileManager.default.contentsOfDirectory(atPath: cacheDirectory.path)) ?? [])
            .filter { $0.hasPrefix("user_status.") && $0.hasSuffix(".bin") && $0.count > "user_status..bin".count }
        guard !names.isEmpty else { throw FetchError.noCache }

        // One file per signed-in identity; the newest fetch is the account in use.
        var newest: Envelope?
        for name in names {
            let url = cacheDirectory.appendingPathComponent(name)
            guard let size = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? Int,
                  size <= maxCacheBytes,
                  let data = try? Data(contentsOf: url),
                  let envelope = try? JSONDecoder().decode(Envelope.self, from: data),
                  envelope.fetched_at_secs > 0 else { continue }
            if newest == nil || envelope.fetched_at_secs > newest!.fetched_at_secs { newest = envelope }
        }
        guard let newest else { throw FetchError.parseFailure }
        guard newest.version == 1 else { throw FetchError.unsupportedVersion }
        guard let base64 = newest.payload,
              let payload = Data(base64Encoded: base64),
              TimeInterval(newest.fetched_at_secs) <= now.timeIntervalSince1970 + maxClockSkewSeconds
        else { throw FetchError.parseFailure }
        return try decode(payload, fetchedAtSecs: newest.fetched_at_secs, now: now)
    }

    /// Any field that is present but not what the schema promises fails the
    /// whole reading rather than showing a number that may be wrong. A percent
    /// that is absent while its reset is present reads as 0 remaining: proto3
    /// does not write a zero scalar, so that is how an exhausted window arrives.
    static func decode(_ payload: Data, fetchedAtSecs: Int64, now: Date) throws -> QuotaSummary {
        let bytes = [UInt8](payload)
        guard let top = parseMessage(bytes[...]),
              let statusField = top[13], statusField.wire == 2, let statusBytes = statusField.bytes,
              let status = parseMessage(statusBytes) else { throw FetchError.parseFailure }
        let plan = try planName(status)
        let fetchedAt = Date(timeIntervalSince1970: TimeInterval(fetchedAtSecs))

        var details: [QuotaSummary.Window] = []
        var unlimited: [String] = []
        var outOfDate = false
        for window in windows {
            let remaining = status[window.remainingField]
            if let remaining, remaining.wire != 0 { throw FetchError.parseFailure }
            if remaining?.value == -1 {
                unlimited.append("\(window.label): unlimited")
                continue
            }
            guard let reset = status[window.resetField] else {
                if remaining == nil { continue }
                throw FetchError.parseFailure
            }
            guard reset.wire == 0, let resetSecs = reset.value else { throw FetchError.parseFailure }
            let left = remaining?.value ?? 0
            guard (0...100).contains(left),
                  resetSecs > fetchedAtSecs,
                  resetSecs <= fetchedAtSecs + maxResetAheadSeconds else { throw FetchError.parseFailure }
            let resetsAt = Date(timeIntervalSince1970: TimeInterval(resetSecs))
            if resetsAt <= now {
                outOfDate = true
                continue
            }
            details.append(QuotaSummary.Window(
                label: window.label,
                percent: Double(100 - left) / 100,
                resetsAt: resetsAt,
                fetchedAt: fetchedAt
            ))
        }

        if details.isEmpty && unlimited.isEmpty {
            throw outOfDate ? FetchError.outOfDate : FetchError.parseFailure
        }
        let age = CodexBankedResetPresentation.compactAge(of: fetchedAt, now: now)
        return QuotaSummary(
            providerFilter: .devin,
            connection: .connected,
            primary: details.first { $0.label == "Weekly" } ?? details.first,
            details: details,
            planLabel: plan,
            footerLines: ["Updated \(age), refreshes while the Devin CLI runs."] + unlimited
        )
    }

    private static func planName(_ status: [Int: Field]) throws -> String? {
        guard let plan = status[1] else { return nil }
        guard plan.wire == 2, let planBytes = plan.bytes, let info = parseMessage(planBytes) else {
            throw FetchError.parseFailure
        }
        guard let name = info[2] else { return nil }
        guard name.wire == 2, let nameBytes = name.bytes,
              let text = String(bytes: nameBytes, encoding: .utf8) else { throw FetchError.parseFailure }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty || trimmed.count > 64 ? nil : trimmed
    }

    struct Field {
        let wire: UInt8
        let value: Int64?
        let bytes: ArraySlice<UInt8>?
    }

    private static func readVarint(_ buf: ArraySlice<UInt8>, _ pos: inout Int) -> UInt64? {
        var result: UInt64 = 0
        for i in 0..<10 {
            guard pos < buf.endIndex else { return nil }
            let byte = buf[pos]
            pos += 1
            result |= UInt64(byte & 0x7f) << UInt64(7 * i)
            if byte & 0x80 == 0 { return result }
        }
        return nil
    }

    /// One protobuf message level, last occurrence wins. Nil on anything that
    /// is not a well-formed message: a truncated varint, a length past the end,
    /// a group wire type or field number 0.
    static func parseMessage(_ buf: ArraySlice<UInt8>) -> [Int: Field]? {
        var fields: [Int: Field] = [:]
        var pos = buf.startIndex
        while pos < buf.endIndex {
            guard let key = readVarint(buf, &pos), key >= 8, key >> 3 <= UInt64(Int32.max) else { return nil }
            let field = Int(key >> 3)
            let wire = UInt8(key & 7)
            switch wire {
            case 0:
                guard let value = readVarint(buf, &pos) else { return nil }
                fields[field] = Field(wire: wire, value: Int64(bitPattern: value), bytes: nil)
            case 2:
                guard let length = readVarint(buf, &pos), length <= UInt64(buf.endIndex - pos) else { return nil }
                let end = pos + Int(length)
                fields[field] = Field(wire: wire, value: nil, bytes: buf[pos..<end])
                pos = end
            case 1, 5:
                let width = wire == 1 ? 8 : 4
                guard buf.endIndex - pos >= width else { return nil }
                pos += width
                fields[field] = Field(wire: wire, value: nil, bytes: nil)
            default:
                return nil
            }
        }
        return fields
    }
}
