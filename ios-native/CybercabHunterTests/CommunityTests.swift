import Testing
import Foundation
import ImageIO
import UniformTypeIdentifiers
@testable import CybercabHunter

// Phase 4: Community. The fixtures are real Worker responses, produced by the
// Worker's own code over an isolated database (scripts/community-test-server.mjs
// --fixtures): production has no Social posts to save yet, and nothing here
// was written by hand.

private struct Token: TokenProvider { let token: String?; func currentToken() -> String? { token } }

/// One test's own fake Worker: answers by "METHOD /path" and records each
/// request with its body. Every StubServer has its own host, so tests running
/// in parallel never share or overwrite each other's answers.
final class StubServer: @unchecked Sendable {
    let host = "s\(UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "")).stub.test"
    private let lock = NSLock()
    private var _responses: [String: (Int, String)] = [:]
    private var _requests: [(URLRequest, Data)] = []

    init() { StubProtocol.register(self) }

    var responses: [String: (Int, String)] {
        get { lock.withLock { _responses } }
        set { lock.withLock { _responses = newValue } }
    }
    var requests: [(URLRequest, Data)] {
        get { lock.withLock { _requests } }
        set { lock.withLock { _requests = newValue } }
    }
    fileprivate func record(_ r: URLRequest, _ body: Data) { lock.withLock { _requests.append((r, body)) } }

    func api(token: String? = "s-test") -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        return APIClient(baseURL: URL(string: "https://\(host)")!, session: URLSession(configuration: config), tokens: Token(token: token))
    }
}

