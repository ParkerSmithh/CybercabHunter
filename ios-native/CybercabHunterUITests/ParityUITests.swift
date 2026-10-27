import XCTest

/// Website parity: the Simulation page's interactive Cybercab, the model
/// pictures, the News hero, and the Home hero film / scroll frames. Reads
/// the live site, read only. Screenshots are kept for side-by-side review.
@MainActor
final class ParityUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
    }
    private func reveal(_ e: XCUIElement, in app: XCUIApplication, swipes: Int = 12) {
        var n = 0
        while !(e.exists && e.isHittable) && n < swipes { app.swipeUp(velocity: .slow); n += 1 }
    }

    func testSimulationCybercabDoorsAndModelPictures() throws {
        let app = XCUIApplication()
        app.launch()
        let explore = app.buttons["homeExplore"]
        XCTAssertTrue(explore.waitForExistence(timeout: 20))
        explore.tap()
        XCTAssertTrue(app.staticTexts["roiTitle"].waitForExistence(timeout: 10))
        let car = app.descendants(matching: .any)["cybercabDoors"]
        let doors = app.buttons["cybercabDoorsButton"]
        XCTAssertTrue(car.waitForExistence(timeout: 5) && doors.exists, "the interactive Cybercab beside the Fleet ROI title")
        XCTAssertEqual(doors.label, "Open the Cybercab's doors")
        shot(app, "roi-closed")
        doors.tap()
        usleep(700_000)
        shot(app, "roi-doors-moving")
        usleep(1_300_000)
        XCTAssertEqual(doors.label, "Close the Cybercab's doors")
        shot(app, "roi-open")
        car.tap()   // the car itself toggles too
        usleep(1_800_000)
        XCTAssertEqual(doors.label, "Open the Cybercab's doors")
        app.swipeUp(velocity: .slow)
        shot(app, "roi-inputs")
        reveal(app.descendants(matching: .any)["roiResults"], in: app)
        shot(app, "roi-results")

        for _ in 0..<10 { app.swipeDown(velocity: .fast) }
        app.buttons["simTab-eta"].tap()
        XCTAssertTrue(app.staticTexts["etaTitle"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["cybercabDoorsButton"].exists, "the same Cybercab on Fleet ETA")
        shot(app, "eta-top")
        let mix = app.descendants(matching: .any)["etaMix"]
        XCTAssertTrue(mix.waitForExistence(timeout: 20))
        app.swipeUp(velocity: .slow)
        shot(app, "eta-mix")
        let card = app.otherElements["etaCard-cybercab"]
        reveal(card, in: app)
        shot(app, "eta-cybercab-card")
        app.swipeUp(velocity: .slow)
        shot(app, "eta-model-y-card")
        XCTAssertEqual(app.webViews.count, 0)
    }

    func testNewsHeroWithTheCybercab() throws {
        let app = XCUIApplication()
        app.launch()
        let news = app.buttons["homeViewNews"]
        XCTAssertTrue(news.waitForExistence(timeout: 20))
        news.tap()
        XCTAssertTrue(app.staticTexts["newsTitle"].waitForExistence(timeout: 10))
        let hero = app.descendants(matching: .any)["newsHeroCount"]
        XCTAssertTrue(hero.waitForExistence(timeout: 5))
        expectation(for: NSPredicate(format: "NOT (label CONTAINS '—')"), evaluatedWith: hero)
        waitForExpectations(timeout: 30)
        XCTAssertTrue(app.otherElements["newsStory"].firstMatch.waitForExistence(timeout: 20))
        shot(app, "news-top")
        app.swipeUp(velocity: .slow)
        shot(app, "news-cards")
        app.swipeUp(velocity: .fast); app.swipeUp(velocity: .fast)
        shot(app, "news-days")
    }

    func testHomeHeroFilmThenScrollFrames() throws {
        let app = XCUIApplication()
        app.launch()
        let film = app.descendants(matching: .any)["heroFilm"]
        let frames = app.descendants(matching: .any)["heroFrames"]
        XCTAssertTrue(film.waitForExistence(timeout: 15) || frames.exists, "the film plays first")
        shot(app, "home-hero-film")
        // The film ends (or fails offline) and hands over to the scroll frames.
        XCTAssertTrue(frames.waitForExistence(timeout: 60), "scroll-driven frames after the film")
        shot(app, "home-hero-frames-closed")
        // A slow 150 pt drag (no fling): the doors are about half open.
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
        start.press(forDuration: 0.1, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -150)), withVelocity: 300, thenHoldForDuration: 0.5)
        sleep(1)
        shot(app, "home-hero-frames-half")
        let again = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
        again.press(forDuration: 0.1, thenDragTo: again.withOffset(CGVector(dx: 0, dy: -200)), withVelocity: 300, thenHoldForDuration: 0.5)
        sleep(1)
        shot(app, "home-hero-frames-open")
        app.swipeDown(velocity: .fast); app.swipeDown(velocity: .fast)
        sleep(1)
        shot(app, "home-hero-frames-back")
    }

    func testFleetGrowthTimelapseAndRegistryButton() throws {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.buttons["homeViewNews"].waitForExistence(timeout: 20))
        let play = app.buttons["fleetPlayButton"]
        reveal(play, in: app, swipes: 16)
        XCTAssertTrue(play.waitForExistence(timeout: 20), "the Timelapse button on Fleet Growth")
        XCTAssertEqual(play.label, "Play fleet growth timelapse")
        XCTAssertTrue(app.descendants(matching: .any)["fleetRegistryTile"].exists, "the registry tile with the Cybercab")
        play.tap()
        XCTAssertTrue(app.staticTexts["fleetPlayReadout"].waitForExistence(timeout: 3), "N Cybercabs · date while it plays")
        shot(app, "fleet-timelapse-playing")
        expectation(for: NSPredicate(format: "label == 'Replay fleet growth timelapse'"), evaluatedWith: play)
        waitForExpectations(timeout: 8)   // 4 s for 90 days
        XCTAssertFalse(app.staticTexts["fleetPlayReadout"].exists)
        let registry = app.buttons["dmvEveryVin"]
        reveal(registry, in: app, swipes: 12)
        XCTAssertTrue(registry.label.hasPrefix("View DMV Tracker"), registry.label)
        shot(app, "dmv-view-registry")
        registry.tap()
        XCTAssertTrue(app.staticTexts["dmvTitle"].waitForExistence(timeout: 10), "View DMV Tracker opens the tracker")
    }
}
