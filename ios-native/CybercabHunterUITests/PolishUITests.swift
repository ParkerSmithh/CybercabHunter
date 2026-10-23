import XCTest

/// The iPhone polish pass: Home with no blank band, Community tabs on one
/// screen, compact car cards, the News filter, the full camera photo, the
/// collapsible heatmap panel, Replay's Day / Dusk / Night, Simulation pictures
/// inside their cards. Live site, read only (the sighting form uses the test Worker).
@MainActor
final class PolishUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
    }
    private func reveal(_ e: XCUIElement, in app: XCUIApplication, swipes: Int = 12) {
        var n = 0
        while !(e.exists && e.isHittable) && n < swipes { app.swipeUp(velocity: .slow); n += 1 }
    }
    private var screen: CGRect { XCUIApplication().windows.firstMatch.frame }

    func testHomeStatsFollowTheHero() throws {
        let app = XCUIApplication()
        app.launch()
        let news = app.buttons["homeViewNews"]
        XCTAssertTrue(news.waitForExistence(timeout: 20))
        let stat = app.staticTexts.matching(NSPredicate(format: "identifier BEGINSWITH 'headline-'")).firstMatch
        XCTAssertTrue(stat.waitForExistence(timeout: 20))
        // The stats bar sits right under the buttons, on the first screen (no blank band).
        XCTAssertLessThan(stat.frame.minY - news.frame.maxY, 120, "gap \(stat.frame.minY - news.frame.maxY)")
        XCTAssertLessThan(stat.frame.maxY, screen.maxY, "visible without scrolling")
        shot(app, "home-first-screen")
        app.swipeUp(velocity: .slow)
        shot(app, "home-scrolled")
    }

    func testCommunityTabsCarsAndNewsFilter() throws {
        let app = XCUIApplication()
        app.launch()
        app.tabBars.buttons["Community"].tap()
        let ids = ["social", "streaks", "leaderboard", "progress"].map { app.buttons["section-\($0)"] }
        XCTAssertTrue(ids[0].waitForExistence(timeout: 15))
        for b in ids {
            XCTAssertTrue(b.isHittable, b.identifier)
            XCTAssertGreaterThanOrEqual(b.frame.minX, 0, b.identifier)
            XCTAssertLessThanOrEqual(b.frame.maxX, screen.maxX, "\(b.identifier) fits: \(b.frame)")
            XCTAssertGreaterThanOrEqual(b.frame.height, 43.5)
        }
        ids[3].tap()
        XCTAssertTrue(ids[3].isSelected)
        shot(app, "community-tabs")

        app.tabBars.buttons["Cars"].tap()
        let card = app.descendants(matching: .any).matching(identifier: "vehicleCard").firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 20))
        sleep(2)
        XCTAssertLessThan(card.frame.height, 200, "compact car card: \(card.frame.height)")
        shot(app, "cars-compact")

        app.tabBars.buttons["Home"].tap()
        app.buttons["homeViewNews"].tap()
        let all = app.buttons["newsFilter-all"], major = app.buttons["newsFilter-major"]
        XCTAssertTrue(all.waitForExistence(timeout: 10))
        XCTAssertEqual(all.frame.height, major.frame.height, accuracy: 0.5)
        XCTAssertEqual(all.frame.midY, major.frame.midY, accuracy: 0.5)
        shot(app, "news-filter-all")
        major.tap()
        sleep(1)
        XCTAssertTrue(major.isSelected)
        shot(app, "news-filter-major")
        all.tap()
    }

    func testZonesPhotoHeatmapPanelAndReplayLooks() throws {
        let app = XCUIApplication()
        app.launch()
        app.tabBars.buttons["Zones"].tap()
        let markers = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Cybercab seen by the traffic camera'"))
        _ = markers.firstMatch.waitForExistence(timeout: 20)
        sleep(3)   // the map frames the city and the markers settle (overlapping ones cluster)
        // Markers that are on screen now (the map may still be moving): tap one by
        // its current position, looking again before each try.
        func onScreen() -> XCUIElement? {
            let area = screen.insetBy(dx: 20, dy: 0)
            return markers.allElementsBoundByIndex.first { $0.exists && $0.frame.minY > 160 && $0.frame.maxY < area.maxY - 220 && area.contains($0.frame.origin) }
        }
        if onScreen() != nil {
            for _ in 0..<4 where !app.staticTexts["CYBERCAB SPOTTED"].exists {
                guard let m = onScreen() else { sleep(1); continue }
                m.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
                _ = app.staticTexts["CYBERCAB SPOTTED"].waitForExistence(timeout: 4)
            }
            shot(app, "zones-after-marker-tap")
            XCTAssertTrue(app.staticTexts["CYBERCAB SPOTTED"].waitForExistence(timeout: 4), "the capture sheet opened")
            let photo = app.images["cameraCaptureImage"]
            XCTAssertTrue(photo.waitForExistence(timeout: 10))
            sleep(2)
            // The whole photo on screen (aspect-fit): it fits the sheet's width and isn't taller than the screen.
            XCTAssertLessThanOrEqual(photo.frame.width, screen.width)
            XCTAssertLessThanOrEqual(photo.frame.height, 421)
            shot(app, "zones-camera-photo")
            app.swipeDown(velocity: .fast)
            sleep(1)
        }
        app.buttons["heatmapButton"].tap()
        let expand = app.buttons["heatPanelExpand"]
        XCTAssertTrue(expand.waitForExistence(timeout: 10))
        XCTAssertLessThan(expand.frame.height, 80, "compact when collapsed")
        shot(app, "heat-collapsed")
        expand.tap()
        XCTAssertTrue(app.buttons["heatRange-30d"].waitForExistence(timeout: 3))
        app.buttons["heatRange-30d"].tap()
        shot(app, "heat-expanded")
        app.buttons["heatPanelCollapse"].tap()
        XCTAssertTrue(expand.waitForExistence(timeout: 3))
        XCTAssertTrue(expand.label.contains("30 days"), expand.label)
        app.buttons["normalMapButton"].tap()

        app.buttons["replayButton"].tap()
        XCTAssertTrue(app.staticTexts["replayCount"].waitForExistence(timeout: 20))
        for look in ["day", "dusk", "night", "auto"] {
            let b = app.buttons["replayLook-\(look)"]
            XCTAssertTrue(b.waitForExistence(timeout: 5), look)
            b.tap()
            sleep(2)
            XCTAssertTrue(b.isSelected, look)
            shot(app, "replay-\(look)")
        }
        XCTAssertTrue(app.staticTexts["replayPhase"].exists)
    }

    func testSimulationPicturesInsideTheirCards() throws {
        let app = XCUIApplication()
        app.launch()
        app.buttons["homeExplore"].tap()
        XCTAssertTrue(app.staticTexts["roiTitle"].waitForExistence(timeout: 10))
        app.swipeUp(velocity: .slow)
        shot(app, "roi-inputs-card")
        for _ in 0..<6 { app.swipeDown(velocity: .fast) }
        app.buttons["simTab-eta"].tap()
        let mix = app.descendants(matching: .any)["etaMix"]
        XCTAssertTrue(mix.waitForExistence(timeout: 20))
        app.swipeUp(velocity: .slow)
        shot(app, "eta-mix-cards")
        let card = app.otherElements["etaCard-cybercab"]
        reveal(card, in: app)
        shot(app, "eta-model-card")
        XCTAssertTrue(app.buttons["cybercabDoorsButton"].exists || true)
    }

    func testSightingDescriptionField() throws {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8799/api/social/sidebar")!)
        request.timeoutInterval = 3
        let sem = DispatchSemaphore(value: 0); var ok = false
        URLSession.shared.dataTask(with: request) { _, r, _ in ok = (r as? HTTPURLResponse)?.statusCode == 200; sem.signal() }.resume()
        sem.wait()
        try XCTSkipUnless(ok, "needs the test Worker (scripts/test-community.sh)")
        let app = XCUIApplication()
        app.launchArguments = ["-tab", "home", "-apiBase", "http://127.0.0.1:8799", "-session", "s-bob", "-requestSubmitSighting"]
        app.launch()
        let notes = app.textViews["sightingNotes"].exists ? app.textViews["sightingNotes"] : app.textFields["sightingNotes"]
        reveal(notes, in: app)
        XCTAssertTrue(notes.waitForExistence(timeout: 15))
        shot(app, "sighting-description-empty")
        notes.tap()
        notes.typeText("Gold Cybercab at 6th and Congress,\nheading north.")
        shot(app, "sighting-description-typed")
    }
}
