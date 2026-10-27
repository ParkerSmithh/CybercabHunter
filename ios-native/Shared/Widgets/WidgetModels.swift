import Foundation

// The Home Screen and Lock Screen widgets' data (CybercabHunterWidgets), read
// from the same public endpoints the app's Home and Community screens use, and
// (My Spotting Progress, the leaderboard's "You") the rider's own session.
// Compiled into the app as well so its tests can decode real answers and
// render every widget. Nothing here is estimated: a figure the server didn't
// send stays nil, and the views say so.

/// cybercabhunter.com's API, as a widget reads it: short timeouts, no retries
/// (WidgetKit's timeline decides when to ask again).
enum WidgetAPI {
    static let base = URL(string: "https://cybercabhunter.com")!

    enum Failure: Error, Equatable { case http(Int), unauthorized }

    static func get(_ path: String, query: [String: String] = [:], token: String? = nil,
                    base: URL = base, session: URLSession = .shared) async throws -> Data {
        var components = URLComponents(url: base.appending(path: path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) } }
        var request = URLRequest(url: components.url!)
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 { throw Failure.unauthorized }
        guard (200..<300).contains(status) else { throw Failure.http(status) }
        return data
    }

    static func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(type, from: data)
    }
}

/// The last answer each widget got, kept so a failed refresh never blanks it.
enum WidgetCache {
    static func save<T: Encodable>(_ value: T, _ key: String, defaults: UserDefaults = .standard) {
        if let data = try? JSONEncoder().encode(value) { defaults.set(data, forKey: "widget.\(key)") }
    }
    static func load<T: Decodable>(_ type: T.Type, _ key: String, defaults: UserDefaults = .standard) -> T? {
        defaults.data(forKey: "widget.\(key)").flatMap { try? JSONDecoder().decode(type, from: $0) }
    }
}

enum WidgetCity: String, Codable, CaseIterable, Sendable {
    case all, austin, dallas
    var title: String { self == .all ? "All cities" : rawValue.capitalized }
}

/// Central time, as the site counts days.
enum WidgetClock {
    static let central = TimeZone(identifier: "America/Chicago")!
    static func dayKey(_ date: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = central; f.dateFormat = "yyyy-MM-dd"
        return f.string(from: date)
    }
    /// The registry's "2026-09-25 05:31:37" (UTC) or an ISO 8601 instant.
    static func instant(_ s: String?) -> Date? {
        guard let s else { return nil }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(identifier: "UTC"); f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        if let d = f.date(from: s) { return d }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = iso.date(from: s) { return d }
        iso.formatOptions = [.withInternetDateTime]
        return iso.date(from: s)
    }
}

// MARK: - Fleet Statistics (and the Lock Screen widgets)

/// GET /api/registry/stats (all cities, the app's ALL CITIES row) or
/// GET /api/homepage-stats?city= (one city, the app's city row).
struct FleetStatsData: Codable, Equatable, Sendable {
    struct CityFigures: Codable, Equatable, Sendable {
        var registered: Int
        var rides: Int
        var sightings: Int
        var added7d: Int?
    }
    var city: WidgetCity
    var registered: Int
    var rides: Int
    var sightings: Int
    /// Registry vehicles added in the last 7 days and the 7 before (nil when the server didn't say).
    var added7d: Int?
    var addedPrev7d: Int?
    var sightings7d: Int?
    var sightingsPrev7d: Int?
    /// All cities: registry vehicles added today (Central), from Cybercab Daily.
    var addedToday: Int?
    /// All cities: Austin and Dallas on their own (best effort).
    var austin: CityFigures?
    var dallas: CityFigures?
    var fetchedAt: Date

    private struct Stats: Decodable { let publicVehicles: Int; let recordedRides: Int; let sightingsAllTime: Int }
    private struct Daily: Decodable { struct Day: Decodable { let registry: Int? }; let day: Day }
    struct Homepage: Decodable {
        struct Hero: Decodable { struct City: Decodable { let vehicles: Int; let rides: Int; let sightings: Int }; let city: City }
        struct Area: Decodable {
            let vehiclesAdded7d: Int?
            let vehiclesAddedPrev7d: Int?
            // convertFromSnakeCase turns "vehicles_added_7d" into "vehiclesAdded7D".
            enum CodingKeys: String, CodingKey { case vehiclesAdded7d = "vehiclesAdded7D", vehiclesAddedPrev7d = "vehiclesAddedPrev7D" }
        }
        struct Sightings: Decodable { let last7Days: Int?; let prev7Days: Int? }
        let hero: Hero
        let area: Area?
        let sightings: Sightings?
        var figures: CityFigures { CityFigures(registered: hero.city.vehicles, rides: hero.city.rides, sightings: hero.city.sightings, added7d: area?.vehiclesAdded7d) }
    }

