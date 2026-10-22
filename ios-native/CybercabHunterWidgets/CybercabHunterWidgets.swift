import WidgetKit
import SwiftUI

// Phase 6: Home Screen and Lock Screen widgets. They read the public API
// (FleetSnapshot, shared with the app) about every 30 minutes; the last good
// answer is kept so a failed refresh never blanks a widget, and is marked
// "as of" when it is older than an hour. Tapping opens the matching tab.

@main
struct CybercabHunterWidgets: WidgetBundle {
    var body: some Widget {
        FleetWidget()
        DailyWidget()
    }
}

// MARK: - Data

struct FleetEntry: TimelineEntry {
    let date: Date
    let snapshot: FleetSnapshot
    /// No answer yet and nothing kept: the views redact the numbers.
    let isPlaceholder: Bool
    /// The last refresh failed: the kept snapshot is shown with its time.
    let isStale: Bool
}

struct FleetProvider: TimelineProvider {
    static let base = URL(string: "https://cybercabhunter.com")!
    private static let cacheKey = "lastFleetSnapshot"

    func placeholder(in context: Context) -> FleetEntry { FleetEntry(date: .now, snapshot: .placeholder, isPlaceholder: true, isStale: false) }

    func getSnapshot(in context: Context, completion: @escaping @Sendable (FleetEntry) -> Void) {
        if context.isPreview, let kept = Self.kept() { completion(FleetEntry(date: .now, snapshot: kept, isPlaceholder: false, isStale: false)); return }
        Task { completion(await Self.entry()) }
    }

    func getTimeline(in context: Context, completion: @escaping @Sendable (Timeline<FleetEntry>) -> Void) {
        Task {
            let entry = await Self.entry()
            // Sooner after a failure; every 30 minutes otherwise (the counters move slowly).
            let next = Calendar.current.date(byAdding: .minute, value: entry.isStale || entry.isPlaceholder ? 10 : 30, to: .now)!
            completion(Timeline(entries: [entry], policy: .after(next)))
        }
    }

    static func entry() async -> FleetEntry {
        if let fresh = try? await FleetSnapshot.load(base: base) {
            keep(fresh)
            return FleetEntry(date: .now, snapshot: fresh, isPlaceholder: false, isStale: false)
        }
        if let kept = kept() { return FleetEntry(date: .now, snapshot: kept, isPlaceholder: false, isStale: true) }
        return FleetEntry(date: .now, snapshot: .placeholder, isPlaceholder: true, isStale: true)
    }

    private static func keep(_ s: FleetSnapshot) {
        if let data = try? JSONEncoder().encode(s) { UserDefaults.standard.set(data, forKey: cacheKey) }
    }
    private static func kept() -> FleetSnapshot? {
        UserDefaults.standard.data(forKey: cacheKey).flatMap { try? JSONDecoder().decode(FleetSnapshot.self, from: $0) }
    }
}

// MARK: - Look

private enum Palette {
    static let gold = Color(red: 250 / 255, green: 224 / 255, blue: 48 / 255)
    static let ink = Color(red: 247 / 255, green: 248 / 255, blue: 248 / 255)
    static let fog = Color(red: 138 / 255, green: 143 / 255, blue: 152 / 255)
    static let background = Color(red: 8 / 255, green: 9 / 255, blue: 10 / 255)
}

private struct Figure: View {
    let value: Int?
    let label: String
    var size: CGFloat = 22
    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(value.map { $0.formatted() } ?? "—")
                .font(.system(size: size, weight: .bold, design: .rounded)).monospacedDigit()
                .foregroundStyle(Palette.ink).minimumScaleFactor(0.6).lineLimit(1)
            Text(label.uppercased()).font(.system(size: 9.5, weight: .semibold)).tracking(0.4).foregroundStyle(Palette.fog).lineLimit(1)
        }
    }
}

private struct Header: View {
    let title: String
    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: "car.side.fill").font(.system(size: 11, weight: .bold)).foregroundStyle(Palette.gold)
            Text(title.uppercased()).font(.system(size: 10, weight: .heavy)).tracking(0.8).foregroundStyle(Palette.gold).lineLimit(1)
        }
    }
}

private struct Freshness: View {
    let entry: FleetEntry
    var body: some View {
        if entry.isStale, entry.snapshot.fetchedAt > .distantPast {
            Text("As of \(entry.snapshot.fetchedAt, style: .time)").font(.system(size: 9)).foregroundStyle(Palette.fog)
        }
    }
}

// MARK: - Cybercab Fleet

