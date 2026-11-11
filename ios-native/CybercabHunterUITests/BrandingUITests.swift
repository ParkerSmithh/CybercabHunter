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
        let app = XCUIApplication()
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

        // Community: the eyebrow keeps the brand's own case.
        app.tabBars.buttons["Community"].tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH 'CybercabHunter'")).firstMatch.waitForExistence(timeout: 15))
        shot(app, "brand-community")
    }
}
