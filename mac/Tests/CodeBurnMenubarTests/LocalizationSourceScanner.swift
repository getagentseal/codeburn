import Foundation

/// Scans `mac/Sources` for user-facing string literals that never reach the
/// `Localizable.strings` catalog (#1219).
///
/// # Why this exists
///
/// `LocalizationCatalogTests` diffs the `en` and `zh-Hans` tables against each
/// other. That catches a key translated in one locale and not the other, but it
/// is blind to the failure that actually happens: a new feature ships a bare
/// `Text("Second row")`, the literal never becomes a key, both tables stay in
/// perfect agreement, and a zh-Hans build renders English. That is exactly how
/// #1252 and #1243 landed — neither PR's diff contained a single `L(` call.
///
/// So this scanner reads the source instead of the catalog: it finds the call
/// sites whose argument AppKit or SwiftUI puts on screen and fails when one of
/// them is handed a literal rather than `L(...)`.
///
/// # Kept out of the app target on purpose
///
/// Nothing here runs in the shipped binary — it reads `.swift` files off disk,
/// which only makes sense from the test bundle. It lives in its own file rather
/// than inside the test so the standalone `swiftc` harness (this host cannot run
/// `swift test`) can exercise the same code the suite does, instead of a
/// reimplementation that could drift from it.
enum LocalizationSourceScanner {

    // MARK: - What counts as user-facing

    /// A call site whose string argument is rendered to the user.
    ///
    /// Each entry is matched as a literal prefix immediately followed by the
    /// argument, so `Text(L("…"))` never matches and `Text("…")` always does.
    /// Adding a new SwiftUI or AppKit surface that displays a string means
    /// adding it here — the list is the definition of "user-facing", and a
    /// surface missing from it is a hole in the guard.
    static let userFacingCallSites: [String] = [
        // SwiftUI views whose first argument is the visible title.
        "Text(",
        "Button(",
        "Toggle(",
        "Picker(",
        "Menu(",
        "Section(",
        "Label(",
        "TextField(",
        "SecureField(",
        "Stepper(",
        "Link(",
        // SwiftUI accessibility, which VoiceOver reads aloud.
        ".accessibilityLabel(",
        ".accessibilityValue(",
        ".accessibilityHint(",
        ".accessibilityAction(named:",
        // Tooltips and window/navigation chrome.
        ".help(",
        ".navigationTitle(",
        // AppKit: the status-item menu, alerts, and window titles.
        "NSMenuItem(title:",
        ".messageText =",
        ".informativeText =",
        "addButton(withTitle:",
        ".title =",
        ".toolTip =",
        // Notification copy, which the notifier hands straight to
        // UNMutableNotificationContent.
        "post(title:",
        // This app's own section-header helper.
        "sectionCaption(",
    ]

    /// Words that are the same in every locale, so a literal made only of them
    /// is not a translation failure.
    ///
    /// Deliberately tiny, and deliberately a vocabulary rather than a list of
    /// exempt call sites: an exemption keyed to a file and line goes stale the
    /// moment the file is edited, and quietly stops guarding anything. These are
    /// the three that actually occur:
    ///
    /// - `CodeBurn` — the product name.
    /// - `tok` — the token unit, kept verbatim next to a formatted figure.
    /// - `USD` — a currency code.
    ///
    /// Provider, model and plan names never appear here because they are never
    /// literals in a view: they arrive as values and are substituted into a
    /// `%@`, which is the routed form this scanner is asking for.
    static let untranslatableWords: Set<String> = ["codeburn", "tok", "usd"]

    // MARK: - Findings

    struct Finding: Equatable, CustomStringConvertible {
        let file: String
        let line: Int
        let callSite: String
        let literal: String

        var description: String {
            "\(file):\(line): \(callSite)\"\(literal)\" is shown to the user but never reaches the catalog — wrap it in L(\"…\")"
        }
    }

    // MARK: - Scanning

