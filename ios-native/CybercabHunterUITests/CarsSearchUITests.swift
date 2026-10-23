import XCTest

/// Home's centred brand, the soft top edge, and Cars' floating Liquid Glass
/// search and sort/filter button. Live site, read only.
@MainActor
final class CarsSearchUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }
    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
    }
    private func drag(_ app: XCUIApplication, by dy: CGFloat) {
        let s = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: dy < 0 ? 0.75 : 0.35))
        s.press(forDuration: 0.05, thenDragTo: s.withOffset(CGVector(dx: 0, dy: dy)), withVelocity: 900, thenHoldForDuration: 0.4)
        sleep(1)
    }

    func testHomeBrandIsCentred() throws {
        let app = XCUIApplication()
        app.launch()
        let brand = app.descendants(matching: .any)["homeBrand"]
        XCTAssertTrue(brand.waitForExistence(timeout: 20))
        let screen = app.windows.firstMatch.frame
        XCTAssertEqual(brand.frame.midX, screen.midX, accuracy: 2, "centred on the screen: \(brand.frame)")
        XCTAssertGreaterThanOrEqual(brand.frame.height, 35, "larger mark")
        let avatar = app.buttons["accountButton"].firstMatch
        XCTAssertTrue(avatar.exists)
        XCTAssertFalse(brand.frame.intersects(avatar.frame), "no overlap with the avatar")
        shot(app, "home-brand")
        drag(app, by: -300)
        shot(app, "home-soft-edge")
    }

    func testCarsFloatingSearchAndFilter() throws {
        let app = XCUIApplication()
        app.launch()
        app.tabBars.buttons["Cars"].tap()
        let inline = app.textFields["registrySearch"], floating = app.textFields["registryFloatingSearch"]
        XCTAssertTrue(inline.waitForExistence(timeout: 20))
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "vehicleCard").firstMatch.waitForExistence(timeout: 20))
        XCTAssertFalse(floating.exists, "no floating copy at the top")
        shot(app, "cars-top")

        // Scrolling down: the floating Liquid Glass search appears.
        drag(app, by: -450)
        XCTAssertTrue(floating.waitForExistence(timeout: 3), "floating search while scrolled")
        XCTAssertGreaterThan(floating.frame.minY, 50, "below the status bar")
        let filter = app.buttons["registryFilter"]
        XCTAssertTrue(filter.isHittable, "filter stays reachable")
        XCTAssertFalse(filter.frame.intersects(floating.frame), "no overlap with the floating search")
        shot(app, "cars-scrolled")

        // Typing in the floating copy filters the list and syncs to the header field.
        floating.tap()
        floating.typeText("XVF35")
        sleep(3)
        shot(app, "cars-floating-typed")
        XCTAssertEqual(floating.value as? String, "XVF35")
        app.keyboards.buttons["search"].firstMatch.exists ? app.keyboards.buttons["search"].firstMatch.tap() : app.keyboards.buttons["Search"].firstMatch.tap()

        // Back to the top: the header field again, with the same text.
        for _ in 0..<4 { drag(app, by: 450) }
        XCTAssertTrue(floating.waitForNonExistence(timeout: 3), "the floating copy goes away at the top")
        XCTAssertEqual(inline.value as? String, "XVF35", "one query in both fields")
        shot(app, "cars-top-searched")

        // Sort and city from the glass button, together with the search.
        filter.tap()
        let mostRides = app.buttons["Most Rides"].firstMatch
        XCTAssertTrue(mostRides.waitForExistence(timeout: 5), "the sort options")
        XCTAssertTrue(app.buttons["Dallas"].firstMatch.exists, "the city options")
        shot(app, "cars-filter-menu")
        mostRides.tap()
        sleep(2)
        XCTAssertTrue(filter.label.contains("Most Rides"), filter.label)
        XCTAssertEqual(inline.value as? String, "XVF35", "the search stays")
        filter.tap()
        app.buttons["Dallas"].firstMatch.tap()
        sleep(3)
        XCTAssertTrue(filter.label.contains("Dallas"), filter.label)
        shot(app, "cars-dallas-most-rides")
        // Clear and restore.
        app.buttons["Clear search"].firstMatch.tap()
        filter.tap(); app.buttons["Recently Used"].firstMatch.tap()
        filter.tap(); app.buttons["Austin"].firstMatch.tap()
        sleep(2)
        XCTAssertEqual((inline.value as? String).map { $0 == "Plate or VIN" || $0.isEmpty }, true)
    }
}
