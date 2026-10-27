import Testing
import Foundation
import SwiftUI
import WidgetKit
@testable import CybercabHunter

// The Home Screen and Lock Screen widgets (Shared/Widgets): their data, read
// from real production answers (Fixtures/widget-*.json, saved Oct 27, 2026)
// and the app's existing community fixtures; milestones; the rider's shared
// session; deep links; and every widget rendered at every size it supports.

private func central(_ s: String) -> Date {
    let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = WidgetClock.central; f.dateFormat = "yyyy-MM-dd HH:mm"
    return f.date(from: s)!
}

private extension StubServer {
    var base: URL { URL(string: "https://\(host)")! }
    var session: URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        return URLSession(configuration: config)
    }
}

private func fleetStub() -> StubServer {
    let s = StubServer()
    s.responses = [
        "GET /api/registry/stats": (200, CommunityStub.fixture("widget-registry-stats")),
        "GET /api/homepage-stats?city=austin": (200, CommunityStub.fixture("widget-homepage-austin")),
        "GET /api/homepage-stats?city=dallas": (200, CommunityStub.fixture("widget-homepage-dallas")),
        "GET /api/daily": (200, CommunityStub.fixture("widget-daily")),
        "GET /api/robotaxi-vehicles?limit=100&offset=0": (200, CommunityStub.fixture("widget-vehicles-0")),
        "GET /api/robotaxi-vehicles?limit=100&offset=100": (200, CommunityStub.fixture("widget-vehicles-100")),
        "GET /api/robotaxi-vehicles?limit=100&offset=200": (200, CommunityStub.fixture("widget-vehicles-200"))
    ]
    return s
}

/// The registry's first-seen instants, straight from the fixture (to check the widget's arithmetic).
private func registryDates() throws -> [Date] {
    struct Page: Decodable { struct V: Decodable { let first_seen_at: String }; let vehicles: [V] }
    return try [0, 100, 200].flatMap { o in try JSONDecoder().decode(Page.self, from: TestFixtures.data("widget-vehicles-\(o)")).vehicles.compactMap { WidgetClock.instant($0.first_seen_at) } }
}

@MainActor
@Suite(.serialized)
struct WidgetTests {
    let now = central("2026-10-27 16:00")

    // MARK: Fleet Statistics

    @Test func fleetStatisticsMatchTheAppsFigures() async throws {
        let s = fleetStub()
        let all = try await FleetStatsData.load(city: .all, base: s.base, session: s.session, now: now)
        #expect(all.registered == 214 && all.rides == 8 && all.sightings == 631, "the app's ALL CITIES row (GET /api/registry/stats)")
        #expect(all.added7d == 32 && all.addedPrev7d == 18, "Austin's 32 + Dallas's 0")
        #expect(all.austin?.registered == 214 && all.dallas?.registered == 0 && all.dallas?.sightings == 55)
        #expect(all.addedToday == 6, "Cybercab Daily's registry figure, for the inline Lock Screen widget")
        let dallas = try await FleetStatsData.load(city: .dallas, base: s.base, session: s.session, now: now)
        #expect(dallas.registered == 0 && dallas.sightings == 55 && dallas.added7d == 0 && dallas.austin == nil)
        // A city that didn't answer leaves the all-cities change unknown, never half a total.
        s.responses["GET /api/homepage-stats?city=dallas"] = (500, "{}")
        let partial = try await FleetStatsData.load(city: .all, base: s.base, session: s.session, now: now)
        #expect(partial.registered == 214 && partial.added7d == nil && partial.dallas == nil)
        // The counters are required: no counters, no widget data (the kept answer stays).
        s.responses["GET /api/registry/stats"] = (503, "{}")
        await #expect(throws: (any Error).self) { _ = try await FleetStatsData.load(city: .all, base: s.base, session: s.session, now: now) }
    }

    // MARK: Fleet Growth