    /// Every user-facing literal in `directory` that is not routed through `L(…)`.
    static func unroutedLiterals(in directory: URL) throws -> [Finding] {
        var findings: [Finding] = []
        for file in try swiftFiles(in: directory) {
            let source = try String(contentsOf: file, encoding: .utf8)
            findings += unroutedLiterals(
                inSource: source,
                fileName: file.lastPathComponent
            )
        }
        return findings.sorted {
            ($0.file, $0.line, $0.literal) < ($1.file, $1.line, $1.literal)
        }
    }

    static func swiftFiles(in directory: URL) throws -> [URL] {
        guard let walker = FileManager.default.enumerator(
            at: directory,
            includingPropertiesForKeys: nil
        ) else { return [] }
        return walker
            .compactMap { $0 as? URL }
            .filter { $0.pathExtension == "swift" }
            .sorted { $0.path < $1.path }
    }

    /// The scan for one file's text. Split out so the rules are testable
    /// against a source snippet rather than the repository.
    static func unroutedLiterals(inSource source: String, fileName: String) -> [Finding] {
        let code = Array(strippingComments(source))
        var findings: [Finding] = []
        let bindings = literalBindings(in: code)

        for callSite in userFacingCallSites {
            let needle = Array(callSite)
            var index = 0
            while index + needle.count <= code.count {
                guard Array(code[index..<(index + needle.count)]) == needle,
                      startsAWord(needle, at: index, in: code) else {
                    index += 1
                    continue
                }
                var cursor = index + needle.count
                // The argument may be on the next line; whitespace is not a
                // reason to stop looking for it.
                while cursor < code.count, code[cursor].isWhitespace { cursor += 1 }
                if cursor < code.count, code[cursor] == "\"",
                   let literal = stringLiteral(in: code, startingAt: cursor),
                   needsTranslation(literal.value) {
                    findings.append(
                        Finding(
                            file: fileName,
                            line: lineNumber(of: index, in: code),
                            callSite: callSite,
                            literal: literal.value
                        )
                    )
                } else if cursor < code.count, code[cursor] != "\"" {
                    // The argument is an expression, not a bare literal: a
                    // ternary (`Text(flag ? "A" : "B")`), a concatenation
                    // (`.help(prefix + " suffix")`), or a variable holding a
                    // literal bound earlier in the file (#1331). Those all put
                    // copy on screen while looking like machinery to the
                    // first-character check above.
                    findings += unroutedExpressionLiterals(
                        after: cursor,
                        at: index,
                        callSite: callSite,
                        in: code,
                        bindings: bindings,
                        fileName: fileName
                    )
                }
                index += needle.count
            }
        }
        // Call sites are scanned one kind at a time, so sort back into reading
        // order — a failure message that jumps around the file is hard to act on.
        return findings.sorted { ($0.line, $0.literal) < ($1.line, $1.literal) }
    }

    // MARK: - Expression arguments (#1331)

    /// A `let`/`var` whose right-hand side is a single string literal (or a
    /// single `L("…")`), collected per file so a call site handed a bare
    /// identifier can be traced back to the copy it carries.
    struct LiteralBinding {
        let name: String
        let literal: String
        /// True when the bound literal already sits inside `L(…)`.
        let routed: Bool
    }

