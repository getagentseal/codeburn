import Foundation
import Testing
@testable import CodeBurnMenubar

@Suite("CLI Devin config", .serialized)
struct CLIDevinConfigTests {
    private func withTemporaryStore(_ body: (URL, CodeburnCLIConfigStore) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("codeburn-devin-config-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.removeItem(at: root)
        }
        try body(root, CodeburnCLIConfigStore(homeDirectory: root.path))
    }

    private func configURL(in home: URL) -> URL {
        home
            .appendingPathComponent(".config", isDirectory: true)
            .appendingPathComponent("codeburn", isDirectory: true)
            .appendingPathComponent("config.json")
    }

    private func writeConfig(_ object: [String: Any], in home: URL) throws {
        let url = configURL(in: home)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: url)
    }

    private func readConfig(in home: URL) throws -> [String: Any] {
        let data = try Data(contentsOf: configURL(in: home))
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test("missing config has no ACU rate")
    func missingConfigHasNoRate() throws {
        try withTemporaryStore { _, store in
            #expect(store.loadDevinAcuUsdRate() == nil)
        }
    }

    @Test("persists and loads ACU rate")
    func persistsAndLoadsRate() throws {
        try withTemporaryStore { _, store in
            store.persistDevinAcuUsdRate(2.25)

            #expect(store.loadDevinAcuUsdRate() == 2.25)
        }
    }

    @Test("preserves existing config while adding Devin rate")
    func preservesExistingConfig() throws {
        try withTemporaryStore { home, store in
            try writeConfig([
                "currency": [
                    "code": "EUR",
                    "symbol": "\u{20AC}"
                ]
            ], in: home)

            store.persistDevinAcuUsdRate(3.5)

            let json = try readConfig(in: home)
            let currency = try #require(json["currency"] as? [String: Any])
            let devin = try #require(json["devin"] as? [String: Any])
            #expect(currency["code"] as? String == "EUR")
            #expect(devin["acuUsdRate"] as? Double == 3.5)
        }
    }

    @Test("ignores invalid rates")
    func ignoresInvalidRates() throws {
        try withTemporaryStore { _, store in
            store.persistDevinAcuUsdRate(1.75)
            store.persistDevinAcuUsdRate(0)
            store.persistDevinAcuUsdRate(-2)
            store.persistDevinAcuUsdRate(.infinity)

            #expect(store.loadDevinAcuUsdRate() == 1.75)
        }
    }

    @Test("loads only positive finite numeric rates")
    func loadsOnlyPositiveFiniteNumericRates() throws {
        try withTemporaryStore { home, store in
            try writeConfig(["devin": ["acuUsdRate": 0]], in: home)
            #expect(store.loadDevinAcuUsdRate() == nil)

            try writeConfig(["devin": ["acuUsdRate": "2.25"]], in: home)
            #expect(store.loadDevinAcuUsdRate() == nil)
        }
    }
}
