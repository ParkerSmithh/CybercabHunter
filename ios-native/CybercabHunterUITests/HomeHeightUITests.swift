import XCTest

/// Measures Home's scroll height (total, and below the Austin minimap) once
/// every section has loaded, and saves screenshots of the lower sections.
@MainActor
final class HomeHeightUITests: XCTestCase {
    func testMeasureHome() throws {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.buttons["homeViewNews"].waitForExistence(timeout: 20))
        sleep(6)
        let heights = app.descendants(matching: .any)["homeHeights"]
        XCTAssertTrue(heights.waitForExistence(timeout: 5))
        // Scroll through everything so every lazy section is laid out, shooting the lower part.
        var i = 0, last = ""
        for _ in 0..<40 {
            let s = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8))
            s.press(forDuration: 0.05, thenDragTo: s.withOffset(CGVector(dx: 0, dy: -560)), withVelocity: 1500, thenHoldForDuration: 0.3)
            usleep(800_000)
            saveShot(app, "home-\(String(format: "%02d", i))"); i += 1
            let now = heights.label
            if now == last && app.buttons["homeViewNews"].exists && i > 6 { break }
            last = now
        }
        sleep(2)
        let parts = heights.label.split(separator: " ")
        let note = "HOME_HEIGHTS total=\(parts.first ?? "?") below=\(parts.last ?? "?") screens=\(i)"
        print(note)
        let a = XCTAttachment(string: note); a.lifetime = .keepAlways; add(a)
        try note.write(toFile: "/tmp/cch-shots/heights.txt", atomically: true, encoding: .utf8)
    }

    /// Each redesigned section framed on screen, with its controls exercised.
    func testShootSections() throws {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.buttons["homeViewNews"].waitForExistence(timeout: 20))
        sleep(5)
        func bring(_ e: XCUIElement, below: CGFloat = 230) {
            for _ in 0..<30 where !(e.exists && e.isHittable && e.frame.minY < 640) {
                let s = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75))
                s.press(forDuration: 0.05, thenDragTo: s.withOffset(CGVector(dx: 0, dy: -180)), withVelocity: 600, thenHoldForDuration: 0.25)
            }
            // Settle its top near `below` points from the top.
            let dy = e.frame.minY - below
            if abs(dy) > 20 {
                let s = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6))
                s.press(forDuration: 0.05, thenDragTo: s.withOffset(CGVector(dx: 0, dy: -dy)), withVelocity: 400, thenHoldForDuration: 0.4)
            }
            sleep(1)
        }
        let tile = app.descendants(matching: .any)["fleetRegistryTile"]
        bring(tile, below: 230)
        saveShot(app, "sec-fleet")
        let predict = app.buttons.matching(identifier: "predictToggle").allElementsBoundByIndex.first { $0.isHittable }
        XCTAssertNotNil(predict, "Predict on Fleet growth")
        predict?.tap(); sleep(2)
        saveShot(app, "sec-fleet-predict")
        predict?.tap(); sleep(1)
        let registry = app.buttons["dmvEveryVin"]
        bring(registry, below: 600)
        saveShot(app, "sec-dmv")
        let all = app.buttons["usAllStates"]
        bring(all, below: 560)
        all.tap()
        XCTAssertTrue(app.navigationBars["Sightings by state"].waitForExistence(timeout: 5), "the full state list")
        saveShot(app, "sec-us-all")
        app.buttons["Done"].firstMatch.tap(); sleep(1)
        let rides = app.staticTexts.matching(NSPredicate(format: "label ==[c] %@", "Ride stats")).firstMatch
        bring(rides, below: 160)
        saveShot(app, "sec-rides")
    }
}
