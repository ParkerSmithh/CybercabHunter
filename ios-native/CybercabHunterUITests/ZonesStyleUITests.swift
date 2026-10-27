import XCTest

/// The refined Zones map: thin zone outline, compact Cybercab markers that
/// cluster (a tap zooms them apart), the charging tile, aligned controls.
/// Live site, read only; screenshots kept for review.
@MainActor
final class ZonesStyleUITests: XCTestCase {
    override func setUp() { continueAfterFailure = true }
    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
    }

    func testZonesMarkersClustersAndControls() throws {
        let app = XCUIApplication()
        app.launch()
        app.tabBars.buttons["Zones"].tap()
        let markers = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Cybercab seen by the traffic camera'"))
        let clusters = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Cybercabs seen by nearby traffic cameras'"))
        XCTAssertTrue(markers.firstMatch.waitForExistence(timeout: 20) || clusters.firstMatch.exists, "Cybercab markers")
        sleep(3)
        shot(app, "zones-austin")

        // Controls: one height, aligned.
        let details = app.buttons["zoneDetailsButton"], search = app.buttons["zoneSearchButton"]
        let picker = app.descendants(matching: .any)["zonesCityPicker"]
        XCTAssertEqual(details.frame.height, 48, accuracy: 1)
        XCTAssertEqual(search.frame.height, 48, accuracy: 1)
        XCTAssertEqual(picker.frame.height, 48, accuracy: 1)
        XCTAssertEqual(details.frame.maxY, picker.frame.maxY, accuracy: 1, "Zone details level with the selector")
        XCTAssertEqual(app.buttons["replayButton"].frame.height, 48, accuracy: 1)

        // A cluster: tapping it zooms in until the Cybercabs separate.
        if clusters.firstMatch.exists {
            let before = markers.count
            clusters.firstMatch.tap()
            sleep(3)
            shot(app, "zones-cluster-zoomed")
            XCTAssertGreaterThan(markers.count, before, "the cluster's Cybercabs shown apart")
            for _ in 0..<2 { app.buttons["Dallas"].firstMatch.tap(); sleep(1); app.buttons["Austin"].firstMatch.tap(); sleep(2) }
        }

        // A charging location opens its sheet.
        let charging = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Charging location'")).firstMatch
        if charging.waitForExistence(timeout: 5) {
            charging.tap()
            XCTAssertTrue(app.staticTexts["CHARGING LOCATION"].waitForExistence(timeout: 5), "charging sheet")
            shot(app, "zones-charging-sheet")
            app.swipeDown(velocity: .fast); sleep(1)
        }

        app.buttons["Dallas"].firstMatch.tap()
        sleep(4)
        shot(app, "zones-dallas")
        app.buttons["Austin"].firstMatch.tap()
        sleep(2)
        app.buttons["heatmapButton"].tap()
        XCTAssertTrue(app.buttons["heatPanelExpand"].waitForExistence(timeout: 10))
        sleep(4)
        shot(app, "zones-heatmap")
        app.buttons["normalMapButton"].tap()
    }
}
