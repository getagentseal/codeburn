import Foundation
import Testing
@testable import CodeBurnMenubar

/// Guards the `Localizable.strings` catalogs (#1219).
///
/// A translation catalog rots silently: a key added to a view but not to
/// `zh-Hans` shows English in a Chinese UI, a dropped key shows a raw
/// identifier, and a format specifier that disagrees between the two tables is
/// a wrong number or a crash inside `String(format:)` — none of which the
/// compiler can see. These tests are the only thing standing between a new
/// string and that class of bug.
@Suite("Localization catalogs")
struct LocalizationCatalogTests {

    // MARK: - Loading

    /// Reads one locale's table straight out of the resource bundle: the same
    /// file `L(_:)` resolves at runtime.
    static func table(_ localization: String) throws -> [String: String] {
        let path = L10n.bundle.path(
            forResource: L10n.table,
            ofType: "strings",
            inDirectory: nil,
            forLocalization: localization
        )
        let resolved = try #require(
            path,
            "no Localizable.strings for this localization; is Resources/<locale>.lproj declared in Package.swift?"
        )
        let parsed = NSDictionary(contentsOfFile: resolved) as? [String: String]
        return try #require(
            parsed,
            "table is not a string/string plist — usually a stray quote or a missing semicolon"
        )
    }

    /// Specifier occurrences in order, `%%` included. Positional specifiers
    /// (`%1$@`) keep their index inside the token; bare ones (`%@`) stay bare.
    static func specifiers(in value: String) -> [String] {
        var found: [String] = []
        var rest = Substring(value)
        while let percent = rest.firstIndex(of: "%") {
            var cursor = rest.index(after: percent)
            guard cursor < rest.endIndex else { break }
            if rest[cursor] == "%" {
                found.append("%%")
                rest = rest[rest.index(after: cursor)...]
                continue
            }
            // Flags, width and precision, then any length modifier, then the verb.
            var token = "%"
            while cursor < rest.endIndex, "0123456789.+- #'".contains(rest[cursor]) {
                token.append(rest[cursor])
                cursor = rest.index(after: cursor)
            }
            // A `$` right after the digits makes this a positional specifier:
            // the index is part of the contract, so it stays in the token.
            if cursor < rest.endIndex, rest[cursor] == "$" {
                token.append("$")
                cursor = rest.index(after: cursor)
            }
            while cursor < rest.endIndex, "lhqLzjt".contains(rest[cursor]) {
                token.append(rest[cursor])
                cursor = rest.index(after: cursor)
            }
            if cursor < rest.endIndex {
                token.append(rest[cursor])
                cursor = rest.index(after: cursor)
            }
            found.append(token)
            rest = rest[cursor...]
        }
        return found
    }

    /// The specifiers that consume an argument. `String(format:)` binds these
    /// by slot, so slot agreement is part of the contract between locales.
    static func arguments(in value: String) -> [String] {
        specifiers(in: value).filter { $0 != "%%" }
    }

    /// Slot number → verb for every argument specifier. A positional specifier
    /// (`%2$lld`) names its own slot; a bare one (`%@`) takes the next slot in
    /// order of appearance, which is how `String(format:)` binds it.
    static func argumentSlots(in value: String) -> [Int: String] {
        var slots: [Int: String] = [:]
        var next = 1
        for token in arguments(in: value) {
            if let dollar = token.firstIndex(of: "$") {
                let digits = token[token.index(after: token.startIndex)..<dollar]
                if let slot = Int(digits) {
                    slots[slot] = String(token[token.index(after: dollar)...])
                    next = max(next, slot + 1)
                    continue
                }
            }
            slots[next] = String(token.dropFirst())
            next += 1
        }
        return slots
    }

    static func literalPercentCount(in value: String) -> Int {
        specifiers(in: value).filter { $0 == "%%" }.count
    }

    /// Formats `key` out of one locale's table, the way `L(_:_:)` does for
    /// whichever locale AppKit picks at runtime.
    static func localized(_ key: String, _ localization: String, _ arguments: CVarArg...) throws -> String {
        let format = try #require(table(localization)[key], "missing key in this localization")
        return String(format: format, arguments: arguments)
    }

    // MARK: - Coverage

    @Test("every shipped localization has a table, and they agree with Package.swift")
    func shippedLocalizationsMatchTheManifest() throws {
        let declared = Set(L10n.supportedLocalizations.map { $0.lowercased() })
        // NSBundle lowercases what it reports, so compare case-insensitively.
        let onDisk = Set(L10n.bundle.localizations.map { $0.lowercased() })
        #expect(
            declared == onDisk,
            "L10n.supportedLocalizations and the bundle disagree; Package.swift, both packaging scripts' CFBundleLocalizations, and L10n have to move together"
        )

        for localization in L10n.supportedLocalizations {
            let entries = try Self.table(localization)
            #expect(!entries.isEmpty)
        }
    }

    /// Every shipped localization except the `en` identity table.
    static let translatedLocalizations = L10n.supportedLocalizations.filter { $0 != "en" }

    @Test("every shipped locale covers exactly the same keys as en")
    func keySetsMatch() throws {
        let en = try Self.table("en")

        for localization in Self.translatedLocalizations {
            let other = try Self.table(localization)

            let untranslated = Set(en.keys).subtracting(other.keys).sorted()
            #expect(
                untranslated.isEmpty,
                "these en keys have no \(localization) entry: \(untranslated.prefix(10))"
            )

            let orphaned = Set(other.keys).subtracting(en.keys).sorted()
            #expect(
                orphaned.isEmpty,
                "these \(localization) keys are not in en, so nothing ever reaches them: \(orphaned.prefix(10))"
            )
        }
    }

    @Test("no entry is blank in any locale")
    func noEmptyValues() throws {
        for localization in L10n.supportedLocalizations {
            let blank = try Self.table(localization)
                .filter { $0.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
                .keys
                .sorted()
            #expect(blank.isEmpty, "blank values render as nothing at all: \(blank.prefix(10))")
        }
    }

    @Test("en is an identity table, so a missing translation degrades to English")
    func englishIsIdentity() throws {
        let mismatched = try Self.table("en").filter { $0.key != $0.value }.keys.sorted()
        #expect(
            mismatched.isEmpty,
            "en entries must repeat their key verbatim — L(_:) falls back to the key, so drift means two different English strings for one key: \(mismatched.prefix(10))"
        )
    }

    // MARK: - Format specifiers

    @Test("every argument slot agrees on its verb across locales")
    func argumentSpecifierParity() throws {
        let en = try Self.table("en")

        for localization in Self.translatedLocalizations {
            let other = try Self.table(localization)
            for key in en.keys.sorted() {
                guard let english = en[key], let translated = other[key] else { continue }
                let expected = Self.argumentSlots(in: english)
                let actual = Self.argumentSlots(in: translated)
                #expect(
                    expected == actual,
                    "specifier mismatch for \(key.debugDescription): en \(expected) vs \(localization) \(actual). String(format:) binds by slot, so a slot with a different verb is a wrong value or a crash."
                )
            }
        }
    }

    /// A key whose arguments are all the same type (`%@ … %@`) cannot be checked
    /// for order by comparing specifier lists: the slots bind positionally, so
    /// Chinese word order may legally reorder them, and only positional
    /// specifiers say which argument landed where. Swapped slots in exactly
    /// this shape shipped once (#1331); this pins the positional form so the
    /// slot comparison above has something explicit to compare.
    @Test("keys with two or more arguments use positional specifiers in every locale")
    func multiArgumentKeysArePositional() throws {
        for localization in L10n.supportedLocalizations {
            for (key, value) in try Self.table(localization) {
                let args = Self.arguments(in: value)
                guard args.count >= 2 else { continue }
                let bare = args.filter { !$0.contains("$") }
                #expect(
                    bare.isEmpty,
                    "\(key.debugDescription) in \(localization) has \(args.count) arguments but \(bare.debugDescription) are bare: use %1$…, %2$… so each slot is explicit and checkable"
                )
            }
        }
    }

    @Test("literal percent signs survive translation")
    func literalPercentParity() throws {
        let en = try Self.table("en")

        for localization in Self.translatedLocalizations {
            let other = try Self.table(localization)
            for key in en.keys.sorted() {
                guard let english = en[key], let translated = other[key] else { continue }
                // Unlike the argument specifiers above, `%%` may move: word order
                // can put the time before the verb in "%@ · %@ 达到 100%%".
                let expected = Self.literalPercentCount(in: english)
                let actual = Self.literalPercentCount(in: translated)
                #expect(
                    expected == actual,
                    "\(key.debugDescription) has \(expected) literal percent sign(s) in en but \(actual) in \(localization)"
                )
            }
        }
    }

    @Test("a key is never only specifiers, which would leave nothing to translate")
    func keysCarryContext() throws {
        for key in try Self.table("en").keys {
            let stripped = Self.specifiers(in: key)
                .reduce(key) { $0.replacingOccurrences(of: $1, with: "") }
                .trimmingCharacters(in: .whitespacesAndNewlines)
            #expect(
                !stripped.isEmpty,
                "\(key.debugDescription) is only specifiers and spaces; a translator has no sentence to work with"
            )
        }
    }

    // MARK: - Representative presentation strings

    @Test("session-count copy resolves in both locales")
    func sessionCountResolves() throws {
        let english = try Self.localized("%lld sessions", "en", 3)
        let chinese = try Self.localized("%lld sessions", "zh-Hans", 3)
        #expect(english == "3 sessions")
        #expect(chinese == "3 个会话")

        let lowerBound = try Self.localized("At least %lld sessions", "zh-Hans", 12)
        #expect(lowerBound == "至少 12 个会话")

        // The test process runs under en, so the presentation struct itself must
        // agree with the en table. That is the link proving the struct reads the
        // catalog rather than a stale hardcoded string.
        #expect(SessionCountLabel.text(sessions: 3, basis: "identity") == english)
        let unavailable = try Self.localized("Session count unavailable", "en")
        #expect(SessionCountLabel.combinedText == unavailable)
    }

    @Test("provider reconnect copy resolves in both locales, keeping the product name")
    func reconnectCopyResolves() throws {
        let presentation = ProviderReconnectPresentation(provider: .claude)
        let englishTitle = try Self.localized("Reconnect %@", "en", "Claude")
        #expect(presentation.title == englishTitle)

        let chineseTitle = try Self.localized("Reconnect %@", "zh-Hans", "Claude")
        #expect(chineseTitle == "重新连接 Claude")
        // Product names are never translated, and the substitution must carry through.
        #expect(chineseTitle.contains("Claude"))

        let chineseInstruction = try Self.localized(
            "Open Claude Code in your terminal and type `/login`, then click Reconnect.",
            "zh-Hans"
        )
        #expect(chineseInstruction.contains("Claude Code"))
        #expect(chineseInstruction.contains("/login"))
    }

    @Test("percent-bearing quota copy formats correctly in both locales")
    func quotaCopyResolves() throws {
        let englishOverLimit = try Self.localized("%1$@ over limit (%2$lld%%)", "en", "Claude", 105)
        #expect(englishOverLimit == "Claude over limit (105%)")

        let chineseOverLimit = try Self.localized("%1$@ over limit (%2$lld%%)", "zh-Hans", "Claude", 105)
        #expect(chineseOverLimit == "Claude 已超限（105%）")

        let countdown = try Self.localized("%1$lldh %2$lldm", "zh-Hans", 2, 11)
        #expect(countdown == "2 小时 11 分")

        // The quota warning banner's reset clause wraps that same countdown.
        let englishReset = try Self.localized("resets in %@", "en", "3h 12m")
        #expect(englishReset == "resets in 3h 12m")
        let chineseReset = try Self.localized("resets in %@", "zh-Hans", "3 小时 12 分")
        #expect(chineseReset == "3 小时 12 分后重置")

        let cacheHit = try Self.localized("%@%% cache hit", "zh-Hans", "87")
        #expect(cacheHit == "缓存命中 87%")
    }
}