    /// The first `let`/`var name =` binding per identifier in the file. Swift
    /// allows shadowing, so this is an approximation — but the shape the issue
    /// names (one literal, one use in a `.help`) is exactly the file-local one,
    /// and a cross-file constant is out of reach for a source scan anyway.
    static func literalBindings(in code: [Character]) -> [String: LiteralBinding] {
        var bindings: [String: LiteralBinding] = [:]
        for keyword in ["let ", "var "] {
            let needle = Array(keyword)
            var index = 0
            while index + needle.count <= code.count {
                guard Array(code[index..<(index + needle.count)]) == needle,
                      startsAWord(needle, at: index, in: code) else {
                    index += 1
                    continue
                }
                var cursor = index + needle.count
                while cursor < code.count, code[cursor].isWhitespace { cursor += 1 }
                var name = ""
                while cursor < code.count, code[cursor].isLetter || code[cursor].isNumber || code[cursor] == "_" {
                    name.append(code[cursor])
                    cursor += 1
                }
                while cursor < code.count, code[cursor].isWhitespace { cursor += 1 }
                guard !name.isEmpty, cursor < code.count, code[cursor] == "=" else {
                    index += needle.count
                    continue
                }
                cursor += 1
                while cursor < code.count, code[cursor].isWhitespace { cursor += 1 }
                if cursor + 1 < code.count, code[cursor] == "L", code[cursor + 1] == "(" {
                    cursor += 2
                    while cursor < code.count, code[cursor].isWhitespace { cursor += 1 }
                    if cursor < code.count, code[cursor] == "\"",
                       let literal = stringLiteral(in: code, startingAt: cursor) {
                        if bindings[name] == nil {
                            bindings[name] = LiteralBinding(name: name, literal: unescaped(literal.value), routed: true)
                        }
                    }
                } else if cursor < code.count, code[cursor] == "\"",
                          let literal = stringLiteral(in: code, startingAt: cursor) {
                    if bindings[name] == nil {
                        bindings[name] = LiteralBinding(name: name, literal: unescaped(literal.value), routed: false)
                    }
                }
                index += needle.count
            }
        }
        return bindings
    }

    /// The extent of one call argument: from just after the open parenthesis to
    /// the enclosing close (or a top-level comma, since only the first
    /// argument of each call site is copy). Bracket-balanced so closures and
    /// nested calls inside the argument do not end it early.
    static func argumentSpan(in code: [Character], from start: Int) -> Range<Int> {
        var depth = 0
        var index = start
        while index < code.count {
            switch code[index] {
            case "(", "[", "{":
                depth += 1
            case ")", "]", "}":
                depth -= 1
                if depth < 0 { return start..<index }
            case "," where depth == 0:
                return start..<index
            default:
                break
            }
            index += 1
        }
        return start..<code.count
    }

    /// Copy hidden inside a non-literal argument: ternary branches,
    /// concatenation operands, and identifiers bound to a literal earlier in
    /// the file. `Text(verbatim:)` is exempt — it is SwiftUI's explicit
    /// do-not-localize API, and flagging it would leave no way to opt out.
    static func unroutedExpressionLiterals(
        after start: Int,
        at callSiteIndex: Int,
        callSite: String,
        in code: [Character],
        bindings: [String: LiteralBinding],
        fileName: String
    ) -> [Finding] {
        var cursor = start
        let span = argumentSpan(in: code, from: start)

        // An argument label (`verbatim:`, `title:`) precedes the value; step
        // past it. `verbatim` opts out of localization entirely.
        if code[cursor].isLetter {
            var label = ""
            while cursor < code.count, code[cursor].isLetter || code[cursor].isNumber || code[cursor] == "_" {
                label.append(code[cursor])
                cursor += 1
            }
            var afterLabel = cursor
            while afterLabel < code.count, code[afterLabel].isWhitespace { afterLabel += 1 }
            if afterLabel < code.count, code[afterLabel] == ":" {
                if label == "verbatim" { return [] }
                cursor = afterLabel + 1
                while cursor < code.count, code[cursor].isWhitespace { cursor += 1 }
            } else {
                cursor = start
            }
        }

        // A bare identifier as the whole argument: the `.help(title)` shape.
        if cursor < code.count, code[cursor].isLetter || code[cursor] == "_" {
            var name = ""
            var end = cursor
            while end < code.count, code[end].isLetter || code[end].isNumber || code[end] == "_" {
                name.append(code[end])
                end += 1
            }
            var after = end
            while after < code.count, code[after].isWhitespace { after += 1 }
            let terminator = after < code.count ? code[after] : "\0"
            if name.count > 1, terminator == "," || terminator == ")" || terminator == "}" || terminator == "\0",
               let binding = bindings[name], !binding.routed, needsTranslation(binding.literal) {
                return [
                    Finding(
                        file: fileName,
                        line: lineNumber(of: callSiteIndex, in: code),
                        callSite: callSite,
                        literal: binding.literal
                    )
                ]
            }
        }

        // Any literal at the argument's own depth that is not already routed
        // (`L(…)`) or another user-facing call's own argument (that call's scan
        // reports it; reporting it here too would double-count).
        var findings: [Finding] = []
        var depth = 0
        var index = span.lowerBound
        while index < span.upperBound {
            switch code[index] {
            case "(", "[", "{":
                depth += 1
            case ")", "]", "}":
                depth -= 1
            case "\"":
                if let literal = stringLiteral(in: code, startingAt: index) {
                    if depth == 0, needsTranslation(literal.value),
                       !precededByRoutingOrCallSite(literalStart: index, in: code) {
                        findings.append(
                            Finding(
                                file: fileName,
                                line: lineNumber(of: index, in: code),
                                callSite: callSite,
                                literal: literal.value
                            )
                        )
                    }
                    index = literal.end
                    continue
                }
            default:
                break
            }
            index += 1
        }
        return findings
    }

