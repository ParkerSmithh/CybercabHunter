import XCTest

/// Phase 2 acceptance on the real backend: Home shows live numbers, Cars lists
/// the registry, a vehicle opens natively, and the website never opens.
@MainActor
final class NavigationUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }

    /// No Safari view controller and no web view anywhere in the app.
    private func assertNoWebsite(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(app.webViews.count, 0, "a web view appeared", file: file, line: line)
        XCTAssertEqual(XCUIApplication(bundleIdentifier: "com.apple.mobilesafari").state, .notRunning, "Safari opened", file: file, line: line)
        XCTAssertEqual(app.state, .runningForeground, file: file, line: line)
    }

    func testHomeCarsAndVehicleDetailAreNative() throws {
        let app = XCUIApplication()
        app.launch()

        // Home: the lifetime counters arrive from /api/registry/stats.
        let registered = app.staticTexts.matching(identifier: "headline-Cybercabs Registered").firstMatch
        XCTAssertTrue(registered.waitForExistence(timeout: 20))
        // The label is the cell's ("Cybercabs Registered, 182"): wait for a number.
        expectation(for: NSPredicate(format: "label MATCHES '.*[0-9].*'"), evaluatedWith: registered)
        waitForExpectations(timeout: 20)
        let digits = registered.label.replacingOccurrences(of: ",", with: "").components(separatedBy: CharacterSet.decimalDigits.inverted).filter { !$0.isEmpty }.last
        XCTAssertGreaterThan(Int(digits ?? "") ?? 0, 0, "a real registry count, got: \(registered.label)")
        shot(app, "1-home-top")
        let scroll = app.scrollViews.firstMatch
        for i in 2...6 {
            scroll.swipeUp(velocity: .fast)
            shot(app, "\(i)-home-scrolled")
        }
        assertNoWebsite(app)

        // Cars: the native registry. (The Liquid Glass tab bar shrinks while
        // scrolling down, as in Apple's apps: scroll back up first.)
        for _ in 0..<6 { scroll.swipeDown(velocity: .fast) }
        XCTAssertTrue(app.tabBars.buttons["Cars"].waitForExistence(timeout: 5))
        app.tabBars.buttons["Cars"].tap()
        let count = app.staticTexts["registryCount"]
        XCTAssertTrue(count.waitForExistence(timeout: 20))
        XCTAssertTrue(count.label.hasSuffix("VEHICLES"))
        let card = app.buttons.matching(identifier: "vehicleCard").firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 20))
        shot(app, "7-cars")
        assertNoWebsite(app)

        // A vehicle's details, natively.
        card.tap()
        XCTAssertTrue(app.staticTexts["rideHistoryTitle"].waitForExistence(timeout: 20))
        sleep(1)
        shot(app, "8-vehicle")
        assertNoWebsite(app)

        // Back to the list, then a search.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(card.waitForExistence(timeout: 10))
        app.swipeDown()
        let search = app.searchFields.firstMatch
        if search.waitForExistence(timeout: 5) {
            search.tap()
            search.typeText("XVF")
            sleep(2)
            shot(app, "9-cars-search")
            XCTAssertTrue(app.buttons.matching(identifier: "vehicleCard").firstMatch.waitForExistence(timeout: 10))
        }
        assertNoWebsite(app)
    }
}
