import WidgetKit
import SwiftUI
import AppIntents

// Home Screen and Lock Screen widgets, in the Live Activity's gold-on-black
// look. Views and data: Shared/Widgets. Each widget reads the public API (and,
// for the rider's own progress and leaderboard place, the session the app
// shares through WidgetSession) on its own timeline: hourly for the counters,
// a few times a day for growth and milestones, never more often after a
// failure than every 20 minutes. The last good answer is kept, so a failed
// refresh never blanks a widget; it is marked "As of" until the next success.

@main
struct CybercabHunterWidgets: WidgetBundle {
    var body: some Widget {
        FleetStatsWidget()        // kind "CybercabFleet": the former Cybercab Fleet widget, redesigned
        FleetGrowthWidget()
        MilestonesWidget()
        SpottingProgressWidget()
        CommunityActivityWidget()
        LeaderboardWidget()
        LockFleetWidget()
        DailyWidget()             // the existing Cybercab Daily widget, restyled
        ServiceLiveActivity()     // Dynamic Island / Lock Screen, off unless the rider turns it on
    }
}

// MARK: - Shared timeline plumbing

struct CCEntry<Value: Sendable, Config: Sendable>: TimelineEntry {
    let date: Date
    let value: Value?
    /// The last refresh failed: `value` is the kept answer (or nil when nothing was kept).
    let stale: Bool
    /// The gallery and the first load: draw the layout with its numbers redacted.
    let placeholder: Bool
    let config: Config
}

enum CCRefresh {
    /// A fresh answer (kept for next time), else the kept one, marked stale.
    static func fetch<V: Codable & Sendable>(_ key: String, _ load: () async throws -> V) async -> (V?, Bool) {
        if let fresh = try? await load() {
            WidgetCache.save(fresh, key)
            return (fresh, false)
        }
        return (WidgetCache.load(V.self, key), true)
    }
    static func next(minutes: Int, failed: Bool) -> Date {
        Date.now.addingTimeInterval(TimeInterval((failed ? min(minutes, 20) : minutes) * 60))
    }
}

/// What every widget wraps its view in: the card, the placeholder and the
/// "can't reach" state.
struct CCShell<Value, Content: View>: View {
    let value: Value?
    let placeholder: Bool
    let blank: Value
    @ViewBuilder let content: (Value, WidgetSize) -> Content
    @Environment(\.widgetFamily) private var family

    var body: some View {
        let size = WidgetSize(family)
        let accessory = [.circular, .rectangular, .inline].contains(size)
        Group {
            if let value {
                content(value, size)
            } else if placeholder {
                content(blank, size).redacted(reason: .placeholder)
            } else if accessory {
                Label("Cybercab Hunter", systemImage: "wifi.slash")
            } else {
                WidgetMessage(icon: "wifi.slash", title: "Can't reach Cybercab Hunter", message: "It'll try again shortly.")
            }
        }
        .containerBackground(for: .widget) {
            if accessory { Color.clear } else { WidgetCardBackground() }
        }
    }
}

// MARK: - Configuration (App Intents)

enum WidgetCityOption: String, AppEnum {
    case all, austin, dallas
    static var typeDisplayRepresentation: TypeDisplayRepresentation { "City" }
    static var caseDisplayRepresentations: [WidgetCityOption: DisplayRepresentation] { [.all: "All cities", .austin: "Austin", .dallas: "Dallas"] }
    var city: WidgetCity { WidgetCity(rawValue: rawValue) ?? .all }
}

enum WidgetStatisticOption: String, AppEnum {
    case registrations, rides, sightings
    static var typeDisplayRepresentation: TypeDisplayRepresentation { "Statistic" }
    static var caseDisplayRepresentations: [WidgetStatisticOption: DisplayRepresentation] { [.registrations: "Registered Cybercabs", .rides: "Rides", .sightings: "Sightings"] }
    var statistic: FleetStatistic { FleetStatistic(rawValue: rawValue) ?? .registrations }
}

enum WidgetGrowthPeriodOption: String, AppEnum {
    case week, month
    static var typeDisplayRepresentation: TypeDisplayRepresentation { "Growth period" }
    static var caseDisplayRepresentations: [WidgetGrowthPeriodOption: DisplayRepresentation] { [.week: "7 days", .month: "30 days"] }
    var days: Int { self == .month ? 30 : 7 }
}

