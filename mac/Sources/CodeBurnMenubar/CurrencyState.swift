import Foundation
import Observation

private let fxCacheTTLSeconds: TimeInterval = 24 * 3600
private let frankfurterBaseURL = "https://api.frankfurter.app/latest?from=USD&to="
/// Defensive bounds on any fetched FX rate. Real-world USD→X rates sit in [0.0001, 200000]
/// for every ISO 4217 pair; anything outside is either a parser bug or a MITM poisoning
/// attempt. We clamp hard so UI can't render NaN, negative, or astronomical numbers.
private let minValidFXRate: Double = 0.0001
private let maxValidFXRate: Double = 1_000_000
private let fxFetchTimeoutSeconds: TimeInterval = 10

@MainActor @Observable
final class CurrencyState: Sendable {
    static let shared = CurrencyState()

    var code: String = "USD"
    var rate: Double = 1.0
    var symbol: String = "$"

    private init() {}

    /// Applies a new currency context. Callers must invoke on the main actor so @Observable
    /// view updates run on the UI thread. Rejects non-finite or out-of-band rates so a
    /// poisoned Frankfurter response can't corrupt displayed costs.
    func apply(code: String, rate: Double?, symbol: String) {
        self.code = code
        self.symbol = symbol
        if let r = rate, r.isFinite, r >= minValidFXRate, r <= maxValidFXRate {
            self.rate = r
        }
    }

    nonisolated static func symbolForCode(_ code: String) -> String {
        // Some locales return "US$" for USD or "CA$" for CAD via NumberFormatter. Prefer the
        // plain glyph form everyone recognises.
        if let override = symbolOverrides[code] { return override }
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = code
        formatter.locale = Locale(identifier: "en_\(code.prefix(2))")
        return formatter.currencySymbol ?? code
    }

    nonisolated private static let symbolOverrides: [String: String] = [
        "USD": "$",
        "CAD": "$",
        "AUD": "$",
        "NZD": "$",
        "HKD": "$",
        "SGD": "$",
        "MXN": "$",
        "EUR": "\u{20AC}",
        "GBP": "\u{00A3}",
        "JPY": "\u{00A5}",
        "CNY": "\u{00A5}",
        "KRW": "\u{20A9}",
        "INR": "\u{20B9}",
        "BRL": "R$",
        "CHF": "CHF",
        "SEK": "kr",
        "DKK": "kr",
        "ZAR": "R"
    ]
}

actor FXRateCache {
    static let shared = FXRateCache()

    private struct Entry: Codable {
        let rate: Double
        let savedAt: TimeInterval
    }

    private var entries: [String: Entry] = [:]
    private var loaded = false

    private var cacheFilePath: String {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return base
            .appendingPathComponent("codeburn-mac", isDirectory: true)
            .appendingPathComponent("fx-rates.json")
            .path
    }

    private func loadIfNeeded() {
        guard !loaded else { return }
        loaded = true
        do {
            let data = try SafeFile.read(from: cacheFilePath)
            let decoded = try JSONDecoder().decode([String: Entry].self, from: data)
            // Drop any persisted entries whose rate violates the sanity bounds -- covers an
            // old cache that was written before the clamp was introduced.
            entries = decoded.filter { _, entry in
                entry.rate.isFinite && entry.rate >= minValidFXRate && entry.rate <= maxValidFXRate
            }
        } catch {
            entries = [:]
        }
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(entries) else { return }
        try? SafeFile.write(data, to: cacheFilePath)
    }

    /// Returns a cached rate regardless of freshness. Nil if never fetched.
    func cachedRate(for code: String) -> Double? {
        if code == "USD" { return 1.0 }
        loadIfNeeded()
        return entries[code]?.rate
    }

    /// Returns a fresh rate, fetching from Frankfurter when cache is stale or absent. Nil on
    /// failure. The returned rate is always finite, positive, and within the sanity bounds.
    func rate(for code: String) async -> Double? {
        if code == "USD" { return 1.0 }
        loadIfNeeded()

        if let entry = entries[code],
           Date().timeIntervalSince1970 - entry.savedAt < fxCacheTTLSeconds {
            return entry.rate
        }

        guard let url = URL(string: "\(frankfurterBaseURL)\(code)") else { return entries[code]?.rate }

        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = fxFetchTimeoutSeconds
        config.tlsMinimumSupportedProtocolVersion = .TLSv12
        let session = URLSession(configuration: config)

        do {
            let (data, response) = try await session.data(from: url)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                return entries[code]?.rate
            }
            struct Response: Decodable { let rates: [String: Double] }
            let decoded = try JSONDecoder().decode(Response.self, from: data)
            guard let fresh = decoded.rates[code],
                  fresh.isFinite, fresh >= minValidFXRate, fresh <= maxValidFXRate else {
                NSLog("CodeBurn: discarding out-of-band FX rate for \(code)")
                return entries[code]?.rate
            }
            entries[code] = Entry(rate: fresh, savedAt: Date().timeIntervalSince1970)
            persist()
            return fresh
        } catch {
            return entries[code]?.rate
        }
    }
}

