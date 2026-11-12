import XCTest

/// The CybercabHunter branding (Nov 2026): the gold diamond emblem
/// (BrandMark, from CybercabLogoNew.png) with the one-word wordmark — Home's
/// top bar (also CarsSearchUITests.testHomeBrandIsCentred), the Account
/// sign-in panel and Community's eyebrow.
@MainActor
final class BrandingUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
    }

    func testHomeAccountAndCommunityBranding() throws {
        let app = XCUIApplication.forTests()
        app.launchArguments = ["-apiBase", "http://127.0.0.1:8799"]
        app.launch()
        let brand = app.descendants(matching: .any)["homeBrand"]
        XCTAssertTrue(brand.waitForExistence(timeout: 20))
        XCTAssertEqual(brand.label, "CybercabHunter")
        XCTAssertEqual(app.navigationBars.count, 1, "one top bar, no duplicate header")
        shot(app, "brand-home")

        // Account, signed out: the emblem and "Sign in to CybercabHunter".
        app.buttons["accountButton"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Sign in to CybercabHunter"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.images["BrandMark"].exists || app.images.matching(NSPredicate(format: "identifier == 'BrandMark'")).firstMatch.exists)
        shot(app, "brand-account")
        app.buttons["Done"].firstMatch.tap()

        // Community: no redundant "… community" heading over the page title.
        app.tabBars.buttons["Community"].tap()
        XCTAssertTrue(app.staticTexts["COMMUNITY"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] 'hunter community'")).firstMatch.exists, "the old Community heading is gone")
        shot(app, "brand-community")
    }

    /// The Zones map and Replay carry the same lockup in their top bar, beside
    /// the Account button and (Replay) the back button, without covering either.
    func testZonesAndReplayBranding() throws {
        let app = XCUIApplication.forTests()
        app.launchArguments = ["-apiBase", "http://127.0.0.1:8799", "-tab", "zones"]
        app.launch()
        let zones = app.descendants(matching: .any)["zonesBrand"]
        XCTAssertTrue(zones.waitForExistence(timeout: 20))
        XCTAssertEqual(zones.label, "CybercabHunter")
        let screen = app.windows.firstMatch.frame
        XCTAssertTrue(screen.contains(zones.frame), "never cut off: \(zones.frame)")
        XCTAssertGreaterThan(zones.frame.width, zones.frame.height * 4, "one line")
        let account = app.buttons["accountButton"].firstMatch
        XCTAssertFalse(zones.frame.intersects(account.frame), "clear of the Account button")
        let picker = app.otherElements["zonesCityPicker"]
        XCTAssertTrue(picker.waitForExistence(timeout: 10))
        XCTAssertLessThanOrEqual(zones.frame.maxY, picker.frame.minY, "the brand sits above the map's controls, not over them")
        XCTAssertTrue(app.descendants(matching: .any)["zonesMap"].exists && app.buttons["replayButton"].isHittable, "map and controls still there")
        shot(app, "brand-zones")

        app.buttons["replayButton"].tap()
        let replay = app.descendants(matching: .any)["replayBrand"]
        XCTAssertTrue(replay.waitForExistence(timeout: 15))
        XCTAssertEqual(replay.label, "CybercabHunter")
        XCTAssertTrue(screen.contains(replay.frame), "never cut off: \(replay.frame)")
        let back = app.navigationBars.buttons.firstMatch
        XCTAssertTrue(back.exists && back.isHittable, "the back button stays usable")
        XCTAssertFalse(replay.frame.intersects(back.frame), "clear of the back button")
        sleep(2)
        shot(app, "brand-replay")
        back.tap()
        XCTAssertTrue(zones.waitForExistence(timeout: 10), "back to Zones")
    }
}