struct FleetWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "CybercabFleet", provider: FleetProvider()) { entry in
            FleetWidgetView(entry: entry)
                .containerBackground(Palette.background, for: .widget)
        }
        .configurationDisplayName("Cybercab Fleet")
        .description("Registered Cybercabs, recorded rides and sightings, from Cybercab Hunter.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular, .accessoryInline])
    }
}

struct FleetWidgetView: View {
    let entry: FleetEntry
    @Environment(\.widgetFamily) private var family
    private var s: FleetSnapshot { entry.snapshot }

    var body: some View {
        content
            .redacted(reason: entry.isPlaceholder ? .placeholder : [])
            .widgetURL(WidgetLink.url("registry"))
    }

    @ViewBuilder private var content: some View {
        switch family {
        case .accessoryInline:
            Label("\(s.registered.formatted()) Cybercabs", systemImage: "car.side.fill")
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 1) {
                Text("CYBERCAB HUNTER").font(.system(size: 11, weight: .heavy)).widgetAccentable()
                Text("\(s.registered.formatted()) Cybercabs").font(.system(size: 15, weight: .bold)).monospacedDigit()
                Text("\(s.rides.formatted()) rides · \(s.sightings.formatted()) sightings").font(.system(size: 12)).monospacedDigit()
            }
        case .systemMedium:
            VStack(alignment: .leading, spacing: 8) {
                HStack { Header(title: "Cybercab Fleet"); Spacer(); Freshness(entry: entry) }
                HStack(alignment: .top, spacing: 14) {
                    Link(destination: WidgetLink.url("registry")) { Figure(value: s.registered, label: "Cybercabs", size: 26) }
                    Figure(value: s.rides, label: "Rides", size: 26)
                    Link(destination: WidgetLink.url("sightings")) { Figure(value: s.sightings, label: "Sightings", size: 26) }
                }
                Spacer(minLength: 0)
                Text(s.todayLine ?? "Today's Cybercab Daily isn't in yet.")
                    .font(.system(size: 11, weight: .medium)).foregroundStyle(s.todayLine == nil ? Palette.fog : Palette.gold).lineLimit(2)
            }
        default:
            VStack(alignment: .leading, spacing: 6) {
                Header(title: "Cybercabs")
                Text(s.registered.formatted()).font(.system(size: 40, weight: .bold, design: .rounded)).monospacedDigit()
                    .foregroundStyle(Palette.gold).minimumScaleFactor(0.5).lineLimit(1)
                Spacer(minLength: 0)
                HStack(spacing: 12) { Figure(value: s.rides, label: "Rides", size: 16); Figure(value: s.sightings, label: "Sightings", size: 16) }
                Freshness(entry: entry)
            }
        }
    }
}

// MARK: - Cybercab Daily

struct DailyWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "CybercabDaily", provider: FleetProvider()) { entry in
            DailyWidgetView(entry: entry)
                .containerBackground(Palette.background, for: .widget)
        }
        .configurationDisplayName("Cybercab Daily")
        .description("Today's new Cybercabs, sightings and camera detections (Central time).")
        .supportedFamilies([.systemSmall, .accessoryRectangular])
    }
}

struct DailyWidgetView: View {
    let entry: FleetEntry
    @Environment(\.widgetFamily) private var family
    private var s: FleetSnapshot { entry.snapshot }

    var body: some View {
        content
            .redacted(reason: entry.isPlaceholder ? .placeholder : [])
            .widgetURL(WidgetLink.url("sightings"))
    }

    @ViewBuilder private var content: some View {
        if family == .accessoryRectangular {
            VStack(alignment: .leading, spacing: 1) {
                Text("CYBERCAB DAILY").font(.system(size: 11, weight: .heavy)).widgetAccentable()
                Text("+\((s.todayNewCybercabs ?? 0).formatted()) Cybercabs today").font(.system(size: 14, weight: .bold)).monospacedDigit()
                Text("\((s.todaySightings ?? 0).formatted()) sightings · \((s.todayDetections ?? 0).formatted()) detections").font(.system(size: 12)).monospacedDigit()
            }
        } else {
            VStack(alignment: .leading, spacing: 7) {
                Header(title: "Cybercab Daily")
                if s.date == nil && !entry.isPlaceholder {
                    Text("Today's report isn't in yet.").font(.system(size: 13)).foregroundStyle(Palette.fog)
                    Spacer(minLength: 0)
                } else {
                    Figure(value: s.todayNewCybercabs, label: "New Cybercabs", size: 24)
                    Figure(value: s.todaySightings, label: "Sightings", size: 18)
                    Figure(value: s.todayDetections, label: "Camera detections", size: 18)
                }
                Freshness(entry: entry)
            }
        }
    }
}