    static func load(city: WidgetCity, base: URL = WidgetAPI.base, session: URLSession = .shared, now: Date = .now) async throws -> FleetStatsData {
        func page(_ c: WidgetCity) async throws -> Homepage {
            try WidgetAPI.decode(Homepage.self, try await WidgetAPI.get("/api/homepage-stats", query: ["city": c.rawValue], base: base, session: session))
        }
        if city != .all {
            let h = try await page(city)
            return FleetStatsData(city: city, registered: h.hero.city.vehicles, rides: h.hero.city.rides, sightings: h.hero.city.sightings,
                                  added7d: h.area?.vehiclesAdded7d, addedPrev7d: h.area?.vehiclesAddedPrev7d,
                                  sightings7d: h.sightings?.last7Days, sightingsPrev7d: h.sightings?.prev7Days, fetchedAt: now)
        }
        async let statsData = WidgetAPI.get("/api/registry/stats", base: base, session: session)
        async let a = try? page(.austin)
        async let d = try? page(.dallas)
        async let daily = try? WidgetAPI.get("/api/daily", base: base, session: session)
        let stats = try WidgetAPI.decode(Stats.self, try await statsData)
        let (austin, dallas) = await (a, d)
        let today = (await daily).flatMap { try? WidgetAPI.decode(Daily.self, $0) }?.day.registry
        return FleetStatsData(city: .all, registered: stats.publicVehicles, rides: stats.recordedRides, sightings: stats.sightingsAllTime,
                              added7d: sum(austin?.area?.vehiclesAdded7d, dallas?.area?.vehiclesAdded7d),
                              addedPrev7d: sum(austin?.area?.vehiclesAddedPrev7d, dallas?.area?.vehiclesAddedPrev7d),
                              sightings7d: sum(austin?.sightings?.last7Days, dallas?.sightings?.last7Days),
                              sightingsPrev7d: sum(austin?.sightings?.prev7Days, dallas?.sightings?.prev7Days),
                              addedToday: today, austin: austin?.figures, dallas: dallas?.figures, fetchedAt: now)
    }

    /// Both cities' figures, or nil when either is missing (never a half total).
    private static func sum(_ a: Int?, _ b: Int?) -> Int? { a.flatMap { a in b.map { a + $0 } } }
}

// MARK: - Fleet Growth and Milestones

/// The registry (GET /api/robotaxi-vehicles, page by page, as the app's fleet
/// growth chart reads it): each vehicle counted from the day it was first seen,
/// by Central date. Only real registrations: no projection.
struct FleetGrowthData: Codable, Equatable, Sendable {
    struct Day: Codable, Equatable, Sendable { var date: String; var total: Int; var added: Int }
    struct CitySplit: Codable, Equatable, Sendable { var total: Int; var added7d: Int; var added30d: Int }
    var city: WidgetCity
    /// The last 31 Central days, oldest first, ending today (so the first point is 30 days ago).
    var days: [Day]
    var austin: CitySplit?
    var dallas: CitySplit?
    /// The date (yyyy-MM-dd, Central) the registry reached each milestone it has passed.
    var milestoneDates: [String: String]
    var fetchedAt: Date

    var total: Int { days.last?.total ?? 0 }
    /// Added over the last `n` days (nil without that much history).
    func change(days n: Int) -> Int? {
        guard days.count > n else { return nil }
        return days[days.count - 1].total - days[days.count - 1 - n].total
    }
    func series(days n: Int) -> [Day] { Array(days.suffix(n + 1)) }

    struct Vehicle: Decodable { let serviceArea: String?; let firstSeenAt: String? }
    struct Page: Decodable { let vehicles: [Vehicle]; let total: Int }

    static func load(city: WidgetCity, base: URL = WidgetAPI.base, session: URLSession = .shared, now: Date = .now) async throws -> FleetGrowthData {
        var all: [Vehicle] = []
        var offset = 0
        while true {
            var query = ["limit": "100", "offset": String(offset)]
            if city != .all { query["city"] = city.rawValue }
            let page = try WidgetAPI.decode(Page.self, try await WidgetAPI.get("/api/robotaxi-vehicles", query: query, base: base, session: session))
            all += page.vehicles
            offset += page.vehicles.count
            if page.vehicles.isEmpty || offset >= page.total || offset >= 5000 { break }
        }
        return build(city: city, vehicles: all, now: now)
    }