    /// Whether the significant text immediately before `literalStart` is `L(`
    /// (routed) or one of the user-facing call sites (that occurrence is its
    /// argument and is reported — or exempted — by that site's own scan).
    static func precededByRoutingOrCallSite(literalStart: Int, in code: [Character]) -> Bool {
        var back = literalStart
        while back > 0, code[back - 1].isWhitespace { back -= 1 }
        for needle in userFacingCallSites + ["L("] {
            let n = Array(needle)
            let start = back - n.count
            guard start >= 0, Array(code[start..<back]) == n else { continue }
            // `L(` must be the localization function, not `someL(`/`a.L(`.
            if needle == "L(", start > 0 {
                let before = code[start - 1]
                if before.isLetter || before.isNumber || before == "_" || before == "." { continue }
            }
            return true
        }
        return false
    }

    // MARK: - Display-label properties

    /// Computed `String` properties this codebase uses to give an enum its
    /// on-screen name — the Settings pickers render exactly these.
    ///
    /// They are not call sites, so the call-site scan above cannot see them:
    /// `case .quotaRemaining: "Quota remaining"` is just a string returned from
    /// a switch. Yet a new `MenubarSecondRowMetric` case is precisely how the
    /// next untranslated picker option would arrive, so the property bodies get
    /// their own pass.
    static let displayLabelProperties: [String] = [
        "displayName",
        "displayLabel",
        "settingsLabel",
    ]

    /// Properties that legitimately return untranslated text, with the reason.
    ///
    /// This is the documented denylist. It names the declaring type as well as
    /// the property so that adding a `displayName` elsewhere is still guarded.
    ///
    /// - `CapacityDockGlanceWindowKind.displayName` — a stand-in for a provider's
    ///   own window label ("Weekly", "5-hour"), used only when the provider
    ///   publishes none. Those labels are provider data and are never
    ///   translated, so translating the fallback alone would make the same
    ///   VoiceOver sentence half-Chinese depending on which provider is
    ///   selected.
    /// - `CapacityDockProvider.displayName` and `CodexUsage.*.displayName` —
    ///   provider, model and plan names, which the catalog header lists as
    ///   verbatim in every locale.
    /// - `LanguagePreference.displayLabel` — each language names itself
    ///   ("English", "简体中文"). Translating an endonym defeats the picker:
    ///   someone opens it because the UI is in a language they cannot read.
    ///   Its `.system` case is routed through `L(…)` even so.
    static let untranslatedLabelProperties: Set<String> = [
        "CapacityDockGlanceWindowKind.displayName",
        "CapacityDockProvider.displayName",
        "CapacityDockProviderCatalogEntry.displayName",
        "LanguagePreference.displayLabel",
        "PlanType.displayName",
        "Tier.displayName",
    ]

    /// Bare literals returned from a display-label property.
    static func unroutedLabelProperties(in directory: URL) throws -> [Finding] {
        var findings: [Finding] = []
        for file in try swiftFiles(in: directory) {
            let source = try String(contentsOf: file, encoding: .utf8)
            findings += unroutedLabelProperties(
                inSource: source,
                fileName: file.lastPathComponent
            )
        }
        return findings.sorted {
            ($0.file, $0.line, $0.literal) < ($1.file, $1.line, $1.literal)
        }
    }

