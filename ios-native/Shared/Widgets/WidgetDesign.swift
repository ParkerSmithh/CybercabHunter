import SwiftUI
import WidgetKit

// The widgets' look, in the Dynamic Island Live Activity's language
// (Shared/ServiceActivityViews.swift): a #0A0A0A card with a soft gold light
// and a hairline gold edge, Inter, tracked gold eyebrows, big gold figures,
// white primary and muted grey secondary text. Gold parts are
// widgetAccentable, so a tinted Home Screen tints them.

/// Which widget size a view draws (the extension maps WidgetKit's family to it,
/// and the app's tests render each one).
enum WidgetSize: CaseIterable, Sendable {
    case small, medium, large, circular, rectangular, inline
    #if canImport(WidgetKit)
    init(_ family: WidgetFamily) {
        switch family {
        case .systemMedium: self = .medium
        case .systemLarge, .systemExtraLarge: self = .large
        case .accessoryCircular: self = .circular
        case .accessoryRectangular: self = .rectangular
        case .accessoryInline: self = .inline
        default: self = .small
        }
    }
    #endif
    var isAccessory: Bool { self == .circular || self == .rectangular || self == .inline }
    /// The point size of each Home Screen widget on a 6.1" iPhone (for previews and tests).
    var canvas: CGSize {
        switch self {
        case .small: CGSize(width: 170, height: 170)
        case .medium: CGSize(width: 364, height: 170)
        case .large: CGSize(width: 364, height: 382)
        case .circular: CGSize(width: 72, height: 72)
        case .rectangular: CGSize(width: 172, height: 76)
        case .inline: CGSize(width: 234, height: 26)
        }
    }
}

enum WidgetPalette {
    static let background = Color(red: 10 / 255, green: 10 / 255, blue: 10 / 255)   // #0A0A0A
    static let gold = ServiceActivityPalette.gold                                     // #FAE030
    static let ink = Color.white
    static let mist = ServiceActivityPalette.mist
    static let fog = ServiceActivityPalette.fog
    static let line = Color.white.opacity(0.09)
    static let up = ServiceActivityPalette.live                                       // #5FD4A3
    static let sky = ServiceActivityPalette.parked
    static let silver = Color(red: 192 / 255, green: 199 / 255, blue: 209 / 255)
    static let bronze = Color(red: 208 / 255, green: 138 / 255, blue: 85 / 255)

    /// The Spotter rank's colour (Bronze to Diamond).
    static func rank(_ key: String?) -> Color {
        switch key {
        case "bronze": bronze
        case "silver": silver
        case "gold": gold
        case "platinum": Color(red: 159 / 255, green: 227 / 255, blue: 224 / 255)
        case "diamond": Color(red: 138 / 255, green: 180 / 255, blue: 248 / 255)
        default: mist
        }
    }
    /// Gold, silver and bronze for the top three places.
    static func medal(_ place: Int) -> Color { place == 1 ? gold : place == 2 ? silver : place == 3 ? bronze : fog }
}

/// The card behind every Home Screen widget.
struct WidgetCardBackground: View {
    var glow: UnitPoint = UnitPoint(x: 0.95, y: 0.0)
    var body: some View {
        ZStack {
            WidgetPalette.background
            EllipticalGradient(colors: [WidgetPalette.gold.opacity(0.13), .clear], center: glow, startRadiusFraction: 0, endRadiusFraction: 0.75)
            LinearGradient(colors: [.white.opacity(0.03), .clear], startPoint: .top, endPoint: .center)
            ContainerRelativeShape().strokeBorder(WidgetPalette.gold.opacity(0.22), lineWidth: 1)
        }
    }
}

