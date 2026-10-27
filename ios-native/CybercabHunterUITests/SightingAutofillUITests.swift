import XCTest

/// Uses the existing isolated Worker. These checks never request GPS, call Apple,
/// submit a sighting, or change system permission; lookup/confirmation use unit mocks.
@MainActor
final class SightingAutofillUITests: XCTestCase {
    override func setUp() async throws {
        continueAfterFailure = false
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8799/api/social/sidebar")!)
        request.timeoutInterval = 3
        let response = try? await URLSession.shared.data(for: request)
        try XCTSkipUnless((response?.1 as? HTTPURLResponse)?.statusCode == 200, "Start the isolated community-test-server first")
    }
    private func form() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-tab", "sightings", "-apiBase", "http://127.0.0.1:8799", "-session", "s-bob"]
        app.launch()
        XCTAssertTrue(app.buttons["submitSighting"].waitForExistence(timeout: 20))
        app.buttons["submitSighting"].tap()
        let city = app.buttons["sightingCity"]
        XCTAssertTrue(city.waitForExistence(timeout: 10)); city.tap()
        app.buttons["Austin"].firstMatch.tap()
        let button = app.buttons["useCurrentSightingLocation"]
        XCTAssertTrue(button.waitForExistence(timeout: 5) && button.isEnabled)
        button.tap()
        return app
    }
    func testDisclosureAndCancelPreserveManualForm() {
        let app = form()
        let privacy = app.staticTexts["sightingLocationPrivacy"]
        XCTAssertTrue(privacy.waitForExistence(timeout: 10))
        XCTAssertTrue(privacy.label.contains("Apple") && privacy.label.contains("GPS coordinates aren't sent"))
        XCTAssertTrue(app.buttons["findNearbySightingPlace"].exists)
        XCTAssertFalse(app.buttons["confirmSightingPlace"].exists)
        saveShot(app, "sighting-location-disclosure")
        app.buttons["Cancel"].firstMatch.tap()
        XCTAssertTrue(app.textFields["sightingLocation"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["sightingPlacePicked"].exists)
        XCTAssertFalse(app.staticTexts["sightingSubmitted"].exists)
    }
    func testManualFallbackStaysEditableWithoutLocationPermission() {
        let app = form()
        XCTAssertTrue(app.buttons["manualSightingLocation"].waitForExistence(timeout: 10))
        app.buttons["manualSightingLocation"].tap()
        let field = app.textFields["sightingLocation"]
        XCTAssertTrue(field.waitForExistence(timeout: 5) && field.isEnabled)
        field.tap(); field.typeText("A") // Below the search threshold: no external lookup.
        XCTAssertEqual(field.value as? String, "A")
        XCTAssertFalse(app.staticTexts["sightingSubmitted"].exists)
    }
}