    static func unroutedLabelProperties(inSource source: String, fileName: String) -> [Finding] {
        let code = Array(strippingComments(source))
        var findings: [Finding] = []

        for property in displayLabelProperties {
            let needle = Array("var \(property): String")
            var index = 0
            while index + needle.count <= code.count {
                guard Array(code[index..<(index + needle.count)]) == needle else {
                    index += 1
                    continue
                }
                let owner = enclosingTypeName(before: index, in: code)
                let qualified = "\(owner).\(property)"
                index += needle.count
                guard !untranslatedLabelProperties.contains(qualified) else { continue }
                guard let body = propertyBody(in: code, after: index) else { continue }
                for literal in valuePositionLiterals(in: Array(code[body])) where needsTranslation(literal.value) {
                    findings.append(
                        Finding(
                            file: fileName,
                            line: lineNumber(of: body.lowerBound + literal.offset, in: code),
                            callSite: "\(qualified): ",
                            literal: literal.value
                        )
                    )
                }
            }
        }
        return findings.sorted { ($0.line, $0.literal) < ($1.line, $1.literal) }
    }

    /// The brace-balanced body that follows a property declaration.
    static func propertyBody(in code: [Character], after index: Int) -> Range<Int>? {
        var i = index
        while i < code.count, code[i] != "{" {
            // A declaration and its body are separated by whitespace only; a
            // computed property written with `=` is a stored one, not ours.
            if !code[i].isWhitespace { return nil }
            i += 1
        }
        guard i < code.count else { return nil }
        let start = i + 1
        var depth = 0
        while i < code.count {
            if code[i] == "{" { depth += 1 }
            if code[i] == "}" {
                depth -= 1
                if depth == 0 { return start..<i }
            }
            i += 1
        }
        return nil
    }

    /// String literals in *value* position within a property body — what the
    /// property evaluates to, rather than what it passes to something else.
    ///
    /// Value position is simply bracket depth zero. That is what separates
    /// `case .pro: "Pro"` (the property's result, which a picker renders) from
    /// `Locale(identifier: "en_US")` and `replacingOccurrences(of: "_", …)`
    /// (arguments to machinery, which are not copy). It also means a literal
    /// already wrapped in `L(…)` sits at depth one and is skipped, which is
    /// exactly the routed form this scan is asking for.
    static func valuePositionLiterals(in code: [Character]) -> [(value: String, offset: Int)] {
        var found: [(value: String, offset: Int)] = []
        var depth = 0
        var i = 0
        while i < code.count {
            switch code[i] {
            case "(", "[":
                depth += 1
            case ")", "]":
                depth -= 1
            case "\"":
                guard let literal = stringLiteral(in: code, startingAt: i) else { break }
                if depth == 0 { found.append((value: literal.value, offset: i)) }
                i = literal.end
                continue
            default:
                break
            }
            i += 1
        }
        return found
    }

    /// The nearest `enum`/`struct`/`class`/`extension` name declared above
    /// `index`, so a denylist entry can name the type it exempts.
    static func enclosingTypeName(before index: Int, in code: [Character]) -> String {
        let keywords = ["enum ", "struct ", "final class ", "class ", "extension "].map(Array.init)
        var best = "?"
        var i = 0
        // One pass in source order, so the *nearest* preceding declaration wins.
        // Scanning keyword-by-keyword instead would make the answer depend on
        // the order of the keyword list: `enum PlanType` nested inside
        // `struct CodexUsage` would report the outer type and quietly miss its
        // denylist entry.
        while i < min(index, code.count) {
            for needle in keywords where i + needle.count <= code.count {
                guard Array(code[i..<(i + needle.count)]) == needle,
                      startsAWord(needle, at: i, in: code) else { continue }
                var j = i + needle.count
                var name = ""
                while j < code.count, code[j].isLetter || code[j].isNumber || code[j] == "_" {
                    name.append(code[j])
                    j += 1
                }
                if !name.isEmpty { best = name }
            }
            i += 1
        }
        return best
    }

