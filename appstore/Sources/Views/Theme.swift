import SwiftUI

enum Theme {
    static let brandEmber        = Color(red: 0xC9/255.0, green: 0x52/255.0, blue: 0x1D/255.0)
    static let brandAccent       = Color(red: 0xC9/255.0, green: 0x52/255.0, blue: 0x1D/255.0)
    static let brandAccentLight  = Color(red: 0xE8/255.0, green: 0x77/255.0, blue: 0x4A/255.0)
    static let brandAccentDeep   = Color(red: 0x8B/255.0, green: 0x3E/255.0, blue: 0x13/255.0)
    static let brandAccentGlow   = Color(red: 0xF0/255.0, green: 0xA0/255.0, blue: 0x70/255.0)

    static func providerColor(_ name: String) -> Color {
        switch name.lowercased() {
        case "claude":              Color(red: 0xC9/255.0, green: 0x52/255.0, blue: 0x1D/255.0)
        case "codex":               Color(red: 0x4A/255.0, green: 0x7D/255.0, blue: 0x5C/255.0)
        case "copilot":             Color(red: 0x6D/255.0, green: 0x8F/255.0, blue: 0xA6/255.0)
        case "cursor":              Color(red: 0x3F/255.0, green: 0x6B/255.0, blue: 0x8C/255.0)
        case "gemini":              Color(red: 0x44/255.0, green: 0x85/255.0, blue: 0xF4/255.0)
        case "cline":               Color(red: 0x23/255.0, green: 0x8A/255.0, blue: 0x7E/255.0)
        case "roo-code", "roo_code": Color(red: 0x4C/255.0, green: 0xAF/255.0, blue: 0x50/255.0)
        case "kilo-code":           Color(red: 0x00/255.0, green: 0x96/255.0, blue: 0x88/255.0)
        default: .secondary
        }
    }
}

extension Font {
    static func codeMono(size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }
}

extension Double {
    func asCurrency() -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        return formatter.string(from: NSNumber(value: self)) ?? "$0.00"
    }

    func asCompactCurrency() -> String {
        if self >= 1000 { return String(format: "$%.0fK", self / 1000) }
        if self >= 100 { return String(format: "$%.0f", self) }
        if self >= 10 { return String(format: "$%.1f", self) }
        return String(format: "$%.2f", self)
    }
}

extension Int {
    func asThousandsSeparated() -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        return formatter.string(from: NSNumber(value: self)) ?? "\(self)"
    }
}
