import SwiftUI

/// The Replay's look. Auto is the website's (js/replay.js "golden day"): the
/// sky washed over the map follows the replay's own clock. Day, Dusk and Night
/// hold one look: Day the light map with a clear sky, Dusk the light map under
/// the site's amber dusk wash, Night the dark map under its indigo night wash.
/// (MapKit can't restyle its map colours like the site's vector tiles, so the
/// wash is what makes Dusk dusk: a real tint, not a copy of Day or Night.)
enum ReplayAppearance: String, CaseIterable, Identifiable {
    case auto, day, dusk, night
    var id: String { rawValue }
    var title: String { rawValue.prefix(1).uppercased() + rawValue.dropFirst() }
    /// The dark MapKit map (the site's Dark Matter basemap) or the light one.
    var darkMap: Bool { self == .auto || self == .night }
    /// The hour whose sky this look shows (nil: the replay's own time).
    var fixedHour: Double? {
        switch self { case .auto: nil; case .day: 12; case .dusk: 18.5; case .night: 0 }
    }
}

enum ReplaySky {
    /// js/replay.js TINT_KEYS: [hour, [r, g, b, alpha]].
    static let keys: [(Double, [Double])] = [
        (0, [22, 26, 88, 0.58]), (4.5, [30, 32, 100, 0.54]), (6.5, [255, 146, 56, 0.46]), (8.5, [250, 224, 48, 0.24]),
        (11, [255, 245, 220, 0.04]), (12, [255, 255, 255, 0]), (15, [250, 224, 48, 0.12]), (18.5, [255, 108, 40, 0.48]),
        (20.5, [62, 40, 118, 0.54]), (24, [22, 26, 88, 0.58])
    ]

    /// The tint at local hour `h` (linear between keys, as tintColor).
    static func tint(_ h: Double) -> [Double] {
        for i in 1..<keys.count where h <= keys[i].0 {
            let (h0, c0) = keys[i - 1], (h1, c1) = keys[i]
            let f = (h - h0) / (h1 - h0)
            return zip(c0, c1).map { $0 + ($1 - $0) * f }
        }
        return [0, 0, 0, 0]
    }

    /// skyAt: deeper toward the top like a real sky (alpha × 1.45, × 1, × 0.8; at most 0.85).
    static func gradient(_ h: Double) -> LinearGradient {
        let c = tint(h)
        func at(_ a: Double) -> Color { Color(red: c[0] / 255, green: c[1] / 255, blue: c[2] / 255).opacity(min(0.85, a)) }
        return LinearGradient(stops: [.init(color: at(c[3] * 1.45), location: 0), .init(color: at(c[3]), location: 0.45), .init(color: at(c[3] * 0.8), location: 1)],
                              startPoint: .top, endPoint: .bottom)
    }

    /// phaseAt's chip colours.
    static func chip(_ phase: String) -> (fill: Color, text: Color) {
        switch phase {
        case "Night": (Color(hex: 0x1E2470), .white)
        case "Dawn": (Color(hex: 0xFF9A3C), Color(hex: 0x2A1600))
        case "Midday": (Color.brandGold, Color(hex: 0x2A2210))
        default: (Color(hex: 0xE8622A), .white)
        }
    }
}
