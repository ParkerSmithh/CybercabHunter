import XCTest

/// Zones and Replay share the session's city: Austin on a fresh launch,
/// Dallas held while the app runs (background included), carried from Zones
/// to Replay and back. The test server has no camera sightings, so Replay
/// must not claim to play (autoplay with data: ReplayCityTests).
@MainActor
final class ZonesReplayCityUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-apiBase", "http://127.0.0.1:8799", "-tab", "zones"]
        app.launch()
        return app
    }

    private func picker(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any)[id] }

    private func selected(_ app: XCUIApplication, in id: String) -> String? {
        let p = picker(app, id)
        for city in ["Austin", "Dallas"] where p.buttons[city].exists && p.buttons[city].isSelected { return city }
        return nil
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
    }

    func testDallasHoldsForTheSessionAndAFreshLaunchIsAustin() throws {
        var app = launch()
        XCTAssertTrue(picker(app, "zonesCityPicker").waitForExistence(timeout: 20))
        XCTAssertEqual(selected(app, in: "zonesCityPicker"), "Austin", "a fresh launch opens Austin")
        picker(app, "zonesCityPicker").buttons["Dallas"].tap()
        XCTAssertEqual(selected(app, in: "zonesCityPicker"), "Dallas")

        // Background and back: the same session keeps Dallas.
        XCUIDevice.shared.press(.home)
        sleep(2)
        app.activate()
        XCTAssertTrue(picker(app, "zonesCityPicker").waitForExistence(timeout: 10))
        XCTAssertEqual(selected(app, in: "zonesCityPicker"), "Dallas", "back from the background: still Dallas")

        // Another tab and back: still Dallas.
        app.tabBars.buttons["Home"].tap()
        app.tabBars.buttons["Zones"].tap()
        XCTAssertEqual(selected(app, in: "zonesCityPicker"), "Dallas")

        // A new process: Austin again.
        app.terminate()
        app = launch()
        XCTAssertTrue(picker(app, "zonesCityPicker").waitForExistence(timeout: 20))
        XCTAssertEqual(selected(app, in: "zonesCityPicker"), "Austin", "relaunched: Austin, not the last session's Dallas")
    }

    func testReplayOpensOnZonesCityAndCarriesASwitchBack() throws {
        let app = launch()
        XCTAssertTrue(picker(app, "zonesCityPicker").waitForExistence(timeout: 20))
        picker(app, "zonesCityPicker").buttons["Dallas"].tap()
        app.buttons["replayButton"].tap()

        XCTAssertTrue(picker(app, "replayCityPicker").waitForExistence(timeout: 15))
        XCTAssertEqual(selected(app, in: "replayCityPicker"), "Dallas", "Dallas Zones → Dallas Replay")
        XCTAssertTrue(app.staticTexts["No camera sightings in this window."].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["replayPlay"].exists)
        XCTAssertEqual(app.buttons["replayPlay"].label, "Play", "no sightings: it doesn't pretend to play")
        XCTAssertFalse(app.buttons["replayPlay"].isEnabled)
        shot(app, "replay-dallas")

        picker(app, "replayCityPicker").buttons["Austin"].tap()
        XCTAssertEqual(selected(app, in: "replayCityPicker"), "Austin")
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] 'Austin'")).firstMatch.waitForExistence(timeout: 5), "the heading follows the city")
        XCTAssertTrue(app.staticTexts["No camera sightings in this window."].waitForExistence(timeout: 15), "Austin's (empty) data loaded")
        shot(app, "replay-austin")

        // Nothing to play: Play stays off rather than running an empty clock
        // (playing by hand with data: ZonesUITests).
        XCTAssertFalse(app.buttons["replayPlay"].isEnabled)
        XCTAssertEqual(app.buttons["replayPlay"].label, "Play")

        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(picker(app, "zonesCityPicker").waitForExistence(timeout: 10))
        XCTAssertEqual(selected(app, in: "zonesCityPicker"), "Austin", "the city chosen in Replay carries back to Zones")
    }
}