enum WidgetFeedOption: String, AppEnum {
    case latest, trending, reviews
    static var typeDisplayRepresentation: TypeDisplayRepresentation { "Posts" }
    static var caseDisplayRepresentations: [WidgetFeedOption: DisplayRepresentation] { [.latest: "Latest", .trending: "Trending", .reviews: "Reviews"] }
    var feed: CommunityActivityData.Feed { switch self { case .latest: .latest; case .trending: .trending; case .reviews: .reviews } }
}

struct FleetStatsWidgetIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource { "Fleet Statistics" }
    static var description: IntentDescription { IntentDescription("Choose the city, and the figure the small widget shows.") }
    @Parameter(title: "City", default: .all) var city: WidgetCityOption
    @Parameter(title: "Statistic", default: .registrations) var statistic: WidgetStatisticOption
    init() {}
}

struct FleetGrowthWidgetIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource { "Fleet Growth" }
    static var description: IntentDescription { IntentDescription("Choose the city and the period the chart covers.") }
    @Parameter(title: "City", default: .all) var city: WidgetCityOption
    @Parameter(title: "Period", default: .week) var period: WidgetGrowthPeriodOption
    init() {}
}

struct CommunityActivityWidgetIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource { "Community Activity" }
    static var description: IntentDescription { IntentDescription("Choose which posts the widget lists.") }
    @Parameter(title: "Posts", default: .latest) var feed: WidgetFeedOption
    init() {}
}

// MARK: - Fleet Statistics

struct FleetStatsProvider: AppIntentTimelineProvider {
    typealias Entry = CCEntry<FleetStatsData, FleetStatsWidgetIntent>
    func placeholder(in context: Context) -> Entry { Entry(date: .now, value: nil, stale: false, placeholder: true, config: FleetStatsWidgetIntent()) }
    func snapshot(for configuration: FleetStatsWidgetIntent, in context: Context) async -> Entry {
        if context.isPreview, let kept = WidgetCache.load(FleetStatsData.self, key(configuration)) { return Entry(date: .now, value: kept, stale: false, placeholder: false, config: configuration) }
        return await entry(configuration)
    }
    func timeline(for configuration: FleetStatsWidgetIntent, in context: Context) async -> Timeline<Entry> {
        let e = await entry(configuration)
        return Timeline(entries: [e], policy: .after(CCRefresh.next(minutes: 60, failed: e.stale)))
    }
    private func key(_ c: FleetStatsWidgetIntent) -> String { "fleetStats.\(c.city.rawValue)" }
    private func entry(_ c: FleetStatsWidgetIntent) async -> Entry {
        let (v, stale) = await CCRefresh.fetch(key(c)) { try await FleetStatsData.load(city: c.city.city) }
        return Entry(date: .now, value: v, stale: stale, placeholder: false, config: c)
    }
}

