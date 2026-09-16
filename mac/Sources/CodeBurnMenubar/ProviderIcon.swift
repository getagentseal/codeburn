import AppKit

/// Shared cache for provider glyphs. Curated vector resources are preferred;
/// existing CodeBurn raster artwork remains a compatibility fallback. Unknown
/// providers receive a crisp, neutral generated sigil rather than an invented
/// approximation of their trademark.
@MainActor
enum ProviderIconCache {
    struct ResourceCandidate: Equatable {
        let name: String
        let fileExtension: String
    }

    struct SigilDescriptor: Equatable {
        let monogram: String
        let quarterTurns: Int
        let reach: Int
        let terminal: Int
    }

    private static var images: [String: NSImage] = [:]

    /// Product-facing IDs that intentionally share a provider mark.
    private static let bundledVectorAliases: [String: String] = [
        "alibabatokenplan": "alibaba",
        "azureopenai": "codex",
        "codex": "codex",
        "openai": "codex",
        "githubcopilot": "copilot",
        "grokbot": "grok",
        "googlegemini": "gemini",
        "moonshot": "kimi",
    ]

    /// Names already shipped by CodeBurn. These are retained behind the SVGs
    /// for compatibility with older packaged resources and non-catalog views.
    private static let bundledRasterAliases: [String: String] = [
        "codex": "openai",
        "openai": "openai",
        "azureopenai": "openai",
        "claude": "claude",
        "gemini": "googlegemini",
        "googlegemini": "googlegemini",
        "copilot": "githubcopilot",
        "githubcopilot": "githubcopilot",
        "kimi": "kimi",
        "antigravity": "antigravity",
        "devin": "devin",
        "general": "general",
        "about": "about",
        "about-flame": "about-flame",
        "flame": "flame",
        "flame-solid": "flame-solid",
    ]

    static func resourceCandidates(for name: String) -> [ResourceCandidate] {
        let canonical = canonicalName(name)
        var candidates: [ResourceCandidate] = []

        let vectorName = bundledVectorAliases[canonical] ?? canonical
        if ProviderConnectionCatalog.entry(id: canonical) != nil
            || bundledVectorAliases[canonical] != nil
        {
            candidates.append(ResourceCandidate(name: "provider-\(vectorName)", fileExtension: "svg"))
        }

        if let resource = bundledRasterAliases[canonical] {
            candidates.append(ResourceCandidate(name: resource, fileExtension: "png"))
        }
        return candidates
    }

    static func monogram(for name: String) -> String {
        let words = name
            .split(whereSeparator: { !$0.isLetter && !$0.isNumber })
            .map(String.init)
        if words.count > 1 {
            return words.prefix(2).compactMap(\.first).map(String.init).joined().uppercased()
        }

        let letters = name.filter { $0.isLetter || $0.isNumber }
        return String(letters.prefix(2)).uppercased()
    }

    static func sigilDescriptor(for name: String) -> SigilDescriptor {
        let hash = stableHash(canonicalName(name))
        return SigilDescriptor(
            monogram: monogram(for: name),
            quarterTurns: Int(hash & 0b11),
            reach: 16 + Int((hash >> 2) % 9),
            terminal: Int((hash >> 6) & 0b1)
        )
    }

    static func image(named name: String) -> NSImage? {
        let cacheKey = canonicalName(name)
        if let cached = images[cacheKey] { return cached }
        for candidate in resourceCandidates(for: name) {
            for subdirectory in ["Resources/ProviderIcons", "ProviderIcons", nil] {
                if let url = Bundle.module.url(
                    forResource: candidate.name,
                    withExtension: candidate.fileExtension,
                    subdirectory: subdirectory
                ), let image = NSImage(contentsOf: url) {
                    image.isTemplate = true
                    images[cacheKey] = image
                    return image
                }
            }
        }
        let image = generatedSigil(named: name)
        images[cacheKey] = image
        return image
    }

    static func generatedSigil(named name: String) -> NSImage {
        let descriptor = sigilDescriptor(for: name)
        let size = NSSize(width: 128, height: 128)
        let image = NSImage(size: size, flipped: false) { rect in
            drawSigil(descriptor, in: rect)
            return true
        }
        image.isTemplate = true
        return image
    }

    private static func canonicalName(_ name: String) -> String {
        name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    /// FNV-1a gives the same provider a stable visual treatment across launches
    /// without relying on Swift's intentionally randomized `Hasher`.
    private static func stableHash(_ value: String) -> UInt64 {
        var hash: UInt64 = 14_695_981_039_346_656_037
        for byte in value.utf8 {
            hash ^= UInt64(byte)
            hash &*= 1_099_511_628_211
        }
        return hash
    }

    private static func drawSigil(_ descriptor: SigilDescriptor, in rect: NSRect) {
        NSGraphicsContext.saveGraphicsState()
        let rotation = NSAffineTransform()
        rotation.translateX(by: rect.midX, yBy: rect.midY)
        rotation.rotate(byDegrees: CGFloat(descriptor.quarterTurns * 90))
        rotation.translateX(by: -rect.midX, yBy: -rect.midY)
        rotation.concat()

        NSColor.black.setStroke()
        NSColor.black.setFill()

        let reach = CGFloat(descriptor.reach)
        let upper = NSBezierPath()
        upper.move(to: NSPoint(x: 25, y: 63))
        upper.line(to: NSPoint(x: 25, y: 82))
        upper.curve(
            to: NSPoint(x: 46, y: 103),
            controlPoint1: NSPoint(x: 25, y: 95),
            controlPoint2: NSPoint(x: 33, y: 103)
        )
        upper.line(to: NSPoint(x: 46 + reach, y: 103))
        upper.lineWidth = 8
        upper.lineCapStyle = .round
        upper.lineJoinStyle = .round
        upper.stroke()

        let lower = NSBezierPath()
        lower.move(to: NSPoint(x: 103, y: 65))
        lower.line(to: NSPoint(x: 103, y: 46))
        lower.curve(
            to: NSPoint(x: 82, y: 25),
            controlPoint1: NSPoint(x: 103, y: 33),
            controlPoint2: NSPoint(x: 95, y: 25)
        )
        lower.line(to: NSPoint(x: 82 - reach, y: 25))
        lower.lineWidth = 8
        lower.lineCapStyle = .round
        lower.lineJoinStyle = .round
        lower.stroke()

        let terminalCenter = descriptor.terminal == 0
            ? NSPoint(x: 25, y: 63)
            : NSPoint(x: 103, y: 65)
        NSBezierPath(
            ovalIn: NSRect(
                x: terminalCenter.x - 5,
                y: terminalCenter.y - 5,
                width: 10,
                height: 10
            )
        ).fill()
        NSGraphicsContext.restoreGraphicsState()

        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        let text = (descriptor.monogram.isEmpty ? "?" : descriptor.monogram) as NSString
        let fontSize: CGFloat = text.length == 1 ? 47 : 39
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: fontSize, weight: .bold),
            .foregroundColor: NSColor.black,
            .paragraphStyle: paragraph,
            .kern: -1.2,
        ]
        let textSize = text.size(withAttributes: attributes)
        text.draw(
            in: NSRect(
                x: rect.minX,
                y: rect.midY - textSize.height / 2,
                width: rect.width,
                height: textSize.height
            ),
            withAttributes: attributes
        )
    }
}
