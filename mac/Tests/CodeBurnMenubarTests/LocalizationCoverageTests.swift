import Foundation
import Testing
@testable import CodeBurnMenubar

/// Fails when a user-facing string in `mac/Sources` never reaches the
/// `Localizable.strings` catalog (#1219).
///
/// `LocalizationCatalogTests` compares the two tables with each other, which
/// passes perfectly while a literal sits in a view and is never a key at all:
/// both locales agree, and a zh-Hans build shows English. #1252 and #1243 both
/// shipped that way — neither diff contained a single `L(` call — so these
/// tests read the source and the call sites instead of the tables.
///
/// The two halves close the same hole from opposite ends: a literal that never
/// becomes a key, and a key that never becomes an entry.
@Suite("Localization coverage")
struct LocalizationCoverageTests {

    /// `mac/Sources/CodeBurnMenubar`, relative to this file. `Bundle.module`
    /// carries the built resources, not the sources, so the path is derived
    /// from `#filePath` — which SwiftPM makes an absolute path to this file.
    static var sourcesDirectory: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // CodeBurnMenubarTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // mac
            .appendingPathComponent("Sources")
            .appendingPathComponent("CodeBurnMenubar")
    }

    // MARK: - The guard

    @Test("the scanner can actually see the sources it is meant to guard")
    func sourcesAreReachable() throws {
        let files = try LocalizationSourceScanner.swiftFiles(in: Self.sourcesDirectory)
        #expect(
            files.count > 50,
            "found \(files.count) Swift files under \(Self.sourcesDirectory.path); if the tree moved, this suite silently guards nothing"
        )
    }

    @Test("every user-facing literal in mac/Sources is routed through L(…)")
    func everyUserFacingLiteralIsRouted() throws {
        let findings = try LocalizationSourceScanner.unroutedLiterals(in: Self.sourcesDirectory)
        #expect(
            findings.isEmpty,
            """
            \(findings.count) user-facing string(s) bypass the catalog, so a zh-Hans \
            build renders them in English:

            \(findings.map(\.description).joined(separator: "\n"))

            Fix by wrapping the literal in L("…") and adding the key to both \
            Resources/en.lproj and Resources/zh-Hans.lproj. If the string is \
            genuinely the same in every locale (a product name, a unit, a \
            currency code), add its word to \
            LocalizationSourceScanner.untranslatableWords with a reason.
            """
        )
    }

    @Test("every display-label property in mac/Sources is routed through L(…)")
    func everyDisplayLabelIsRouted() throws {
        let findings = try LocalizationSourceScanner.unroutedLabelProperties(in: Self.sourcesDirectory)
        #expect(
            findings.isEmpty,
            """
            \(findings.count) picker/label option(s) bypass the catalog:

            \(findings.map(\.description).joined(separator: "\n"))

            A new enum case whose display name is a bare literal is how an \
            untranslated Settings picker option arrives. Wrap it in L("…"), or — \
            if the property returns provider, model or plan names — add it to \
            LocalizationSourceScanner.untranslatedLabelProperties with a reason.
            """
        )
    }

    @Test("every key a view asks for exists in both catalogs")
    func everyRequestedKeyIsTranslated() throws {
        let requested = try LocalizationSourceScanner.requestedKeys(in: Self.sourcesDirectory)
        #expect(!requested.isEmpty, "no L(…) call sites found at all — the scanner is broken, not the code")

        for localization in L10n.supportedLocalizations {
            let table = try LocalizationCatalogTests.table(localization)
            let missing = requested.subtracting(table.keys).sorted()
            #expect(
                missing.isEmpty,
                "\(localization) has no entry for \(missing.count) key(s) a view asks for, which render as raw English: \(missing.prefix(10))"
            )
        }
    }

    @Test("no catalog entry is dead weight")
    func noOrphanedKeys() throws {
        let requested = try LocalizationSourceScanner.requestedKeys(in: Self.sourcesDirectory)
        let orphaned = try LocalizationCatalogTests.table("en").keys
            .filter { !requested.contains($0) }
            .sorted()
        #expect(
            orphaned.isEmpty,
            "\(orphaned.count) key(s) have no L(…) call site, so a translator is spending effort on copy nobody can see: \(orphaned.prefix(10))"
        )
    }

    // MARK: - The scanner's own rules
    //
    // The guard above is only as good as these: a scanner that quietly stops
    // recognising a call site, or starts treating every literal as exempt,
    // passes the repository forever while guarding nothing.

    @Test("a bare literal at a user-facing call site is reported")
    func flagsBareLiterals() {
        let source = """
        struct V: View {
            var body: some View {
                Text("Second row")
                Toggle("Notify me", isOn: $flag)
                Button("Reconnect") { }
            }
        }
        """
        let findings = LocalizationSourceScanner.unroutedLiterals(inSource: source, fileName: "V.swift")
        #expect(findings.map(\.literal) == ["Second row", "Notify me", "Reconnect"])
    }

    @Test("the same strings routed through L(…) are not reported")
    func acceptsRoutedLiterals() {
        let source = """
        struct V: View {
            var body: some View {
                Text(L("Second row"))
                Toggle(L("Notify me"), isOn: $flag)
                Button(L("Reconnect")) { }
            }
        }
        """
        #expect(LocalizationSourceScanner.unroutedLiterals(inSource: source, fileName: "V.swift").isEmpty)
    }

    @Test("an argument on the next line is still seen")
    func findsLiteralsAcrossLineBreaks() {
        let source = """
        Text(
            "Update Available"
        )
        """
        #expect(
            LocalizationSourceScanner.unroutedLiterals(inSource: source, fileName: "V.swift")
                .map(\.literal) == ["Update Available"]
        )
    }

    @Test("accessibility copy counts as user-facing")
    func flagsAccessibilityCopy() {
        let source = """
        view.accessibilityLabel("Capacity Dock")
            .accessibilityHint("Click to keep it expanded")
            .accessibilityAction(named: "Show weekly usage", switchWindow)
        """
        #expect(LocalizationSourceScanner.unroutedLiterals(inSource: source, fileName: "V.swift").count == 3)
    }

    @Test("one string is reported once, not once per overlapping call site")
    func doesNotDoubleReport() {
        // `Label(` is a substring of `.accessibilityLabel(` and `Button(` of
        // `addButton(withTitle:`; both used to match twice and report the same
        // literal as two separate violations.
        let source = """
        view.accessibilityLabel("Capacity Dock")
        alert.addButton(withTitle: "Try Again")
        """
        #expect(
            LocalizationSourceScanner.unroutedLiterals(inSource: source, fileName: "V.swift")
                .map(\.literal) == ["Capacity Dock", "Try Again"]
        )
    }

    @Test("AppKit menu items, alerts and window titles count too")
    func flagsAppKitSurfaces() {
        let source = """
        let item = NSMenuItem(title: "Refresh Now", action: nil, keyEquivalent: "")
        alert.messageText = "Up to Date"
        alert.addButton(withTitle: "OK")
        window.title = "CodeBurn Settings"
        """
        // "CodeBurn Settings" still carries the translatable word "Settings".
        #expect(
            LocalizationSourceScanner.unroutedLiterals(inSource: source, fileName: "V.swift")
                .map(\.literal) == ["Refresh Now", "Up to Date", "OK", "CodeBurn Settings"]
        )
    }

    @Test("figures, symbols and empty placeholders are not translation failures")
    func ignoresNonWords() {
        let source = """
        Text("\\(model.calls)")
        Text("$25")
        Text("1M")
        Text("—")
        Text("\\(Int(scale * 100))%")
        TextField("", text: $rate)
        Text("\\(title) \\(provider.displayName)")
        """
        #expect(LocalizationSourceScanner.unroutedLiterals(inSource: source, fileName: "V.swift").isEmpty)
    }

    @Test("the product name, units and currency codes are exempt, and only those")
    func honoursTheUntranslatableVocabulary() {
        let exempt = """
        Text("CodeBurn")
        Text("USD")
        Text("\\(compact(tokens)) tok")
        """
        #expect(LocalizationSourceScanner.unroutedLiterals(inSource: exempt, fileName: "V.swift").isEmpty)

        // A sentence that merely contains one of those words is still copy.
        let copy = """
        Text("CodeBurn could not check for updates.")
        """
        #expect(LocalizationSourceScanner.unroutedLiterals(inSource: copy, fileName: "V.swift").count == 1)
    }

    @Test("a comment that mentions a call site is not a call site")
    func ignoresComments() {
        // Localization.swift's own documentation says `Text("literal")`.
        let source = """
        /// The implicit path that SwiftUI uses for `Text("literal")` always misses.
        // Text("also not real")
        /* Text("nor this") */
        let real = Text("Refresh Now")
        """
        #expect(
            LocalizationSourceScanner.unroutedLiterals(inSource: source, fileName: "V.swift")
                .map(\.literal) == ["Refresh Now"]
        )
    }

    @Test("a URL inside a literal does not read as a comment")
    func survivesURLsInLiterals() {
        let source = """
        let endpoint = "https://api.github.com/copilot_internal/user"
        Text("Reconnect required")
        """
        #expect(
            LocalizationSourceScanner.unroutedLiterals(inSource: source, fileName: "V.swift")
                .map(\.literal) == ["Reconnect required"]
        )
    }

    @Test("a bare enum display label is reported, a routed one is not")
    func flagsBareDisplayLabels() {
        let bare = """
        enum Metric {
            var settingsLabel: String {
                switch self {
                case .quotaRemaining: "Quota remaining"
                case .todayCost: "Today's cost"
                }
            }
        }
        """
        #expect(
            LocalizationSourceScanner.unroutedLabelProperties(inSource: bare, fileName: "M.swift")
                .map(\.literal) == ["Quota remaining", "Today's cost"]
        )

        let routed = """
        enum Metric {
            var settingsLabel: String {
                switch self {
                case .quotaRemaining: L("Quota remaining")
                case .todayCost: L("Today's cost")
                }
            }
        }
        """
        #expect(
            LocalizationSourceScanner.unroutedLabelProperties(inSource: routed, fileName: "M.swift").isEmpty
        )
    }

    @Test("a literal passed to machinery inside a label property is not copy")
    func ignoresArgumentLiteralsInLabelProperties() {
        // CodexUsage's credit label builds a formatter before it builds a
        // sentence; the locale id and the separators are not translatable copy.
        let source = """
        struct CreditLimit {
            var displayLabel: String {
                formatter.locale = Locale(identifier: "en_US")
                let raw = plan.replacingOccurrences(of: "_", with: " ")
                return L("Monthly usage limit")
            }
        }
        """
        #expect(
            LocalizationSourceScanner.unroutedLabelProperties(inSource: source, fileName: "C.swift").isEmpty
        )
    }

    @Test("the label denylist is keyed to the declaring type, not the bare name")
    func labelDenylistIsQualified() {
        // Plan names are verbatim in every locale, so PlanType.displayName is exempt…
        let exempt = """
        enum PlanType {
            var displayName: String {
                switch self {
                case .pro: "Pro"
                case .team: "Team"
                }
            }
        }
        """
        #expect(
            LocalizationSourceScanner.unroutedLabelProperties(inSource: exempt, fileName: "P.swift").isEmpty
        )

        // …while the same property name on another type is still guarded.
        let guarded = """
        enum AccentPreset {
            var displayName: String {
                switch self {
                case .flame: "Flame orange"
                }
            }
        }
        """
        #expect(
            LocalizationSourceScanner.unroutedLabelProperties(inSource: guarded, fileName: "A.swift")
                .map(\.literal) == ["Flame orange"]
        )
    }

    @Test("L(…) keys are collected, and only from the localization function")
    func collectsRequestedKeys() {
        let source = """
        let a = L("Refresh Now")
        let b = L("%lld sessions", count)
        let c = URL(string: "https://example.com")
        let d = someL("not the catalog")
        let e = model.L("nor this")
        """
        #expect(
            LocalizationSourceScanner.requestedKeys(inSource: source) == ["Refresh Now", "%lld sessions"]
        )
    }

    @Test("an escaped key is collected as the text the catalog stores")
    func unescapesRequestedKeys() {
        // CodeBurnApp's update alert carries newlines in its key.
        let source = #"let a = L("%@ Run:\n\ncodeburn menubar --force")"#
        #expect(
            LocalizationSourceScanner.requestedKeys(inSource: source)
                == ["%@ Run:\n\ncodeburn menubar --force"]
        )
    }

    @Test("findings name the file and line so the failure is actionable")
    func reportsLocation() {
        let source = """
        struct V: View {
            var body: some View {
                Text("Second row")
            }
        }
        """
        let finding = LocalizationSourceScanner
            .unroutedLiterals(inSource: source, fileName: "SettingsView.swift")
            .first
        #expect(finding?.file == "SettingsView.swift")
        #expect(finding?.line == 3)
    }
}