/// Routes each request to the StubServer named by its host.
final class StubProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var servers: [String: StubServer] = [:]
    static func register(_ s: StubServer) { lock.withLock { servers[s.host] = s } }
    private static func server(_ host: String?) -> StubServer? { lock.withLock { host.flatMap { servers[$0] } } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var body = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 65536)
            while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; body.append(buffer, count: n) }
            stream.close()
        }
        let stub = Self.server(request.url?.host())
        stub?.record(request, body)
        let key = "\(request.httpMethod ?? "GET") \(request.url?.path ?? "")"
        // Query-specific stubs allow city-isolation tests; existing path stubs still work.
        let queryKey = key + (request.url?.query.map { "?" + $0 } ?? "")
        let (status, text) = stub?.responses[queryKey] ?? stub?.responses[key] ?? (404, #"{"success":false,"error":"not_found"}"#)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(text.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

/// The saved fixtures (real Worker responses) as stub answers.
enum CommunityStub {
    static func fixture(_ name: String) -> String { String(decoding: (try? TestFixtures.data(name)) ?? Data(), as: UTF8.self) }
    /// An error fixture ({ status, body }) as a stub answer.
    static func errorFixture(_ name: String) -> (Int, String) {
        struct E: Decodable { let status: Int }
        let data = (try? TestFixtures.data(name)) ?? Data()
        let status = (try? JSONDecoder().decode(E.self, from: data))?.status ?? 500
        let body = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["body"].flatMap { try? JSONSerialization.data(withJSONObject: $0) } ?? Data()
        return (status, String(decoding: body, as: UTF8.self))
    }
}

struct SocialDecodingTests {
    @Test func feedPostsAndPagination() throws {
        let page: SocialFeedPage = try TestFixtures.decode("social-feed-latest")
        #expect(page.posts.count == 11, "10 a page plus the pinned post above Latest")
        #expect(page.nextCursor != nil)
        #expect(page.viewer == SocialViewer(signedIn: true, moderator: false))
        let pinned = try #require(page.posts.first)
        #expect(pinned.pinned && pinned.category == "review" && pinned.mine && pinned.canEdit && !pinned.canPin)
        #expect(Set(page.posts.map(\.id)).count == page.posts.count, "stable, unique ids")
        let page2: SocialFeedPage = try TestFixtures.decode("social-feed-latest-page2")
        #expect(page2.nextCursor == nil)
        #expect(Set(page.posts.map(\.id)).isDisjoint(with: page2.posts.map(\.id)), "page 2 continues, never repeats")
        #expect(page2.posts.allSatisfy { !$0.pinned }, "pins only on the first page")
    }

    @Test func categoriesPhotosVehicleReviewAndLink() throws {
        let posts = try TestFixtures.decode("social-feed-latest", as: SocialFeedPage.self).posts
        #expect(Set(posts.map(\.category)).isSubset(of: Set(PostCategory.allCases.map(\.rawValue))))
        #expect(PostCategory.allCases.map(\.title) == ["General", "Sighting", "Question", "News", "Review"])
        let withVehicle = try #require(posts.first { $0.vehicle != nil })
        let v = try #require(withVehicle.vehicle)
        #expect(v.licensePlate == "XVF-3582" && v.cybercab && v.shortId == "a1b2c3d4" && v.vin == "7SAYGDEF5TA000123")
        #expect(v.route == VehicleRoute(id: "a1b2c3d4-0000-4000-8000-000000000001", plate: "XVF-3582"))
        #expect(withVehicle.photos.count == 1 && withVehicle.photos[0].fullURL.path.hasPrefix("/api/social/photos/"))
        #expect(posts.contains { $0.photos.count == 2 })
        let review = try #require(posts.first { $0.review != nil }?.review)
        #expect(review == SocialReview(rating: 5, vehicleType: "cybercab", quotedFare: 12.4, pickupWaitMinutes: 4, rideDate: review.rideDate))
        #expect(SocialText.reviewFacts(review).prefix(3) == ["Cybercab", "$12.40 fare", "4 min pickup wait"])
        #expect(SocialText.stars(4) == "★★★★☆")
        #expect(posts.first { $0.linkUrl != nil }?.linkURL?.host() == "www.tesla.com")
    }

    @Test func likeAndSaveState() throws {
        let saved = try TestFixtures.decode("social-feed-saved", as: SocialFeedPage.self).posts
        #expect(saved.count == 1 && saved[0].saved && saved[0].liked, "alice saved and liked bob's sighting")
        let like: SocialLikeResult = try TestFixtures.decode("social-like")
        #expect(like == SocialLikeResult(liked: true, likeCount: 1))
        let save: SocialOK = try TestFixtures.decode("social-save")
        #expect(save.success)
    }

    @Test func commentsAndOneLevelOfReplies() throws {
        let page: SocialCommentsPage = try TestFixtures.decode("social-comments")
        #expect(page.comments.count == 2 && page.nextCursor == nil)
        try #require(page.comments.count == 2)
        // Comments made in the same second have no fixed order: find it by its text.
        let first = try #require(page.comments.first { $0.body == "How long was the ride?" })
        #expect(first.parentId == nil && first.body == "How long was the ride?" && first.mine && first.canEdit)
        let reply = try #require(first.replies?.first)
        #expect(reply.parentId == first.id && reply.replies == nil && !reply.canEdit && !reply.canDelete)
        let created: SocialCommentCreated = try TestFixtures.decode("social-comment-created")
        #expect(created.commentCount == 1 && created.comment.replies == [])
    }

    @Test func privateAuthorsAreAnonymous() throws {
        let posts = try TestFixtures.decode("social-feed-latest", as: SocialFeedPage.self).posts
        let anon = try #require(posts.first { $0.author.anonymous })
        #expect(anon.author.name == "Anonymous")
        #expect(anon.author.handle == nil && anon.author.avatarUrl == nil && anon.author.rank == nil && anon.author.level == nil)
        // Nothing of the private rider (Carol Private, @carol_c) is in any response.
        for name in ["social-feed-latest", "social-feed-latest-page2", "leaderboard-overall", "rider-search", "streaks-leaderboard-weekly"] {
            let raw = CommunityStub.fixture(name)
            #expect(!raw.contains("Carol") && !raw.contains("carol_c"), "\(name) leaks a private rider")
        }
        let privateProfile = CommunityStub.errorFixture("rider-profile-private")
        #expect(privateProfile.0 == 404, "a private profile looks exactly like an unknown one")
        // Who liked a post is never sent, only the count.
        #expect(!CommunityStub.fixture("social-feed-latest").contains("liked_by"))
    }

    @Test func sidebarNotificationsAndVehicleSearch() throws {
        let side: SocialSidebar = try TestFixtures.decode("social-sidebar")
        #expect(side.stats.posts == 14 && side.stats.contributors == 3 && side.stats.averageRating == 5)
        #expect(side.trending.count == 2 && side.announcement?.body.hasPrefix("Community Social is open") == true)
        let n: SocialNotifications = try TestFixtures.decode("social-notifications")
        #expect(n.unread == 6)
        #expect(Set(n.notifications.map(\.type)) == ["like", "comment", "mention", "announcement"])
        let comment = try #require(n.notifications.first { $0.type == "comment" })
        #expect(comment.target?.commentId != nil, "a comment notification opens at its comment")
        let ann = try #require(n.notifications.first { $0.type == "announcement" })
        #expect(ann.actor?.official == true && ann.target == nil)
        let count: SocialUnread = try TestFixtures.decode("social-notifications-count")
        #expect(count.unread == 6)
        let search: SocialVehicleSearch = try TestFixtures.decode("social-vehicles")
        #expect(search.vehicles.count == 2 && search.vehicles.allSatisfy { $0.url?.hasPrefix("/vehicle/") == true })
    }

    @Test func linksOpenNatively() {
        #expect(CommunityLink(url: URL(string: "https://cybercabhunter.com/community?post=0123456789abcdef0123456789abcdef&comment=fedcba9876543210fedcba9876543210")!)
                == .post(PostRoute(id: "0123456789abcdef0123456789abcdef", commentId: "fedcba9876543210fedcba9876543210")))
        #expect(CommunityLink(url: URL(string: "https://www.cybercabhunter.com/vehicle/a1b2c3d4-0000-4000-8000-000000000001")!)
                == .vehicle(VehicleRoute(id: "a1b2c3d4-0000-4000-8000-000000000001")))
        #expect(CommunityLink(url: URL(string: "https://cybercabhunter.com/rider/Alice_A")!) == .rider(RiderRoute(handle: "alice_a")))
        #expect(CommunityLink(url: URL(string: "https://cybercabhunter.com/community")!) == .community)
        #expect(CommunityLink(url: URL(string: "https://cybercabhunter.com/community?post=not-an-id")!) == .community)
        #expect(CommunityLink(url: URL(string: "https://example.com/community?post=0123456789abcdef0123456789abcdef")!) == nil, "other sites stay external")
        #expect(CommunityLink(url: URL(string: "https://cybercabhunter.com/rider/x")!) == nil, "handles are 3–20 characters")
    }

    @Test func linkedTextMatchesTheWebsite() {
        let s = LinkedText.attributed("See https://www.tesla.com/robotaxi. And http://x.co/a, ok")
        let links = s.runs.compactMap(\.link).map(\.absoluteString)
        #expect(links == ["https://www.tesla.com/robotaxi", "http://x.co/a"], "trailing punctuation stays text")
        #expect(String(s.characters) == "See https://www.tesla.com/robotaxi. And http://x.co/a, ok")
    }

    @Test func relativeTimesAndAvatars() {
        let now = Format.instant("2026-10-21 12:00:00")!
        #expect(SocialText.relative("2026-10-21 11:59:30", now: now) == "just now")
        #expect(SocialText.relative("2026-10-21 11:55:00", now: now) == "5m")
        #expect(SocialText.relative("2026-10-21 09:00:00", now: now) == "3h")
        #expect(SocialText.relative("2026-10-19 12:00:00", now: now) == "2d")
        #expect(SocialAuthor.initials("Alice A") == "AA" && SocialAuthor.initials("@bob_b") == "B" && SocialAuthor.initials("") == "CH")
        #expect(SocialAuthor.avatarURL("/api/avatars/0123456789abcdef0123456789abcdef")?.absoluteString == "https://cybercabhunter.com/api/avatars/0123456789abcdef0123456789abcdef/128")
        #expect(SocialAuthor.avatarURL("http://insecure.example/a.png") == nil, "only https photos and the site's own")
        #expect(SocialAuthor.avatarURL("javascript:alert(1)") == nil)
    }
}