/// "▣ FLEET STATISTICS · AUSTIN": the gold tracked heading.
struct WidgetEyebrow: View {
    let icon: String
    let title: String
    var detail: String? = nil
    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: icon).font(.system(size: 10.5, weight: .bold))
            Text(title.uppercased()).font(ServiceFont.inter(10, .bold)).tracking(1.0).lineLimit(1)
            if let detail {
                Text("· \(detail.uppercased())").font(ServiceFont.inter(10, .semibold)).tracking(0.8).foregroundStyle(WidgetPalette.fog).lineLimit(1)
            }
        }
        .foregroundStyle(WidgetPalette.gold)
        .widgetAccentable()
        .minimumScaleFactor(0.8)
    }
}

/// A figure: the big gold number (or white), "—" when the server had none.
struct WidgetNumber: View {
    let value: Int?
    var size: CGFloat = 34
    var color: Color = WidgetPalette.gold
    var body: some View {
        Text(value.map { $0.formatted() } ?? "—")
            .font(ServiceFont.inter(size, .bold)).monospacedDigit()
            .foregroundStyle(color)
            .lineLimit(1).minimumScaleFactor(0.5)
            .contentTransition(.numericText())
    }
}

/// A labelled figure for the three-column layouts.
struct WidgetStat: View {
    let value: Int?
    let label: String
    var size: CGFloat = 24
    var color: Color = WidgetPalette.ink
    var note: String? = nil
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            WidgetNumber(value: value, size: size, color: color)
            Text(label.uppercased()).font(ServiceFont.inter(9, .semibold)).tracking(0.6).foregroundStyle(WidgetPalette.fog).lineLimit(1)
            if let note { Text(note).font(ServiceFont.inter(10, .semibold)).foregroundStyle(WidgetPalette.up).lineLimit(1).minimumScaleFactor(0.8) }
        }
    }
}

/// "+32 this week": a change over a period (green up, grey none, "—" unknown).
struct WidgetChange: View {
    let change: Int?
    let period: String
    var size: CGFloat = 11.5
    var body: some View {
        Group {
            if let change {
                HStack(spacing: 3) {
                    Image(systemName: change > 0 ? "arrow.up.right" : "minus").font(.system(size: size - 2, weight: .bold))
                    Text("\(change > 0 ? "+" : "")\(change.formatted()) \(period)")
                }
                .foregroundStyle(change > 0 ? WidgetPalette.up : WidgetPalette.fog)
            } else {
                Text("No \(period) figure").foregroundStyle(WidgetPalette.fog)
            }
        }
        .font(ServiceFont.inter(size, .semibold)).monospacedDigit().lineLimit(1).minimumScaleFactor(0.8)
    }
}

/// "Updated 3:41 PM", or "As of 3:41 PM · offline" when the last refresh failed.
struct WidgetFreshness: View {
    let date: Date?
    var stale = false
    var body: some View {
        if let date, date > .distantPast {
            HStack(spacing: 3) {
                if stale { Image(systemName: "wifi.slash").font(.system(size: 8, weight: .bold)) }
                Text(stale ? "As of " : "Updated ") + Text(date, style: .time)
            }
            .font(ServiceFont.inter(9, .medium)).foregroundStyle(WidgetPalette.fog.opacity(stale ? 1 : 0.8)).lineLimit(1)
        }
    }
}

/// A gold line with a soft fill under it (a series of real points; flat when it never moved).
struct WidgetSparkline: View {
    let values: [Int]
    var lineWidth: CGFloat = 2
    var body: some View {
        GeometryReader { g in
            let lo = Double(values.min() ?? 0), hi = Double(values.max() ?? 0)
            let span = max(hi - lo, 1)
            let pts = values.enumerated().map { i, v in
                CGPoint(x: values.count > 1 ? g.size.width * CGFloat(i) / CGFloat(values.count - 1) : g.size.width,
                        y: g.size.height - g.size.height * CGFloat((Double(v) - lo) / span) * 0.9 - 1)
            }
            ZStack {
                Path { p in
                    guard let first = pts.first else { return }
                    p.move(to: CGPoint(x: first.x, y: g.size.height)); pts.forEach { p.addLine(to: $0) }
                    p.addLine(to: CGPoint(x: pts.last!.x, y: g.size.height)); p.closeSubpath()
                }
                .fill(LinearGradient(colors: [WidgetPalette.gold.opacity(0.28), WidgetPalette.gold.opacity(0)], startPoint: .top, endPoint: .bottom))
                Path { p in
                    guard let first = pts.first else { return }
                    p.move(to: first); pts.dropFirst().forEach { p.addLine(to: $0) }
                }
                .stroke(WidgetPalette.gold, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round, lineJoin: .round))
                .widgetAccentable()
                if let last = pts.last { Circle().fill(WidgetPalette.gold).frame(width: lineWidth * 3, height: lineWidth * 3).position(last).widgetAccentable() }
            }
        }
        .accessibilityHidden(true)
    }
}

