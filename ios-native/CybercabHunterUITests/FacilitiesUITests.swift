import XCTest

/// Robotaxi facilities on the native Zones map: markers per type with
/// VoiceOver labels, the per-city filter (a combined site under both), the
/// preview, the details screen (gallery swipe, thumbnails, full screen,
/// Apple Maps, Share, Copy Address, Sources), placeholders for facilities
/// without photos and for photos that can't load, and large text.
/// The list is the bundled copy (-facilitiesOffline); photos come from
/// -facilityPhotoBase (the website's public/ served on this Mac at :8765,
/// since they aren't on the live site until release). Screenshots attached.
@MainActor
final class FacilitiesUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }
    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
    }
    private func any(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any)[id] }
    private func launch(photoBase: String = "http://127.0.0.1:8765", extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication.forTests()
        app.launchArguments = ["-tab", "zones", "-facilitiesOffline", "-facilityPhotoBase", photoBase] + extra
        app.launch()
        XCTAssertTrue(app.buttons["zoneDetailsButton"].waitForExistence(timeout: 20))
        return app
    }
    private func toDallas(_ app: XCUIApplication) {
        app.buttons["Dallas"].firstMatch.tap()
        sleep(3)
    }
    private func filter(_ app: XCUIApplication, _ title: String) {
        app.buttons["facilityFilterButton"].tap()
        let item = app.buttons[title].firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 5), "menu item \(title)")
        item.tap()
        sleep(1)
    }

    func testFacilityPreviewDetailsAndGallery() throws {
        let app = launch()
        toDallas(app)
        let marker = any(app, "facilityMarker-dallas-cedar-springs")
        XCTAssertTrue(marker.waitForExistence(timeout: 10), "the Cedar Springs marker")
        XCTAssertEqual(marker.label, "Staging Ground: Dallas Cedar Springs Staging Ground", "VoiceOver: type and name")
        shot(app, "fac-dallas-map")
        marker.tap()

        // Preview: photo, name, type, address, status, View Details.
        XCTAssertTrue(any(app, "facilityPreview").waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["facilityPreviewName"].label, "Dallas Cedar Springs Staging Ground")
        XCTAssertTrue(app.staticTexts["Near Cedar Springs Rd & W Mockingbird Ln, Dallas, TX 75235"].exists)
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Observed'")).firstMatch.exists, "observed, not confirmed")
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Staging Ground'")).firstMatch.exists, "type")
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Reported activity'")).firstMatch.exists, "status")
        XCTAssertTrue(any(app, "facilityPhotoImage").waitForExistence(timeout: 15), "the photo loads")
        shot(app, "fac-preview")

        // Details.
        app.buttons["facilityViewDetails"].tap()
        XCTAssertTrue(app.staticTexts["facilityDetailName"].waitForExistence(timeout: 5))
        let counter = any(app, "facilityPhotoCounter")
        XCTAssertTrue(counter.waitForExistence(timeout: 5))
        XCTAssertEqual(counter.label, "Photo 1 of 3")
        XCTAssertTrue(any(app, "facilityPhotoImage").waitForExistence(timeout: 15), "the hero photo loads")
        shot(app, "fac-details-top")
        any(app, "facilityGallery").swipeLeft()
        XCTAssertTrue(NSPredicate(format: "label == 'Photo 2 of 3'").evaluate(with: counter) || counter.waitForLabel("Photo 2 of 3"), "swiped to photo 2")
        app.buttons["facilityThumb-2"].tap()
        XCTAssertTrue(counter.waitForLabel("Photo 3 of 3"), "thumbnail picks photo 3")
        XCTAssertTrue(app.buttons["facilityThumb-2"].isSelected)

        // Full screen.
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'A row of gold Cybercabs'")).firstMatch.tap()
        XCTAssertTrue(any(app, "facilityViewer").waitForExistence(timeout: 5), "full screen")
        sleep(1)
        shot(app, "fac-fullscreen")
        app.buttons["facilityViewerClose"].tap()
        XCTAssertTrue(any(app, "facilityViewer").waitForNonExistence(timeout: 5))

        // Details: no charging, staging points, status, last verified.
        XCTAssertFalse(any(app, "facilityCharging").exists, "no charging section for a staging ground")
        XCTAssertTrue(any(app, "facilityStaging").exists)
        let facts = any(app, "facilityFacts")
        XCTAssertTrue(facts.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Reported activity'")).firstMatch.exists, "status")
        XCTAssertTrue(facts.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Nov 16, 2026'")).firstMatch.exists, "last verified")
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] 'Supercharger'")).firstMatch.exists, "never a Supercharger")

        // Copy Address, Sources.
        app.buttons["facilityCopyAddress"].tap()
        XCTAssertTrue(app.buttons["facilityCopyAddress"].waitForLabel("Copied"), "copied")
        app.buttons["facilityViewSources"].tap()
        sleep(1)
        let sources = app.descendants(matching: .any).matching(identifier: "facilitySource")
        XCTAssertEqual(sources.count, 2)
        XCTAssertTrue(sources.firstMatch.isHittable, "scrolled to the sources")
        shot(app, "fac-details-sources")

        // Share: the system share sheet with the facility link.
        app.buttons["facilityShare"].firstMatch.tap()
        let shareSheet = app.otherElements["ActivityListView"]
        XCTAssertTrue(shareSheet.waitForExistence(timeout: 8) || app.navigationBars["UIActivityContentView"].waitForExistence(timeout: 2), "share sheet")
        shot(app, "fac-share")
        if app.buttons["Close"].exists { app.buttons["Close"].tap() } else { app.swipeDown(velocity: .fast) }
        sleep(1)

        // Apple Maps: directions to the lot.
        app.buttons["facilityOpenMaps"].tap()
        let maps = XCUIApplication(bundleIdentifier: "com.apple.Maps")
        // A fresh simulator's Maps may first ask for location: launched is what counts.
        XCTAssertTrue(maps.wait(for: .runningForeground, timeout: 15) || maps.state != .notRunning, "Apple Maps opens")
        sleep(2)
        let mapsShot = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); mapsShot.name = "fac-apple-maps"; mapsShot.lifetime = .keepAlways; add(mapsShot)
        app.activate()
        XCTAssertTrue(app.staticTexts["facilityDetailName"].waitForExistence(timeout: 10), "back in the app, where it was")
        XCTAssertEqual(app.webViews.count, 0, "native, no web view")
    }

    func testFacilityFiltersSearchAndPlaceholder() throws {
        let app = launch()
        toDallas(app)
        let cedar = any(app, "facilityMarker-dallas-cedar-springs")
        XCTAssertTrue(cedar.waitForExistence(timeout: 10))
        XCTAssertEqual(app.buttons["facilityFilterButton"].value as? String, "All Facilities")
        filter(app, "Charging Hubs")
        XCTAssertTrue(cedar.waitForNonExistence(timeout: 5), "a staging ground hides under Charging Hubs")
        XCTAssertEqual(app.buttons["facilityFilterButton"].value as? String, "Charging Hubs")
        shot(app, "fac-filter-charging")
        filter(app, "Staging Grounds")
        XCTAssertTrue(cedar.waitForExistence(timeout: 5), "…and shows under Staging Grounds")
        // Each city keeps its own filter; the city and zones don't change.
        app.buttons["Austin"].firstMatch.tap(); sleep(2)
        XCTAssertEqual(app.buttons["facilityFilterButton"].value as? String, "All Facilities", "Austin: its own filter")
        XCTAssertTrue(any(app, "facilityMarker-austin-st-elmo").waitForExistence(timeout: 10) || any(app, "facilityMarker-austin-ridgepoint").exists, "Austin's charging hubs")
        filter(app, "Staging Grounds")
        XCTAssertTrue(any(app, "facilityFilterEmpty").waitForExistence(timeout: 5), "no staging grounds in Austin: it says so")
        XCTAssertEqual(any(app, "facilityFilterEmpty").label, "No staging grounds listed in Austin yet")
        XCTAssertTrue(app.buttons["Austin"].firstMatch.isSelected, "still Austin")
        shot(app, "fac-filter-austin-empty")
        filter(app, "All Facilities")
        toDallas(app)
        XCTAssertEqual(app.buttons["facilityFilterButton"].value as? String, "Staging Grounds", "Dallas kept Staging Grounds")
        filter(app, "All Facilities")

        // Search lists the city's facilities; picking Irving flies there; its preview has the placeholder.
        app.buttons["zoneSearchButton"].tap()
        let irvingRow = any(app, "zoneFacility-irving-royal-lane")
        XCTAssertTrue(irvingRow.waitForExistence(timeout: 5), "facilities in search")
        shot(app, "fac-search")
        irvingRow.tap()
        sleep(3)
        let irving = any(app, "facilityMarker-irving-royal-lane")
        XCTAssertTrue(irving.waitForExistence(timeout: 10))
        XCTAssertEqual(irving.label, "Charging & Staging: Irving Robotaxi Hub")
        irving.tap()
        XCTAssertTrue(any(app, "facilityPreview").waitForExistence(timeout: 5))
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label == 'No verified photos yet'")).firstMatch.waitForExistence(timeout: 5), "Irving: the placeholder")
        shot(app, "fac-irving-preview")
        app.buttons["facilityViewDetails"].tap()
        XCTAssertTrue(any(app, "facilityCharging").waitForExistence(timeout: 5) && any(app, "facilityStaging").exists, "combined: both sections")
        shot(app, "fac-irving-details")
    }

    func testFacilityPhotoUnavailableAndLargeText() throws {
        let app = launch(photoBase: "http://127.0.0.1:9", extra: ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityM"])
        toDallas(app)
        let marker = any(app, "facilityMarker-dallas-cedar-springs")
        XCTAssertTrue(marker.waitForExistence(timeout: 10))
        marker.tap()
        XCTAssertTrue(any(app, "facilityPreview").waitForExistence(timeout: 5))
        let placeholder = app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Photo unavailable'")).firstMatch
        XCTAssertTrue(placeholder.waitForExistence(timeout: 20), "a photo that can't load: the placeholder, announced as unavailable")
        XCTAssertFalse(app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Photo: Long rows'")).firstMatch.exists, "never announces a photo that isn't shown")
        shot(app, "fac-large-preview-unavailable")
        app.buttons["facilityViewDetails"].tap()
        XCTAssertTrue(app.staticTexts["facilityDetailName"].waitForExistence(timeout: 5))
        sleep(2)
        shot(app, "fac-large-details")
        app.swipeUp(velocity: .slow)
        shot(app, "fac-large-details-2")
        XCTAssertTrue(app.buttons["facilityOpenMaps"].exists && app.buttons["facilityCopyAddress"].exists, "actions at large text")
    }
}

private extension XCUIElement {
    func waitForLabel(_ label: String, timeout: TimeInterval = 5) -> Bool {
        let e = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", label), object: self)
        return XCTWaiter().wait(for: [e], timeout: timeout) == .completed
    }
}
