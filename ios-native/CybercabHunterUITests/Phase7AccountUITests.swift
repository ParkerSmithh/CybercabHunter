import XCTest

/// Phase 7 signed-in screens against the isolated test Worker
/// (scripts/test-community.sh): Rider data, Receipt sync (Gmail forwarding)
/// and the moderator's Tesla link status. Nothing here changes the seeded
/// rides, the forwarding address or any Tesla link: each destructive control
/// is opened and cancelled (the writes are unit-tested against stubs).
@MainActor
final class Phase7AccountUITests: XCTestCase {
    static let server = "http://127.0.0.1:8799"

    override func setUp() async throws {
        continueAfterFailure = false
        var request = URLRequest(url: URL(string: "\(Self.server)/api/social/sidebar")!)
        request.timeoutInterval = 3
        let ok = (try? await URLSession.shared.data(for: request)).map { ($0.1 as? HTTPURLResponse)?.statusCode == 200 } ?? false
        try XCTSkipUnless(ok, "The test Worker isn't running: run ios-native/scripts/test-community.sh")
    }

    private func launch(session: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-tab", "home", "-apiBase", Self.server, "-session", session]
        app.launch()
        return app
    }
    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
    }
    private func openAccount(_ app: XCUIApplication) {
        let all = app.buttons.matching(identifier: "accountButton")
        XCTAssertTrue(all.firstMatch.waitForExistence(timeout: 15))
        let deadline = Date().addingTimeInterval(10)
        var visible: XCUIElement?
        while visible == nil && Date() < deadline {
            visible = all.allElementsBoundByIndex.first { $0.exists && $0.isHittable }
            if visible == nil { usleep(300_000) }
        }
        visible?.tap()
    }
    private func reveal(_ e: XCUIElement, in app: XCUIApplication, swipes: Int = 12) {
        var n = 0
        while !(e.exists && e.isHittable) && n < swipes { app.swipeUp(velocity: .slow); n += 1 }
    }
    private func any(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any)[id] }

    func testRiderDataShowsTheRidersOwnRides() throws {
        let app = launch(session: "s-alice")
        openAccount(app)
        let link = app.buttons["riderData"]
        reveal(link, in: app)
        link.tap()
        XCTAssertTrue(app.staticTexts["riderTitle"].waitForExistence(timeout: 10))
        let stats = any(app, "riderStats")
        XCTAssertTrue(stats.waitForExistence(timeout: 15))
        // Alice's two seeded rides: 5.6 miles; no duration on the receipts, so "—" (never 0).
        XCTAssertTrue(app.staticTexts["5.6 mi"].exists)
        XCTAssertFalse(app.webViews.firstMatch.exists)
        shot(app, "p7-rider-data")
        let spending = any(app, "riderSpending")
        reveal(spending, in: app)
        XCTAssertTrue(app.staticTexts["$13.84"].exists, "total of two $6.92 fares")
        shot(app, "p7-rider-spending")
        let ride = app.descendants(matching: .any).matching(identifier: "riderRide").firstMatch
        reveal(ride, in: app)
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "riderRide").count, 2)
        // Remove asks first; Cancel leaves the ride.
        ride.buttons["riderRemove"].tap()
        XCTAssertTrue(app.buttons["riderConfirmRemove"].waitForExistence(timeout: 5))
        shot(app, "p7-rider-remove-confirm")
        ride.buttons["Cancel"].tap()
        XCTAssertFalse(app.buttons["riderConfirmRemove"].exists)
        XCTAssertFalse(any(app, "riderTesla").exists, "Tesla linking is offered to moderators only, as on the website")
    }

    func testReceiptSyncShowsAddressAndGmailConfirmation() throws {
        let app = launch(session: "s-alice")
        openAccount(app)
        let link = app.buttons["receiptSync"]
        reveal(link, in: app)
        link.tap()
        XCTAssertTrue(app.staticTexts["gmailTitle"].waitForExistence(timeout: 10))
        let address = app.staticTexts["gmailAddress"]
        XCTAssertTrue(address.waitForExistence(timeout: 15))
        XCTAssertTrue(address.label.hasSuffix("@receipts.cch-test.invalid") && address.label.hasPrefix("u_"), address.label)
        XCTAssertTrue(any(app, "gmailStatus").label.contains("Confirm in Gmail"))
        shot(app, "p7-gmail")
        app.buttons["gmailCopy"].tap()
        XCTAssertTrue(app.buttons["Copied"].waitForExistence(timeout: 3))
        let code = any(app, "gmailCode")
        reveal(code, in: app)
        XCTAssertEqual(app.staticTexts["gmailCodeValue"].label, "Confirmation code 4 8 2 9 1 5 7 3 4", "Gmail's confirmation code, read digit by digit")
        shot(app, "p7-gmail-code")
        // A new address asks first; cancelling keeps the current one.
        let rotate = app.buttons["gmailRotate"]
        reveal(rotate, in: app)
        rotate.tap()
        XCTAssertTrue(app.buttons["Yes, get a new address"].waitForExistence(timeout: 5))
        // iOS 26 shows the dialog as a popover with no Cancel button: tap outside it.
        if app.buttons["Cancel"].exists { app.buttons["Cancel"].firstMatch.tap() } else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).tap() }
        XCTAssertTrue(app.buttons["Yes, get a new address"].waitForNonExistence(timeout: 5))
        XCTAssertFalse(any(app, "gmailNotice").exists)
        XCTAssertFalse(app.secureTextFields.firstMatch.exists, "no password field anywhere")
    }

    func testModeratorSeesTeslaLinkStatus() throws {
        let app = launch(session: "s-mod")
        openAccount(app)
        let link = app.buttons["riderData"]
        reveal(link, in: app)
        link.tap()
        let tesla = any(app, "riderTesla")
        XCTAssertTrue(app.staticTexts["riderTitle"].waitForExistence(timeout: 10))
        reveal(tesla, in: app)
        XCTAssertTrue(tesla.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["teslaStatus"].label.hasPrefix("Not linked"))
        XCTAssertTrue(app.buttons["teslaLink"].exists)
        XCTAssertFalse(app.secureTextFields.firstMatch.exists)
        shot(app, "p7-tesla-moderator")
    }
}
