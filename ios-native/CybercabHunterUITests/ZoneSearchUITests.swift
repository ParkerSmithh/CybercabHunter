import XCTest

/// The Apple Maps-style Zones search sheet: opens at medium height over the
/// map, expands, collapses and closes; suggestions, live results, picking a
/// place, recents; the keyboard always goes away. Live site, read only.
@MainActor
final class ZoneSearchUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }
    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a); saveShot(app, name)
    }

    func testSearchSheet() throws {
        let app = XCUIApplication()
        app.launch()
        app.tabBars.buttons["Zones"].tap()
        let button = app.buttons["zoneSearchButton"]
        XCTAssertTrue(button.waitForExistence(timeout: 15))
        sleep(3)
        shot(app, "zones-full-screen")
        let screen = app.windows.firstMatch.frame

        // Opens at medium: the field in the lower half, the map above it.
        button.tap()
        let field = app.textFields["zoneSearchField"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        sleep(1)
        XCTAssertGreaterThan(field.frame.minY, screen.height * 0.35, "medium sheet: \(field.frame)")
        XCTAssertFalse(app.keyboards.firstMatch.exists, "no keyboard until the field is tapped")
        XCTAssertTrue(app.buttons["zoneCity-austin"].exists && app.buttons["zoneCity-dallas"].exists, "the two cities")
        shot(app, "search-medium")

        // Drag up: full height. Drag down: medium. Down again: closed.
        let grabber = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: field.frame.minY / screen.height - 0.03))
        grabber.press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)))
        sleep(1)
        XCTAssertLessThan(field.frame.minY, screen.height * 0.3, "expanded: \(field.frame)")
        shot(app, "search-large")
        let top = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: field.frame.minY / screen.height - 0.03))
        top.press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)))
        sleep(1)
        XCTAssertGreaterThan(field.frame.minY, screen.height * 0.35, "back to medium")
        let mid = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: field.frame.minY / screen.height - 0.03))
        mid.press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)))
        XCTAssertTrue(field.waitForNonExistence(timeout: 4), "dragged closed")

        // Typing: the sheet rises, results come from the city's service area; Search key hides the keyboard.
        button.tap()
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        sleep(1)
        XCTAssertLessThan(field.frame.minY, screen.height * 0.3, "the field stays above the keyboard")
        field.typeText("Zilker")
        let result = app.buttons["zonePlaceSuggestion"].firstMatch
        XCTAssertTrue(result.waitForExistence(timeout: 20), "live results")
        shot(app, "search-results")
        app.keyboards.buttons["search"].firstMatch.exists ? app.keyboards.buttons["search"].firstMatch.tap() : app.keyboards.buttons["Search"].firstMatch.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 3), "Search hides the keyboard")

        // Picking: the sheet closes, the map flies there and pins it.
        let label = result.label
        result.tap()
        XCTAssertTrue(field.waitForNonExistence(timeout: 5))
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        sleep(2)
        shot(app, "search-picked")
        XCTAssertTrue(button.isHittable)

        // Reopening: the place is in Recents and "On the map".
        button.tap()
        XCTAssertTrue(app.buttons["zoneRecent"].firstMatch.waitForExistence(timeout: 5), "recents")
        XCTAssertTrue(app.buttons["zoneRecent"].firstMatch.label.contains(label.components(separatedBy: ",").first ?? label))
        shot(app, "search-recents")
        // Done above the keyboard.
        field.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        app.buttons["zoneSearchDone"].tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 3), "Done hides the keyboard")
        // A city row switches the map and closes the sheet.
        app.buttons["zoneCity-dallas"].tap()
        XCTAssertTrue(field.waitForNonExistence(timeout: 5))
        sleep(2)
        XCTAssertTrue(app.buttons["Dallas"].firstMatch.isSelected, "switched to Dallas")
        shot(app, "search-dallas")
        app.buttons["Austin"].firstMatch.tap()
        // Remove the pin, so later runs start clean.
        button.tap()
        if app.buttons["zoneRemovePin"].waitForExistence(timeout: 3) { app.buttons["zoneRemovePin"].tap() } else { app.swipeDown(velocity: .fast) }
        XCTAssertFalse(app.keyboards.firstMatch.exists)
    }
}
