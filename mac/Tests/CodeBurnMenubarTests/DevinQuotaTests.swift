import Foundation
import Testing
@testable import CodeBurnMenubar

/// Every payload here is built with a small protobuf encoder, never copied
/// from a real Devin UserStatus (which carries the account's email and name).
@Suite("Devin quota")
struct DevinQuotaTests {
    static let fetched: Int64 = 1_790_622_000
    static let dailyReset: Int64 = 1_790_668_800
    static let weeklyReset: Int64 = 1_791_100_800
    static let now = Date(timeIntervalSince1970: TimeInterval(fetched + 3 * 3600))

    static func varint(_ value: Int64) -> [UInt8] {
        var v = UInt64(bitPattern: value)
        var out: [UInt8] = []
        repeat {
            let byte = UInt8(v & 0x7f)
            v >>= 7
            out.append(v > 0 ? byte | 0x80 : byte)
        } while v > 0
        return out
    }

    static func num(_ field: Int, _ value: Int64) -> [UInt8] { varint(Int64(field << 3)) + varint(value) }
    static func msg(_ field: Int, _ body: [UInt8]) -> [UInt8] {
        varint(Int64(field << 3 | 2)) + varint(Int64(body.count)) + body
    }

    static func status(
        daily: Int64? = 100,
        weekly: Int64 = 96,
        dailyReset: Int64 = Self.dailyReset,
        weeklyReset: Int64 = Self.weeklyReset
    ) -> Data {
        let planInfo = num(1, 16) + msg(2, Array("Pro".utf8)) + msg(33, Array("synthetic org".utf8))
        var planStatus = msg(1, planInfo) + num(8, -1)
        if let daily { planStatus += num(14, daily) }
        planStatus += num(15, weekly) + num(17, dailyReset) + num(18, weeklyReset)
        return Data(num(1, 7) + msg(5, Array("synthetic@example.invalid".utf8)) + msg(13, planStatus))
    }

    static func decode(_ payload: Data, now: Date = now) throws -> QuotaSummary {
        try DevinSubscriptionService.decode(payload, fetchedAtSecs: fetched, now: now)
    }

    @Test("reads plan, daily and weekly windows as used percent")
    func decodesNormalStatus() throws {
        let summary = try Self.decode(Self.status())
        #expect(summary.connection == .connected)
        #expect(summary.planLabel == "Pro")
        #expect(summary.details.map(\.label) == ["Daily", "Weekly"])
        #expect(summary.details.map(\.percent) == [0, 0.04])
        #expect(summary.details[1].resetsAt == Date(timeIntervalSince1970: TimeInterval(Self.weeklyReset)))
        #expect(summary.details[1].fetchedAt == Date(timeIntervalSince1970: TimeInterval(Self.fetched)))
        #expect(summary.primary?.label == "Weekly")
        #expect(summary.footerLines.count == 1)
    }

    @Test("-1 is unlimited: no bar, a footer line instead")
    func unlimitedSentinel() throws {
        let summary = try Self.decode(Self.status(daily: -1))
        #expect(summary.details.map(\.label) == ["Weekly"])
        #expect(summary.footerLines.last == "Daily: unlimited")
    }

    @Test("an absent percent next to a reset reads as exhausted (proto3 omits zero)")
    func absentPercentIsExhausted() throws {
        let summary = try Self.decode(Self.status(daily: nil))
        #expect(summary.details.first?.percent == 1)
    }

    @Test("out-of-range percents and implausible resets fail instead of showing numbers")
    func rejectsOutOfRange() {
        let bad = [
            Self.status(weekly: 101),
            Self.status(daily: -2),
            Self.status(weeklyReset: Self.fetched - 10),
            Self.status(dailyReset: 4_000_000_000),
            Data([0x6a, 0x7f, 0x01]),
        ]
        for payload in bad {
            #expect(throws: DevinSubscriptionService.FetchError.parseFailure) { try Self.decode(payload) }
        }
    }

    @Test("a window whose reset has passed since the fetch is dropped")
    func dropsStaleWindows() throws {
        let afterDaily = Date(timeIntervalSince1970: TimeInterval(Self.dailyReset + 60))
        #expect(try Self.decode(Self.status(), now: afterDaily).details.map(\.label) == ["Weekly"])
        let afterWeekly = Date(timeIntervalSince1970: TimeInterval(Self.weeklyReset + 60))
        #expect(throws: DevinSubscriptionService.FetchError.outOfDate) {
            try Self.decode(Self.status(), now: afterWeekly)
        }
    }

    @Test("cache discovery: missing dir, newest identity, unknown version")
    func readsCacheDirectory() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("codeburn-devin-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        #expect(throws: DevinSubscriptionService.FetchError.noCache) {
            try DevinSubscriptionService.refresh(cacheDirectory: root, now: Self.now)
        }

        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        func write(_ name: String, version: Int, fetched: Int64, payload: Data) throws {
            let body: [String: Any] = [
                "version": version, "identity_digest": "synthetic",
                "fetched_at_secs": fetched, "payload": payload.base64EncodedString(),
            ]
            try JSONSerialization.data(withJSONObject: body).write(to: root.appendingPathComponent(name))
        }
        try write("user_status.aaaa.bin", version: 1, fetched: Self.fetched - 100, payload: Self.status(weekly: 10))
        try write("user_status.bbbb.bin", version: 1, fetched: Self.fetched, payload: Self.status())
        let summary = try DevinSubscriptionService.refresh(cacheDirectory: root, now: Self.now)
        #expect(summary.details.last?.percent == 0.04)

        try write("user_status.cccc.bin", version: 2, fetched: Self.fetched + 1, payload: Self.status())
        #expect(throws: DevinSubscriptionService.FetchError.unsupportedVersion) {
            try DevinSubscriptionService.refresh(cacheDirectory: root, now: Self.now)
        }
    }
}
