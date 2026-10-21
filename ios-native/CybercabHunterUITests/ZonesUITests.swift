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
}
