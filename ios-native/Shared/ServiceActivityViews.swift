import SwiftUI

// The Live Activity's presentations (Dynamic Island compact / minimal /
// expanded, and the Lock Screen), drawn as the website's homepage service
// banner (public/js/service-banner.js, .service-banner in css/style.css):
// the green LIVE NOW eyebrow, the white uppercase headline, the gold
// "Service ends in" line, the service day on a 24-hour track (the window, the
// part already run, now), and the gold Cybercab (CybercabLive, from
// public/images/CybercabLive.png) over a soft gold light (no road: the
// banner's dashed road is left to the website and the app's Home card).
// Parked: sky blue, the car greyed and dimmed, no light.
//
// Motion: Live Activities can't run the banner's continuous animations (the
// bobbing car, the streaming road, the pinging dot). What moves here is what
// the system draws itself: the countdown (Text(timerInterval:)) and the gold
// run filling the service window up to now (ProgressView(timerInterval:)),
// whose leading edge stands in for the banner's "now" marker. The dot's
// ring is drawn still; the car slides in when the state changes.
// Shared so the app's tests can render each presentation.

enum ServiceActivityPalette {
    static let gold = Color(red: 250 / 255, green: 224 / 255, blue: 48 / 255)     // #FAE030, --gold
    static let live = Color(red: 95 / 255, green: 212 / 255, blue: 163 / 255)     // #5FD4A3, the banner's LIVE NOW
    static let parked = Color(red: 125 / 255, green: 211 / 255, blue: 252 / 255)  // #7DD3FC, the banner's PARKED
    static let ink = Color(red: 247 / 255, green: 248 / 255, blue: 248 / 255)     // #F7F8F8, --ink
    static let mist = Color(red: 208 / 255, green: 214 / 255, blue: 224 / 255)    // slate-200
    static let fog = Color(red: 160 / 255, green: 165 / 255, blue: 173 / 255)     // slate-400
    static let slate = Color(red: 148 / 255, green: 163 / 255, blue: 184 / 255)   // the parked window
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
    let live: Bool
    let since: Date
    let until: Date
    let stale: Bool
    let openLabel: String
    let closeLabel: String

    /// Live and up to date: the gold car and the light.
    var lit: Bool { live && !stale }
    var accent: Color { stale ? ServiceActivityPalette.fog : (live ? ServiceActivityPalette.live : ServiceActivityPalette.parked) }
    var badge: String { stale ? "NOT UPDATED" : (live ? "LIVE NOW" : "PARKED") }
    /// The banner's headlines (shown uppercase).
    var headline: String { stale ? "Status needs updating" : (live ? "Cybercabs are on the road now" : "The fleet is parked for the night") }
    var countdownLead: String { live ? "Service ends in" : "Back on the road in" }
    var hours: String { "\(openLabel) – \(closeLabel)" }
    /// The countdown and the run go from `since` to `until` (never a reversed range).
    var window: ClosedRange<Date> { since...max(until, since.addingTimeInterval(60)) }

    /// Where the service hours sit on the 24-hour track (0 = 12 AM, 1 = the next
    /// 12 AM): one piece, or two when service runs past midnight (6 AM–12 AM, 12 AM–2 AM).
    var servicePieces: [ClosedRange<CGFloat>] { live ? Self.pieces(since, until) : Self.pieces(until, since) }

    /// One stretch the system fills up to now: where it sits, and its times.
    struct Run { let span: ClosedRange<CGFloat>; let time: ClosedRange<Date> }
    /// The service window while live (split at midnight when it runs past it, so
    /// each piece fills in its own time); the night while parked, when it doesn't
    /// cross midnight; nothing while stale.
    var runs: [Run] {
        if stale { return [] }
        let a = Self.fraction(since), b = Self.fraction(until)
        if !live { return b > a ? [Run(span: a...b, time: window)] : [] }
        let midnight = Self.calendar.startOfDay(for: until)
        guard midnight > since, midnight < until, b > 0 else { return [Run(span: a...(b > a ? b : 1), time: window)] }
        return [Run(span: a...1, time: since...midnight), Run(span: 0...b, time: midnight...until)]
    }

    private static var calendar: Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = ServiceSchedule.timeZone
        return cal
    }

    /// The share of the Central day at `date`.
    static func fraction(_ date: Date) -> CGFloat {
        let c = calendar.dateComponents([.hour, .minute], from: date)
        return CGFloat((c.hour ?? 0) * 60 + (c.minute ?? 0)) / 1440
    }
    /// From `start` to `end` on the track: an end at midnight is the right edge;
    /// an end past midnight is a second piece from the left edge.
    static func pieces(_ start: Date, _ end: Date) -> [ClosedRange<CGFloat>] {
        let a = fraction(start), b = fraction(end)
        if b > a { return [a...b] }
        return b > 0 ? [a...1, 0...b] : [a...1]
    }
}

// MARK: - Building blocks