    // MARK: - Keys the code asks for

    /// Every key passed to `L(…)` anywhere under `directory`.
    ///
    /// The other direction of the same guard: `unroutedLiterals` catches copy
    /// that never became a key, this catches a key that never became an entry.
    /// Both ship English in a zh-Hans build, and neither is visible to the
    /// compiler or to a catalog-versus-catalog diff.
    static func requestedKeys(in directory: URL) throws -> Set<String> {
        var keys: Set<String> = []
        for file in try swiftFiles(in: directory) {
            let source = try String(contentsOf: file, encoding: .utf8)
            keys.formUnion(requestedKeys(inSource: source))
        }
        return keys
    }

    static func requestedKeys(inSource source: String) -> Set<String> {
        let chars = Array(strippingComments(source))
        var keys: Set<String> = []
        var i = 0
        while i < chars.count {
            defer { i += 1 }
            guard chars[i] == "L" else { continue }
            // `L` has to be the whole identifier: `URL(`, `someL(` and `a.L(`
            // are not the localization function.
            if i > 0 {
                let previous = chars[i - 1]
                if previous.isLetter || previous.isNumber || previous == "_" || previous == "." {
                    continue
                }
            }
            var cursor = i + 1
            guard cursor < chars.count, chars[cursor] == "(" else { continue }
            cursor += 1
            while cursor < chars.count, chars[cursor].isWhitespace { cursor += 1 }
            guard cursor < chars.count, chars[cursor] == "\"",
                  let literal = stringLiteral(in: chars, startingAt: cursor) else { continue }
            // The catalog stores the unescaped text, which is what NSBundle
            // matches against, so undo the escapes the source carries.
            keys.insert(unescaped(literal.value))
        }
        return keys
    }

    /// Turns a source-level literal body into the string it denotes. Only the
    /// escapes the catalog actually uses are handled; an interpolated key would
    /// not be a constant key at all, so it is left alone and will simply fail to
    /// match an entry.
    static func unescaped(_ literal: String) -> String {
        var out = ""
        let chars = Array(literal)
        var i = 0
        while i < chars.count {
            guard chars[i] == "\\", i + 1 < chars.count else {
                out.append(chars[i])
                i += 1
                continue
            }
            switch chars[i + 1] {
            case "n": out.append("\n")
            case "t": out.append("\t")
            case "r": out.append("\r")
            case "\"": out.append("\"")
            case "'": out.append("'")
            case "\\": out.append("\\")
            default:
                out.append(chars[i])
                out.append(chars[i + 1])
            }
            i += 2
        }
        return out
    }

    /// Whether a match is the start of the call it names rather than the tail of
    /// a longer identifier.
    ///
    /// Without this `Label(` matches inside `.accessibilityLabel(`, and
    /// `Button(` inside `addButton(withTitle:`, reporting one string twice. A
    /// type name (`Text`, `Label`, `NSMenuItem`) is also rejected after a dot,
    /// since that is a member access; a method (`addButton`, `sectionCaption`)
    /// is not, because a dot is exactly how it is normally called.
    static func startsAWord(_ needle: [Character], at index: Int, in code: [Character]) -> Bool {
        guard index > 0, let first = needle.first else { return true }
        // A needle written as a member (`.accessibilityLabel(`) carries its own
        // boundary: the dot can only follow the receiver.
        guard first.isLetter else { return true }
        let previous = code[index - 1]
        if previous.isLetter || previous.isNumber || previous == "_" { return false }
        if previous == ".", first.isUppercase { return false }
        return true
    }

    // MARK: - Rules

    /// Whether a literal carries words a translator would have to translate.
    ///
    /// Interpolated segments are dropped first: `"\(count) calls"` is asking
    /// about the word `calls`, not about `count`. What is left is then reduced
    /// to runs of two or more letters, so a figure, a currency symbol, a unit
    /// suffix like `1M`, an em dash or an empty placeholder is never reported.
    static func needsTranslation(_ literal: String) -> Bool {
        !translatableWords(in: literal).isEmpty
    }

