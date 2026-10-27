import XCTest

/// Screenshots of every tab and its main screens (signed out, live site,
/// read only) for the website-parity review. Asserts only that each screen
/// opens natively.
@MainActor
final class ParityTourUITests: XCTestCase {
    override func setUp() { continueAfterFailure = true }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
    }
    private func scrollShots(_ app: XCUIApplication, _ prefix: String, count: Int) {
        for i in 0..<count {
            shot(app, "\(prefix)-\(i)")
            let s = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8))
            s.press(forDuration: 0.05, thenDragTo: s.withOffset(CGVector(dx: 0, dy: -520)), withVelocity: 1200, thenHoldForDuration: 0.3)
            sleep(1)
        }
    }

    func testTour() throws {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.buttons["homeViewNews"].waitForExistence(timeout: 20))
        sleep(4)
        scrollShots(app, "home", count: 9)

        app.tabBars.buttons["Cars"].tap(); sleep(4)
        scrollShots(app, "cars", count: 3)
        let firstCar = app.descendants(matching: .any).matching(identifier: "vehicleCard").firstMatch
        for _ in 0..<6 { app.swipeDown(velocity: .fast) }
        if firstCar.waitForExistence(timeout: 5) { firstCar.tap(); sleep(3); scrollShots(app, "vehicle", count: 2); app.navigationBars.buttons.firstMatch.tap() }

        app.tabBars.buttons["Sightings"].tap(); sleep(5)
        scrollShots(app, "sightings", count: 3)

        app.tabBars.buttons["Community"].tap(); sleep(5)
        scrollShots(app, "community", count: 2)
        for tab in ["streaks", "leaderboard", "progress"] {
            for _ in 0..<6 { app.swipeDown(velocity: .fast) }
            let b = app.buttons["section-\(tab)"].firstMatch
            if b.waitForExistence(timeout: 3) { b.tap(); sleep(3); scrollShots(app, "community-\(tab)", count: 2) }
        }

        app.tabBars.buttons["Zones"].tap(); sleep(6)
        shot(app, "zones")

        app.tabBars.buttons["Home"].tap()
        for _ in 0..<3 { app.swipeUp(velocity: .fast) }
        let dmv = app.buttons["dmvEveryVin"]
        for _ in 0..<12 where !(dmv.exists && dmv.isHittable) { app.swipeUp(velocity: .slow) }
        if dmv.exists { dmv.tap(); sleep(4); scrollShots(app, "dmv-roster", count: 2) }
        XCTAssertEqual(app.webViews.count, 0)
    }
}
