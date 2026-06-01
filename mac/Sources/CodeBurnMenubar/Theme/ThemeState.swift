import SwiftUI
import Observation

enum AccentPreset: String, CaseIterable, Identifiable {
    // Classic
    case ember    = "Ember"
    case blue     = "Blue"
    case purple   = "Purple"
    case pink     = "Pink"
    case red      = "Red"
    case orange   = "Orange"
    case yellow   = "Yellow"
    case green    = "Green"
    case graphite = "Graphite"
    // Catppuccin
    case catLatte      = "Latte"
    case catFrappe     = "Frappé"
    case catMacchiato  = "Macchiato"
    case catMocha      = "Mocha"

    var id: String { rawValue }

    /// Base accent color.
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
        // Catppuccin — using Mauve as base accent per flavor
        case .catLatte:     Color(red: 0x88/255, green: 0x39/255, blue: 0xEF/255) // Latte Mauve
        case .catFrappe:    Color(red: 0xCA/255, green: 0x9E/255, blue: 0xE6/255) // Frappé Mauve
        case .catMacchiato: Color(red: 0xC6/255, green: 0xA0/255, blue: 0xF6/255) // Macchiato Mauve
        case .catMocha:     Color(red: 0xCB/255, green: 0xA6/255, blue: 0xF7/255) // Mocha Mauve
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
        // Catppuccin — using Sky/Sapphire as light accent
        case .catLatte:     Color(red: 0x04/255, green: 0xA5/255, blue: 0xE5/255) // Latte Sky
        case .catFrappe:    Color(red: 0x99/255, green: 0xD1/255, blue: 0xDB/255) // Frappé Sky
        case .catMacchiato: Color(red: 0x91/255, green: 0xD7/255, blue: 0xE3/255) // Macchiato Sky
        case .catMocha:     Color(red: 0x89/255, green: 0xDC/255, blue: 0xEB/255) // Mocha Sky
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
        // Catppuccin — using Base surface as deep
        case .catLatte:     Color(red: 0xEF/255, green: 0xF1/255, blue: 0xF5/255) // Latte Base
        case .catFrappe:    Color(red: 0x30/255, green: 0x34/255, blue: 0x46/255) // Frappé Base
        case .catMacchiato: Color(red: 0x24/255, green: 0x27/255, blue: 0x3A/255) // Macchiato Base
        case .catMocha:     Color(red: 0x1E/255, green: 0x1E/255, blue: 0x2E/255) // Mocha Base
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
        // Catppuccin — using Peach as glow
        case .catLatte:     Color(red: 0xFE/255, green: 0x64/255, blue: 0x0B/255) // Latte Peach
        case .catFrappe:    Color(red: 0xEF/255, green: 0x9F/255, blue: 0x76/255) // Frappé Peach
        case .catMacchiato: Color(red: 0xF5/255, green: 0xA9/255, blue: 0x7F/255) // Macchiato Peach
        case .catMocha:     Color(red: 0xFA/255, green: 0xB3/255, blue: 0x87/255) // Mocha Peach
        }
    }

    /// Emoji shown in the preset picker for visual flair.
    var emoji: String {
        switch self {
        case .ember: "🔥"
        case .blue: "💎"
        case .purple: "🔮"
        case .pink: "🌸"
        case .red: "❤️‍🔥"
        case .orange: "🍊"
        case .yellow: "⚡"
        case .green: "🌿"
        case .graphite: "🪨"
        case .catLatte: "☕"
        case .catFrappe: "🧋"
        case .catMacchiato: "🍵"
        case .catMocha: "🍫"
        }
    }

    /// Whether this is a Catppuccin flavor.
    var isCatppuccin: Bool {
        switch self {
        case .catLatte, .catFrappe, .catMacchiato, .catMocha: true
        default: false
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
