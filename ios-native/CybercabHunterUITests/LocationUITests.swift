import XCTest

@MainActor
final class LocationUITests: XCTestCase {
    func testLocationControlPlacementWithoutCameras() {
        let app = XCUIApplication()
        app.launchArguments = ["-tab", "zones", "-zoneStatusFixture", "dallas", "-apiBase", "http://127.0.0.1:8799"]
        app.launch()
        let search = app.buttons["zoneSearchButton"]
        let location = app.buttons["zoneMyLocationButton"]
        XCTAssertTrue(search.waitForExistence(timeout: 15))
        XCTAssertTrue(location.waitForExistence(timeout: 15))
        let deadline = Date().addingTimeInterval(20)
        while !location.isHittable && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        XCTAssertTrue(location.isHittable)
        XCTAssertGreaterThanOrEqual(location.frame.minY, search.frame.maxY)
        XCTAssertEqual(location.frame.midX, search.frame.midX, accuracy: 2)
        let badge = app.buttons["zoneStatusBadge"]
        let cities = app.otherElements["zonesCityPicker"]
        XCTAssertTrue(badge.waitForExistence(timeout: 5))
        XCTAssertEqual(badge.label, "INSIDE DALLAS SERVICE ZONE")
        XCTAssertGreaterThanOrEqual(badge.frame.minY, cities.frame.maxY)
        XCTAssertLessThanOrEqual(badge.frame.minY - cities.frame.maxY, 16)
        XCTAssertEqual(badge.frame.minX, cities.frame.minX, accuracy: 2)
        XCTAssertLessThan(badge.frame.maxX, search.frame.minX)
        XCTAssertLessThan(badge.frame.height, 48)
        XCTAssertLessThan(badge.frame.width, app.windows.firstMatch.frame.width - 70)
        saveShot(app, "zones-without-cameras-dallas")
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "location-controls"; shot.lifetime = .keepAlways; add(shot)
        XCTAssertFalse(app.buttons["Cameras"].exists)
        XCTAssertFalse(app.switches["Nearest Cameras"].exists)
        XCTAssertFalse(app.navigationBars["Cameras"].exists)
        XCTAssertFalse(app.otherElements["cameraInventoryDetail"].exists)
        XCTAssertTrue(app.buttons["zoneDetailsButton"].isHittable)
        // Never change system location permission in an automated UI test.

    }
    func testCompactOutsideStatusKeepsNearestBoundaryAction() {
        let app = XCUIApplication()
        app.launchArguments = ["-tab", "zones", "-zoneStatusFixture", "outside", "-apiBase", "http://127.0.0.1:8799"]
        app.launch()
        let badge = app.buttons["zoneStatusBadge"]
        XCTAssertTrue(badge.waitForExistence(timeout: 15))
        XCTAssertEqual(badge.label, "OUTSIDE SERVICE ZONES")
        badge.tap()
        let nearest = app.buttons["viewNearestZone"]
        XCTAssertTrue(nearest.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'APPROXIMATELY' AND label CONTAINS 'MILES'")).firstMatch.exists)
        nearest.tap()
        XCTAssertTrue(nearest.waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.buttons["zoneMyLocationButton"].isHittable)
        saveShot(app, "zones-compact-status-outside")
    }
    func testSightingsGalleryHasNoNearbyControls() {
        let app = XCUIApplication()
        app.launchArguments = ["-tab", "sightings", "-apiBase", "http://127.0.0.1:8799"]
        app.launch()
        XCTAssertTrue(app.buttons["order-desc"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["submitSighting"].exists)
        XCTAssertFalse(app.switches["Near Me"].exists)
        XCTAssertFalse(app.segmentedControls["nearMeRadius"].exists)
        XCTAssertFalse(app.staticTexts["nearMeCount"].exists)
        XCTAssertFalse(app.staticTexts["Nearby sightings unavailable"].exists)
    }
}
