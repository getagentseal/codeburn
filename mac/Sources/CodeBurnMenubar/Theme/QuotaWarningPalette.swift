import Foundation

/// Colours for the popover's quota warning banner (`QuotaWarningRow`), held as
/// plain sRGB so the one promise the banner makes — that it can be read — is a
/// unit test rather than a judgement call on a screenshot.
///
/// The banner is a 12% wash of a severity hue with text on top. It used to
/// paint that text in the same system yellow / orange / red as the wash, which
/// in light mode put yellow text on a barely yellower near-white. The hue stays
/// on the pill; the text, and the glyph beside it that carries the same
/// meaning, get a foreground chosen per colour scheme that clears WCAG AA for
/// small text (`minimumContrast`) against the composited pill in both schemes.
enum QuotaWarningPalette {
    /// An opaque sRGB colour, 0...1 per channel.
    struct RGB: Equatable, Sendable, CustomStringConvertible {
        let red: Double
        let green: Double
        let blue: Double

        init(_ red: Int, _ green: Int, _ blue: Int) {
            self.init(red: Double(red) / 255, green: Double(green) / 255, blue: Double(blue) / 255)
        }

        init(red: Double, green: Double, blue: Double) {
            self.red = red
            self.green = green
            self.blue = blue
        }

        var description: String {
            String(
                format: "#%02lX%02lX%02lX",
                Int((red * 255).rounded()),
                Int((green * 255).rounded()),
                Int((blue * 255).rounded())
            )
        }
    }

    enum Scheme: String, CaseIterable, Sendable {
        case light
        case dark
    }

    /// The severities the banner can show. `.normal` never reaches it: a
    /// provider has to be at 70% of a window to warn, which is already
    /// `.warning`.
    enum Tone: String, CaseIterable, Sendable {
        case warning
        case critical
        case danger

        init?(_ severity: QuotaSummary.Severity) {
            switch severity {
            case .normal: return nil
            case .warning: self = .warning
            case .critical: self = .critical
            case .danger: self = .danger
            }
        }
    }

    /// Opacity of the tinted pill, unchanged from the original banner.
    static let pillOpacity = 0.12

    /// WCAG 2.x AA for normal-size text. The banner is 10.5pt medium, well
    /// under the 14pt-bold "large text" size that would allow 3:1.
    static let minimumContrast = 4.5

    /// The pill's hue: what AppKit resolves `.systemYellow`, `.systemOrange`
    /// and `.systemRed` to in each appearance, so the wash looks as it did.
    static func tint(_ tone: Tone, _ scheme: Scheme) -> RGB {
        switch (tone, scheme) {
        case (.warning, .light): RGB(255, 204, 0)
        case (.warning, .dark): RGB(255, 214, 0)
        case (.critical, .light): RGB(255, 141, 40)
        case (.critical, .dark): RGB(255, 146, 48)
        case (.danger, .light): RGB(255, 56, 60)
        case (.danger, .dark): RGB(255, 66, 69)
        }
    }

    /// Text and glyph colour.
    static func foreground(_ tone: Tone, _ scheme: Scheme) -> RGB {
        switch (tone, scheme) {
        // Light: the same hues taken down to a deep amber, rust and brick.
        case (.warning, .light): RGB(122, 82, 0)
        case (.critical, .light): RGB(143, 62, 0)
        case (.danger, .light): RGB(158, 28, 20)
        // Dark: the system yellow already clears AA; orange and red are
        // lifted, because the stock red sits under 4.5:1 on a dark popover.
        case (.warning, .dark): RGB(255, 214, 0)
        case (.critical, .dark): RGB(255, 184, 92)
        case (.danger, .dark): RGB(255, 146, 135)
        }
    }

    /// What the pill is composited over. The header has no fill of its own, so
    /// this is the popover, whose material shifts with what is behind it. Each
    /// scheme is checked at both ends of that range: the window background
    /// AppKit resolves (white / #1E1E1E) and a greyer rendering of the material
    /// (#ECECEC / #323232). Dark text is hardest to read on the darkest light
    /// surface and light text on the lightest dark one, so the two ends bound
    /// every surface between them.
    static func surfaces(_ scheme: Scheme) -> [RGB] {
        switch scheme {
        case .light: [RGB(255, 255, 255), RGB(236, 236, 236)]
        case .dark: [RGB(30, 30, 30), RGB(50, 50, 50)]
        }
    }

    /// The pill as it lands on screen: the tint at `pillOpacity` over `surface`.
    static func pillBackground(_ tone: Tone, _ scheme: Scheme, over surface: RGB) -> RGB {
        composite(tint(tone, scheme), opacity: pillOpacity, over: surface)
    }

    /// Source-over in gamma-encoded sRGB, which is how Core Animation blends a
    /// translucent fill onto what is beneath it.
    static func composite(_ top: RGB, opacity: Double, over bottom: RGB) -> RGB {
        let alpha = min(max(opacity, 0), 1)
        return RGB(
            red: top.red * alpha + bottom.red * (1 - alpha),
            green: top.green * alpha + bottom.green * (1 - alpha),
            blue: top.blue * alpha + bottom.blue * (1 - alpha)
        )
    }

    /// WCAG 2.x relative luminance.
    static func relativeLuminance(_ colour: RGB) -> Double {
        func linear(_ channel: Double) -> Double {
            channel <= 0.04045 ? channel / 12.92 : pow((channel + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear(colour.red) + 0.7152 * linear(colour.green) + 0.0722 * linear(colour.blue)
    }

    /// WCAG 2.x contrast ratio, 1...21, whichever argument is lighter.
    static func contrastRatio(_ first: RGB, _ second: RGB) -> Double {
        let a = relativeLuminance(first)
        let b = relativeLuminance(second)
        return (max(a, b) + 0.05) / (min(a, b) + 0.05)
    }
}