/// The eyebrow's dot: the banner's green dot with its ping ring (drawn still),
/// the moon when parked, a plain grey dot when stale.
struct ServicePulseDot: View {
    let d: ServiceActivityDisplay
    var size: CGFloat = 8
    var body: some View {
        Group {
            if d.stale {
                Circle().fill(d.accent).frame(width: size, height: size)
            } else if d.live {
                ZStack {
                    Circle().fill(d.accent.opacity(0.22)).frame(width: size * 2, height: size * 2)
                    Circle().strokeBorder(d.accent.opacity(0.45), lineWidth: 1).frame(width: size * 1.55, height: size * 1.55)
                    Circle().fill(d.accent).frame(width: size, height: size)
                }
            } else {
                Image(systemName: "moon").font(.system(size: size * 1.35, weight: .semibold)).foregroundStyle(d.accent.opacity(0.8))
            }
        }
        .frame(width: size * 2, height: size * 2)
    }
}

/// "● LIVE NOW", in the banner's tracked uppercase.
struct ServiceEyebrow: View {
    let d: ServiceActivityDisplay
    var size: CGFloat = 11
    var body: some View {
        HStack(spacing: size * 0.45) {
            ServicePulseDot(d: d, size: size * 0.7)
            Text(d.badge).font(ServiceFont.inter(size, .semibold)).tracking(size * 0.16)
                .foregroundStyle(d.live && !d.stale ? d.accent : d.accent.opacity(0.85)).lineLimit(1)
        }
    }
}

/// The headline, white (slate when parked), uppercase.
struct ServiceHeadline: View {
    let d: ServiceActivityDisplay
    var size: CGFloat
    var body: some View {
        Text(d.headline.uppercased())
            .font(ServiceFont.inter(size, .semibold)).tracking(size * 0.02)
            .foregroundStyle(d.lit ? ServiceActivityPalette.ink : ServiceActivityPalette.mist)
            .lineLimit(2).minimumScaleFactor(0.8)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// The countdown to the next change, drawn by the system (no app code runs).
struct ServiceCountdown: View {
    let d: ServiceActivityDisplay
    var size: CGFloat = 14
    var body: some View {
        if d.stale {
            Text("—").font(ServiceFont.inter(size)).foregroundStyle(ServiceActivityPalette.fog)
        } else {
            Text(timerInterval: d.window, countsDown: true)
                .font(ServiceFont.inter(size)).monospacedDigit()
                .foregroundStyle(d.live ? ServiceActivityPalette.gold : ServiceActivityPalette.parked)
                .multilineTextAlignment(.trailing)
        }
    }
}

/// "Service ends in 4:09:12": the banner's gold line (parked: slate, sky countdown).
struct ServiceCountdownLine: View {
    let d: ServiceActivityDisplay
    var size: CGFloat = 13
    var body: some View {
        Group {
            if d.stale {
                Text("Open Cybercab Hunter to refresh it.").foregroundStyle(ServiceActivityPalette.fog)
            } else {
                Text("\(d.countdownLead) ").foregroundStyle(d.live ? ServiceActivityPalette.gold : ServiceActivityPalette.fog)
                    + Text(timerInterval: d.window, countsDown: true).foregroundStyle(d.live ? ServiceActivityPalette.gold : ServiceActivityPalette.parked)
            }
        }
        .font(ServiceFont.inter(size)).monospacedDigit().lineLimit(1).minimumScaleFactor(0.85)
    }
}

/// The service day on a 24-hour track, as on the banner: the service window
/// (soft gold; slate when parked), the part already run filled by the system
/// up to now (its leading edge is the "now" marker, with the gold glow), and
/// the hour marks under it where there's room.
struct ServiceDayTrack: View {
    let d: ServiceActivityDisplay
    var height: CGFloat = 6
    var marks = false
    var body: some View {
        VStack(spacing: 5) {
            GeometryReader { g in
                let w = g.size.width, runs = d.runs
                ZStack(alignment: .leading) {
                    Capsule().fill(ServiceActivityPalette.ink.opacity(0.09))
                    ForEach(Array(d.servicePieces.enumerated()), id: \.offset) { _, span in
                        Capsule()
                            .fill(d.lit ? ServiceActivityPalette.gold.opacity(0.28) : ServiceActivityPalette.slate.opacity(0.22))
                            .frame(width: w * (span.upperBound - span.lowerBound))
                            .offset(x: w * span.lowerBound)
                    }
                    ForEach(runs.indices, id: \.self) { i in
                        ProgressView(timerInterval: runs[i].time, countsDown: false) { EmptyView() } currentValueLabel: { EmptyView() }
                            .progressViewStyle(.linear)
                            .labelsHidden()
                            .tint(d.live ? ServiceActivityPalette.gold : ServiceActivityPalette.parked.opacity(0.75))
                            .scaleEffect(x: 1, y: height / 4, anchor: .center)
                            .frame(width: w * (runs[i].span.upperBound - runs[i].span.lowerBound))
                            .offset(x: w * runs[i].span.lowerBound)
                            .shadow(color: (d.live ? ServiceActivityPalette.gold : ServiceActivityPalette.parked).opacity(0.55), radius: 4)
                    }
                }
                .frame(height: height)
                .frame(maxHeight: .infinity, alignment: .center)
            }
            .frame(height: height + 2)
            if marks {
                HStack(spacing: 0) {
                    ForEach(Array(["12 AM", "6 AM", "12 PM", "6 PM", "12 AM"].enumerated()), id: \.offset) { i, m in
                        if i > 0 { Spacer(minLength: 0) }
                        Text(m)
                    }
                }
                .font(ServiceFont.inter(9, .medium)).monospacedDigit().foregroundStyle(ServiceActivityPalette.fog.opacity(0.8))
            }
        }
        .accessibilityHidden(true)
    }
}

/// The gold Cybercab (CybercabLive.png, its own proportions and transparency),
/// optionally with the soft gold light behind it, kept inside its own frame so
/// it never reaches the text beside it or the service-day track below. Parked
/// or stale: grey and dim, no light, as on the banner.
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
            car(h)
        }
        .frame(width: width, height: h)
        .accessibilityHidden(true)
    }

    private func car(_ h: CGFloat) -> some View {
            Image("CybercabLive")
                .resizable()
                .interpolation(.high)
                .aspectRatio(Self.aspect, contentMode: .fit)
                .frame(width: width, height: h)
                .grayscale(d.lit ? 0 : 1)
                .brightness(d.lit ? 0 : -0.12)
                .opacity(d.lit ? 1 : 0.7)
                .shadow(color: .black.opacity(scene ? 0.45 : 0), radius: 4, y: 2)
                .id(d.lit)
                .transition(.push(from: .trailing))
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
        .accessibilityLabel(d.stale ? "Cybercab service status needs updating" : (d.live ? "Cybercabs live" : "Cybercab service parked"))
    }
}

