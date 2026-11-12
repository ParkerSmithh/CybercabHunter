import SwiftUI

// The Live Activity's presentations (Dynamic Island compact / minimal /
// expanded, and the Lock Screen), in the design they've always had: the
// website's banner look (the green eyebrow dot, the white uppercase headline,
// the gold line, the gold Cybercab over a soft gold light, the dark card with
// the gold edge). Robotaxi service runs 24/7, so where the service countdown
// and the service-day track used to be, it shows today's Cybercab Daily
// figures: camera detections (the gold number, also in the compact Dynamic
// Island) and sightings, the area they cover and when they were updated.
//
// Motion: no countdown and nothing continuous. A count that changes rolls to
// its new value (contentTransition(.numericText)); the system drops that with
// Reduce Motion. Stale (not updated in time): grey, no light, "—".
// Shared so the app's tests can render each presentation.

enum ServiceActivityPalette {
    static let gold = Color(red: 250 / 255, green: 224 / 255, blue: 48 / 255)     // #FAE030, --gold
    static let live = Color(red: 95 / 255, green: 212 / 255, blue: 163 / 255)     // #5FD4A3, the banner's LIVE
    static let parked = Color(red: 125 / 255, green: 211 / 255, blue: 252 / 255)  // #7DD3FC, sky (the Home Screen widgets use it)
    static let ink = Color(red: 247 / 255, green: 248 / 255, blue: 248 / 255)     // #F7F8F8, --ink
    static let mist = Color(red: 208 / 255, green: 214 / 255, blue: 224 / 255)    // slate-200
    static let fog = Color(red: 160 / 255, green: 165 / 255, blue: 173 / 255)     // slate-400
    static let slate = Color(red: 148 / 255, green: 163 / 255, blue: 184 / 255)   // the stale edge
    static let background = Color(red: 8 / 255, green: 9 / 255, blue: 10 / 255)  // #08090A
}

/// Inter, the website's typeface (bundled with the widget extension and the app).
enum ServiceFont {
    static func inter(_ size: CGFloat, _ weight: Font.Weight = .semibold) -> Font {
        .custom("Inter", fixedSize: size).weight(weight)
    }
}

/// What every presentation shows, worked out once.
struct ServiceActivityDisplay {
    let detections: Int?
    let sightings: Int?
    let detectionsYesterday: Int?
    let updated: Date
    let city: String
    let stale: Bool

    /// Up to date: the gold car and the light.
    var lit: Bool { !stale }
    var accent: Color { stale ? ServiceActivityPalette.fog : ServiceActivityPalette.live }
    var badge: String { stale ? "NOT UPDATED" : "LIVE · 24/7" }
    var headline: String { "Cybercab Daily" }
    /// "1,234", or "—" when there's no current figure.
    var detectionsText: String { stale ? "—" : Self.count(detections) }
    var sightingsText: String { stale ? "—" : Self.count(sightings) }
    /// "+12 vs yesterday" (or "−3"), when both days are known.
    var versusYesterday: String? {
        guard !stale, let d = detections, let y = detectionsYesterday else { return nil }
        let diff = d - y
        return diff == 0 ? "Same as yesterday" : "\(diff > 0 ? "+" : "−")\(Self.count(abs(diff))) vs yesterday"
    }
    var updatedText: String { updated == .distantPast ? "Not updated yet" : "Updated \(CentralTime.clock(updated)) CT" }

    static func count(_ n: Int?) -> String {
        guard let n else { return "—" }
        return n.formatted(.number.locale(Locale(identifier: "en_US")))
    }
}

// MARK: - Building blocks

/// The eyebrow's dot: the banner's green dot with its ring (drawn still); a
/// plain grey dot when stale.
struct ServicePulseDot: View {
    let d: ServiceActivityDisplay
    var size: CGFloat = 8
    var body: some View {
        Group {
            if d.stale {
                Circle().fill(d.accent).frame(width: size, height: size)
            } else {
                ZStack {
                    Circle().fill(d.accent.opacity(0.22)).frame(width: size * 2, height: size * 2)
                    Circle().strokeBorder(d.accent.opacity(0.45), lineWidth: 1).frame(width: size * 1.55, height: size * 1.55)
                    Circle().fill(d.accent).frame(width: size, height: size)
                }
            }
        }
        .frame(width: size * 2, height: size * 2)
    }
}

/// "● LIVE · 24/7", in the banner's tracked uppercase.
struct ServiceEyebrow: View {
    let d: ServiceActivityDisplay
    var size: CGFloat = 11
    var body: some View {
        HStack(spacing: size * 0.45) {
            ServicePulseDot(d: d, size: size * 0.7)
            Text(d.badge).font(ServiceFont.inter(size, .semibold)).tracking(size * 0.16)
                .foregroundStyle(d.lit ? d.accent : d.accent.opacity(0.85)).lineLimit(1)
        }
    }
}