    static func build(city: WidgetCity, vehicles: [Vehicle], now: Date) -> FleetGrowthData {
        let seen = vehicles.compactMap { v in WidgetClock.instant(v.firstSeenAt).map { (v.serviceArea?.lowercased(), $0) } }
        let dates = seen.map(\.1).sorted()
        var cal = Calendar(identifier: .gregorian); cal.timeZone = WidgetClock.central
        let today = cal.startOfDay(for: now)
        var days: [Day] = []
        for back in stride(from: 30, through: 0, by: -1) {
            let start = cal.date(byAdding: .day, value: -back, to: today)!
            let end = cal.date(byAdding: .day, value: 1, to: start)!
            let total = dates.filter { $0 < end }.count
            days.append(Day(date: WidgetClock.dayKey(start), total: total, added: dates.filter { $0 >= start && $0 < end }.count))
        }
        func split(_ name: String) -> CitySplit {
            let mine = seen.filter { $0.0 == name }.map(\.1)
            let d7 = cal.date(byAdding: .day, value: -6, to: today)!, d30 = cal.date(byAdding: .day, value: -29, to: today)!
            return CitySplit(total: mine.count, added7d: mine.filter { $0 >= d7 }.count, added30d: mine.filter { $0 >= d30 }.count)
        }
        var reached: [String: String] = [:]
        for m in FleetMilestones.passed(dates.count) where m <= dates.count { reached[String(m)] = WidgetClock.dayKey(dates[m - 1]) }
        return FleetGrowthData(city: city, days: days, austin: city == .all ? split("austin") : nil, dallas: city == .all ? split("dallas") : nil,
                               milestoneDates: reached, fetchedAt: now)
    }
}

/// Registered-fleet milestones: 100, 150, 250, 500, 1,000, then 2,500, 5,000,
/// 10,000, 25,000… (always one ahead of the fleet).
enum FleetMilestones {
    static func ladder(through n: Int) -> [Int] {
        var out = [100, 150, 250, 500, 1000]
        var step = [2.5, 2, 2]   // 1,000 → 2,500 → 5,000 → 10,000 → 25,000 …
        var i = 0
        while out.last! <= n {
            out.append(Int((Double(out.last!) * step[i % 3]).rounded()))
            i += 1
            if i > 60 { step = [2] }   // never runs away
        }
        return out
    }
    /// The first milestone above `n` (reaching a milestone moves on to the next).
    static func next(after n: Int) -> Int { ladder(through: n).first { $0 > n }! }
    static func passed(_ n: Int) -> [Int] { ladder(through: n).filter { $0 <= n } }
    static func upcoming(after n: Int, count: Int) -> [Int] { Array(ladder(through: n * 30 + 1000).filter { $0 > n }.prefix(count)) }
    /// Share of the way to the next milestone, counted from zero (214 of 250 → 0.856).
    static func progress(_ n: Int) -> Double { min(1, Double(n) / Double(next(after: n))) }
}

/// Milestones: the registered fleet (the app's ALL CITIES figure) and, when
/// the registry list loaded, the dates the earlier milestones were reached.
struct MilestonesData: Codable, Equatable, Sendable {
    var registered: Int
    var reachedOn: [String: String]
    var fetchedAt: Date

    var next: Int { FleetMilestones.next(after: registered) }
    var remaining: Int { next - registered }
    var progress: Double { FleetMilestones.progress(registered) }
    var passed: [Int] { FleetMilestones.passed(registered) }

    static func load(base: URL = WidgetAPI.base, session: URLSession = .shared, now: Date = .now) async throws -> MilestonesData {
        struct Stats: Decodable { let publicVehicles: Int }
        async let statsData = WidgetAPI.get("/api/registry/stats", base: base, session: session)
        async let growth = try? FleetGrowthData.load(city: .all, base: base, session: session, now: now)
        let stats = try WidgetAPI.decode(Stats.self, try await statsData)
        return MilestonesData(registered: stats.publicVehicles, reachedOn: (await growth)?.milestoneDates ?? [:], fetchedAt: now)
    }
}

// MARK: - My Spotting Progress

/// GET /api/xp/me and /api/streaks/me with the rider's session (shared by the
/// app through WidgetSession). Signed out: nothing personal is fetched or shown.
struct SpottingProgressData: Codable, Equatable, Sendable {
    struct Mission: Codable, Equatable, Sendable { var title: String; var progress: Int; var required: Int; var reward: Int; var done: Bool }
    var signedIn: Bool
    var xp: Int = 0
    var level: Int = 0
    var levelInto: Int = 0
    var levelSpan: Int?
    var rankName: String = ""
    var rankKey: String = ""
    var nextRankName: String?
    var nextRankNeeded: Int?
    var dailyStreak: Int?
    var dailyDone: Bool?
    var weeklyStreak: Int?
    var weeklyDone: Bool?
    var weekly: [Mission] = []
    var daily: [Mission] = []
    var fetchedAt: Date

