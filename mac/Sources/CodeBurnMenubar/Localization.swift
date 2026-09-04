import Foundation

// Localization helpers.
//
// SwiftUI views that take a `LocalizedStringKey` literal (Text("…"), Button("…"),
// Toggle("…"), .help("…"), …) already resolve their English literal as a key in
// the main bundle's Localizable.strings, so they need no wrapping. These helpers
// cover the two other cases: plain Swift `String` values that reach the UI, and
// label text that arrives at runtime from the CLI payload.

/// Localizes a plain-String UI literal. The English text is the key; string
/// interpolation is preserved as format placeholders (`%@`, `%lld`, `%lf`).
///
///     L("Reconnect")
///     L("Resets in \(remaining)")   // key "Resets in %@"
@inline(__always)
func L(_ key: String.LocalizationValue) -> String {
    String(localized: key)
}

/// Localizes text that only exists at runtime, such as activity names
/// ("Coding", "Testing") or section labels the CLI puts in its JSON payload.
/// Looks the text up as a key and falls back to the text itself.
func LR(_ runtime: String) -> String {
    NSLocalizedString(runtime, comment: "")
}