/// The headline, white (slate when stale), uppercase.
struct ServiceHeadline: View {
    let d: ServiceActivityDisplay
    var size: CGFloat
    var body: some View {
        Text(d.headline.uppercased())
            .font(ServiceFont.inter(size, .semibold)).tracking(size * 0.02)
            .foregroundStyle(d.lit ? ServiceActivityPalette.ink : ServiceActivityPalette.mist)
            .lineLimit(1).minimumScaleFactor(0.8)
    }
}

/// A count that rolls to its new value when it changes.
struct ServiceCount: View {
    let text: String
    let value: Int?
    var size: CGFloat
    var color: Color = ServiceActivityPalette.gold
    var body: some View {
        Text(text)
            .font(ServiceFont.inter(size, .bold)).monospacedDigit()
            .foregroundStyle(color)
            .contentTransition(.numericText(value: Double(value ?? 0)))
            .lineLimit(1).minimumScaleFactor(0.7)
    }
}

/// "1,234 camera detections today": the banner's gold line, where the
/// service countdown was.
struct ServiceDetectionsLine: View {
    let d: ServiceActivityDisplay
    var size: CGFloat = 13
    var body: some View {
        Group {
            if d.stale {
                Text("Open CybercabHunter to refresh it.").foregroundStyle(ServiceActivityPalette.fog)
            } else {
                Text(d.detectionsText).foregroundStyle(ServiceActivityPalette.gold).fontWeight(.bold)
                    + Text(d.detections == 1 ? " camera detection today" : " camera detections today").foregroundStyle(ServiceActivityPalette.gold)
            }
        }
        .font(ServiceFont.inter(size)).monospacedDigit().lineLimit(1).minimumScaleFactor(0.8)
        .contentTransition(.numericText(value: Double(d.detections ?? 0)))
    }
}