/// The gold progress bar.
struct WidgetBar: View {
    let progress: Double
    var height: CGFloat = 6
    var color: Color = WidgetPalette.gold
    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .leading) {
                Capsule().fill(WidgetPalette.line)
                Capsule().fill(color).frame(width: max(height, g.size.width * min(max(progress, 0), 1))).widgetAccentable()
                    .shadow(color: color.opacity(0.45), radius: 3)
            }
        }
        .frame(height: height)
        .accessibilityHidden(true)
    }
}

/// The gold progress ring.
struct WidgetRing: View {
    let progress: Double
    var lineWidth: CGFloat = 7
    var body: some View {
        ZStack {
            Circle().stroke(WidgetPalette.line, lineWidth: lineWidth)
            Circle().trim(from: 0, to: min(max(progress, 0), 1))
                .stroke(WidgetPalette.gold, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .widgetAccentable()
        }
        .accessibilityHidden(true)
    }
}

/// Nothing to show yet (no answer and nothing kept), or signed out.
struct WidgetMessage: View {
    let icon: String
    let title: String
    let message: String
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Image(systemName: icon).font(.system(size: 18, weight: .semibold)).foregroundStyle(WidgetPalette.gold).widgetAccentable()
            Text(title).font(ServiceFont.inter(14, .bold)).foregroundStyle(WidgetPalette.ink).lineLimit(2)
            Text(message).font(ServiceFont.inter(11.5, .medium)).foregroundStyle(WidgetPalette.fog).lineLimit(4).minimumScaleFactor(0.85)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

/// The gold Cybercab (CybercabLive), as on the Live Activity.
struct WidgetCar: View {
    var width: CGFloat
    var body: some View {
        Image("CybercabLive").resizable().interpolation(.high)
            .aspectRatio(ServiceCarArt.aspect, contentMode: .fit)
            .frame(width: width)
            .shadow(color: .black.opacity(0.5), radius: 5, y: 3)
            .background(
                EllipticalGradient(colors: [WidgetPalette.gold.opacity(0.2), .clear], center: .center, startRadiusFraction: 0, endRadiusFraction: 0.5)
                    .frame(width: width * 1.4, height: width * 0.7)
            )
            .accessibilityHidden(true)
    }
}

/// "3h ago" for a post.
enum WidgetTime {
    static func ago(_ date: Date?, now: Date = .now) -> String? {
        guard let date else { return nil }
        let s = max(0, now.timeIntervalSince(date))
        if s < 60 { return "just now" }
        if s < 3600 { return "\(Int(s / 60))m ago" }
        if s < 86400 { return "\(Int(s / 3600))h ago" }
        return "\(Int(s / 86400))d ago"
    }
    /// "Oct 3" from a Central yyyy-MM-dd day.
    static func day(_ key: String?) -> String? {
        guard let key else { return nil }
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = WidgetClock.central; f.dateFormat = "yyyy-MM-dd"
        guard let d = f.date(from: key) else { return nil }
        let out = DateFormatter(); out.locale = Locale(identifier: "en_US"); out.timeZone = WidgetClock.central; out.dateFormat = "MMM d"
        return out.string(from: d)
    }
}
