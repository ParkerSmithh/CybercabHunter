import XCTest

/// UI refinements before Phase 6: no redundant navigation titles, the
/// full-screen Zones map with its two circular controls, the tab bar that
/// never minimizes, and the moderator-only Traffic Camera field.
/// The layout tests read the live site (read only); the camera tests use the
/// isolated test Worker (scripts/test-community.sh) and skip without it.
@MainActor
final class RefinementUITests: XCTestCase {
    static let server = "http://127.0.0.1:8799"

    override func setUp() { continueAfterFailure = false }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
    }
    private func launch(_ tab: String, session: String? = nil, server: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-tab", tab] + (server ? ["-apiBase", Self.server] : []) + (session.map { ["-session", $0] } ?? [])
        app.launch()
        return app
    }
    private func serverUp() async -> Bool {
        var r = URLRequest(url: URL(string: "\(Self.server)/api/social/sidebar")!)
        r.timeoutInterval = 3
        return (try? await URLSession.shared.data(for: r)).map { ($0.1 as? HTTPURLResponse)?.statusCode == 200 } ?? false
    }

    // MARK: 1. No redundant titles

    func testMainTabsHaveNoNavigationTitles() throws {
        let app = launch("home")
        let headings = ["registry": "CYBERCABS", "sightings": "SIGHTINGS", "community": "COMMUNITY"]
        for (tab, title) in [("registry", "Cars"), ("zones", "Zones"), ("sightings", "Sightings"), ("community", "Community")] {
            app.tabBars.buttons[title].tap()
            sleep(2)
            let bar = app.navigationBars.firstMatch
            XCTAssertTrue(bar.waitForExistence(timeout: 10), "\(tab): the bar (with the Account button) is still there")
            XCTAssertFalse(bar.staticTexts[title].exists, "\(tab): no '\(title)' navigation title")
            XCTAssertTrue(app.buttons.matching(identifier: "accountButton").allElementsBoundByIndex.contains { $0.isHittable }, "\(tab): Account stays")
            if let h = headings[tab] { XCTAssertTrue(app.staticTexts[h].waitForExistence(timeout: 15), "\(tab): the page heading '\(h)' stays") }
            shot(app, "r-\(tab)")
        }
    }

    // MARK: 2–3. Full-screen Zones, the two circular buttons

    func testZonesMapIsFullScreenWithAlignedButtons() throws {
        let app = launch("zones")
        let map = app.otherElements["zonesMap"].firstMatch
        XCTAssertTrue(map.waitForExistence(timeout: 20) || app.maps.firstMatch.waitForExistence(timeout: 5))
        sleep(3)
        let window = app.windows.firstMatch.frame
        let mapFrame = (map.exists ? map : app.maps.firstMatch).frame
        XCTAssertEqual(mapFrame.minY, window.minY, accuracy: 1, "the map starts at the top edge (behind the status bar)")
        XCTAssertEqual(mapFrame.maxY, window.maxY, accuracy: 1, "...and runs under the tab bar to the bottom edge")
        XCTAssertEqual(mapFrame.width, window.width, accuracy: 1, "full width")
        XCTAssertFalse(app.navigationBars.firstMatch.staticTexts["Zones"].exists, "no Zones title")

        let picker = app.otherElements["zonesCityPicker"].firstMatch
        let details = app.buttons["zoneDetailsButton"]
        let search = app.buttons["zoneSearchButton"]
        XCTAssertTrue(picker.waitForExistence(timeout: 10) && details.exists && search.exists)
        XCTAssertFalse(app.textFields["zoneSearchField"].exists, "search is just the circular button by default")
        let p = picker.frame, d = details.frame, s = search.frame
        XCTAssertEqual(d.maxY, p.maxY, accuracy: 1.5, "Zone details' bottom edge is level with the city selector's")
        XCTAssertEqual(d.width, d.height, accuracy: 1, "circular")
        XCTAssertEqual(s.midX, d.midX, accuracy: 1, "Search directly below Zone details")
        XCTAssertGreaterThan(s.minY, d.maxY, "below it")
        XCTAssertLessThan(s.minY - d.maxY, 20, "close below it")
        XCTAssertGreaterThan(d.minX, p.maxX, "no overlap with the city selector")
        XCTAssertEqual(window.maxX - d.maxX, p.minX - window.minX, accuracy: 2, "the same side margins")
        // Inside the safe area: below the status bar / Dynamic Island, above the tab bar.
        let tabBar = app.tabBars.firstMatch.frame
        XCTAssertGreaterThan(p.minY, 54, "below the status bar and Dynamic Island")
        XCTAssertLessThan(s.maxY, tabBar.minY)
        XCTAssertFalse(app.staticTexts["D"].exists || app.staticTexts["S"].exists, "no letter labels")
        XCTAssertEqual(details.label, "Zone details")
        XCTAssertEqual(search.label, "Search places")
        shot(app, "r-zones-full-screen")

        // Zone details opens the existing panel.
        details.tap()
        XCTAssertTrue(app.descendants(matching: .any)["zoneDetailsLegend"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["FLEET & FARES"].waitForExistence(timeout: 10))
        app.swipeDown(velocity: .fast)
        XCTAssertTrue(app.descendants(matching: .any)["zoneDetailsLegend"].waitForNonExistence(timeout: 10))

        // Search opens the existing place search (live suggestions, pick, back to the button).
        search.tap()
        let field = app.textFields["zoneSearchField"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons["zoneSearchButton"].label, "Close search")
        field.typeText("Congress")
        let suggestion = app.buttons["zonePlaceSuggestion"].firstMatch
        XCTAssertTrue(suggestion.waitForExistence(timeout: 20), "suggestions")
        XCTAssertFalse(app.buttons["replayButton"].exists, "the bottom controls step aside while searching (nothing covers the suggestions)")
        shot(app, "r-zones-search")
        suggestion.tap()
        XCTAssertTrue(field.waitForNonExistence(timeout: 5), "picking a place closes the field")
        XCTAssertEqual(app.buttons["zoneSearchButton"].label, "Search places")
        XCTAssertTrue(app.buttons["replayButton"].waitForExistence(timeout: 5), "...and come back after")

        // Gestures still work on the map.
        app.swipeLeft(velocity: .slow)
        app.tabBars.buttons["Zones"].tap()
        XCTAssertTrue(details.isHittable)
        XCTAssertEqual(app.webViews.count, 0)
    }

    // MARK: 5. The tab bar never minimizes

    func testTabBarStaysExpandedWhileScrolling() throws {
        let app = launch("registry")
        XCTAssertTrue(app.staticTexts["CYBERCABS"].waitForExistence(timeout: 20))
        let bar = app.tabBars.firstMatch
        let before = bar.frame
        let names = ["Home", "Zones", "Cars", "Sightings", "Community"]
        func allVisible() -> Bool { names.allSatisfy { bar.buttons[$0].exists && bar.buttons[$0].isHittable } }
        XCTAssertTrue(allVisible())
        for _ in 0..<4 { app.swipeUp(velocity: .fast) }
        sleep(1)
        XCTAssertTrue(allVisible(), "scrolled down: all five tabs still shown")
        XCTAssertEqual(bar.frame.width, before.width, accuracy: 1, "not collapsed")
        XCTAssertTrue(bar.buttons["Cars"].isSelected, "the selected tab stays highlighted")
        for _ in 0..<4 { app.swipeDown(velocity: .fast) }
        sleep(1)
        XCTAssertTrue(allVisible())
        XCTAssertEqual(bar.frame, before, "scrolled back up: no change at all")
        // The same on Home and Sightings.
        for tab in ["Home", "Sightings"] {
            bar.buttons[tab].tap()
            sleep(2)
            for _ in 0..<3 { app.swipeUp(velocity: .fast) }
            sleep(1)
            XCTAssertTrue(allVisible(), "\(tab): all five tabs still shown")
        }
        shot(app, "r-tab-bar-expanded")
    }

    // MARK: 6. Traffic camera: moderators only

    func testTrafficCameraFieldIsForModeratorsOnly() async throws {
        let up = await serverUp()
        try XCTSkipUnless(up, "The test Worker isn't running: run ios-native/scripts/test-community.sh")

        // A rider: no camera field at all.
        let rider = launch("sightings", session: "s-bob", server: true)
        XCTAssertTrue(rider.buttons["submitSighting"].waitForExistence(timeout: 20))
        rider.buttons["submitSighting"].tap()
        XCTAssertTrue(rider.buttons["sightingSubmit"].waitForExistence(timeout: 10))
        sleep(2)   // the moderator check has answered
        for _ in 0..<3 { rider.swipeUp(velocity: .slow) }
        XCTAssertFalse(rider.buttons["sightingCamera"].exists, "riders never see the camera field")
        XCTAssertFalse(rider.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] 'TRAFFIC CAMERA'")).firstMatch.exists, "...nor its label")
        shot(rider, "r-camera-rider")
        rider.terminate()

        // A moderator: the field, the searchable picker, select, clear.
        let app = launch("sightings", session: "s-mod", server: true)
        XCTAssertTrue(app.buttons["submitSighting"].waitForExistence(timeout: 20))
        app.buttons["submitSighting"].tap()
        let camera = app.buttons["sightingCamera"]
        var n = 0
        while !(camera.exists && camera.isHittable) && n < 6 { app.swipeUp(velocity: .slow); n += 1 }
        XCTAssertTrue(camera.waitForExistence(timeout: 10), "a moderator sees Traffic Camera (optional)")
        XCTAssertTrue(camera.label.contains("none"))
        camera.tap()
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["cameraOption"].firstMatch.waitForExistence(timeout: 10), "the camera list")
        search.tap()
        search.typeText("Trinity")
        let option = app.buttons["cameraOption"].firstMatch
        XCTAssertTrue(option.waitForExistence(timeout: 5))
        shot(app, "r-camera-picker")
        option.tap()
        XCTAssertTrue(camera.waitForExistence(timeout: 5))
        XCTAssertTrue(camera.label.lowercased().contains("trinity"), "chosen: \(camera.label)")
        let clear = app.buttons["sightingCameraClear"]
        XCTAssertTrue(clear.exists)
        clear.tap()
        XCTAssertTrue(camera.label.contains("none"), "cleared")
        XCTAssertFalse(clear.exists)
        shot(app, "r-camera-moderator")
    }
}
