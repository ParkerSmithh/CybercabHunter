import XCTest

/// Phase 3 acceptance on the real backend: Zones, the heatmap, the Replay,
/// Home's predictions and minimap — all native, never a web view or Safari.
@MainActor
final class ZonesUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
    }
    private func assertNative(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(app.webViews.count, 0, "a web view appeared", file: file, line: line)
        XCTAssertEqual(XCUIApplication(bundleIdentifier: "com.apple.mobilesafari").state, .notRunning, "Safari opened", file: file, line: line)
        XCTAssertEqual(app.state, .runningForeground, file: file, line: line)
    }

    func testZonesHeatmapAndReplayAreNative() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-tab", "zones"]
        app.launch()

        XCTAssertTrue(app.otherElements["zonesMap"].waitForExistence(timeout: 20) || app.maps.firstMatch.waitForExistence(timeout: 5))
        sleep(4)   // tiles and the live markers
        shot(app, "z1-zones-austin")
        assertNative(app)

        // Zone details: the website's panel, natively.
        app.buttons["zoneDetailsButton"].tap()
        XCTAssertTrue(app.staticTexts["FLEET & FARES"].waitForExistence(timeout: 10))
        sleep(2)
        shot(app, "z2-zone-details")
        app.swipeDown(velocity: .fast)
        sleep(1)

        // Dallas, then back to Austin.
        app.buttons["Dallas"].firstMatch.tap()
        sleep(3)
        shot(app, "z3-zones-dallas")
        app.buttons["Austin"].firstMatch.tap()
        sleep(2)

        // Heatmap: real detections (or the honest empty line).
        app.buttons["heatmapButton"].tap()
        let status = app.staticTexts["heatStatus"]
        XCTAssertTrue(status.waitForExistence(timeout: 10))
        expectation(for: NSPredicate(format: "label CONTAINS 'detection' AND NOT (label BEGINSWITH 'Loading')"), evaluatedWith: status)
        waitForExpectations(timeout: 25)
        sleep(2)
        shot(app, "z4-heatmap-7d")
        app.buttons["heatRange-all"].tap()
        sleep(3)
        shot(app, "z5-heatmap-all")
        assertNative(app)
        app.buttons["normalMapButton"].tap()

        // Replay.
        app.buttons["replayButton"].tap()
        let count = app.staticTexts["replayCount"]
        XCTAssertTrue(count.waitForExistence(timeout: 20))
        let play = app.buttons["replayPlay"]
        expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: play)
        waitForExpectations(timeout: 30)
        shot(app, "z6-replay-start")
        play.tap()
        sleep(6)
        shot(app, "z7-replay-playing")
        play.tap()
        XCTAssertGreaterThan(Int(count.label.replacingOccurrences(of: ",", with: "")) ?? 0, 0, "sightings landed during playback")
        assertNative(app)
    }

    func testHomePredictionsAndMinimap() throws {
        let app = XCUIApplication()
        app.launch()
        let scroll = app.scrollViews.firstMatch
        XCTAssertTrue(scroll.waitForExistence(timeout: 20))

        // Fleet growth: Actual + Predictions shows the forecast tiles.
        let predictions = app.buttons["Actual + Predictions"].firstMatch
        for _ in 0..<8 where !predictions.isHittable { scroll.swipeUp(velocity: .slow) }
        XCTAssertTrue(predictions.waitForExistence(timeout: 20))
        predictions.tap()
        XCTAssertTrue(app.otherElements["fleetForecastTiles"].waitForExistence(timeout: 10) || app.staticTexts["CURRENT DOCUMENTED FLEET"].waitForExistence(timeout: 5))
        sleep(1)
        shot(app, "h1-fleet-predictions")

        // The US map further down.
        for _ in 0..<4 { scroll.swipeUp(velocity: .fast) }
        shot(app, "h2-home-us-map")

        // Back up to the minimap; it opens Zones natively.
        for _ in 0..<12 { scroll.swipeDown(velocity: .fast) }
        let minimap = app.buttons["zoneMiniMap"]
        for _ in 0..<6 where !minimap.isHittable { scroll.swipeUp(velocity: .slow) }
        XCTAssertTrue(minimap.waitForExistence(timeout: 10))
        shot(app, "h3-minimap")
        minimap.tap()
        XCTAssertTrue(app.buttons["zoneDetailsButton"].waitForExistence(timeout: 10))
        assertNative(app)
    }

    // MARK: Phase 5.1

    /// The map key is only in Zone details (as on the website), never floating on the map.
    func testZonesLegendOnlyInZoneDetails() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-tab", "zones"]
        app.launch()
        XCTAssertTrue(app.buttons["zoneDetailsButton"].waitForExistence(timeout: 20))
        sleep(2)
        let legend = app.descendants(matching: .any)["zoneDetailsLegend"]
        let floating = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Map key'"))
        XCTAssertFalse(legend.exists, "closed: no legend")
        XCTAssertEqual(floating.count, 0, "closed: no floating map key")
        XCTAssertFalse(app.staticTexts["Charging"].exists)
        shot(app, "z8-zones-no-legend")

        app.buttons["zoneDetailsButton"].tap()
        XCTAssertTrue(legend.waitForExistence(timeout: 10), "open: the legend is in Zone details")
        XCTAssertTrue(legend.label.contains("Charging Locations") && legend.label.contains("Cybercabs"))
        shot(app, "z9-zone-details-legend")
        app.swipeDown(velocity: .fast)
        XCTAssertTrue(legend.waitForNonExistence(timeout: 10), "closed again: gone")
        XCTAssertEqual(floating.count, 0)
        assertNative(app)
    }

    /// Home's minimap is the website's phone card: height 0.92 × width, Austin and Dallas.
    func testHomeMinimapsMatchTheWebsite() throws {
        let app = XCUIApplication()
        app.launch()
        let scroll = app.scrollViews.firstMatch
        XCTAssertTrue(scroll.waitForExistence(timeout: 20))
        let minimap = app.buttons["zoneMiniMap"]
        for _ in 0..<10 where !(minimap.exists && minimap.isHittable) { scroll.swipeUp(velocity: .slow) }
        XCTAssertTrue(minimap.waitForExistence(timeout: 10))
        func checkRatio(_ city: String) {
            let title = app.staticTexts["\(city.uppercased()) MINIMAP"]
            for _ in 0..<6 where !(title.exists && minimap.isHittable) { scroll.swipeUp(velocity: .slow); _ = title.waitForExistence(timeout: 3) }
            XCTAssertTrue(title.waitForExistence(timeout: 15), "\(city)'s minimap")
            let f = minimap.frame
            XCTAssertGreaterThan(f.width, 200, city)
            XCTAssertEqual(f.height / f.width, 0.92, accuracy: 0.02, "\(city): \(f)")
            XCTAssertTrue(app.staticTexts["\(city.uppercased()) MINIMAP"].exists, city)
            XCTAssertTrue(app.staticTexts["Explore map"].exists || minimap.label.contains("Explore map") || app.buttons.containing(NSPredicate(format: "label CONTAINS 'Explore map'")).firstMatch.exists)
        }
        sleep(3)   // the zone draws
        // Back up a little so the whole card is on screen.
        if minimap.frame.minY < 120 { scroll.swipeDown(velocity: .slow) }
        checkRatio("Austin")
        shot(app, "h4-minimap-austin")
        let dallas = app.buttons["Dallas"].firstMatch
        for _ in 0..<6 where !dallas.isHittable { scroll.swipeDown(velocity: .slow) }
        // A tap while the list is still decelerating is dropped: tap until the city is selected.
        for _ in 0..<3 where !dallas.isSelected {
            sleep(1)
            dallas.tap()
            _ = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "isSelected == true"), object: dallas)], timeout: 3)
        }
        XCTAssertTrue(dallas.isSelected, "Dallas chosen")
        for _ in 0..<6 where !(minimap.exists && minimap.isHittable) { scroll.swipeUp(velocity: .slow) }
        sleep(3)
        checkRatio("Dallas")
        shot(app, "h5-minimap-dallas")
        minimap.tap()
        XCTAssertTrue(app.buttons["zoneDetailsButton"].waitForExistence(timeout: 10), "Explore map opens Zones")
        assertNative(app)
    }
}
