import XCTest

/// The Texas DMV tracker against the local DMV dev server (port 8791: the
/// Worker with a read-only copy of the real TxDMV snapshots, never production).
@MainActor
final class DMVTrackerUITests: XCTestCase {
    static let server = "http://127.0.0.1:8791"
    override func setUp() { continueAfterFailure = false }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
        saveShot(app, name)
    }
    private func reveal(_ e: XCUIElement, in app: XCUIApplication, swipes: Int = 12) {
        var n = 0
        while !(e.exists && e.isHittable) && n < swipes { app.swipeUp(velocity: .slow); n += 1 }
    }
    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-tab", "home", "-apiBase", Self.server]
        app.launch()
        return app
    }

    func testHomeSummaryOpensTracker() throws {
        let app = launch()
        let button = app.buttons["dmvEveryVin"]
        XCTAssertTrue(app.scrollViews.firstMatch.waitForExistence(timeout: 20))
        reveal(button, in: app)
        XCTAssertTrue(button.waitForExistence(timeout: 15))
        expectation(for: NSPredicate(format: "label CONTAINS 'newly detected in the latest update'"), evaluatedWith: button)
        waitForExpectations(timeout: 15)
        XCTAssertTrue(button.label.hasPrefix("View DMV Tracker"), button.label)
        shot(app, "dmv-home-button")
        button.tap()
        XCTAssertTrue(app.staticTexts["dmvTitle"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any)["dmvFreshness"].waitForExistence(timeout: 15))
        for label in ["Total tracked", "New in latest update", "Cybercabs", "Model Ys"] {
            XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label ==[c] %@", label)).firstMatch.exists, label)
        }
        shot(app, "dmv-tracker-top")
    }

    func testActivityHistoryAndUpdateDetail() throws {
        let app = launch()
        let button = app.buttons["dmvEveryVin"]
        XCTAssertTrue(app.scrollViews.firstMatch.waitForExistence(timeout: 20))
        reveal(button, in: app)
        button.tap()
        let update = app.buttons["dmvUpdate"].firstMatch
        XCTAssertTrue(update.waitForExistence(timeout: 15))
        reveal(update, in: app, swipes: 4)
        shot(app, "dmv-activity")
        update.tap()
        let vin = app.buttons["dmvUpdateVin"].firstMatch
        XCTAssertTrue(vin.waitForExistence(timeout: 10), "the update's VINs")
        shot(app, "dmv-update-detail")
        vin.tap()
        XCTAssertTrue(app.staticTexts["Not published by TxDMV"].waitForExistence(timeout: 10), "no registration date is ever shown")
        shot(app, "dmv-vin-detail")
        app.buttons["Done"].firstMatch.tap()
        // View all → the full history with filters.
        let all = app.buttons["dmvHistoryAll"]
        XCTAssertTrue(all.waitForExistence(timeout: 5))
        all.tap()
        XCTAssertTrue(app.staticTexts["dmvHistoryTitle"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["dmvHistoryRow"].firstMatch.waitForExistence(timeout: 10))
        shot(app, "dmv-history")
        app.buttons["dmvKind-missing"].tap()
        XCTAssertTrue(app.staticTexts["dmvHistoryEmpty"].waitForExistence(timeout: 10), "the real data has no missing VINs")
    }

    func testDirectoryFiltersSearchAndVinSheet() throws {
        let app = launch()
        let button = app.buttons["dmvEveryVin"]
        XCTAssertTrue(app.scrollViews.firstMatch.waitForExistence(timeout: 20))
        reveal(button, in: app)
        button.tap()
        XCTAssertTrue(app.staticTexts["dmvTitle"].waitForExistence(timeout: 10))
        let latest = app.buttons["dmvModel-recent"]
        reveal(latest, in: app)
        latest.tap()
        let count = app.staticTexts["dmvCount"]
        expectation(for: NSPredicate(format: "label == '50 of 55 VINs'"), evaluatedWith: count)
        waitForExpectations(timeout: 15)
        XCTAssertTrue(app.descendants(matching: .any)["dmvNewBadge"].firstMatch.exists, "the latest update's VINs carry NEW")
        shot(app, "dmv-directory-latest")
        app.buttons["dmvModel-cybercab"].tap()
        expectation(for: NSPredicate(format: "label ENDSWITH 'of 351 VINs'"), evaluatedWith: count)
        waitForExpectations(timeout: 15)
        let search = app.textFields["dmvSearch"]
        search.tap()
        search.typeText("ZZZZZZZZZZ")
        expectation(for: NSPredicate(format: "label == 'No VIN matches that search.'"), evaluatedWith: count)
        waitForExpectations(timeout: 15)
        app.buttons["Clear search"].tap()
        let row = app.buttons["dmvRow"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        reveal(row, in: app, swipes: 4)
        row.tap()
        XCTAssertTrue(app.staticTexts["Not published by TxDMV"].waitForExistence(timeout: 10))
        let built = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'where it was built, not where it is'")).firstMatch
        var n = 0
        while !built.exists && n < 6 { app.swipeUp(velocity: .slow); n += 1 }
        XCTAssertTrue(built.exists, "the plant is labelled as where it was built, not where it is")
        shot(app, "dmv-vin-sheet")
        XCTAssertEqual(app.webViews.count, 0)
    }
}