/// Reads and writes the CLI's persisted currency config (~/.config/codeburn/config.json).
/// Uses an on-disk flock so a concurrent `codeburn currency ...` invocation from a terminal
/// can't race the menubar and silently drop each other's writes (TOCTOU on config.json).
enum CLICurrencyConfig {
    private static var configDir: String {
        (NSHomeDirectory() as NSString).appendingPathComponent(".config/codeburn")
    }
    private static var configPath: String {
        (configDir as NSString).appendingPathComponent("config.json")
    }
    private static var lockPath: String {
        (configDir as NSString).appendingPathComponent(".config.lock")
    }

    static func loadCode() -> String? {
        guard
            let data = try? SafeFile.read(from: configPath),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let currency = json["currency"] as? [String: Any],
            let code = currency["code"] as? String
        else {
            return nil
        }
        return code.uppercased()
    }

    static func persist(code: String) {
        do {
            try SafeFile.withExclusiveLock(at: lockPath) {
                var existing: [String: Any] = [:]
                if let data = try? SafeFile.read(from: configPath),
                   let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    existing = parsed
                }

                if code == "USD" {
                    existing.removeValue(forKey: "currency")
                } else {
                    existing["currency"] = [
                        "code": code,
                        "symbol": CurrencyState.symbolForCode(code)
                    ]
                }

                guard let data = try? JSONSerialization.data(
                    withJSONObject: existing,
                    options: [.prettyPrinted, .sortedKeys]
                ) else {
                    return
                }
                try SafeFile.write(data, to: configPath, mode: 0o600)
            }
        } catch {
            NSLog("CodeBurn: failed to persist currency config: \(error)")
        }
    }
}

struct CodeburnCLIConfigStore {
    let homeDirectory: String

    init(homeDirectory: String = NSHomeDirectory()) {
        self.homeDirectory = homeDirectory
    }

    private var configDir: String {
        (homeDirectory as NSString).appendingPathComponent(".config/codeburn")
    }
    private var configPath: String {
        (configDir as NSString).appendingPathComponent("config.json")
    }
    private var lockPath: String {
        (configDir as NSString).appendingPathComponent(".config.lock")
    }

    func loadDevinAcuUsdRate() -> Double? {
        guard
            let data = try? SafeFile.read(from: configPath),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let devin = json["devin"] as? [String: Any],
            let rate = devin["acuUsdRate"] as? Double,
            rate.isFinite,
            rate > 0
        else {
            return nil
        }
        return rate
    }

    func persistDevinAcuUsdRate(_ rate: Double) {
        guard rate.isFinite, rate > 0 else { return }
        do {
            try SafeFile.withExclusiveLock(at: lockPath) {
                var existing: [String: Any] = [:]
                if let data = try? SafeFile.read(from: configPath),
                   let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    existing = parsed
                }

                var devin = existing["devin"] as? [String: Any] ?? [:]
                devin["acuUsdRate"] = rate
                existing["devin"] = devin

                guard let data = try? JSONSerialization.data(
                    withJSONObject: existing,
                    options: [.prettyPrinted, .sortedKeys]
                ) else {
                    return
                }
                try SafeFile.write(data, to: configPath, mode: 0o600)
            }
        } catch {
            NSLog("CodeBurn: failed to persist Devin ACU config: \(error)")
        }
    }
}

enum CLIDevinConfig {
    private static let store = CodeburnCLIConfigStore()

    static func loadAcuUsdRate() -> Double? {
        store.loadDevinAcuUsdRate()
    }

    static func persistAcuUsdRate(_ rate: Double) {
        store.persistDevinAcuUsdRate(rate)
    }
}