struct CommunityDecodingTests {
    @Test func streaks() throws {
        let me: MyStreaks = try TestFixtures.decode("streaks-me")
        #expect(me.daily == MyStreaks.Run(current: 4, longest: 4, todayDone: true, weekDone: nil))
        #expect(me.weekly.current == 5 && me.weekly.done)
        #expect(me.verified == MyStreaks.Verified(sightings: 8, days: 8))
        #expect(me.tiers("daily") == [3, 7, 14, 30, 60, 100] && me.tiers("weekly") == [2, 4, 8, 12, 26, 52])
        #expect(me.milestones.filter(\.unlocked).map(\.id) == ["daily-3", "weekly-2", "weekly-4"])
        // The website's countdown on the server's numbers (streaks.js nextTier).
        let next = try #require(StreakMath.next(kind: "daily", run: me.daily, me: me))
        #expect(next.n == 7 && next.left == 3)
        #expect(next.when == StreakMath.key(StreakMath.date(me.today)!.addingTimeInterval(3 * 86400)))
        let empty: MyStreaks = try TestFixtures.decode("streaks-me-empty")
        #expect(empty.daily.current == 0 && empty.calendar.days.isEmpty && empty.milestones.allSatisfy { !$0.unlocked })
        #expect(StreakMath.next(kind: "daily", run: empty.daily, me: empty)?.when == nil, "no pace without a streak")
        let board: StreakBoard = try TestFixtures.decode("streaks-leaderboard-weekly")
        #expect(board.entries.map(\.name) == ["Alice A", "Bob B"] && board.entries[0].weeklyCurrent == 5)
    }