    static func translatableWords(in literal: String) -> [String] {
        withoutInterpolations(literal)
            .split(whereSeparator: { !$0.isLetter })
            .map { $0.lowercased() }
            .filter { $0.count >= 2 && !untranslatableWords.contains($0) }
    }

    /// Removes `\(…)` segments, brace-counting so a nested call such as
    /// `\(f(x))` is dropped whole rather than leaving a stray `)`.
    static func withoutInterpolations(_ literal: String) -> String {
        var out = ""
        let chars = Array(literal)
        var i = 0
        while i < chars.count {
            if chars[i] == "\\", i + 1 < chars.count, chars[i + 1] == "(" {
                var depth = 0
                var j = i + 1
                while j < chars.count {
                    if chars[j] == "(" { depth += 1 }
                    if chars[j] == ")" {
                        depth -= 1
                        if depth == 0 { j += 1; break }
                    }
                    j += 1
                }
                i = j
                continue
            }
            out.append(chars[i])
            i += 1
        }
        return out
    }

    // MARK: - Lexing

    /// Replaces comment bodies with spaces, keeping newlines so reported line
    /// numbers still match the file. Without this a doc comment that *mentions*
    /// `Text("literal")` — Localization.swift has one — reads as a violation.
    static func strippingComments(_ source: String) -> String {
        var out = ""
        let chars = Array(source)
        var i = 0
        while i < chars.count {
            // A string literal can contain "//" (a URL), so strings win.
            if chars[i] == "\"" {
                if let literal = stringLiteral(in: chars, startingAt: i) {
                    out += String(chars[i..<literal.end])
                    i = literal.end
                    continue
                }
            }
            if chars[i] == "/", i + 1 < chars.count, chars[i + 1] == "/" {
                while i < chars.count, chars[i] != "\n" { out.append(" "); i += 1 }
                continue
            }
            if chars[i] == "/", i + 1 < chars.count, chars[i + 1] == "*" {
                // Block comments nest in Swift.
                var depth = 0
                while i < chars.count {
                    if chars[i] == "/", i + 1 < chars.count, chars[i + 1] == "*" {
                        depth += 1
                        out += "  "
                        i += 2
                        continue
                    }
                    if chars[i] == "*", i + 1 < chars.count, chars[i + 1] == "/" {
                        depth -= 1
                        out += "  "
                        i += 2
                        if depth == 0 { break }
                        continue
                    }
                    out.append(chars[i] == "\n" ? "\n" : " ")
                    i += 1
                }
                continue
            }
            out.append(chars[i])
            i += 1
        }
        return out
    }

    /// Reads the Swift string literal beginning at `start`, returning its
    /// contents and the index just past the closing quote. Handles `"""` blocks
    /// and backslash escapes; returns nil for an unterminated literal.
    static func stringLiteral(
        in chars: [Character],
        startingAt start: Int
    ) -> (value: String, end: Int)? {
        guard start < chars.count, chars[start] == "\"" else { return nil }

        let isMultiline = start + 2 < chars.count
            && chars[start + 1] == "\""
            && chars[start + 2] == "\""
        let delimiterLength = isMultiline ? 3 : 1

        var value = ""
        var i = start + delimiterLength
        while i < chars.count {
            if chars[i] == "\\" {
                // Keep the backslash: `\(` has to survive for the
                // interpolation stripper to recognise it.
                value.append(chars[i])
                if i + 1 < chars.count { value.append(chars[i + 1]) }
                i += 2
                continue
            }
            if chars[i] == "\"" {
                if isMultiline {
                    if i + 2 < chars.count, chars[i + 1] == "\"", chars[i + 2] == "\"" {
                        return (value, i + 3)
                    }
                } else {
                    return (value, i + 1)
                }
            }
            if !isMultiline, chars[i] == "\n" { return nil }
            value.append(chars[i])
            i += 1
        }
        return nil
    }

    static func lineNumber(of index: Int, in chars: [Character]) -> Int {
        var line = 1
        var i = 0
        while i < index, i < chars.count {
            if chars[i] == "\n" { line += 1 }
            i += 1
        }
        return line
    }
}
