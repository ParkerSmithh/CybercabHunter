import XCTest

/// Followers & Following against the isolated test Worker (the real Worker over
/// an in-memory database). A change made through the API the website uses shows
/// in the app, and the reverse. Each test restores what it changes.
@MainActor
final class FollowUITests: XCTestCase {
    private let base = "http://127.0.0.1:8799"

    override func setUp() async throws {
        continueAfterFailure = false
        var request = URLRequest(url: URL(string: "\(base)/api/social/sidebar")!)
        request.timeoutInterval = 3
        let response = try? await URLSession.shared.data(for: request)
        try XCTSkipUnless((response?.1 as? HTTPURLResponse)?.statusCode == 200, "Start the isolated community-test-server first")
    }

    /// What the website does: the same request with the same session.
    private func web(_ method: String, _ path: String, session: String) async throws -> [String: Any] {
        var r = URLRequest(url: URL(string: base + path)!)
        r.httpMethod = method
        r.setValue("Bearer \(session)", forHTTPHeaderField: "Authorization")
        let (data, _) = try await URLSession.shared.data(for: r)
        return (try JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }

    private func openProfile(_ handle: String, session: String?) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-tab", "community", "-apiBase", base, "-openRider", handle] + (session.map { ["-session", $0] } ?? [])
        app.launch()
        return app
    }

    func testFollowOnTheWebsiteShowsInTheAppAndUnfollowInTheAppShowsOnTheWebsite() async throws {
        _ = try await web("DELETE", "/api/follows/dave_d", session: "s-alice")
        _ = try await web("PUT", "/api/follows/dave_d", session: "s-alice")      // the website follows
        let app = openProfile("dave_d", session: "s-alice")
        let button = app.buttons["followButton-dave_d"]
        XCTAssertTrue(button.waitForExistence(timeout: 20))
        XCTAssertEqual(button.label.hasPrefix("Following"), true, "the app shows what the website did")
        saveShot(app, "follow-profile")
        button.tap()
        let unfollow = app.buttons["Unfollow"]
        XCTAssertTrue(unfollow.waitForExistence(timeout: 5), "unfollowing asks first")
        unfollow.tap()
        // Dave follows Alice, so unfollowing him leaves Follow Back.
        let done = NSPredicate(format: "label BEGINSWITH 'Follow back @'")
        let changed = XCTNSPredicateExpectation(predicate: done, object: button)
        await fulfillment(of: [changed], timeout: 10)
        let status = try await web("GET", "/api/follows/dave_d", session: "s-alice")
        XCTAssertEqual(status["relationship"] as? String, "follow_back", "the website sees what the app did")
    }

    func testFollowersListOpensFromTheCount() {
        let app = openProfile("alice_a", session: "s-bob")
        let count = app.buttons["followCount-followers"]
        XCTAssertTrue(count.waitForExistence(timeout: 20))
        count.tap()
        XCTAssertTrue(app.descendants(matching: .any)["followRow"].firstMatch.waitForExistence(timeout: 10))
        saveShot(app, "follow-list")
    }

    func testPrivateAccountShowsOnlyTheHandleUntilApproved() {
        // dave has a pending request to carol: no name, no counts.
        var app = openProfile("carol_c", session: "s-dave")
        XCTAssertTrue(app.descendants(matching: .any)["riderPrivateFollow"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts["@carol_c"].exists)
        XCTAssertFalse(app.buttons["followCount-followers"].exists, "no counts while pending")
        XCTAssertTrue(app.buttons["followButton-carol_c"].label.hasPrefix("Follow requested"))
        saveShot(app, "follow-private-requested")
        app.terminate()
        // bob is approved: counts and the name.
        app = openProfile("carol_c", session: "s-bob")
        XCTAssertTrue(app.buttons["followCount-followers"].waitForExistence(timeout: 20), "approved followers see the counts")
        app.terminate()
        // Signed out: the plain private state, and nothing else.
        app = openProfile("carol_c", session: nil)
        XCTAssertTrue(app.descendants(matching: .any)["riderPrivate"].waitForExistence(timeout: 20))
        XCTAssertFalse(app.descendants(matching: .any)["riderPrivateFollow"].exists)
    }

    func testFollowingFilterAndRequestsScreen() {
        // The Following feed, signed in.
        var app = XCUIApplication()
        app.launchArguments = ["-tab", "community", "-apiBase", base, "-session", "s-dave"]
        app.launch()
        let tab = app.buttons["Following"].firstMatch
        XCTAssertTrue(tab.waitForExistence(timeout: 20))
        tab.tap()
        XCTAssertTrue(app.staticTexts["Newest posts from accounts you follow"].waitForExistence(timeout: 10))
        saveShot(app, "follow-feed")
        app.terminate()
        // Follow Requests, for the private account.
        app = XCUIApplication()
        app.launchArguments = ["-tab", "home", "-account", "-apiBase", base, "-session", "s-carol"]
        app.launch()
        let link = app.buttons["followersAndRequests"].firstMatch
        var tries = 0
        while !link.exists && tries < 6 { app.swipeUp(velocity: .slow); tries += 1; _ = link.waitForExistence(timeout: 2) }
        XCTAssertTrue(link.waitForExistence(timeout: 15))
        link.tap()
        XCTAssertTrue(app.buttons["acceptRequest"].firstMatch.waitForExistence(timeout: 10), "dave's request")
        XCTAssertTrue(app.buttons["declineRequest"].firstMatch.exists)
        saveShot(app, "follow-requests")
    }
}