    @Test func leaderboardAndRanks() throws {
        let overall: Leaderboard = try TestFixtures.decode("leaderboard-overall")
        #expect(overall.boards.map(\.id) == ["overall", "discovered", "miles", "rides", "vehicles", "xp"])
        let top = try #require(overall.entries.first)
        #expect(top.rank == 1 && top.name == "Alice A" && top.spotterRank == "Bronze Spotter" && top.spotterRankKey == "bronze")
        // Top Overall = 10 × found + 3 × rides + 2 × cars + 5 × cities + round(miles / 10).
        let points = 10 * top.discovered! + 3 * top.rides! + 2 * top.uniqueVehicles! + 5 * top.cities! + Int((top.miles! / 10).rounded())
        #expect(Double(points) == top.score)
        #expect(overall.unit(for: 1) == "pt" && overall.unit(for: 36) == "pts")
        let xp: Leaderboard = try TestFixtures.decode("leaderboard-xp")
        #expect(xp.label == "Top XP" && xp.entries.allSatisfy { ($0.xp ?? 0) > 0 })
        #expect(overall.totals == Leaderboard.Totals(spotters: 1, vehicles: 2))
    }

    @Test func progressMissionsAndRules() throws {
        let me: MyProgress = try TestFixtures.decode("xp-me")
        #expect(me.xp == 740 && me.level.n == 5 && me.level.next == 1060 && me.level.into == 40)
        #expect(me.rank.key == "bronze" && me.rank.next?.name == "Silver Spotter" && me.rank.next?.needed == 260)
        #expect(me.ranks.map(\.name) == ["Bronze Spotter", "Silver Spotter", "Gold Spotter", "Platinum Spotter", "Diamond Spotter"])
        #expect(me.ranks.map(\.xp) == [0, 1000, 3000, 8000, 20000], "the server's thresholds")
        // Each mission's state is the server's and agrees with its own progress
        // (which state applies depends on the day the fixtures were made).
        for m in me.missions.daily + me.missions.weekly {
            #expect(m.progress <= m.required)
            if m.progress >= m.required { #expect(["completed", "completing"].contains(m.state), "\(m.id)") }
            else if m.progress > 0 { #expect(["in_progress"].contains(m.state), "\(m.id)") }
            else { #expect(["not_started", "awaiting_verification"].contains(m.state), "\(m.id)") }
        }
        #expect(me.missions.daily.map(\.id) == ["daily_contribution"] && me.missions.weekly.map(\.id) == ["weekly_spotter", "weekly_contributor"])
        #expect(me.recent.allSatisfy { !$0.reason.lowercased().contains("post") && !$0.reason.lowercased().contains("like") }, "Social actions earn no XP")
        let rules: XPRules = try TestFixtures.decode("xp-rules")
        #expect(rules.rewards.map(\.id) == ["verified_sighting", "first_discovery", "daily_mission", "weekly_mission"])
        #expect(Set(rules.missions.map(\.period)) == ["day", "week"])
        let summary: CommunitySummary = try TestFixtures.decode("community-summary")
        #expect(summary.sightings?.last14Days.count == 14 && summary.streaks?.recordWeekly == 5 && summary.xp?.topRank == "Bronze Spotter")
    }

    @Test func riderProfileAndSearch() throws {
        let p: RiderProfile = try TestFixtures.decode("rider-profile")
        #expect(p.rider.handle == "alice_a" && p.rider.joined?.count == 7, "month only")
        #expect(p.discovered.count == 2 && p.reviews.average == 5 && p.rides.cities.first?.name == "Dallas")
        #expect(!CommunityStub.fixture("rider-profile").contains("email") && !CommunityStub.fixture("rider-profile").contains("fare"))
        let search: RiderSearch = try TestFixtures.decode("rider-search")
        #expect(search.results.map(\.handle) == ["alice_a", "dave_d"])
    }
}

@Suite(.serialized)
@MainActor
struct SocialBehaviourTests {
    @Test func likeIsOptimisticAndRollsBackOnRateLimit() async throws {
        let stub = StubServer()
        let posts = try TestFixtures.decode("social-feed-latest", as: SocialFeedPage.self).posts
        let target = try #require(posts.first { !$0.liked })
        stub.responses = [
            "GET /api/social/feed": (200, CommunityStub.fixture("social-feed-latest")),
            "PUT /api/social/posts/\(target.id)/like": CommunityStub.errorFixture("error-rate-limited")
        ]
        let model = SocialFeedModel(api: stub.api())
        await model.select(.latest)
        #expect(model.feed.count == 11)
        await model.toggleLike(target.id)
        #expect(model.posts[target.id]?.liked == false && model.posts[target.id]?.likeCount == target.likeCount, "rolled back")
        #expect(model.toast?.text == "You're going a bit fast. Try again in a few minutes." && model.toast?.isError == true)

        stub.responses["PUT /api/social/posts/\(target.id)/like"] = (200, #"{"success":true,"liked":true,"like_count":\#(target.likeCount + 1)}"#)
        await model.toggleLike(target.id)
        #expect(model.posts[target.id]?.liked == true && model.posts[target.id]?.likeCount == target.likeCount + 1)
        #expect(model.feedIDs.count == 11, "a like changes one post, never reloads the feed")
    }

    @Test func pagingAppendsWithoutDuplicates() async throws {
        let stub = StubServer()
        let page1 = CommunityStub.fixture("social-feed-latest")
        stub.responses = ["GET /api/social/feed": (200, page1)]
        let model = SocialFeedModel(api: stub.api())
        await model.select(.latest)
        stub.requests = []
        stub.responses["GET /api/social/feed"] = (200, CommunityStub.fixture("social-feed-latest-page2"))
        await model.loadMore()
        let query = stub.requests.last?.0.url?.query() ?? ""
        #expect(query.contains("cursor=") && query.contains("filter=latest"))
        #expect(model.feedIDs.count == Set(model.feedIDs).count && model.feedIDs.count == 14)
        #expect(model.nextCursor == nil)
    }

    @Test func savedNeedsSignInAndSortIsSent() async throws {
        let stub = StubServer()
        stub.responses = ["GET /api/social/feed": CommunityStub.errorFixture("social-feed-saved-signed-out")]
        let model = SocialFeedModel(api: stub.api(token: nil))
        await model.select(.saved)
        #expect(model.phase == .signInRequired)
        stub.responses = ["GET /api/social/feed": (200, CommunityStub.fixture("social-feed-latest"))]
        stub.requests = []
        await model.select(.popular)
        let q = stub.requests.last?.0.url?.query() ?? ""
        #expect(q.contains("sort=popular") && q.contains("filter=saved"))
        await model.select(.foryou)
        let lastQuery = stub.requests.last?.0.url?.query() ?? ""
        #expect(lastQuery == "filter=foryou&limit=10", "For You is an order in itself (no sort)")
        await model.select(.new)
    }

    @Test func errorsUseTheWebsitesWords() async throws {
        let stub = StubServer()
        let api = stub.api()
        for (fixture, message) in [("error-duplicate-post", "You've already posted that."),
                                   ("error-rate-limited", "You're going a bit fast. Try again in a few minutes."),
                                   ("error-already-reported", "You've already reported this. Moderators will take a look."),
                                   ("error-cannot-report-own", "You can't report your own post."),
                                   ("error-invalid-rating", "Choose a rating from 1 to 5 stars."),
                                   ("error-forbidden-edit", "You can't change that.")] {
            stub.responses = ["POST /x": CommunityStub.errorFixture(fixture)]
            do { let _: SocialOK = try await api.send("/x", method: "POST"); Issue.record("\(fixture) should fail") }
            catch { #expect(SocialText.message(for: error) == message, "\(fixture)") }
        }
        stub.responses = ["POST /x": CommunityStub.errorFixture("error-signed-out-post")]
        await #expect(throws: APIError.unauthorized) { let _: SocialOK = try await api.send("/x", method: "POST") }
    }

    @Test func reportsSendTheReasonAndDetails() async throws {
        let stub = StubServer()
        stub.responses = ["POST /api/social/reports": CommunityStub.errorFixture("social-report-created")]
        stub.requests = []
        let model = SocialFeedModel(api: stub.api())
        let failure = await model.report("comment", id: "abc", reason: .offTopic, details: "  not about cars  ")
        #expect(failure == nil)
        let body = try #require(stub.requests.last?.1)
        let json = try #require(try JSONSerialization.jsonObject(with: body) as? [String: String])
        #expect(json == ["target_type": "comment", "target_id": "abc", "reason": "off_topic", "details": "not about cars"])
        #expect(ReportReason.allCases.map(\.rawValue) == ["spam", "harassment", "off_topic", "misleading", "privacy", "other"])
        stub.responses = ["POST /api/social/reports": CommunityStub.errorFixture("error-already-reported")]
        #expect(await model.report("post", id: "abc", reason: .spam, details: "") == "You've already reported this. Moderators will take a look.")
    }
}

@MainActor
struct ComposerTests {
    @Test func counterAndLimits() {
        let c = ComposerModel()
        #expect(!c.canPublish && c.counter == "0 / 2,000")
        c.body = String(repeating: "a", count: 1800)
        #expect(c.countMessage == "200 characters left." && c.canPublish)
        c.body = String(repeating: "a", count: 2000)
        #expect(c.countMessage == "You've reached the 2,000-character limit.")
        c.body = String(repeating: "a", count: 2001)
        #expect(c.countMessage == "1 character over the 2,000-character limit. Shorten your post to publish it." && !c.canPublish)
        c.body = "hi"
        c.reviewOn = true
        #expect(c.category == .review, "attaching a review makes a General post a Review")
        #expect(!c.canPublish, "a review needs a rating")
        c.rating = 4
        #expect(c.canPublish)
        c.reviewOn = false
        #expect(c.category == .general)
        c.vehicleOn = true
        #expect(c.validate() == "Choose a Cybercab from the search results, or remove the attachment.")
    }

    @Test func formMatchesTheWebsite() throws {
        let post = try TestFixtures.decode("social-feed-latest", as: SocialFeedPage.self).posts.first { $0.review != nil }!
        let c = ComposerModel(editing: post)
        #expect(c.reviewOn && c.rating == 5 && c.reviewVehicle == "cybercab" && c.fare == "12.40" && c.wait == "4")
        c.reviewOn = false
        let fields = c.form().fields
        #expect(fields.contains { $0 == ("remove_review", "1") }, "editing without the review removes it")
        #expect(fields.first { $0.0 == "category" }?.1 == "review", "an edit keeps its category")

        let n = ComposerModel()
        n.body = "  Spotted one  "
        n.category = .sighting
        n.reviewOn = true; n.rating = 3; n.reviewVehicle = "model_y"; n.fare = "9.5"; n.wait = "7"
        n.rideDate = Format.calendarDate("2026-10-19")
        n.linkOn = true; n.link = "https://example.com/a"
        n.vehicleOn = true
        n.vehicle = try TestFixtures.decode("social-vehicles", as: SocialVehicleSearch.self).vehicles.first
        let f = n.form()
        let dict = Dictionary(f.fields, uniquingKeysWith: { a, _ in a })
        #expect(dict["body"] == "Spotted one" && dict["category"] == "sighting" && dict["link_url"] == "https://example.com/a")
        #expect(dict["vehicle_id"] == "a1b2c3d4-0000-4000-8000-000000000001")
        #expect(dict["review"] == "1" && dict["rating"] == "3" && dict["vehicle_type"] == "model_y" && dict["quoted_fare"] == "9.5" && dict["pickup_wait_minutes"] == "7")
        #expect(dict["ride_date"]?.hasPrefix("2026-10-1") == true)
        #expect(dict["remove_review"] == nil, "a new post never sends remove_review")
        let encoded = String(decoding: f.encoded(), as: UTF8.self)
        #expect(encoded.contains("name=\"body\"\r\n\r\nSpotted one\r\n") && encoded.hasSuffix("--\(f.boundary)--\r\n"))
    }

    @Test func photosAreReencodedWithoutLocation() throws {
        // A 3000 × 2000 JPEG carrying GPS and EXIF, as a phone camera writes it.
        let ctx = CGContext(data: nil, width: 3000, height: 2000, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        ctx.setFillColor(CGColor(red: 0.98, green: 0.88, blue: 0.19, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: 3000, height: 2000))
        let out = NSMutableData()
        let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil)!
        let meta: [CFString: Any] = [kCGImagePropertyGPSDictionary: [kCGImagePropertyGPSLatitude: 30.2672, kCGImagePropertyGPSLatitudeRef: "N"],
                                     kCGImagePropertyExifDictionary: [kCGImagePropertyExifLensModel: "Test lens"]]
        CGImageDestinationAddImage(dest, ctx.makeImage()!, meta as CFDictionary)
        CGImageDestinationFinalize(dest)
        let original = out as Data
        let src0 = CGImageSourceCreateWithData(original as CFData, nil)!
        #expect((CGImageSourceCopyPropertiesAtIndex(src0, 0, nil) as? [CFString: Any])?[kCGImagePropertyGPSDictionary] != nil, "the test photo has a location")

        let jpeg = try PhotoEncoder.jpeg(from: original)
        let src = CGImageSourceCreateWithData(jpeg as CFData, nil)!
        let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any] ?? [:]
        #expect(props[kCGImagePropertyGPSDictionary] == nil, "no location leaves the phone")
        #expect(((props[kCGImagePropertyExifDictionary] as? [CFString: Any])?[kCGImagePropertyExifLensModel]) == nil)
        #expect(max(props[kCGImagePropertyPixelWidth] as? Int ?? 0, props[kCGImagePropertyPixelHeight] as? Int ?? 0) == 2048)
        #expect(jpeg.count <= PhotoEncoder.maxBytes)
        #expect(throws: PhotoEncoder.Failure.unreadable) { try PhotoEncoder.jpeg(from: Data("not an image".utf8)) }
    }
}
