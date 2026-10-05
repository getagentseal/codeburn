import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("Cursor sync status")
struct CursorSyncStatusTests {
    private static func payload(_ cursorSync: String?) -> Data {
        Data("""
        {
          "generated": "2026-10-05T12:00:00Z",
          "current": { "label": "Today", "cost": 1.25, "calls": 2, "sessions": 1, "inputTokens": 100, "outputTokens": 50 },
          "optimize": { "findingCount": 0, "savingsUSD": 0, "topFindings": [] },
          "history": { "daily": [] }\(cursorSync.map { ", \"cursorSync\": \($0)" } ?? "")
        }
        """.utf8)
    }

    private static let now = LiveSession.parseISO8601("2026-10-05T12:00:00.000Z")!

    private static func status(_ json: String) throws -> CursorSyncStatus {
        try JSONDecoder().decode(CursorSyncStatus.self, from: Data(json.utf8))
    }

    @Test("absent on an older CLI, and a malformed block never costs the payload")
    func optionalDecoding() throws {
        #expect(try JSONDecoder().decode(MenubarPayload.self, from: Self.payload(nil)).cursorSync == nil)
        #expect(try JSONDecoder().decode(MenubarPayload.self, from: Self.payload("{\"state\": 3}")).cursorSync == nil)
    }

    @Test("decodes the block and survives the status cache round trip")
    func decodesAndEncodes() throws {
        let decoded = try JSONDecoder().decode(MenubarPayload.self, from: Self.payload(
            #"{"enabled": true, "state": "ok", "lastSuccessAt": "2026-10-05T11:48:00.000Z"}"#
        ))
        #expect(decoded.cursorSync == CursorSyncStatus(enabled: true, state: "ok", lastSuccessAt: "2026-10-05T11:48:00.000Z", errorCode: nil, error: nil))
        let again = try JSONDecoder().decode(MenubarPayload.self, from: JSONEncoder().encode(decoded))
        #expect(again.cursorSync == decoded.cursorSync)
    }

    @Test("words each state from fixed copy, hiding the line when off")
    func lines() throws {
        let ok = try Self.status(#"{"enabled": true, "state": "ok", "lastSuccessAt": "2026-10-05T11:48:00.000Z"}"#).line(now: Self.now)
        #expect(ok?.text == "Synced from cursor.com 12m ago")
        #expect(ok?.warn == false)
        #expect(try Self.status(#"{"enabled": true, "state": "syncing-never", "lastSuccessAt": null}"#).line(now: Self.now)?.text == "Not synced from cursor.com yet")
        #expect(try Self.status(#"{"enabled": false, "state": "off", "lastSuccessAt": null}"#).line(now: Self.now) == nil)

        let login = try Self.status(#"{"enabled": true, "state": "no-login", "lastSuccessAt": null, "errorCode": "login", "error": "server said x"}"#).line(now: Self.now)
        #expect(login?.text == "Cursor login expired, open Cursor to sign in again")
        #expect(login?.warn == true)
        #expect(try Self.status(#"{"enabled": true, "state": "error", "lastSuccessAt": null, "errorCode": "network"}"#).line(now: Self.now)?.text == "Couldn't reach cursor.com, will retry")
        #expect(try Self.status(#"{"enabled": true, "state": "error", "lastSuccessAt": null, "errorCode": "new-kind"}"#).line(now: Self.now)?.text == "Couldn't read the usage export from cursor.com, will retry")
    }

    @Test("the Settings footer names the env override and otherwise shows the last sync")
    func settingsFooter() throws {
        let off = try Self.status(#"{"enabled": false, "state": "off", "lastSuccessAt": null}"#)
        #expect(CursorSyncStatus.envOff(configEnabled: true, status: off))
        #expect(CursorSyncStatus.settingsFooter(configEnabled: true, status: off) == "Turned off by CODEBURN_CURSOR_SYNC=0")
        #expect(!CursorSyncStatus.envOff(configEnabled: false, status: off))
        #expect(CursorSyncStatus.settingsFooter(configEnabled: false, status: off) == "Downloads your own usage export with the Cursor app's login, at most once an hour.")
        let ok = try Self.status(#"{"enabled": true, "state": "ok", "lastSuccessAt": "2026-10-05T11:48:00.000Z"}"#)
        #expect(!CursorSyncStatus.envOff(configEnabled: true, status: ok))
        #expect(CursorSyncStatus.settingsFooter(configEnabled: true, status: ok, now: Self.now) == "Synced from cursor.com 12m ago")
        #expect(CursorSyncStatus.settingsFooter(configEnabled: true, status: nil) == "Downloads your own usage export with the Cursor app's login, at most once an hour.")
    }

    @Test("the toggle writes only the cursorSync key, clearing it when on")
    func configRoundTrip() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("cursor-sync-\(UUID().uuidString)").path
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let config = (dir as NSString).appendingPathComponent("config.json")
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        try Data(#"{"language": "fr"}"#.utf8).write(to: URL(fileURLWithPath: config))

        #expect(CLICursorSyncConfig.load(configDir: dir))
        try CLICursorSyncConfig.persist(enabled: false, configDir: dir)
        #expect(!CLICursorSyncConfig.load(configDir: dir))
        var json = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: config))) as? [String: Any]
        #expect(json?["language"] as? String == "fr")
        try CLICursorSyncConfig.persist(enabled: true, configDir: dir)
        json = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: config))) as? [String: Any]
        #expect(json?["cursorSync"] == nil)
        #expect(json?["language"] as? String == "fr")

        try Data("not json".utf8).write(to: URL(fileURLWithPath: config))
        #expect(throws: (any Error).self) { try CLICursorSyncConfig.persist(enabled: false, configDir: dir) }
        #expect(try String(contentsOfFile: config, encoding: .utf8) == "not json")
    }
}
