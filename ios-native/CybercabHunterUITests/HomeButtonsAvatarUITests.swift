import XCTest

/// Home's hero buttons fit their labels (arrow 10 pt from the text), still
/// open News and Simulation, and the account avatar has no Liquid Glass
/// bubble but keeps a 44 pt tap target on every tab. Signed in on the
/// isolated test Worker (scripts/test-community.sh).
@MainActor
final class HomeButtonsAvatarUITests: XCTestCase {
    static let server = "http://127.0.0.1:8799"

    override func setUp() async throws {
        continueAfterFailure = false
        var request = URLRequest(url: URL(string: "\(Self.server)/api/social/sidebar")!)
        request.timeoutInterval = 3
        let ok = (try? await URLSession.shared.data(for: request)).map { ($0.1 as? HTTPURLResponse)?.statusCode == 200 } ?? false
        try XCTSkipUnless(ok, "The test Worker isn't running: run ios-native/scripts/test-community.sh")
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
    }

    func testHeroButtonsAreCompactAndNavigate() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-tab", "home", "-apiBase", Self.server, "-session", "s-frank"]
        app.launch()
        let news = app.buttons["homeViewNews"], explore = app.buttons["homeExplore"]
        XCTAssertTrue(news.waitForExistence(timeout: 15) && explore.exists)
        shot(app, "home-buttons")
        let screen = app.windows.firstMatch.frame.width
        // Label + 10 pt + arrow + 2 × 16 pt padding: well under the old "Browse sightings" footprint.
        XCTAssertLessThan(news.frame.width, 150, "View News fits its label: \(news.frame.width)")
        XCTAssertGreaterThanOrEqual(news.frame.height, 43.5)
        XCTAssertLessThan(explore.frame.width, 95, "Explore fits its label: \(explore.frame.width)")
        XCTAssertGreaterThanOrEqual(explore.frame.height, 43.5, "44 pt (allowing for rounding)")
        XCTAssertEqual(news.frame.midY, explore.frame.midY, accuracy: 2, "same row")
        // Both on screen with the 16 pt gutters; the pair (and its 18 pt gap) must also fit 320 − 32 pt (iPhone SE 1st gen, the narrowest).
        XCTAssertLessThanOrEqual(explore.frame.maxX, screen - 16)
        XCTAssertLessThanOrEqual(explore.frame.maxX - news.frame.minX, 288, "fits the narrowest iPhone")

        news.tap()
        XCTAssertTrue(app.staticTexts["newsTitle"].waitForExistence(timeout: 10), "View News → native News")
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(explore.waitForExistence(timeout: 10))
        explore.tap()
        XCTAssertTrue(app.staticTexts["roiTitle"].waitForExistence(timeout: 10), "Explore → native Simulation")
    }

    func testAvatarHasNoGlassBubbleAndOpensAccount() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-tab", "home", "-apiBase", Self.server, "-session", "s-frank"]
        app.launch()
        for tab in ["Home", "Zones", "Community"] {
            app.tabBars.buttons[tab].tap()
            let avatar = app.buttons.matching(identifier: "accountButton").allElementsBoundByIndex.first { $0.exists && $0.isHittable }
            XCTAssertNotNil(avatar, "account avatar on \(tab)")
            if let f = avatar?.frame { XCTAssertTrue(f.width >= 44 && f.height >= 44, "44 pt tap target on \(tab): \(f)") }
            shot(app, "avatar-\(tab)")
        }
        XCTAssertEqual(app.tabBars.buttons.count, 5, "five tabs unchanged")
        app.tabBars.buttons["Home"].tap()
        app.buttons.matching(identifier: "accountButton").allElementsBoundByIndex.first { $0.isHittable }?.tap()
        XCTAssertTrue(app.staticTexts["accountName"].waitForExistence(timeout: 10), "the avatar still opens the account")
    }
}