/// Today's two figures, side by side, where the service-day track was.
struct ServiceFigures: View {
    let d: ServiceActivityDisplay
    var size: CGFloat = 20
    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            figure("Detections", d.detectionsText, d.detections, note: d.versusYesterday)
            Rectangle().fill(ServiceActivityPalette.gold.opacity(0.18)).frame(width: 1).padding(.horizontal, 12)
            figure("Sightings", d.sightingsText, d.sightings, note: nil)
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private func figure(_ label: String, _ text: String, _ value: Int?, note: String?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(ServiceFont.inter(10.5, .medium)).foregroundStyle(ServiceActivityPalette.fog)
            ServiceCount(text: text, value: value, size: size, color: d.lit ? ServiceActivityPalette.gold : ServiceActivityPalette.fog)
            if let note { Text(note).font(ServiceFont.inter(10, .regular)).foregroundStyle(ServiceActivityPalette.fog).lineLimit(1).minimumScaleFactor(0.8) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// "Austin & Dallas · Updated 10:41 AM CT".
struct ServiceFootnote: View {
    let d: ServiceActivityDisplay
    var size: CGFloat = 10.5
    var body: some View {
        HStack(spacing: 0) {
            Text(d.city).foregroundStyle(ServiceActivityPalette.mist)
                + Text(" · \(d.updatedText)").foregroundStyle(ServiceActivityPalette.fog)
            Spacer(minLength: 0)
        }
        .font(ServiceFont.inter(size, .medium)).lineLimit(1).minimumScaleFactor(0.8)
    }
}

/// The gold Cybercab (CybercabLive.png, its own proportions and transparency),
/// optionally with the soft gold light behind it, kept inside its own frame.
/// Stale: grey and dim, no light.
struct ServiceCarArt: View {
    let d: ServiceActivityDisplay
    var width: CGFloat
    var scene = false
    /// The trimmed image's width over height.
    static let aspect: CGFloat = 1406 / 567
    var body: some View {
        let h = width / Self.aspect
        ZStack {
            if scene && d.lit {
                EllipticalGradient(colors: [ServiceActivityPalette.gold.opacity(0.22), .clear], center: .center, startRadiusFraction: 0, endRadiusFraction: 0.5)
                    .frame(width: width * 1.4, height: h)
            }
            Image("CybercabLive")
                .resizable()
                .interpolation(.high)
                .aspectRatio(Self.aspect, contentMode: .fit)
                .frame(width: width, height: h)
                .grayscale(d.lit ? 0 : 1)
                .brightness(d.lit ? 0 : -0.12)
                .opacity(d.lit ? 1 : 0.7)
                .shadow(color: .black.opacity(scene ? 0.45 : 0), radius: 4, y: 2)
        }
        .frame(width: width, height: h)
        .accessibilityHidden(true)
    }
}

// MARK: - Dynamic Island

/// Compact, leading: the Cybercab and the status dot.
struct ServiceCompactLeading: View {
    let d: ServiceActivityDisplay
    var body: some View {
        HStack(spacing: 4) {
            ServiceCarArt(d: d, width: 38)
            ZStack {
                Circle().fill(d.accent.opacity(d.lit ? 0.3 : 0)).frame(width: 11, height: 11)
                Circle().fill(d.accent).frame(width: 6, height: 6)
            }
            .frame(width: 11, height: 11)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(d.stale ? "Cybercab Daily needs updating" : "Cybercab Daily, live")
    }
}

/// Compact, trailing: today's camera detections, gold (where the countdown was).
struct ServiceCompactTrailing: View {
    let d: ServiceActivityDisplay
    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "video.fill").font(.system(size: 9, weight: .semibold))
                .foregroundStyle(d.lit ? ServiceActivityPalette.gold.opacity(0.8) : ServiceActivityPalette.fog)
            ServiceCount(text: d.detectionsText, value: d.detections, size: 14, color: d.lit ? ServiceActivityPalette.gold : ServiceActivityPalette.fog)
        }
        .frame(maxWidth: 64, alignment: .trailing)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(d.stale ? "Detections not updated" : "\(d.detectionsText) camera detections today")
    }
}

/// Minimal: the dot inside a gold ring (the car is too small to read here).
struct ServiceMinimal: View {
    let d: ServiceActivityDisplay
    var body: some View {
        ZStack {
            Circle().strokeBorder(d.lit ? ServiceActivityPalette.gold : ServiceActivityPalette.fog, lineWidth: 1.5)
            Circle().fill(d.accent.opacity(d.lit ? 0.3 : 0)).frame(width: 12, height: 12)
            Circle().fill(d.accent).frame(width: 7, height: 7)
        }
        .frame(width: 20, height: 20)
        .accessibilityLabel(d.stale ? "Cybercab Daily needs updating" : "\(d.detectionsText) camera detections today")
    }
}

/// Expanded, leading: LIVE · 24/7.
struct ServiceExpandedLeading: View {
    let d: ServiceActivityDisplay
    var body: some View { ServiceEyebrow(d: d, size: 11).padding(.leading, 6) }
}

/// Expanded, bottom: the headline and today's detections, with the car
/// center-right beside them; then detections and sightings, and the area and
/// update time.
struct ServiceExpandedBottom: View {
    let d: ServiceActivityDisplay
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 4) {
                    ServiceHeadline(d: d, size: 15)
                    ServiceDetectionsLine(d: d, size: 13)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                ServiceCarArt(d: d, width: 104, scene: true)
            }
            ServiceFigures(d: d, size: 16)
                .padding(.top, 7)
            ServiceFootnote(d: d, size: 10)
                .padding(.top, 5)
        }
        .padding(.horizontal, 6)
    }
}

// MARK: - Lock Screen

/// The Lock Screen banner: the dark rounded card with the gold edge and the
/// light behind the car, as before; today's figures where the countdown and
/// the service-day track were.
struct ServiceLockScreen: View {
    let d: ServiceActivityDisplay
    static let lift: CGFloat = 12
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ServiceEyebrow(d: d, size: 11)
            // The car rises into the eyebrow row's empty right side, level with
            // the headline and the detections line.
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    ServiceHeadline(d: d, size: 16)
                    ServiceDetectionsLine(d: d, size: 13.5)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                ServiceCarArt(d: d, width: 120, scene: true)
                    .padding(.top, -Self.lift)
                    .padding(.trailing, -2)
            }
            .padding(.top, 2)
            // iOS truncates a Lock Screen Live Activity past 160 pt: kept compact.
            ServiceFigures(d: d, size: 17)
                .padding(.top, 6)
            ServiceFootnote(d: d)
                .padding(.top, 4)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background {
            if d.lit {
                EllipticalGradient(colors: [ServiceActivityPalette.gold.opacity(0.16), .clear], center: UnitPoint(x: 0.82, y: 0.4), startRadiusFraction: 0, endRadiusFraction: 0.55)
            }
        }
        .overlay {
            ContainerRelativeShape()
                .strokeBorder(d.lit ? ServiceActivityPalette.gold.opacity(0.28) : ServiceActivityPalette.slate.opacity(0.18), lineWidth: 1)
        }
    }
}
