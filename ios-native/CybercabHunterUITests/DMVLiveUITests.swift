import XCTest

/// The DMV tracker against the live site (read only; no -apiBase): the totals
/// match the website's, the history and a VIN's details open.
@MainActor
final class DMVLiveUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testLiveTrackerTotalsHistoryAndVin() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-tab", "home"]
        app.launch()
        let button = app.buttons["dmvEveryVin"]
        XCTAssertTrue(app.scrollViews.firstMatch.waitForExistence(timeout: 30))
        var n = 0
        while !(button.exists && button.isHittable) && n < 14 { app.swipeUp(velocity: .slow); n += 1 }
        XCTAssertTrue(button.waitForExistence(timeout: 20), "the live DMV panel")
        button.tap()
        XCTAssertTrue(app.staticTexts["dmvTitle"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.descendants(matching: .any)["dmvFreshness"].waitForExistence(timeout: 20))
        // The website's live totals (GET /api/dmv/overview), the same numbers here.
        XCTAssertTrue(app.staticTexts["858"].waitForExistence(timeout: 10), "total tracked")
        XCTAssertTrue(app.staticTexts["351"].exists && app.staticTexts["507"].exists, "Cybercabs and Model Ys")
        saveShot(app, "live-dmv-top")
        let all = app.buttons["dmvHistoryAll"]
        n = 0
        while !(all.exists && all.isHittable) && n < 6 { app.swipeUp(velocity: .slow); n += 1 }
        all.tap()
        XCTAssertTrue(app.staticTexts["dmvHistoryTitle"].waitForExistence(timeout: 15))
        saveShot(app, "live-dmv-history")
        app.navigationBars.buttons.firstMatch.tap()
        let row = app.buttons["dmvRow"].firstMatch
        n = 0
        while !(row.exists && row.isHittable) && n < 20 { app.swipeUp(velocity: .slow); n += 1 }
        XCTAssertTrue(row.waitForExistence(timeout: 20), "the live VIN directory")
        row.tap()
        XCTAssertTrue(app.staticTexts["Not published by TxDMV"].waitForExistence(timeout: 15), "a VIN's details")
        saveShot(app, "live-dmv-vin")
    }
}
