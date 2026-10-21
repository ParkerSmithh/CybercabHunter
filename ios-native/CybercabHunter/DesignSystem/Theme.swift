import SwiftUI

/// The website's design tokens (public/css/style.css :root, dark theme), so
/// the app reads as Cybercab Hunter: a near-black canvas, carbon surfaces,
/// graphite hairlines, mist and fog text, and one accent, gold #FAE030.
extension Color {
    init(hex: UInt32, opacity: Double = 1) {
        self.init(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255, opacity: opacity)
    }

    static let chBackground = Color(hex: 0x08090A)  // --bg  Void: the canvas
    static let chSurface = Color(hex: 0x0F1011)     // --surface  Carbon: cards, inputs, nav
    static let chSurface2 = Color(hex: 0x161718)    // --surface-2  Obsidian: elevated panels
    static let chInk = Color(hex: 0xF7F8F8)         // --ink  headings, big numbers
    static let chMist = Color(hex: 0xD0D6E0)        // --n-300  body text
    static let chFog = Color(hex: 0x8A8F98)         // --n-400  muted text
    static let chCaption = Color(hex: 0x7E838C)     // --n-500  captions, metric labels
    static let chSmoke = Color(hex: 0x383B3F)       // --n-700
    static let chLine = Color(hex: 0x23252A)        // --line  Graphite hairlines
    static let chHair2 = Color(hex: 0x2E3035)       // --hair-2  outlined controls
    static let brandGold = Color(hex: 0xFAE030)     // --gold  the one accent
    static let chDanger = Color(hex: 0xE82127)      // --danger
    static let chOK = Color(hex: 0x5FD4A3)          // --ok-ink  rises, "live"
    static let chModelY = Color(hex: 0xEF4444)      // the DMV panel's Model Y red

    // Phase 1 names, kept for the account sheet and fallbacks.
    static let appBackground = chBackground
    static let secondaryText = chFog
    static let cardFill = chSurface
    static let cardStroke = chLine
}

/// Inter (the website's typeface, bundled) with Dynamic Type scaling.
extension Font {
    static func inter(_ size: CGFloat, _ weight: Font.Weight = .regular, relativeTo style: Font.TextStyle = .body) -> Font {
        .custom("Inter", size: size, relativeTo: style).weight(weight)
    }
    /// Geist Mono, used on the website for codes (VINs).
    static func geistMono(_ size: CGFloat, _ weight: Font.Weight = .medium, relativeTo style: Font.TextStyle = .body) -> Font {
        .custom("Geist Mono", size: size, relativeTo: style).weight(weight)
    }
}

extension View {
    /// The website's display headings: Inter bold, tight tracking, uppercase.
    func displayTitle(_ size: CGFloat = 22) -> some View {
        self.font(.inter(size, .bold, relativeTo: .title2)).tracking(-0.02 * size).textCase(.uppercase).foregroundStyle(Color.chInk)
    }

    /// Big numbers: Inter, tabular figures, the site's tight tracking.
    func statNumber(_ size: CGFloat = 28, color: Color = .chInk) -> some View {
        self.font(.inter(size, .semibold, relativeTo: .title)).monospacedDigit().tracking(-0.022 * size).foregroundStyle(color)
    }

    /// `.home-data-panel`: carbon surface with a faint gold wash from the top
    /// left, a 1px ink/10% border, 16pt corners.
    func dataPanel(padding: CGFloat = 16) -> some View {
        self.padding(.vertical, padding + 4).padding(.horizontal, padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                RoundedRectangle(cornerRadius: 16)
                    .fill(Color.chSurface)
                    .overlay(RoundedRectangle(cornerRadius: 16).fill(LinearGradient(colors: [Color.brandGold.opacity(0.06), .clear], startPoint: .topLeading, endPoint: UnitPoint(x: 0.6, y: 0.8))))
            }
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.chInk.opacity(0.1)))
    }

    /// `.glass` cards: carbon at 82% with a graphite border (no blur: these
    /// sit on the canvas, not over content).
    func glassCard(padding: CGFloat = 16, radius: CGFloat = 16) -> some View {
        self.padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.chSurface.opacity(0.82), in: .rect(cornerRadius: radius))
            .overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(Color.chLine))
    }

    /// Phase 1's card, now the glass card.
    func card(padding: CGFloat = 16) -> some View { glassCard(padding: padding) }

    /// The canvas behind every screen.
    func appBackground() -> some View {
        self.scrollContentBackground(.hidden).background(Color.chBackground.ignoresSafeArea())
    }
}

/// The small uppercase label over every section ("SERVICE AREA · AUSTIN").
struct Eyebrow: View {
    let text: String
    var accent: String? = nil
    var color: Color = .brandGold

    var body: some View {
        (Text(text.uppercased()).foregroundStyle(accent == nil ? color : Color.chFog)
            + Text(accent.map { " · \($0.uppercased())" } ?? "").foregroundStyle(Color.brandGold))
            .font(.inter(11, .semibold, relativeTo: .caption))
            .tracking(1.9)
    }
}
