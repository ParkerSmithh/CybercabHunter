import XCTest

/// All Sightings | Following on the Zones map, against the isolated test Worker
/// (the real Worker over an in-memory database). What the website does through
/// the API shows in the app, and each test restores what it changes.
@MainActor
final class FollowingMapUITests: XCTestCase {
    private let base = "http://127.0.0.1:8799"

    override func setUp() async throws {
        continueAfterFailure = false
        var request = URLRequest(url: URL(string: "\(base)/api/social/sidebar")!)
        request.timeoutInterval = 20
        let response = try? await URLSession.shared.data(for: request)
        try XCTSkipUnless((response?.1 as? HTTPURLResponse)?.statusCode == 200, "Start the isolated community-test-server first")
    }

    private func web(_ method: String, _ path: String, session: String) async throws {
        var r = URLRequest(url: URL(string: base + path)!)
        r.httpMethod = method
        r.setValue("Bearer \(session)", forHTTPHeaderField: "Authorization")
        _ = try await URLSession.shared.data(for: r)
    }

    private func openZones(session: String?, extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-tab", "zones", "-apiBase", base] + (session.map { ["-session", $0] } ?? []) + extra
        app.launch()
        return app
    }
    private func any(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any)[id].firstMatch }

    func testAllSightingsIsTheDefaultAndFollowingShowsAFollowedSpotter() {
        let app = openZones(session: "s-alice")
        let all = app.buttons["mapSourceAll"], following = app.buttons["mapSourceFollowing"]
        XCTAssertTrue(all.waitForExistence(timeout: 30))
        XCTAssertTrue(all.isSelected, "All Sightings by default")
        XCTAssertFalse(any(app, "followingMarker").exists, "no Following marker until it is chosen")
        following.tap()
        let marker = any(app, "followingMarker")
        XCTAssertTrue(marker.waitForExistence(timeout: 20), "bob's Austin sighting")
        XCTAssertTrue(following.isSelected)
        saveShot(app, "following-map")
        marker.tap()
        XCTAssertTrue(any(app, "followingSightingTitle").waitForExistence(timeout: 10))
        XCTAssertTrue(any(app, "followingSpotterLink").exists)
        XCTAssertTrue(any(app, "followingSpotterLink").label.contains("Bob B"))
        saveShot(app, "following-map-sheet")
        any(app, "followingSpotterLink").tap()
        XCTAssertTrue(app.staticTexts["@bob_b"].waitForExistence(timeout: 15), "the link opens the spotter's profile")
    }

    func testSwitchingBackHidesFollowingMarkers() {
        let app = openZones(session: "s-alice")
        XCTAssertTrue(app.buttons["mapSourceFollowing"].waitForExistence(timeout: 30))
        app.buttons["mapSourceFollowing"].tap()
        XCTAssertTrue(any(app, "followingMarker").waitForExistence(timeout: 20))
        app.buttons["mapSourceAll"].tap()
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: any(app, "followingMarker"))
        wait(for: [gone], timeout: 10)
        XCTAssertTrue(app.buttons["mapSourceAll"].isSelected)
    }

    func testSignedOutAsksToSignInAndKeepsThePublicMap() {
        let app = openZones(session: nil)
        XCTAssertTrue(app.buttons["mapSourceFollowing"].waitForExistence(timeout: 30))
        app.buttons["mapSourceFollowing"].tap()
        XCTAssertTrue(any(app, "followingEmptyTitle").waitForExistence(timeout: 10))
        XCTAssertEqual(any(app, "followingEmptyTitle").label, "Sign in to see Following")
        XCTAssertTrue(any(app, "followingSignIn").exists)
        saveShot(app, "following-map-signed-out")
        any(app, "followingBackToAll").tap()
        XCTAssertTrue(app.buttons["mapSourceAll"].isSelected, "the public map is one tap away")
    }

    func testAnEndedSessionAsksToSignInAgain() {
        let app = openZones(session: "s-expired")
        XCTAssertTrue(app.buttons["mapSourceFollowing"].waitForExistence(timeout: 30))
        app.buttons["mapSourceFollowing"].tap()
        XCTAssertTrue(any(app, "followingEmptyTitle").waitForExistence(timeout: 15))
        XCTAssertEqual(any(app, "followingEmptyTitle").label, "Sign in to see Following")
        XCTAssertFalse(any(app, "followingMarker").exists)
    }

    func testAFailedRequestSaysSoAndOffersTryAgain() {
        // Nothing listens on this port: the same as being offline, for this request and the map's others.
        let app = XCUIApplication()
        app.launchArguments = ["-tab", "zones", "-apiBase", "http://127.0.0.1:1", "-session", "s-alice"]
        app.launch()
        XCTAssertTrue(app.buttons["mapSourceFollowing"].waitForExistence(timeout: 30))
        app.buttons["mapSourceFollowing"].tap()
        XCTAssertTrue(any(app, "followingRetry").waitForExistence(timeout: 30), "a clear error, not an empty map")
        XCTAssertTrue(any(app, "followingBackToAll").exists)
        saveShot(app, "following-map-offline")
    }

    func testFollowingNobodyOffersWaysToFindSpotters() {
        let app = openZones(session: "s-erin")
        XCTAssertTrue(app.buttons["mapSourceFollowing"].waitForExistence(timeout: 30))
        app.buttons["mapSourceFollowing"].tap()
        XCTAssertTrue(any(app, "followingEmptyTitle").waitForExistence(timeout: 15))
        XCTAssertEqual(any(app, "followingEmptyTitle").label, "No followed spotters yet")
        XCTAssertTrue(any(app, "followingFindSpotters").exists)
        saveShot(app, "following-map-nobody")
    }

    func testAPendingRequestRevealsNothingButApprovalDoes() {
        // dave's request to carol (private) is pending, and he follows only alice.
        let dave = openZones(session: "s-dave")
        XCTAssertTrue(dave.buttons["mapSourceFollowing"].waitForExistence(timeout: 30))
        dave.buttons["mapSourceFollowing"].tap()
        XCTAssertTrue(any(dave, "followingEmptyTitle").waitForExistence(timeout: 15))
        XCTAssertEqual(any(dave, "followingEmptyTitle").label, "No sightings from followed users in this area")
        XCTAssertFalse(any(dave, "followingMarker").exists)
        saveShot(dave, "following-map-no-sightings")
        dave.terminate()
        // bob is carol's approved follower: her sighting and his other follows show.
        let bob = openZones(session: "s-bob")
        XCTAssertTrue(bob.buttons["mapSourceFollowing"].waitForExistence(timeout: 30))
        bob.buttons["mapSourceFollowing"].tap()
        XCTAssertTrue(any(bob, "followingMarker").waitForExistence(timeout: 20), "an approved follower sees it")
        bob.terminate()
    }

    func testUnfollowOnTheWebsiteLeavesTheMapAndFollowingAgainReturnsIt() async throws {
        try await web("DELETE", "/api/follows/bob_b", session: "s-alice")
        let app = openZones(session: "s-alice")
        XCTAssertTrue(app.buttons["mapSourceFollowing"].waitForExistence(timeout: 30))
        app.buttons["mapSourceFollowing"].tap()
        XCTAssertTrue(any(app, "followingEmptyTitle").waitForExistence(timeout: 15))
        XCTAssertFalse(any(app, "followingMarker").exists, "after unfollowing, nothing of bob's")
        app.terminate()
        try await web("PUT", "/api/follows/bob_b", session: "s-alice")
        let again = openZones(session: "s-alice")
        XCTAssertTrue(again.buttons["mapSourceFollowing"].waitForExistence(timeout: 30))
        again.buttons["mapSourceFollowing"].tap()
        XCTAssertTrue(any(again, "followingMarker").waitForExistence(timeout: 20), "following again brings it back")
    }
}