    var levelProgress: Double { levelSpan.map { $0 > 0 ? min(1, Double(levelInto) / Double($0)) : 1 } ?? 1 }

    static let signedOut = SpottingProgressData(signedIn: false, fetchedAt: .distantPast)

    struct XP: Decodable {
        struct Level: Decodable { let n: Int; let into: Int; let span: Int? }
        struct Rank: Decodable { struct Next: Decodable { let name: String; let needed: Int }; let key: String; let name: String; let next: Next? }
        struct M: Decodable { let title: String; let progress: Int; let required: Int; let reward: Int; let state: String }
        struct Missions: Decodable { let daily: [M]; let weekly: [M] }
        let xp: Int; let level: Level; let rank: Rank; let missions: Missions
    }
    struct Streaks: Decodable {
        struct Run: Decodable { let current: Int; let todayDone: Bool?; let weekDone: Bool? }
        let daily: Run; let weekly: Run
    }

    static func load(token: String?, base: URL = WidgetAPI.base, session: URLSession = .shared, now: Date = .now) async throws -> SpottingProgressData {
        guard let token else { return .signedOut }
        do {
            async let x = WidgetAPI.get("/api/xp/me", token: token, base: base, session: session)
            async let s = try? WidgetAPI.get("/api/streaks/me", token: token, base: base, session: session)
            let xp = try WidgetAPI.decode(XP.self, try await x)
            let streaks = (await s).flatMap { try? WidgetAPI.decode(Streaks.self, $0) }
            func mission(_ m: XP.M) -> Mission { Mission(title: m.title, progress: m.progress, required: m.required, reward: m.reward, done: m.state == "completed" || m.progress >= m.required) }
            return SpottingProgressData(signedIn: true, xp: xp.xp, level: xp.level.n, levelInto: xp.level.into, levelSpan: xp.level.span,
                                        rankName: xp.rank.name, rankKey: xp.rank.key, nextRankName: xp.rank.next?.name, nextRankNeeded: xp.rank.next?.needed,
                                        dailyStreak: streaks?.daily.current, dailyDone: streaks?.daily.todayDone,
                                        weeklyStreak: streaks?.weekly.current, weeklyDone: streaks?.weekly.weekDone,
                                        weekly: xp.missions.weekly.map(mission), daily: xp.missions.daily.map(mission), fetchedAt: now)
        } catch WidgetAPI.Failure.unauthorized {
            return .signedOut
        }
    }
}

// MARK: - Community Activity

/// GET /api/social/sidebar (posts this week, trending), /api/social/feed (the
/// newest public posts, as a signed-out visitor sees them: hidden and private
/// posts never reach a widget) and /api/community/summary (spotting this week).
/// Text only: no photos.
struct CommunityActivityData: Codable, Equatable, Sendable {
    enum Feed: String, Codable, CaseIterable, Sendable {
        case latest, trending = "foryou", reviews
        var title: String { switch self { case .latest: "Latest"; case .trending: "Trending"; case .reviews: "Reviews" } }
    }
    struct Post: Codable, Equatable, Sendable, Identifiable {
        var id: String
        var category: String
        var excerpt: String
        var author: String?
        var createdAt: Date?
        var likes: Int
        var comments: Int
    }
    var feed: Feed
    var postsThisWeek: Int?
    var posts: Int?
    var contributors: Int?
    var verifiedThisWeek: Int?
    var activeStreaks: Int?
    var missionsThisWeek: Int?
    var recent: [Post]
    var trending: [Post]
    var fetchedAt: Date

    struct Sidebar: Decodable {
        struct Stats: Decodable { let posts: Int; let contributors: Int; let postsThisWeek: Int }
        struct Trending: Decodable { let id: String; let category: String; let excerpt: String; let likeCount: Int; let commentCount: Int }
        let stats: Stats; let trending: [Trending]
    }
    struct FeedPage: Decodable {
        struct P: Decodable {
            struct Author: Decodable { let name: String; let anonymous: Bool }
            let id: String; let body: String; let category: String; let createdAt: String; let author: Author
            let likeCount: Int; let commentCount: Int; let removed: Bool
        }
        let posts: [P]
    }
    struct Summary: Decodable {
        struct Streaks: Decodable { let activeDaily: Int?; let verifiedThisWeek: Int? }
        struct XP: Decodable { let missionsThisWeek: Int? }
        let streaks: Streaks?; let xp: XP?
    }