    @Test func fleetGrowthCountsRealRegistrationsOnly() async throws {
        let s = fleetStub()
        let g = try await FleetGrowthData.load(city: .all, base: s.base, session: s.session, now: now)
        let dates = try registryDates()
        var cal = Calendar(identifier: .gregorian); cal.timeZone = WidgetClock.central
        let endToday = cal.date(byAdding: .day, value: 1, to: cal.startOfDay(for: now))!
        let weekAgo = cal.date(byAdding: .day, value: -7, to: endToday)!, monthAgo = cal.date(byAdding: .day, value: -30, to: endToday)!
        #expect(g.total == 214 && g.days.count == 31 && g.days.last?.date == "2026-10-27")
        #expect(g.change(days: 7) == dates.filter { $0 >= weekAgo && $0 < endToday }.count, "the last 7 days, from first-seen dates")
        #expect(g.change(days: 30) == dates.filter { $0 >= monthAgo && $0 < endToday }.count)
        #expect(g.days.map(\.total) == g.days.map(\.total).sorted(), "a running total never falls")
        #expect(g.austin?.total == 214 && g.dallas?.total == 0 && g.dallas?.added30d == 0, "Austin vs Dallas, from each vehicle's service area")
        #expect(g.milestoneDates["100"] != nil && g.milestoneDates["150"] != nil && g.milestoneDates["250"] == nil, "only milestones actually reached have a date")
        #expect(s.requests.count == 3, "three pages of 100: no more requests than the registry needs")
    }

    // MARK: Milestones

    @Test func milestonesAdvanceAndExtend() {
        #expect(FleetMilestones.next(after: 0) == 100 && FleetMilestones.next(after: 99) == 100)
        #expect(FleetMilestones.next(after: 100) == 150, "reaching a milestone moves on to the next")
        #expect(FleetMilestones.next(after: 214) == 250 && FleetMilestones.next(after: 250) == 500 && FleetMilestones.next(after: 999) == 1000)
        #expect(FleetMilestones.next(after: 1000) == 2500 && FleetMilestones.next(after: 2500) == 5000 && FleetMilestones.next(after: 5000) == 10000 && FleetMilestones.next(after: 10000) == 25000)
        #expect(FleetMilestones.passed(214) == [100, 150] && FleetMilestones.passed(99).isEmpty)
        #expect(abs(FleetMilestones.progress(214) - 0.856) < 0.0001)
        #expect(FleetMilestones.upcoming(after: 214, count: 3) == [250, 500, 1000])
        let m = MilestonesData(registered: 214, reachedOn: [:], fetchedAt: now)
        #expect(m.next == 250 && m.remaining == 36 && m.passed == [100, 150])
    }

    // MARK: My Spotting Progress (the rider's own data)

