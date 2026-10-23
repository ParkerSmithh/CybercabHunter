import XCTest

/// Siri and Shortcuts can't be driven from a UI test, so `-open <screen>` does
/// exactly what the "Open …" intent does (AppRouter.open) at a cold launch.
/// Live site, read only.
@MainActor
final class SiriUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    /// Sets a List row's switch: waits until it can be tapped (a sheet's first
    /// touch can land mid-animation), taps the switch itself, and checks the value.
    private func set(_ e: XCUIElement, to value: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(e.waitForExistence(timeout: 10))
        // Clear of the sheet's bottom edge before tapping.
        let app = XCUIApplication()
        var n = 0
        while e.frame.maxY > app.windows.firstMatch.frame.maxY - 140 && n < 5 { app.swipeUp(velocity: .slow); n += 1 }
        expectation(for: NSPredicate(format: "isHittable == true AND isEnabled == true"), evaluatedWith: e)
        waitForExpectations(timeout: 10)
        for _ in 0..<3 where (e.value as? String) != value {
            e.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
            _ = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", value), object: e)], timeout: 2)
        }
        XCTAssertEqual(e.value as? String, value, "\(e.identifier)", file: file, line: line)
    }

    private func launch(_ args: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = args
        app.launch()
        return app
    }

    func testOpenDMVTrackerFromAColdLaunch() throws {
        let app = launch(["-open", "dmvTracker"])
        XCTAssertTrue(app.staticTexts["dmvTitle"].waitForExistence(timeout: 20), "the DMV tracker, pushed on Home")
        saveShot(app, "siri-open-dmv")
        XCTAssertTrue(app.tabBars.buttons["Home"].isSelected)
    }

    func testOpenMapFromAColdLaunch() throws {
        let app = launch(["-open", "map"])
        XCTAssertTrue(app.tabBars.buttons["Zones"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.tabBars.buttons["Zones"].isSelected)
    }

    func testActivityAlertsStayOffUntilTheRiderTurnsThemOn() throws {
        var app = launch(["-open", "alertSettings", "-resetSiriState"])
        let toggle = app.switches["alertsMasterToggle"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 15), "Siri opens Activity Alerts")
        XCTAssertEqual(toggle.value as? String, "0", "off by default, and opening the screen doesn't turn it on")
        XCTAssertTrue(app.staticTexts["Not available yet"].exists, "delivery isn't claimed")
        XCTAssertFalse(app.switches["alertsCategory-dmvVINs"].isEnabled, "nothing to choose until alerts are on")
        saveShot(app, "siri-alerts-off")
        // The rider turns them on: only now is notification permission asked
        // (a simulator that already answered it shows no alert).
        set(toggle, to: "1")
        let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Allow"]
        if allow.waitForExistence(timeout: 3) { allow.tap() }
        let dmv = app.switches["alertsCategory-dmvVINs"]
        set(dmv, to: "1")
        saveShot(app, "siri-alerts-on")
        // Saved: still on after a relaunch; off again whenever the rider wants.
        app.terminate()
        app = launch(["-open", "alertSettings"])
        let again = app.switches["alertsMasterToggle"]
        XCTAssertTrue(again.waitForExistence(timeout: 15))
        XCTAssertEqual(again.value as? String, "1")
        XCTAssertEqual(app.switches["alertsCategory-dmvVINs"].value as? String, "1")
        set(again, to: "0")
        app.terminate()
        app = launch(["-open", "alertSettings"])
        XCTAssertTrue(app.switches["alertsMasterToggle"].waitForExistence(timeout: 15))
        XCTAssertEqual(app.switches["alertsMasterToggle"].value as? String, "0", "turned off stays off")
    }

    func testSiriSettingsListsActionsAndPermissions() throws {
        let app = launch(["-open", "siriSettings", "-resetSiriState"])
        XCTAssertTrue(app.staticTexts["Daily Briefing"].waitForExistence(timeout: 15))
        for title in ["Quick Status", "Check Fleet", "DMV Updates", "Fleet Growth", "Recent Sightings", "Nearby Sightings", "Find a Cybercab", "Vehicle History", "Service Zone", "Open a Screen"] {
            var n = 0
            while !(app.staticTexts[title].exists && app.staticTexts[title].isHittable) && n < 6 { app.swipeUp(velocity: .slow); n += 1 }
            XCTAssertTrue(app.staticTexts[title].exists, title)
        }
        saveShot(app, "siri-settings-top")
        var n = 0
        while !app.staticTexts["siriLocationStatus"].exists && !app.descendants(matching: .any)["siriLocationStatus"].exists && n < 8 { app.swipeUp(velocity: .slow); n += 1 }
        XCTAssertTrue(app.descendants(matching: .any)["siriLocationStatus"].exists, "location status shown; nothing asked yet")
        saveShot(app, "siri-settings-bottom")
    }
}
