import XCTest

/// Phase 5 acceptance: Sightings, Account, Privacy and Moderation are native,
/// against the REAL Worker code over an isolated in-memory database
/// (scripts/community-test-server.mjs; scripts/test-community.sh starts it).
/// These tests submit, edit, toggle privacy and moderate: never production.
@MainActor
final class SightingsAccountUITests: XCTestCase {
    static let server = "http://127.0.0.1:8799"

    override func setUp() async throws {
        continueAfterFailure = false
        var request = URLRequest(url: URL(string: "\(Self.server)/api/social/sidebar")!)
        request.timeoutInterval = 3
        let ok = (try? await URLSession.shared.data(for: request)).map { ($0.1 as? HTTPURLResponse)?.statusCode == 200 } ?? false
        try XCTSkipUnless(ok, "The test Worker isn't running: run ios-native/scripts/test-community.sh")
    }

    private func launch(_ tab: String, session: String?) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-tab", tab, "-apiBase", Self.server] + (session.map { ["-session", $0] } ?? [])
        app.launch()
        return app
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
    }

    private func assertNative(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(app.webViews.count, 0, "a web view appeared", file: file, line: line)
        XCTAssertEqual(XCUIApplication(bundleIdentifier: "com.apple.mobilesafari").state, .notRunning, "Safari opened", file: file, line: line)
    }

    private func text(_ app: XCUIApplication, _ s: String) -> XCUIElement {
        app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", s)).firstMatch
    }

    /// The server's own answer (the test Worker), for checks that must not rely on the UI.
    private func status(_ path: String, session: String? = nil) -> Int {
        // Straight to the server: the Worker caches a profile's 404 for 60 s,
        // and a cached answer would hide the change being tested.
        var r = URLRequest(url: URL(string: Self.server + path)!, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData)
        if let session { r.setValue("Bearer \(session)", forHTTPHeaderField: "Authorization") }
        let done = expectation(description: path)
        nonisolated(unsafe) var code = 0
        URLSession.shared.dataTask(with: r) { _, response, _ in
            code = (response as? HTTPURLResponse)?.statusCode ?? 0
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 10)
        return code
    }

    /// Every tab has an Account button in its bar: use the one that is on screen.
    private func openAccount(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let all = app.buttons.matching(identifier: "accountButton")
        XCTAssertTrue(all.firstMatch.waitForExistence(timeout: 15), "an Account button", file: file, line: line)
        // isHittable can't go in a query predicate: check each match.
        let deadline = Date().addingTimeInterval(10)
        var visible: XCUIElement?
        while visible == nil && Date() < deadline {
            visible = all.allElementsBoundByIndex.first { $0.exists && $0.isHittable }
            if visible == nil { usleep(300_000) }
        }
        guard let visible else { XCTFail("no Account button on screen", file: file, line: line); return }
        visible.tap()
    }

    /// Scrolls a List or form until a lazily created row exists and is on screen.
    private func scrollTo(_ e: XCUIElement, in app: XCUIApplication, swipes: Int = 6) -> Bool {
        var n = 0
        while !(e.exists && e.isHittable) && n < swipes { app.swipeUp(velocity: .slow); n += 1 }
        return e.exists
    }

    private func reveal(_ e: XCUIElement, in app: XCUIApplication, swipes: Int = 6) {
        var n = 0
        while !(e.exists && e.isHittable) && n < swipes { app.swipeUp(velocity: .slow); n += 1 }
    }

    // MARK: Sightings

    func test1SightingsBrowseViewerVehicleAndReplay() throws {
        let app = launch("sightings", session: "s-alice")
        XCTAssertTrue(app.otherElements["sightingCard"].firstMatch.waitForExistence(timeout: 20) || app.buttons["sightingPhoto"].firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(text(app, "SIGHTINGS").exists)
        XCTAssertTrue(text(app, "Approved sightings").exists, "the stat cards")
        XCTAssertFalse(text(app, "Photos · Approved by moderators").exists)
        XCTAssertFalse(text(app, "Latest sightings").exists)
        XCTAssertTrue(app.staticTexts["feedCount"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["feedCount"].label, "2 sightings in Austin", "the server's count")
        shot(app, "s01-sightings")
        assertNative(app)

        // The photo viewer.
        app.buttons["sightingPhoto"].firstMatch.tap()
        XCTAssertTrue(app.buttons["closeViewer"].waitForExistence(timeout: 5))
        shot(app, "s02-viewer")
        app.buttons["closeViewer"].tap()

        // A plate opens the native vehicle screen.
        let plate = app.buttons["sightingPlate"].firstMatch
        reveal(plate, in: app)
        plate.tap()
        XCTAssertTrue(app.staticTexts["rideHistoryTitle"].waitForExistence(timeout: 20))
        shot(app, "s03-vehicle")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // Dallas, then the oldest first.
        for _ in 0..<4 { app.swipeDown(velocity: .fast) }
        app.buttons["Dallas"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["feedCount"].waitForExistence(timeout: 10))
        expectation(for: NSPredicate(format: "label == '1 sighting in Dallas'"), evaluatedWith: app.staticTexts["feedCount"])
        waitForExpectations(timeout: 10)
        app.buttons["order-asc"].tap()
        XCTAssertTrue(app.buttons["order-asc"].isSelected)

        // Replay Map: the native Replay (Phase 3).
        app.buttons["sightingsReplay"].tap()
        XCTAssertTrue(app.buttons["replayPlay"].waitForExistence(timeout: 20))
        shot(app, "s04-replay")
        assertNative(app)
    }

    func test2SubmitSightingValidationAndSuccess() throws {
        let app = launch("sightings", session: "s-bob")
        XCTAssertTrue(app.buttons["submitSighting"].waitForExistence(timeout: 20))
        app.buttons["submitSighting"].tap()
        let submit = app.buttons["sightingSubmit"]
        XCTAssertTrue(submit.waitForExistence(timeout: 10))
        // The website's check: a photo is required.
        reveal(submit, in: app)
        submit.tap()
        XCTAssertTrue(app.staticTexts["sightingPhotoError"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["sightingPhotoError"].label, "Please add a photo of the Cybercab.")
        // Location is off until a city is chosen (only real places in that city).
        // (No swipe down here: on a sheet it would close the form.)
        XCTAssertTrue(app.textFields["sightingLocation"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.textFields["sightingLocation"].isEnabled)
        shot(app, "s05-form-validation")

        // A photo from the system picker (Apple's sample library), then the plate.
        app.buttons["sightingPhotoPicker"].tap()
        let cell = app.images.matching(identifier: "PXGGridLayout-Info").firstMatch
        guard cell.waitForExistence(timeout: 45) else { shot(app, "s05b-photo-picker"); throw XCTSkip("The simulator's photo picker didn't show its library within 45 s") }
        cell.tap()
        XCTAssertTrue(app.otherElements["sightingPhotoChosen"].waitForExistence(timeout: 20) || app.buttons["Remove photo"].waitForExistence(timeout: 5))
        let plateField = app.textFields["sightingPlateField"]
        reveal(plateField, in: app)
        plateField.tap()
        plateField.typeText("XVF5555")
        reveal(submit, in: app)
        shot(app, "s06-form-filled")
        submit.tap()
        XCTAssertTrue(app.staticTexts["sightingSubmitted"].waitForExistence(timeout: 30))
        shot(app, "s07-submitted")
        app.buttons["Done"].tap()

        // Account › My sightings: the new one is pending, never verified by the app.
        openAccount(app)
        app.buttons["mySightings"].tap()
        XCTAssertTrue(app.otherElements["mySighting-pending"].firstMatch.waitForExistence(timeout: 15) || app.cells.containing(NSPredicate(format: "label CONTAINS 'Pending review'")).firstMatch.waitForExistence(timeout: 5))
        shot(app, "s08-my-sightings")
        assertNative(app)
    }

    // MARK: Account and privacy

    /// Taps a switch once it can take the tap (a tap during the pop-back
    /// animation from Edit profile is dropped by the system); taps again only
    /// if the value hasn't moved and nothing is saving.
    private func flip(_ toggle: XCUIElement, from old: String) {
        let target = toggle.switches.firstMatch.exists ? toggle.switches.firstMatch : toggle
        for _ in 0..<10 where !target.isHittable { usleep(300_000) }
        target.tap()
        sleep(3)
        if toggle.value as? String == old && toggle.isEnabled { target.tap() }
    }

    func test3ProfileEditAndPrivacy() throws {
        let app = launch("community", session: "s-dave")
        openAccount(app)
        XCTAssertTrue(app.staticTexts["accountName"].waitForExistence(timeout: 15))
        shot(app, "s09-account")

        // Edit profile: a new display name, saved through PATCH /api/profile.
        app.buttons["editProfile"].tap()
        let name = app.textFields["displayNameField"]
        XCTAssertTrue(name.waitForExistence(timeout: 10))
        name.tap()
        name.press(forDuration: 1.2)
        if app.menuItems["Select All"].waitForExistence(timeout: 2) { app.menuItems["Select All"].tap() }
        name.typeText("Dave Native")
        shot(app, "s10-edit-profile")
        app.buttons["saveProfile"].tap()
        XCTAssertTrue(app.staticTexts["accountName"].waitForExistence(timeout: 15))
        expectation(for: NSPredicate(format: "label == 'Dave Native'"), evaluatedWith: app.staticTexts["accountName"])
        waitForExpectations(timeout: 15)

        // Privacy off: the server stops serving the public profile at once.
        let toggle = app.switches["privacyToggle"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 10))
        XCTAssertEqual(toggle.value as? String, "1")
        flip(toggle, from: "1")
        expectation(for: NSPredicate(format: "value == '0' AND isEnabled == true"), evaluatedWith: toggle)
        waitForExpectations(timeout: 15)
        shot(app, "s11-privacy-off")
        XCTAssertEqual(status("/api/riders/dave_d"), 404, "a private profile is a 404 for everyone")

        // Find riders (another viewer's view): Dave isn't listed.
        app.buttons["Done"].tap()
        app.buttons["findRiders"].tap()
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText("Dave")
        XCTAssertTrue(text(app, "No public profiles match").waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["riderResult"].exists)
        shot(app, "s12-find-riders-private")
        // The first Close can just end the active search; close until the sheet is gone.
        for _ in 0..<3 where app.searchFields.firstMatch.exists {
            if app.buttons["Close"].exists { app.buttons["Close"].tap() }
            _ = app.searchFields.firstMatch.waitForNonExistence(timeout: 4)
        }
        XCTAssertFalse(app.searchFields.firstMatch.exists, "the Find riders sheet closed")

        // Back on: listed again.
        openAccount(app)
        XCTAssertTrue(toggle.waitForExistence(timeout: 10))
        flip(toggle, from: "0")
        expectation(for: NSPredicate(format: "value == '1' AND isEnabled == true"), evaluatedWith: toggle)
        waitForExpectations(timeout: 15)
        XCTAssertEqual(status("/api/riders/dave_d"), 200)
        assertNative(app)
    }

    // MARK: Moderation

    func test4ModeratorReviewsAndRidersCannot() throws {
        // A rider: no Moderation link, and the server refuses the queue.
        let rider = launch("home", session: "s-bob")
        openAccount(rider)
        XCTAssertTrue(rider.buttons["editProfile"].waitForExistence(timeout: 15))
        // Scroll to the end of the list (the Account section) before checking.
        XCTAssertTrue(scrollTo(rider.buttons["deleteAccount"], in: rider))
        XCTAssertFalse(rider.buttons["moderationLink"].exists, "riders don't see moderation")
        XCTAssertEqual(status("/api/moderation/vehicle-sightings", session: "s-bob"), 403, "the Worker refuses a rider")
        rider.terminate()

        // The moderator.
        let app = launch("home", session: "s-mod")
        openAccount(app)
        let link = app.buttons["moderationLink"]
        XCTAssertTrue(app.buttons["editProfile"].waitForExistence(timeout: 15))
        sleep(2)   // the server's moderator answer arrives with the settings
        XCTAssertTrue(scrollTo(link, in: app), "the moderator sees Moderation")
        link.tap()
        let card = app.otherElements["queueCard"].firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 20))
        shot(app, "s13-moderation-images")
        let before = app.otherElements.matching(identifier: "queueCard").count
        app.buttons["approveSighting"].firstMatch.tap()
        // The confirmation is brief (2.6 s): look for it as any element type.
        XCTAssertTrue(app.descendants(matching: .any)["toast"].waitForExistence(timeout: 5))
        expectation(for: NSPredicate(format: "count < %d", before), evaluatedWith: app.otherElements.matching(identifier: "queueCard"))
        waitForExpectations(timeout: 10)

        // Social: open reports, the author's history, Dismiss.
        app.buttons["modTab-social"].tap()
        XCTAssertTrue(app.otherElements["reportCard"].firstMatch.waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["authorHistory"].firstMatch.exists)
        shot(app, "s14-moderation-social")
        app.buttons["dismissReport"].firstMatch.tap()
        let confirm = app.alerts.buttons["Dismiss"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
        XCTAssertTrue(app.staticTexts["noReports"].waitForExistence(timeout: 15) || !app.otherElements["reportCard"].exists)
        assertNative(app)
    }

    func test5SignedOutIsReadOnly() throws {
        let app = launch("sightings", session: nil)
        XCTAssertTrue(app.buttons["sightingPhoto"].firstMatch.waitForExistence(timeout: 20), "anyone can browse")
        app.buttons["submitSighting"].tap()
        XCTAssertTrue(app.buttons["googleSignIn"].waitForExistence(timeout: 10), "submitting asks to sign in")
        XCTAssertFalse(app.buttons["moderationLink"].exists)
        shot(app, "s15-signed-out")
        assertNative(app)
    }
}