struct FleetStatsWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "CybercabFleet", intent: FleetStatsWidgetIntent.self, provider: FleetStatsProvider()) { e in
            CCShell(value: e.value, placeholder: e.placeholder, blank: .blank(e.config.city.city)) { data, size in
                FleetStatsView(data: data, size: size, statistic: e.config.statistic.statistic, stale: e.stale)
            }
        }
        .configurationDisplayName("Fleet Statistics")
        .description("Registered Cybercabs, recorded rides and sightings, with this week's changes.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

// MARK: - Fleet Growth

struct FleetGrowthProvider: AppIntentTimelineProvider {
    typealias Entry = CCEntry<FleetGrowthData, FleetGrowthWidgetIntent>
    func placeholder(in context: Context) -> Entry { Entry(date: .now, value: nil, stale: false, placeholder: true, config: FleetGrowthWidgetIntent()) }
    func snapshot(for configuration: FleetGrowthWidgetIntent, in context: Context) async -> Entry {
        if context.isPreview, let kept = WidgetCache.load(FleetGrowthData.self, key(configuration)) { return Entry(date: .now, value: kept, stale: false, placeholder: false, config: configuration) }
        return await entry(configuration)
    }
    func timeline(for configuration: FleetGrowthWidgetIntent, in context: Context) async -> Timeline<Entry> {
        let e = await entry(configuration)
        // The registry changes a few times a day: four refreshes a day at most.
        return Timeline(entries: [e], policy: .after(CCRefresh.next(minutes: 360, failed: e.stale)))
    }
    private func key(_ c: FleetGrowthWidgetIntent) -> String { "fleetGrowth.\(c.city.rawValue)" }
    private func entry(_ c: FleetGrowthWidgetIntent) async -> Entry {
        let (v, stale) = await CCRefresh.fetch(key(c)) { try await FleetGrowthData.load(city: c.city.city) }
        return Entry(date: .now, value: v, stale: stale, placeholder: false, config: c)
    }
}

struct FleetGrowthWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "CybercabFleetGrowth", intent: FleetGrowthWidgetIntent.self, provider: FleetGrowthProvider()) { e in
            CCShell(value: e.value, placeholder: e.placeholder, blank: .blank(e.config.city.city)) { data, size in
                FleetGrowthView(data: data, size: size, period: e.config.period.days, stale: e.stale)
            }
        }
        .configurationDisplayName("Fleet Growth")
        .description("The registered fleet over the last week and month, from the Cybercab registry.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

// MARK: - Static widgets (no configuration)

/// A provider for a widget without options: `load` fetches, `key` keeps the last answer.
struct CCStaticProvider<Value: Codable & Sendable>: TimelineProvider {
    typealias Entry = CCEntry<Value, Void>
    let key: String
    let minutes: Int
    let load: @Sendable () async throws -> Value

    func placeholder(in context: Context) -> Entry { Entry(date: .now, value: nil, stale: false, placeholder: true, config: ()) }
    func getSnapshot(in context: Context, completion: @escaping @Sendable (Entry) -> Void) {
        if context.isPreview, let kept = WidgetCache.load(Value.self, key) { completion(Entry(date: .now, value: kept, stale: false, placeholder: false, config: ())); return }
        let (key, load) = (key, load)
        Task { completion(await Self.entry(key, load)) }
    }
    func getTimeline(in context: Context, completion: @escaping @Sendable (Timeline<Entry>) -> Void) {
        let (key, load, minutes) = (key, load, minutes)
        Task {
            let e = await Self.entry(key, load)
            completion(Timeline(entries: [e], policy: .after(CCRefresh.next(minutes: minutes, failed: e.stale))))
        }
    }
    static func entry(_ key: String, _ load: @Sendable () async throws -> Value) async -> Entry {
        let (v, stale) = await CCRefresh.fetch(key, load)
        return Entry(date: .now, value: v, stale: stale, placeholder: false, config: ())
    }
}

struct MilestonesWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "CybercabMilestones", provider: CCStaticProvider(key: "milestones", minutes: 360) { try await MilestonesData.load() }) { e in
            CCShell(value: e.value, placeholder: e.placeholder, blank: MilestonesData(registered: 0, reachedOn: [:], fetchedAt: .distantPast)) { data, size in
                MilestonesView(data: data, size: size, stale: e.stale)
            }
        }
        .configurationDisplayName("Cybercab Milestones")
        .description("How close the registered fleet is to its next milestone, and the ones it has passed.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

struct SpottingProgressWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "CybercabSpottingProgress", provider: CCStaticProvider(key: "progress", minutes: 60) {
            try await SpottingProgressData.load(token: WidgetSession.read())
        }) { e in
            CCShell(value: e.value, placeholder: e.placeholder, blank: SpottingProgressData(signedIn: true, rankName: "Bronze Spotter", fetchedAt: .distantPast)) { data, size in
                SpottingProgressView(data: data, size: size, stale: e.stale)
            }
        }
        .configurationDisplayName("My Spotting Progress")
        .description("Your Spotter rank, level, XP, streak and weekly missions. Sign in to Cybercab Hunter to see them.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

struct CommunityActivityProvider: AppIntentTimelineProvider {
    typealias Entry = CCEntry<CommunityActivityData, CommunityActivityWidgetIntent>
    func placeholder(in context: Context) -> Entry { Entry(date: .now, value: nil, stale: false, placeholder: true, config: CommunityActivityWidgetIntent()) }
    func snapshot(for configuration: CommunityActivityWidgetIntent, in context: Context) async -> Entry {
        if context.isPreview, let kept = WidgetCache.load(CommunityActivityData.self, key(configuration)) { return Entry(date: .now, value: kept, stale: false, placeholder: false, config: configuration) }
        return await entry(configuration)
    }
    func timeline(for configuration: CommunityActivityWidgetIntent, in context: Context) async -> Timeline<Entry> {
        let e = await entry(configuration)
        return Timeline(entries: [e], policy: .after(CCRefresh.next(minutes: 120, failed: e.stale)))
    }
    private func key(_ c: CommunityActivityWidgetIntent) -> String { "community.\(c.feed.rawValue)" }
    private func entry(_ c: CommunityActivityWidgetIntent) async -> Entry {
        let (v, stale) = await CCRefresh.fetch(key(c)) { try await CommunityActivityData.load(feed: c.feed.feed) }
        return Entry(date: .now, value: v, stale: stale, placeholder: false, config: c)
    }
}

struct CommunityActivityWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "CybercabCommunityActivity", intent: CommunityActivityWidgetIntent.self, provider: CommunityActivityProvider()) { e in
            CCShell(value: e.value, placeholder: e.placeholder, blank: .blank(e.config.feed.feed)) { data, size in
                CommunityActivityView(data: data, size: size, stale: e.stale)
            }
        }
        .configurationDisplayName("Community Activity")
        .description("This week in the Cybercab Hunter community, and its newest posts. Tap a post to open it.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

struct LeaderboardWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "CybercabLeaderboard", provider: CCStaticProvider(key: "leaderboard", minutes: 180) {
            try await LeaderboardData.load(token: WidgetSession.read())
        }) { e in
            CCShell(value: e.value, placeholder: e.placeholder, blank: LeaderboardData.blank) { data, size in
                LeaderboardView(data: data, size: size, stale: e.stale)
            }
        }
        .configurationDisplayName("Community Leaderboard")
        .description("The top Cybercab spotters by XP, and your place when you're signed in.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

struct LockFleetWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "CybercabLockFleet", provider: CCStaticProvider(key: "fleetStats.all", minutes: 60) { try await FleetStatsData.load(city: .all) }) { e in
            CCShell(value: e.value, placeholder: e.placeholder, blank: .blank(.all)) { data, size in
                LockFleetView(data: data, size: size)
            }
        }
        .configurationDisplayName("Fleet Statistics")
        .description("Registered Cybercabs and this week's change, on your Lock Screen.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

// MARK: - Cybercab Daily (existing, restyled)

struct DailyWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "CybercabDaily", provider: CCStaticProvider(key: "daily", minutes: 30) { try await FleetSnapshot.load(base: WidgetAPI.base) }) { e in
            CCShell(value: e.value, placeholder: e.placeholder, blank: .placeholder) { data, size in
                DailyWidgetView(snapshot: data, size: size, stale: e.stale, placeholder: e.placeholder)
            }
        }
        .configurationDisplayName("Cybercab Daily")
        .description("Today's new Cybercabs, sightings and camera detections (Central time).")
        .supportedFamilies([.systemSmall, .accessoryRectangular])
    }
}

// MARK: - Placeholder layouts (always redacted; never shown as data)

extension FleetStatsData {
    static func blank(_ city: WidgetCity) -> FleetStatsData {
        FleetStatsData(city: city, registered: 0, rides: 0, sightings: 0, added7d: 0, addedPrev7d: 0, sightings7d: 0, sightingsPrev7d: 0, fetchedAt: .distantPast)
    }
}
extension FleetGrowthData {
    static func blank(_ city: WidgetCity) -> FleetGrowthData {
        FleetGrowthData(city: city, days: (0...30).map { FleetGrowthData.Day(date: "", total: $0, added: 1) }, milestoneDates: [:], fetchedAt: .distantPast)
    }
}
extension CommunityActivityData {
    static func blank(_ feed: Feed) -> CommunityActivityData {
        CommunityActivityData(feed: feed, postsThisWeek: 0, posts: 0, contributors: 0, verifiedThisWeek: 0, recent: [], trending: [], fetchedAt: .distantPast)
    }
}
extension LeaderboardData {
    static let blank = LeaderboardData(entries: (1...5).map { LeaderboardData.Entry(rank: $0, name: "Spotter", xp: 0) }, signedIn: false, fetchedAt: .distantPast)
}
