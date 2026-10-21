import XCTest

/// Phase 4 acceptance: Community is native, end to end, against the REAL
/// Worker code over an isolated in-memory database
/// (scripts/community-test-server.mjs on 127.0.0.1:8799; scripts/test-community.sh
/// starts it). Production has no Social posts, and these tests write (likes, a
/// post, a comment): they never touch production data.
@MainActor
final class CommunityUITests: XCTestCase {
    static let server = "http://127.0.0.1:8799"

    override func setUp() async throws {
        continueAfterFailure = false
        // The local test Worker must be running (it is a separate process on the Mac).
        var request = URLRequest(url: URL(string: "\(Self.server)/api/social/sidebar")!)
        request.timeoutInterval = 3
        let ok = (try? await URLSession.shared.data(for: request)).map { ($0.1 as? HTTPURLResponse)?.statusCode == 200 } ?? false
        try XCTSkipUnless(ok, "The Community test Worker isn't running: run ios-native/scripts/test-community.sh")
    }

    private func launch(session: String?) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-tab", "community", "-apiBase", Self.server] + (session.map { ["-session", $0] } ?? [])
        app.launch()
        return app
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
    }

    private func assertNative(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(app.webViews.count, 0, "a web view appeared", file: file, line: line)
        XCTAssertEqual(XCUIApplication(bundleIdentifier: "com.apple.mobilesafari").state, .notRunning, "Safari opened", file: file, line: line)
        XCTAssertEqual(app.state, .runningForeground, file: file, line: line)
    }

    private func text(_ app: XCUIApplication, containing s: String) -> XCUIElement {
        app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", s)).firstMatch
    }

    /// Scrolls the visible section until `element` is on screen.
    private func reveal(_ element: XCUIElement, in app: XCUIApplication, maxSwipes: Int = 8) {
        var n = 0
        while !(element.exists && element.isHittable) && n < maxSwipes {
            app.swipeUp(velocity: .slow)
            n += 1
        }
    }

    private func back(_ app: XCUIApplication) {
        app.navigationBars.buttons.element(boundBy: 0).tap()
    }

    func testSocialFeedPostProfileVehicleAndSectionsAreNative() throws {
        let app = launch(session: "s-alice")

        // Community opens on Social, with the real feed (pinned review first).
        XCTAssertTrue(app.buttons["section-social"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["section-social"].isSelected, "Social is the default section")
        let review = text(app, containing: "First ride in a Cybercab")
        XCTAssertTrue(review.waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts["Pinned"].exists)
        XCTAssertTrue(app.staticTexts["Bronze Spotter"].firstMatch.exists, "the author's Spotter rank")
        shot(app, "c01-social-foryou")
        assertNative(app)

        // Filters: Photos shows only photo posts.
        app.buttons["filter-photos"].tap()
        XCTAssertTrue(app.buttons["postPhoto"].firstMatch.waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["sortMenu"].exists, "Photos can be sorted")
        shot(app, "c02-social-photos")
        app.buttons["filter-latest"].tap()
        XCTAssertTrue(text(app, containing: "Newest posts first").waitForExistence(timeout: 10))

        // A like: the count updates in place (written to the test database only).
        let like = app.buttons["likeButton"].firstMatch
        XCTAssertTrue(like.waitForExistence(timeout: 10))
        let before = like.label
        like.tap()
        expectation(for: NSPredicate(format: "label != %@", before), evaluatedWith: like)
        waitForExpectations(timeout: 10)

        // The post's own screen with its comments and replies.
        app.buttons["filter-foryou"].tap()
        XCTAssertTrue(review.waitForExistence(timeout: 15))
        app.buttons["commentsButton"].firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Post"].waitForExistence(timeout: 10))
        XCTAssertTrue(text(app, containing: "How long was the ride?").waitForExistence(timeout: 15))
        XCTAssertTrue(text(app, containing: "About 18 minutes").exists, "the reply under it")
        XCTAssertTrue(text(app, containing: "RIDE REVIEW").exists)
        shot(app, "c03-post-detail")

        // A comment (test database only).
        let input = app.textFields["commentInput"].exists ? app.textFields["commentInput"] : app.textViews["commentInput"]
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        input.tap()
        input.typeText("Native app test comment")
        app.buttons["commentSend"].tap()
        XCTAssertTrue(text(app, containing: "Native app test comment").waitForExistence(timeout: 10))
        shot(app, "c04-comment-added")
        assertNative(app)

        // A comment author's profile, natively.
        app.buttons["Bob B"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["riderName"].waitForExistence(timeout: 15))
        XCTAssertEqual(app.staticTexts["riderName"].label, "Bob B")
        shot(app, "c05-rider-profile")
        back(app)
        back(app)

        // An attached Cybercab opens the native vehicle screen.
        app.buttons["filter-latest"].tap()
        let vehicle = app.buttons["postVehicle"].firstMatch
        XCTAssertTrue(vehicle.waitForExistence(timeout: 15))
        reveal(vehicle, in: app)
        vehicle.tap()
        XCTAssertTrue(app.staticTexts["rideHistoryTitle"].waitForExistence(timeout: 20))
        shot(app, "c06-attached-vehicle")
        assertNative(app)
        back(app)

        // Notifications: the bell lists them; one opens its post.
        app.buttons["notificationsBell"].tap()
        let note = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'notification-'")).firstMatch
        XCTAssertTrue(note.waitForExistence(timeout: 15))
        shot(app, "c07-notifications")
        note.tap()
        XCTAssertTrue(app.navigationBars["Post"].waitForExistence(timeout: 10))
        back(app)

        // The other three sections.
        for _ in 0..<4 { app.swipeDown(velocity: .fast) }
        app.buttons["section-streaks"].tap()
        XCTAssertTrue(app.staticTexts["weeklyStreakValue"].waitForExistence(timeout: 15))
        XCTAssertEqual(app.staticTexts["weeklyStreakValue"].label, "5", "the server's weekly streak")
        XCTAssertEqual(app.staticTexts["dailyStreakValue"].label, "4", "the server's daily streak")
        shot(app, "c08-streaks")
        app.swipeUp(velocity: .slow)
        shot(app, "c09-streaks-calendar")
        app.swipeUp(velocity: .slow)
        shot(app, "c10-streaks-board")
        for _ in 0..<4 { app.swipeDown(velocity: .fast) }

        app.buttons["section-leaderboard"].tap()
        let row = app.buttons["leaderboardRow"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        row.tap()
        XCTAssertTrue(app.buttons["leaderboardProfile"].waitForExistence(timeout: 5))
        shot(app, "c11-leaderboard")
        app.buttons["board-xp"].tap()
        XCTAssertTrue(app.staticTexts["boardTitle"].waitForExistence(timeout: 10))
        expectation(for: NSPredicate(format: "label == 'TOP XP'"), evaluatedWith: app.staticTexts["boardTitle"])
        waitForExpectations(timeout: 10)
        for _ in 0..<4 { app.swipeDown(velocity: .fast) }

        app.buttons["section-progress"].tap()
        let level = app.staticTexts["progressLevel"]
        XCTAssertTrue(level.waitForExistence(timeout: 15))
        XCTAssertTrue(level.label.contains("LEVEL") && level.label.contains("SPOTTER"))
        XCTAssertTrue(app.otherElements["mission"].firstMatch.exists || app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'DAILY CONTRIBUTION'")).firstMatch.exists)
        shot(app, "c12-progress")
        app.swipeUp(velocity: .slow)
        shot(app, "c13-progress-ranks")

        // Back to Social: its scroll position and feed are kept.
        for _ in 0..<4 { app.swipeDown(velocity: .fast) }
        app.buttons["section-social"].tap()
        XCTAssertTrue(app.buttons["likeButton"].firstMatch.waitForExistence(timeout: 5))
        assertNative(app)
    }

    func testComposerPostsWithCybercabAndReview() throws {
        let app = launch(session: "s-bob")
        XCTAssertTrue(app.buttons["composeButton"].waitForExistence(timeout: 20))
        app.buttons["composeButton"].tap()
        let body = app.textViews["composerBody"].exists ? app.textViews["composerBody"] : app.textFields["composerBody"]
        XCTAssertTrue(body.waitForExistence(timeout: 5))
        body.typeText("Native composer test: a Cybercab with a ride review.")
        XCTAssertTrue(app.staticTexts["composerCounter"].label.hasPrefix("52 /"), "the counter: \(app.staticTexts["composerCounter"].label)")

        // Attach a Cybercab from the registry search.
        app.buttons["composerAttachVehicle"].tap()
        let search = app.textFields["vehicleSearch"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText("XVF")
        let result = app.buttons["vehicleResult"].firstMatch
        XCTAssertTrue(result.waitForExistence(timeout: 10))
        result.tap()
        XCTAssertTrue(app.buttons["Change"].waitForExistence(timeout: 5))

        // A ride review: Post stays off until a rating is chosen (the site's rule).
        app.buttons["composerAttachReview"].tap()
        XCTAssertFalse(app.buttons["composerPublish"].isEnabled)
        app.buttons["star4"].tap()
        XCTAssertTrue(app.buttons["composerPublish"].isEnabled)
        shot(app, "c14-composer")

        XCTAssertTrue(app.buttons["composerPublish"].waitForExistence(timeout: 5))
        app.buttons["composerPublish"].tap()
        XCTAssertTrue(text(app, containing: "Native composer test").waitForExistence(timeout: 30), "the new post at the top of the feed")
        XCTAssertTrue(app.buttons["postVehicle"].firstMatch.exists)
        shot(app, "c17-posted")
        assertNative(app)

        // Posting the same text again is refused with the website's message.
        app.buttons["composeButton"].tap()
        let again = app.textViews["composerBody"].exists ? app.textViews["composerBody"] : app.textFields["composerBody"]
        XCTAssertTrue(again.waitForExistence(timeout: 5))
        again.typeText("Native composer test: a Cybercab with a ride review.")
        app.buttons["composerPublish"].tap()
        XCTAssertTrue(app.staticTexts["composerError"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.staticTexts["composerError"].label, "You've already posted that.")
        shot(app, "c18-duplicate")
    }

    /// The system photo picker (Apple's, out of process): a picked photo is
    /// re-encoded and shown in the composer. Skipped, with the reason, when the
    /// simulator's picker never shows its library (it loads asynchronously).
    func testPhotoPickerAddsAPhoto() throws {
        let app = launch(session: "s-bob")
        XCTAssertTrue(app.buttons["composeButton"].waitForExistence(timeout: 20))
        app.buttons["composeButton"].tap()
        XCTAssertTrue(app.buttons["composerPhotos"].waitForExistence(timeout: 5))
        app.buttons["composerPhotos"].tap()
        let firstPhoto = app.images.matching(identifier: "PXGGridLayout-Info").firstMatch
        guard firstPhoto.waitForExistence(timeout: 45) else {
            shot(app, "c15-photo-picker")
            throw XCTSkip("The simulator's photo picker didn't show its library within 45 s")
        }
        shot(app, "c15-photo-picker")
        firstPhoto.tap()
        let done = app.buttons["Done"]
        XCTAssertTrue(done.waitForExistence(timeout: 5))
        expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: done)
        waitForExpectations(timeout: 5)
        done.tap()
        XCTAssertTrue(app.buttons["Remove photo"].firstMatch.waitForExistence(timeout: 30), "the picked photo, re-encoded, in the composer")
        shot(app, "c16-composer-photo")
        XCTAssertTrue(app.buttons["composerPublish"].isEnabled, "a photo alone is a post")
    }

    func testSignedOutIsReadOnly() throws {
        let app = launch(session: nil)
        XCTAssertTrue(app.buttons["socialSignIn"].waitForExistence(timeout: 20), "signed out: a sign-in prompt instead of the composer")
        XCTAssertFalse(app.buttons["composeButton"].exists)
        XCTAssertFalse(app.buttons["notificationsBell"].exists)
        XCTAssertTrue(text(app, containing: "First ride in a Cybercab").waitForExistence(timeout: 20), "anyone can read")
        shot(app, "c18-signed-out")

        // Saved needs an account.
        app.buttons["filter-saved"].tap()
        XCTAssertTrue(app.otherElements["savedSignIn"].waitForExistence(timeout: 10) || text(app, containing: "Sign in to save posts").waitForExistence(timeout: 5))

        // Liking asks to sign in (the account sheet) and changes nothing.
        app.buttons["filter-foryou"].tap()
        let like = app.buttons["likeButton"].firstMatch
        XCTAssertTrue(like.waitForExistence(timeout: 10))
        let before = like.label
        like.tap()
        XCTAssertTrue(app.buttons.containing(NSPredicate(format: "label CONTAINS 'Google'")).firstMatch.waitForExistence(timeout: 5), "the sign-in sheet")
        app.swipeDown(velocity: .fast)
        sleep(1)
        XCTAssertEqual(app.buttons["likeButton"].firstMatch.label, before)

        // Streaks and Progress invite sign-in; the public boards still show.
        for _ in 0..<3 { app.swipeDown(velocity: .fast) }
        app.buttons["section-streaks"].tap()
        XCTAssertTrue(app.buttons["signInPrompt"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.otherElements["streakBoard"].waitForExistence(timeout: 10) || text(app, containing: "COMMUNITY STREAKS").exists)
        app.buttons["section-progress"].tap()
        XCTAssertTrue(app.buttons["signInPrompt"].firstMatch.waitForExistence(timeout: 10))
        shot(app, "c19-progress-signed-out")
        assertNative(app)
    }
}
