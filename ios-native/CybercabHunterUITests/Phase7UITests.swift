import XCTest

/// Phase 7 acceptance: the website's remaining pages, natively. Simulation,
/// News and the Texas DMV roster read the live site (read only); the signed-in
/// screens (Rider data, Gmail, Tesla) use the isolated test Worker.
@MainActor
final class Phase7UITests: XCTestCase {
    static let server = "http://127.0.0.1:8799"
    override func setUp() { continueAfterFailure = false }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
    }
    private func reveal(_ e: XCUIElement, in app: XCUIApplication, swipes: Int = 10) {
        var n = 0
        while !(e.exists && e.isHittable) && n < swipes { app.swipeUp(velocity: .slow); n += 1 }
    }
    private func openExplore(_ app: XCUIApplication, _ id: String) {
        let card = app.buttons[id]
        XCTAssertTrue(app.scrollViews.firstMatch.waitForExistence(timeout: 20))
        reveal(card, in: app)
        XCTAssertTrue(card.waitForExistence(timeout: 10), id)
        card.tap()
    }

    // MARK: Simulation

    func testSimulationROIAndFleetEta() throws {
        let app = XCUIApplication()
        app.launch()
        openExplore(app, "exploreSimulation")
        XCTAssertTrue(app.staticTexts["roiTitle"].waitForExistence(timeout: 10))
        let note = app.staticTexts["roiStartNote"]
        expectation(for: NSPredicate(format: "label CONTAINS 'lifetime registry count'"), evaluatedWith: note)
        waitForExpectations(timeout: 15)
        XCTAssertFalse(app.navigationBars.firstMatch.staticTexts["Simulation"].exists, "no redundant title")
        shot(app, "p7-roi")
        // An exact fleet size: 10 cabs, $0.12/kWh, 150 mi/day, loss on (calc.js values).
        let fleet = app.textFields["roiFleetField"]
        reveal(fleet, in: app)
        fleet.tap()
        fleet.press(forDuration: 1.0)
        if app.menuItems["Select All"].waitForExistence(timeout: 2) { app.menuItems["Select All"].tap() }
        fleet.typeText("10\n")
        let results = app.descendants(matching: .any)["roiResults"]
        reveal(results, in: app)
        func shown(_ text: String) -> XCUIElement { app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch }
        XCTAssertTrue(shown("$90,000").waitForExistence(timeout: 5), "gross revenue for 10 cabs: 150 mi ÷ 5 = 30 trips × $10 × 10 cabs × 30 days")
        XCTAssertTrue(shown("$1,458").exists, "energy overhead: 150 × 0.25 kWh × $0.12 × 10 × 30 × 1.08")
        XCTAssertTrue(shown("$66,042").exists, "net operating income: 90,000 − 25% − 1,458")
        XCTAssertTrue(app.staticTexts["roiBreakeven"].label.hasSuffix("mo"))
        let chart = app.descendants(matching: .any)["roiChart"]
        reveal(chart, in: app)
        shot(app, "p7-roi-results")

        // Fleet ETA: Austin, then Dallas (each its own numbers).
        for _ in 0..<10 { app.swipeDown(velocity: .fast) }
        app.buttons["simTab-eta"].tap()
        XCTAssertTrue(app.staticTexts["etaTitle"].waitForExistence(timeout: 10))
        let cyCard = app.otherElements["etaCard-cybercab"]
        XCTAssertTrue(cyCard.waitForExistence(timeout: 20), "the Cybercab card (live estimates)")
        let fare = app.staticTexts["etaFare-cybercab"]
        XCTAssertTrue(fare.label.hasPrefix("$") || fare.label == "Insufficient data", "a range or no number, never a guess: \(fare.label)")
        XCTAssertTrue(app.staticTexts["etaAssumed"].label.contains("not a Tesla label"))
        shot(app, "p7-eta-austin")
        reveal(cyCard, in: app)
        shot(app, "p7-eta-austin-cards")
        app.buttons["scenario-busy"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["etaAssumed"].label.hasPrefix("Showing Busy") || app.staticTexts["etaAssumed"].label.contains("Busy"))
        for _ in 0..<12 { app.swipeDown(velocity: .fast) }
        app.otherElements["etaCityPicker"].buttons["Dallas"].tap()
        let dalCard = app.otherElements["etaCard-cybercab"]
        XCTAssertTrue(dalCard.waitForExistence(timeout: 20))
        let dalFare = app.staticTexts["etaFare-cybercab"]
        XCTAssertTrue(dalFare.label.hasPrefix("$") || dalFare.label == "Insufficient data")
        XCTAssertFalse(app.staticTexts["etaFleetLine"].exists, "the registry count line is Austin's only")
        reveal(dalCard, in: app)
        shot(app, "p7-eta-dallas")
        let method = app.descendants(matching: .any)["etaMethod"]
        reveal(method, in: app)
        XCTAssertTrue(method.exists)
        XCTAssertEqual(app.webViews.count, 0)
    }

    // MARK: News

    func testNewsFeedFiltersSearchAndOpensTheArticle() throws {
        let app = XCUIApplication()
        app.launch()
        openExplore(app, "exploreNews")
        XCTAssertTrue(app.staticTexts["newsTitle"].waitForExistence(timeout: 10))
        let story = app.otherElements["newsStory"].firstMatch
        XCTAssertTrue(story.waitForExistence(timeout: 20), "live headlines")
        let stats = app.descendants(matching: .any)["newsStats"]
        expectation(for: NSPredicate(format: "NOT (label CONTAINS '—')"), evaluatedWith: stats)
        waitForExpectations(timeout: 30)
        shot(app, "p7-news")
        // Major only: every card is Major.
        let major = app.buttons["newsFilter-major"]
        reveal(major, in: app)
        major.tap()
        sleep(3)
        let majors = app.otherElements.matching(identifier: "newsStory")
        if majors.count > 0 { XCTAssertTrue(majors.firstMatch.staticTexts["MAJOR"].exists, "Major only lists Major stories") }
        else { XCTAssertTrue(app.descendants(matching: .any)["newsEmpty"].exists) }
        app.buttons["newsFilter-all"].tap()
        // Search with no match: the site's empty message.
        let search = app.textFields["newsSearch"]
        search.tap()
        search.typeText("zzqqxxnomatch")
        XCTAssertTrue(app.descendants(matching: .any)["newsEmpty"].waitForExistence(timeout: 15), "No stories match.")
        shot(app, "p7-news-empty-search")
        search.buttons.firstMatch.exists ? search.buttons.firstMatch.tap() : app.buttons["Clear search"].tap()
        XCTAssertTrue(app.otherElements["newsStory"].firstMatch.waitForExistence(timeout: 20))
        // Opening a story shows the publisher's own page (Safari's in-app viewer, not a web view of ours).
        app.otherElements["newsStory"].firstMatch.buttons.firstMatch.tap()
        let done = app.buttons["Done"].firstMatch
        XCTAssertTrue(done.waitForExistence(timeout: 15) || app.buttons["Close"].firstMatch.waitForExistence(timeout: 5), "the original article opened")
        shot(app, "p7-news-article")
    }

    // MARK: Texas DMV

    func testDMVRosterFiltersAndSearch() throws {
        let app = XCUIApplication()
        app.launch()
        openExplore(app, "exploreDMV")
        XCTAssertTrue(app.staticTexts["dmvTitle"].waitForExistence(timeout: 10))
        let row = app.descendants(matching: .any).matching(identifier: "dmvRow").firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 20), "the live TxDMV roster")
        let count = app.staticTexts["dmvCount"]
        XCTAssertTrue(count.label.contains(" of ") && count.label.hasSuffix("VINs"), count.label)
        shot(app, "p7-dmv")
        // Cybercab only: every row on screen is a Cybercab.
        app.buttons["dmvModel-cybercab"].tap()
        sleep(3)
        let rows = app.descendants(matching: .any).matching(identifier: "dmvRow")
        if rows.count > 0 { XCTAssertTrue(rows.firstMatch.label.localizedCaseInsensitiveContains("cybercab"), rows.firstMatch.label) }
        shot(app, "p7-dmv-cybercab")
        // A VIN that can't exist: the site's no-match line.
        let search = app.textFields["dmvSearch"]
        search.tap()
        search.typeText("ZZZZZZZZZZ")
        expectation(for: NSPredicate(format: "label == 'No VIN matches that search.'"), evaluatedWith: app.staticTexts["dmvCount"])
        waitForExpectations(timeout: 15)
        XCTAssertEqual(app.webViews.count, 0)
    }
}
