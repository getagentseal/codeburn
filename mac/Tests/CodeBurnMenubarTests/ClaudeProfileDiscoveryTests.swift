import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("Claude file-only profiles", .serialized)
struct ClaudeProfileDiscoveryTests {
    @Test("a changed CLI login wins over an older in-memory credential and org changes cannot reuse it")
    func switchedLoginDoesNotReusePreviousAccount() throws {
        try CredentialStoreTestIsolation.lock.withLock {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            let config = root.appendingPathComponent("work")
            try FileManager.default.createDirectory(at: config, withIntermediateDirectories: true)
            ClaudeCredentialStore.resetTestSeams()
            ClaudeCredentialStore.homeDirectoryOverride = root
            defer {
                ClaudeCredentialStore.resetTestSeams()
                try? FileManager.default.removeItem(at: root)
            }
            let profile = CapacityDockClaudeProfile(id: "config", label: "First", path: config.path, orgUuid: "first")
            let old = ClaudeCredentialStore.CredentialRecord(accessToken: "old-fixture", refreshToken: nil,
                expiresAt: Date().addingTimeInterval(7_200), rateLimitTier: nil, subscriptionType: nil)
            var reads = 0
            let reader: (String, String) throws -> ClaudeCredentialStore.CredentialRecord? = { service, account in
                reads += 1
                #expect(service == ClaudeCredentialStore.keychainService(forConfigDir: config.path))
                #expect(account == NSUserName())
                return old
            }
            #expect(try ClaudeCredentialStore.credentialForProfile(profile, userInitiated: true, keychainReader: reader)?.accessToken == "old-fixture")
            let file = config.appendingPathComponent(".credentials.json")
            let fresh = try JSONSerialization.data(withJSONObject: ["claudeAiOauth": [
                "accessToken": "new-fixture", "expiresAt": Date().addingTimeInterval(3_600).timeIntervalSince1970 * 1_000,
            ]])
            try fresh.write(to: file)
            #expect(try ClaudeCredentialStore.credentialForProfile(profile, keychainReader: reader)?.accessToken == "new-fixture")
            try FileManager.default.removeItem(at: file)
            let changed = CapacityDockClaudeProfile(id: profile.id, label: "Second", path: config.path, orgUuid: "second")
            #expect(try ClaudeCredentialStore.credentialForProfile(changed, keychainReader: reader) == nil)
            #expect(reads == 1)
        }
    }

    @Test("names come from metadata, unknown orgs use IDs, and Desktop token caches are ignored")
    func fileOnlyIdentityAndCredentials() throws {
        try CredentialStoreTestIsolation.lock.withLock {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            ClaudeCredentialStore.resetTestSeams()
            ClaudeCredentialStore.homeDirectoryOverride = root
            defer {
                ClaudeCredentialStore.resetTestSeams()
                try? FileManager.default.removeItem(at: root)
            }
            func write(_ path: String, _ value: String) throws {
                let url = root.appendingPathComponent(path)
                try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                try Data(value.utf8).write(to: url)
            }
            let account = "11111111-1111-4111-8111-111111111111"
            let known = "22222222-2222-4222-8222-222222222222"
            let unknown = "33333333-3333-4333-8333-333333333333"
            let configured = root.appendingPathComponent(".work").path
            let config = try JSONSerialization.data(withJSONObject: ["claudeConfigDirs": [configured]])
            try write(".config/codeburn/config.json", String(decoding: config, as: UTF8.self))
            try write(".work/.claude.json", #"{"oauthAccount":{"organizationUuid":"\#(known)","organizationName":"Acme Engineering"}}"#)
            try write("Library/Application Support/Claude/claude-code-sessions/\(account)/\(known)/local_first.json", #"{"cliSessionId":"first"}"#)
            try write("Library/Application Support/Claude/claude-code-sessions/\(account)/\(unknown)/local_second.json", #"{"cliSessionId":"second"}"#)
            try write("Library/Application Support/Claude/config.json", "invalid encrypted token cache")
            let credential = #"{"claudeAiOauth":{"accessToken":"fixture-only","refreshToken":"must-not-be-spent","expiresAt":4102444800000}}"#
            try write(".work/.credentials.json", credential)
            let profiles = ClaudeCredentialStore.discoverProfiles()
            #expect(profiles.map(\.label) == ["Acme Engineering", unknown])
            #expect(profiles[1].id == "claude-org:\(unknown)")
            #expect(try ClaudeCredentialStore.credentialForProfile(profiles[1]) == nil)
            #expect(try ClaudeCredentialStore.credentialForProfile(profiles[0])?.accessToken == "fixture-only")
            #expect(try String(contentsOf: root.appendingPathComponent(".work/.credentials.json"), encoding: .utf8) == credential)
            #expect(ClaudeCredentialStore.keychainService(forConfigDir: configured).hasPrefix("Claude Code-credentials-"))
            try FileManager.default.removeItem(at: root.appendingPathComponent(".work/.claude.json"))
            #expect(ClaudeCredentialStore.discoverProfiles().map(\.label) == ["work", known, unknown])
        }
    }
}
