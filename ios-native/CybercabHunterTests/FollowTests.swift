import Testing
import Foundation
@testable import CybercabHunter

// Followers & Following in the app: real Worker answers (Fixtures/follow-*.json,
// written by scripts/community-test-server.mjs), the Following filter and its
// empty states. The rules themselves are tested in tests/follows.test.mjs.

@MainActor
@Suite(.serialized)
struct FollowTests {
    @Test func answersDecodeWithWhatTheViewerMaySee() throws {
        let open: FollowStatus = try TestFixtures.decode("follow-status-public")
        #expect(open.relationship == .following && open.followsYou && !open.private && open.counts != nil && open.profile == nil)
        let closed: FollowStatus = try TestFixtures.decode("follow-status-private")
        #expect(closed.private && !closed.canView && closed.relationship == .requested, "a pending request grants nothing")
        #expect(closed.counts == nil && closed.profile == nil, "no counts, name or photo from a private account")
        let approved: FollowStatus = try TestFixtures.decode("follow-status-approved")
        #expect(approved.private && approved.canView && approved.relationship == .following && approved.counts != nil && approved.profile?.name.isEmpty == false)
        let list: FollowListPage = try TestFixtures.decode("follow-list")
        #expect(!list.users.isEmpty && list.users.allSatisfy { $0.handle != nil && $0.relationship != nil && $0.rank != nil })
        let requests: FollowRequestsPage = try TestFixtures.decode("follow-requests")
        #expect(requests.count == 1 && requests.requests[0].user.handle == "dave_d")
    }

    @Test func buttonTitles() {
        #expect([FollowState.follow, .following, .requested, .followBack].map(\.title) == ["Follow", "Following", "Requested", "Follow Back"])
        #expect(FollowState.following.isActive && FollowState.requested.isActive && !FollowState.followBack.isActive)
    }

    @Test func followingFilterSitsAfterForYouAndKeepsTheOthers() {
        #expect(SocialFeedModel.Filter.allCases.map(\.title) == ["For You", "Following", "Latest", "Photos", "Reviews", "Saved"])
        #expect(!SocialFeedModel.Filter.following.sortable)
    }

    @Test func followingFeedStates() async {
        let s = StubServer()
        s.responses["GET /api/social/feed"] = (200, CommunityStub.fixture("social-feed-following"))
        let m = SocialFeedModel(api: s.api())
        await m.select(.following)
        #expect(m.phase == .loaded && !m.feed.isEmpty && !m.followsNobody)
        #expect(s.requests.last?.0.url?.query?.contains("filter=following") == true)
        #expect(s.requests.last?.0.url?.query?.contains("sort=") == false, "always newest first")
        // Follows nobody yet, and follows people who haven't posted: different empty states.
        s.responses["GET /api/social/feed"] = (200, #"{"filter":"following","sort":"new","posts":[],"next_cursor":null,"viewer":{"signed_in":true,"moderator":false},"following_count":0}"#)
        await m.reload()
        #expect(m.feed.isEmpty && m.followsNobody)
        s.responses["GET /api/social/feed"] = (200, #"{"filter":"following","sort":"new","posts":[],"next_cursor":null,"viewer":{"signed_in":true,"moderator":false},"following_count":3}"#)
        await m.reload()
        #expect(m.feed.isEmpty && !m.followsNobody)
        // Signed out or expired: sign in, not someone's feed.
        s.responses["GET /api/social/feed"] = (401, #"{"authenticated":false,"error":"sign_in_required"}"#)
        await m.reload()
        #expect(m.phase == .signInRequired && m.feed.isEmpty)
        // A server failure says so.
        s.responses["GET /api/social/feed"] = (500, "{}")
        await m.reload()
        #expect(m.phase == .failed)
    }

    @Test func messagesExplainFailures() {
        #expect(FollowAPI.message(APIError.http(status: 429, code: "rate_limited")).contains("too often"))
        #expect(FollowAPI.message(APIError.http(status: 404, code: "not_found")).contains("no longer available"))
        #expect(FollowAPI.message(URLError(.notConnectedToInternet)).contains("connection"))
    }
}