    static func excerpt(_ body: String, limit: Int = 140) -> String {
        let flat = body.split(whereSeparator: \.isNewline).joined(separator: " ").trimmingCharacters(in: .whitespaces)
        return flat.count > limit ? String(flat.prefix(limit - 1)) + "…" : flat
    }

    static func load(feed: Feed, base: URL = WidgetAPI.base, session: URLSession = .shared, now: Date = .now) async throws -> CommunityActivityData {
        async let sidebarData = WidgetAPI.get("/api/social/sidebar", base: base, session: session)
        async let feedData = try? WidgetAPI.get("/api/social/feed", query: ["filter": feed.rawValue, "limit": "6"], base: base, session: session)
        async let summaryData = try? WidgetAPI.get("/api/community/summary", base: base, session: session)
        let sidebar = try WidgetAPI.decode(Sidebar.self, try await sidebarData)
        let page = (await feedData).flatMap { try? WidgetAPI.decode(FeedPage.self, $0) }
        let summary = (await summaryData).flatMap { try? WidgetAPI.decode(Summary.self, $0) }
        let recent = (page?.posts ?? []).filter { !$0.removed }.map {
            Post(id: $0.id, category: $0.category, excerpt: excerpt($0.body), author: $0.author.anonymous ? "Anonymous" : $0.author.name,
                 createdAt: WidgetClock.instant($0.createdAt), likes: $0.likeCount, comments: $0.commentCount)
        }
        let trending = sidebar.trending.map { Post(id: $0.id, category: $0.category, excerpt: excerpt($0.excerpt), author: nil, createdAt: nil, likes: $0.likeCount, comments: $0.commentCount) }
        return CommunityActivityData(feed: feed, postsThisWeek: sidebar.stats.postsThisWeek, posts: sidebar.stats.posts, contributors: sidebar.stats.contributors,
                                     verifiedThisWeek: summary?.streaks?.verifiedThisWeek, activeStreaks: summary?.streaks?.activeDaily,
                                     missionsThisWeek: summary?.xp?.missionsThisWeek, recent: recent, trending: trending, fetchedAt: now)
    }

    static func categoryTitle(_ c: String) -> String {
        switch c { case "sighting": "Sighting"; case "review": "Review"; case "question": "Question"; case "news": "News"; default: "General" }
    }
}

// MARK: - Community Leaderboard

/// GET /api/community/leaderboard?board=xp: the public Top XP board (only
/// riders who show on the public leaderboard; the server applies privacy).
/// With the rider's session, /api/me says which entry is theirs.
struct LeaderboardData: Codable, Equatable, Sendable {
    struct Entry: Codable, Equatable, Sendable, Identifiable {
        var rank: Int
        var name: String
        var xp: Int
        var level: Int?
        var rankName: String?
        var rankKey: String?
        var handle: String?
        var id: String { "\(rank)-\(handle ?? name)" }
    }
    var entries: [Entry]
    var spotters: Int?
    /// The signed-in rider's entry, when they are on the board.
    var me: Entry?
    var signedIn: Bool
    var fetchedAt: Date

    struct Board: Decodable {
        struct E: Decodable { let rank: Int; let name: String; let handle: String?; let xp: Int?; let score: Int?; let level: Int?; let spotterRank: String?; let spotterRankKey: String? }
        struct Totals: Decodable { let spotters: Int? }
        let entries: [E]; let totals: Totals?
    }
    struct Me: Decodable { struct U: Decodable { let handle: String? }; let authenticated: Bool?; let user: U? }

    static func load(token: String?, base: URL = WidgetAPI.base, session: URLSession = .shared, now: Date = .now) async throws -> LeaderboardData {
        async let boardData = WidgetAPI.get("/api/community/leaderboard", query: ["board": "xp"], base: base, session: session)
        async let meData: Data? = token == nil ? nil : try? WidgetAPI.get("/api/me", token: token, base: base, session: session)
        let board = try WidgetAPI.decode(Board.self, try await boardData)
        let handle = (await meData).flatMap { try? WidgetAPI.decode(Me.self, $0) }?.user?.handle
        let entries = board.entries.map { Entry(rank: $0.rank, name: $0.name, xp: $0.xp ?? $0.score ?? 0, level: $0.level, rankName: $0.spotterRank, rankKey: $0.spotterRankKey, handle: $0.handle) }
        return LeaderboardData(entries: entries, spotters: board.totals?.spotters,
                               me: handle.flatMap { h in entries.first { $0.handle == h } }, signedIn: handle != nil, fetchedAt: now)
    }
}
