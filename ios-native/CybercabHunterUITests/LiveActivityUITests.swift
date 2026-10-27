import XCTest

/// The Live now card's Live Activity switch in the running app, and the real
/// Dynamic Island / Lock Screen it drives on the simulator (screenshots for review).
@MainActor
final class LiveActivityUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    private func set(_ e: XCUIElement, to value: String, in app: XCUIApplication) {
        var n = 0
        while !(e.exists && e.isHittable) && n < 10 { app.swipeUp(velocity: .slow); n += 1 }
        XCTAssertTrue(e.waitForExistence(timeout: 10))
        for _ in 0..<3 where (e.value as? String) != value {
            e.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
            _ = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", value), object: e)], timeout: 3)
        }
        print("LIVE ACTIVITY STATUS:", app.staticTexts["liveActivityStatus"].label, "| frame:", e.frame)
        saveShot(app, "live-activity-after-set-\(value)")
        XCTAssertEqual(e.value as? String, value)
    }

    func testSwitchIsOffByDefaultAndDrivesTheLiveActivity() throws {
        var app = XCUIApplication()
        app.launchArguments = ["-tab", "home", "-resetLiveActivity"]
        app.launch()
        let toggle = app.switches["liveActivityToggle"]
        var n = 0
        while !toggle.exists && n < 10 { app.swipeUp(velocity: .slow); n += 1 }
        XCTAssertTrue(toggle.waitForExistence(timeout: 15), "the switch is in the Live now card")
        XCTAssertEqual(toggle.value as? String, "0", "off by default")
        XCTAssertTrue(app.staticTexts["liveActivityStatus"].label.hasPrefix("Off"))
        saveShot(app, "live-activity-switch-off")
        set(toggle, to: "1", in: app)
        expectation(for: NSPredicate(format: "label BEGINSWITH 'On'"), evaluatedWith: app.staticTexts["liveActivityStatus"])
        waitForExpectations(timeout: 10)
        saveShot(app, "live-activity-switch-on")
        // The real Dynamic Island (home screen) and Lock Screen activity.
        XCUIDevice.shared.press(.home)
        sleep(3)
        let screen = XCUIScreen.main.screenshot()
        try screen.pngRepresentation.write(to: URL(fileURLWithPath: "/tmp/cch-shots/live-activity-island-home.png"))
        // Relaunch: the choice is kept and the activity reconciled, not restarted twice.
        app = XCUIApplication()
        app.launchArguments = ["-tab", "home"]
        app.launch()
        let again = app.switches["liveActivityToggle"]
        n = 0
        while !again.exists && n < 10 { app.swipeUp(velocity: .slow); n += 1 }
        XCTAssertTrue(again.waitForExistence(timeout: 15))
        XCTAssertEqual(again.value as? String, "1", "kept across launches")
        // Off: ends it at once, and stays off on the next launch.
        set(again, to: "0", in: app)
        expectation(for: NSPredicate(format: "label BEGINSWITH 'Off'"), evaluatedWith: app.staticTexts["liveActivityStatus"])
        waitForExpectations(timeout: 10)
        XCUIDevice.shared.press(.home)
        sleep(2)
        try XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "/tmp/cch-shots/live-activity-island-off.png"))
        app.launch()
        let third = app.switches["liveActivityToggle"]
        n = 0
        while !third.exists && n < 10 { app.swipeUp(velocity: .slow); n += 1 }
        XCTAssertEqual(third.value as? String, "0", "never turns itself back on")
    }
}