/// Compact, trailing: the gold countdown.
struct ServiceCompactTrailing: View {
    let d: ServiceActivityDisplay
    var body: some View { ServiceCountdown(d: d, size: 14).frame(maxWidth: 58) }
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
        .accessibilityLabel(d.stale ? "Cybercab service status needs updating" : (d.live ? "Cybercabs live" : "Cybercab service parked"))
    }
}

/// Expanded, leading: LIVE NOW.
struct ServiceExpandedLeading: View {
    let d: ServiceActivityDisplay
    var body: some View { ServiceEyebrow(d: d, size: 11).padding(.leading, 6) }
}

/// Expanded, bottom: the headline and countdown, with the car
/// center-right beside them; then, in rows of their own, the service-day
/// track and the hours.
struct ServiceExpandedBottom: View {
    let d: ServiceActivityDisplay
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 4) {
                    ServiceHeadline(d: d, size: 15)
                    ServiceCountdownLine(d: d, size: 13)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                ServiceCarArt(d: d, width: 110, scene: true)
            }
            ServiceDayTrack(d: d, height: 5)
                .padding(.top, 12)
            HStack {
                Text("Service day · ").foregroundStyle(ServiceActivityPalette.fog)
                    + Text(d.hours).foregroundStyle(ServiceActivityPalette.mist)
                    + Text(" · CT").foregroundStyle(ServiceActivityPalette.fog)
                Spacer(minLength: 0)
            }
            .font(ServiceFont.inter(10.5, .medium)).lineLimit(1).minimumScaleFactor(0.85)
            .padding(.top, 7)
        }
        .padding(.horizontal, 6)
        .padding(.top, 2)
    }
}

// MARK: - Lock Screen

/// The Lock Screen banner: the website's Live now card, in a dark rounded card
/// with the gold edge and the light behind the car.
struct ServiceLockScreen: View {
    let d: ServiceActivityDisplay
    static let lift: CGFloat = 12
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ServiceEyebrow(d: d, size: 11)
            // The car rises into the eyebrow row's empty right side (its frame
            // gives back `lift` at the top), so it sits center-right, level
            // with the headline and countdown and well clear of the track.
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 5) {
                    ServiceHeadline(d: d, size: 16)
                    ServiceCountdownLine(d: d, size: 13.5)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                ServiceCarArt(d: d, width: 128, scene: true)
                    .padding(.top, -Self.lift)
                    .padding(.trailing, -2)
            }
            .padding(.top, 3)
            ServiceDayTrack(d: d, height: 6, marks: true)
                .padding(.top, 12)
            HStack(spacing: 0) {
                Text("Service day · ").foregroundStyle(ServiceActivityPalette.fog)
                    + Text(d.hours).foregroundStyle(ServiceActivityPalette.mist)
                    + Text(" · Central time (CT)").foregroundStyle(ServiceActivityPalette.fog)
                Spacer(minLength: 0)
            }
            .font(ServiceFont.inter(10.5, .medium)).lineLimit(1).minimumScaleFactor(0.8)
            .padding(.top, 6)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
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