    @Test func spottingProgressNeedsTheRidersSession() async throws {
        let s = StubServer()
        s.responses = ["GET /api/xp/me": (200, CommunityStub.fixture("xp-me")), "GET /api/streaks/me": (200, CommunityStub.fixture("streaks-me"))]
        let out = try await SpottingProgressData.load(token: nil, base: s.base, session: s.session, now: now)
        #expect(!out.signedIn && s.requests.isEmpty, "signed out: nothing personal is fetched")
        let p = try await SpottingProgressData.load(token: "t-1", base: s.base, session: s.session, now: now)
        #expect(p.signedIn && p.xp == 740 && p.level == 5 && p.rankName == "Bronze Spotter" && p.nextRankName == "Silver Spotter" && p.nextRankNeeded == 260)
        #expect(p.dailyStreak == 4 && p.dailyDone == true && p.weeklyStreak == 5)
        #expect(!p.weekly.isEmpty && p.weekly[0].title == "Weekly Spotter" && p.weekly[0].done)
        #expect(s.requests.allSatisfy { $0.0.value(forHTTPHeaderField: "Authorization") == "Bearer t-1" })
        s.responses["GET /api/xp/me"] = (401, #"{"authenticated":false}"#)
        #expect(!(try await SpottingProgressData.load(token: "expired", base: s.base, session: s.session, now: now)).signedIn, "an expired session shows the signed-out state")
    }

    @Test func theSessionIsSharedWithTheWidgetsOnlyThroughTheSharedKeychainGroup() {
        let before = WidgetSession.read()
        defer { WidgetSession.write(before) }
        #expect(WidgetSession.group?.hasSuffix(".com.cybercabhunter.shared") == true, "the shared group, with this team's prefix")
        #expect(WidgetSession.write("widget-test-token"))
        #expect(WidgetSession.read() == "widget-test-token")
        #expect(!WidgetSession.write("widget-test-token"), "unchanged: the widgets aren't reloaded")
        WidgetSession.write(nil)
        #expect(WidgetSession.read() == nil, "signed out: removed")
    }

    // MARK: Community

    @Test func communityActivityIsPublicTextOnly() async throws {
        let s = StubServer()
        s.responses = [
            "GET /api/social/sidebar": (200, CommunityStub.fixture("social-sidebar")),
            "GET /api/social/feed": (200, CommunityStub.fixture("social-feed-latest")),
            "GET /api/community/summary": (200, CommunityStub.fixture("widget-community-summary"))
        ]
        let c = try await CommunityActivityData.load(feed: .latest, base: s.base, session: s.session, now: now)
        #expect(c.postsThisWeek == 10 && c.posts == 14 && c.contributors == 3)
        #expect(c.verifiedThisWeek == 23 && c.missionsThisWeek == 3, "this week's spotting, from the community summary")
        #expect(!c.recent.isEmpty && c.recent.allSatisfy { !$0.excerpt.contains("\n") && $0.excerpt.count <= 140 })
        #expect(!c.trending.isEmpty)
        #expect(s.requests.allSatisfy { $0.0.value(forHTTPHeaderField: "Authorization") == nil }, "as a signed-out visitor sees it: hidden and private posts never reach a widget")
        #expect(s.requests.contains { $0.0.url?.query?.contains("filter=latest") == true })
        #expect(CommunityActivityData.excerpt("Line one\nLine two") == "Line one Line two")
    }

    @Test func leaderboardFindsTheSignedInRider() async throws {
        let s = StubServer()
        s.responses = [
            "GET /api/community/leaderboard": (200, CommunityStub.fixture("leaderboard-xp")),
            "GET /api/me": (200, #"{"authenticated":true,"user":{"id":"u1","handle":"alice_a"}}"#)
        ]
        let signedOut = try await LeaderboardData.load(token: nil, base: s.base, session: s.session, now: now)
        #expect(!signedOut.entries.isEmpty && signedOut.entries[0].rank == 1 && signedOut.me == nil && !signedOut.signedIn)
        #expect(s.requests.allSatisfy { $0.0.url?.path != "/api/me" } && s.requests.contains { $0.0.url?.query == "board=xp" })
        let mine = try await LeaderboardData.load(token: "t-1", base: s.base, session: s.session, now: now)
        #expect(mine.me?.handle == "alice_a" && mine.signedIn)
    }

    // MARK: Deep links

    @Test func widgetLinksOpenTheRightScreens() {
        let r = AppRouter()
        #expect(r.open(widgetURL: WidgetLink.community("leaderboard")) && r.selectedTab == .community && r.communitySection == .leaderboard)
        #expect(r.open(widgetURL: WidgetLink.community("progress")) && r.communitySection == .progress)
        #expect(r.open(widgetURL: WidgetLink.post("8dd9ea0d6eb60d422bb32429a0ec8d5f")) && r.selectedTab == .community && r.communityPath.count == 1)
        #expect(r.open(widgetURL: WidgetLink.url("registry")) && r.selectedTab == .registry)
        #expect(r.open(widgetURL: WidgetLink.url("home")) && r.selectedTab == .home)
        #expect(WidgetLink.url("zones", city: "dallas").absoluteString == "cybercabhunter-widget://zones?city=dallas", "the existing link format is unchanged")
    }

    @Test func theCacheKeepsTheLastAnswer() {
        let d = UserDefaults(suiteName: "widget-\(UUID().uuidString)")!
        let m = MilestonesData(registered: 214, reachedOn: ["100": "2026-09-25"], fetchedAt: now)
        WidgetCache.save(m, "milestones", defaults: d)
        #expect(WidgetCache.load(MilestonesData.self, "milestones", defaults: d) == m)
        #expect(WidgetCache.load(MilestonesData.self, "missing", defaults: d) == nil)
    }

    // MARK: Every widget at every size

    @Test func everyWidgetRendersAndFits() async throws {
        let dir = "/tmp/cch-shots/widgets"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let s = fleetStub()
        let stats = try await FleetStatsData.load(city: .all, base: s.base, session: s.session, now: now)
        let austin = try await FleetStatsData.load(city: .austin, base: s.base, session: s.session, now: now)
        let growth = try await FleetGrowthData.load(city: .all, base: s.base, session: s.session, now: now)
        let milestones = MilestonesData(registered: stats.registered, reachedOn: growth.milestoneDates, fetchedAt: now)
        let c = StubServer()
        c.responses = [
            "GET /api/social/sidebar": (200, CommunityStub.fixture("social-sidebar")),
            "GET /api/social/feed": (200, CommunityStub.fixture("social-feed-latest")),
            "GET /api/community/summary": (200, CommunityStub.fixture("widget-community-summary")),
            "GET /api/xp/me": (200, CommunityStub.fixture("xp-me")), "GET /api/streaks/me": (200, CommunityStub.fixture("streaks-me")),
            "GET /api/community/leaderboard": (200, CommunityStub.fixture("leaderboard-xp")),
            "GET /api/me": (200, #"{"authenticated":true,"user":{"handle":"alice_a"}}"#)
        ]
        let community = try await CommunityActivityData.load(feed: .latest, base: c.base, session: c.session, now: now)
        var quiet = community; quiet.recent = []; quiet.trending = []; quiet.postsThisWeek = 0   // production today: no posts yet
        let progress = try await SpottingProgressData.load(token: "t", base: c.base, session: c.session, now: now)
        let board = try await LeaderboardData.load(token: "t", base: c.base, session: c.session, now: now)
        let daily = FleetSnapshot(registered: 214, rides: 8, sightings: 631, date: "2026-10-27", todayNewCybercabs: 6, todaySightings: 10, todayDetections: 8, fetchedAt: now)

        let home: [WidgetSize] = [.small, .medium, .large]
        let sets: [(String, [WidgetSize], (WidgetSize) -> AnyView)] = [
            ("fleet-statistics", home, { AnyView(FleetStatsView(data: stats, size: $0)) }),
            ("fleet-statistics-austin-sightings", home, { AnyView(FleetStatsView(data: austin, size: $0, statistic: .sightings)) }),
            ("fleet-growth", home, { AnyView(FleetGrowthView(data: growth, size: $0, period: 30)) }),
            ("milestones", home, { AnyView(MilestonesView(data: milestones, size: $0)) }),
            ("spotting-progress", home, { AnyView(SpottingProgressView(data: progress, size: $0)) }),
            ("spotting-progress-signed-out", home, { AnyView(SpottingProgressView(data: .signedOut, size: $0)) }),
            ("community-activity", home, { AnyView(CommunityActivityView(data: community, size: $0)) }),
            ("community-activity-no-posts", home, { AnyView(CommunityActivityView(data: quiet, size: $0)) }),
            ("leaderboard", home, { AnyView(LeaderboardView(data: board, size: $0)) }),
            ("lock-fleet", [.circular, .rectangular, .inline], { AnyView(LockFleetView(data: stats, size: $0)) }),
            ("daily", [.small, .rectangular], { AnyView(DailyWidgetView(snapshot: daily, size: $0)) }),
            ("fleet-statistics-offline", [.small, .medium], { AnyView(FleetStatsView(data: stats, size: $0, stale: true)) })
        ]
        for (name, sizes, make) in sets {
            for size in sizes {
                let accessory = [.circular, .rectangular, .inline].contains(size)
                let canvas = size.canvas, inset: CGFloat = accessory ? 0 : 16
                // It fits: the content's own height inside the widget's margins.
                let natural = ImageRenderer(content: make(size).frame(width: canvas.width - inset * 2).fixedSize(horizontal: false, vertical: true).environment(\.colorScheme, .dark))
                let h = try #require(natural.uiImage, "\(name) \(size)").size.height
                #expect(h <= canvas.height - inset * 2 + 0.5, "\(name) \(size): \(h) pt tall in \(canvas.height - inset * 2)")
                for scheme in accessory ? [ColorScheme.dark] : [.dark, .light] {
                    let card = make(size).padding(inset).frame(width: canvas.width, height: canvas.height)
                        .background { if accessory { Color.black.opacity(0.55) } else { WidgetCardBackground() } }
                        .containerShape(.rect(cornerRadius: accessory ? 12 : 22)).clipShape(.rect(cornerRadius: accessory ? (size == .circular ? 36 : 12) : 22))
                        .padding(14).background(scheme == .dark ? Color(white: 0.16) : Color(white: 0.88)).environment(\.colorScheme, scheme)
                    let r = ImageRenderer(content: card); r.scale = 3
                    let image = try #require(r.uiImage)
                    try image.pngData()?.write(to: URL(fileURLWithPath: "\(dir)/\(name)-\(size)-\(scheme == .dark ? "dark" : "light").png"))
                }
            }
        }
    }
}
