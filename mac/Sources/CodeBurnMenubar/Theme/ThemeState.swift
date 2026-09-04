import SwiftUI
import Observation

enum AccentPreset: String, CaseIterable, Identifiable {
    case ember    = "Ember"
    case blue     = "Blue"
    case purple   = "Purple"
    case pink     = "Pink"
    case red      = "Red"
    case orange   = "Orange"
    case yellow   = "Yellow"
    case green    = "Green"
    case graphite = "Graphite"

    var id: String { rawValue }

    /// Localized label for display; rawValue stays the persisted identifier.
    var displayName: String { LR(rawValue) }

    /// Apple macOS dark-mode system accent colors (NSColor.system*).
    var base: Color {
        switch self {
        case .ember:    Color(red: 0xC9/255, green: 0x52/255, blue: 0x1D/255)
        case .blue:     Color(red: 0x0A/255, green: 0x84/255, blue: 0xFF/255)
        case .purple:   Color(red: 0xBF/255, green: 0x5A/255, blue: 0xF2/255)
        case .pink:     Color(red: 0xFF/255, green: 0x37/255, blue: 0x5F/255)
        case .red:      Color(red: 0xFF/255, green: 0x45/255, blue: 0x3A/255)
        case .orange:   Color(red: 0xFF/255, green: 0x9F/255, blue: 0x0A/255)
        case .yellow:   Color(red: 0xFF/255, green: 0xD6/255, blue: 0x0A/255)
        case .green:    Color(red: 0x30/255, green: 0xD1/255, blue: 0x58/255)
        case .graphite: Color(red: 0x98/255, green: 0x98/255, blue: 0x9D/255)
        }
    }

    var light: Color {
        switch self {
        case .ember:    Color(red: 0xE8/255, green: 0x77/255, blue: 0x4A/255)
        case .blue:     Color(red: 0x40/255, green: 0x9C/255, blue: 0xFF/255)
        case .purple:   Color(red: 0xDA/255, green: 0x8F/255, blue: 0xF7/255)
        case .pink:     Color(red: 0xFF/255, green: 0x6E/255, blue: 0x8C/255)
        case .red:      Color(red: 0xFF/255, green: 0x6E/255, blue: 0x63/255)
        case .orange:   Color(red: 0xFF/255, green: 0xBD/255, blue: 0x4A/255)
        case .yellow:   Color(red: 0xFF/255, green: 0xE0/255, blue: 0x4A/255)
        case .green:    Color(red: 0x5A/255, green: 0xE0/255, blue: 0x78/255)
        case .graphite: Color(red: 0xAE/255, green: 0xAE/255, blue: 0xB2/255)
        }
    }

    var deep: Color {
        switch self {
        case .ember:    Color(red: 0x8B/255, green: 0x3E/255, blue: 0x13/255)
        case .blue:     Color(red: 0x06/255, green: 0x52/255, blue: 0xB3/255)
        case .purple:   Color(red: 0x7C/255, green: 0x38/255, blue: 0xA8/255)
        case .pink:     Color(red: 0xB3/255, green: 0x26/255, blue: 0x42/255)
        case .red:      Color(red: 0xB3/255, green: 0x30/255, blue: 0x28/255)
        case .orange:   Color(red: 0xB3/255, green: 0x6F/255, blue: 0x06/255)
        case .yellow:   Color(red: 0xB3/255, green: 0x96/255, blue: 0x06/255)
        case .green:    Color(red: 0x20/255, green: 0x92/255, blue: 0x3D/255)
        case .graphite: Color(red: 0x5E/255, green: 0x5E/255, blue: 0x62/255)
        }
    }

    var glow: Color {
        switch self {
        case .ember:    Color(red: 0xF0/255, green: 0xA0/255, blue: 0x70/255)
        case .blue:     Color(red: 0x80/255, green: 0xC0/255, blue: 0xFF/255)
        case .purple:   Color(red: 0xE0/255, green: 0xB8/255, blue: 0xFA/255)
        case .pink:     Color(red: 0xFF/255, green: 0x99/255, blue: 0xB0/255)
        case .red:      Color(red: 0xFF/255, green: 0x99/255, blue: 0x90/255)
        case .orange:   Color(red: 0xFF/255, green: 0xD0/255, blue: 0x80/255)
        case .yellow:   Color(red: 0xFF/255, green: 0xEA/255, blue: 0x80/255)
        case .green:    Color(red: 0x80/255, green: 0xF0/255, blue: 0x98/255)
        case .graphite: Color(red: 0xC8/255, green: 0xC8/255, blue: 0xCC/255)
        }
    }
}

@MainActor
@Observable
final class ThemeState {
    static let shared = ThemeState()

    var preset: AccentPreset {
        didSet { UserDefaults.standard.set(preset.rawValue, forKey: "CodeBurnAccentPreset") }
    }

    private init() {
        let saved = UserDefaults.standard.string(forKey: "CodeBurnAccentPreset") ?? ""
        self.preset = AccentPreset(rawValue: saved) ?? .ember
    }
}
