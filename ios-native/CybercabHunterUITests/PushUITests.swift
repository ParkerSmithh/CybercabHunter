import XCTest

@MainActor
final class PushUITests: XCTestCase {
    func testNotificationSettings() {
        let app = XCUIApplication()
        app.launchArguments = ["-pushSettings"]
        app.launch()
        XCTAssertTrue(app.navigationBars["Notifications"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts["iOS permission"].exists)
        XCTAssertTrue(app.switches["Push Notifications"].exists)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "push-settings-general"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        app.swipeUp()
        XCTAssertTrue(app.staticTexts["Cybercab Daily Report"].firstMatch.waitForExistence(timeout: 5))
        let daily = XCTAttachment(screenshot: app.screenshot())
        daily.name = "push-settings-categories"
        daily.lifetime = .keepAlways
        add(daily)
        // No permission request, Save, registration or production write.
    }
}
