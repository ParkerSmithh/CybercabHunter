import XCTest

/// Phase 6 acceptance: widget links, the "Submit a sighting" shortcut, and the
/// widgets in the Home Screen gallery. Siri itself can't be driven by UI
/// tests: the intents' own behaviour is in Phase6Tests (unit tests).
@MainActor
final class Phase6UITests: XCTestCase {
    static let server = "http://127.0.0.1:8799"
    override func setUp() { continueAfterFailure = false }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
    }

    /// What tapping a widget does: cybercabhunter-widget://<tab> opens that tab natively.
    func testWidgetLinksOpenTheirTabs() throws {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 20))
        app.open(URL(string: "cybercabhunter-widget://zones?city=dallas")!)
        let dallas = app.otherElements["zonesCityPicker"].buttons["Dallas"]
        XCTAssertTrue(dallas.waitForExistence(timeout: 15), "Zones opened")
        expectation(for: NSPredicate(format: "isSelected == true"), evaluatedWith: dallas)
        waitForExpectations(timeout: 10)
        XCTAssertTrue(app.tabBars.buttons["Zones"].isSelected)
        shot(app, "p6-widget-link-zones-dallas")
        app.open(URL(string: "cybercabhunter-widget://sightings")!)
        XCTAssertTrue(app.staticTexts["SIGHTINGS"].waitForExistence(timeout: 15))
        app.open(URL(string: "cybercabhunter-widget://registry")!)
        XCTAssertTrue(app.staticTexts["CYBERCABS"].waitForExistence(timeout: 15))
        XCTAssertEqual(app.webViews.count, 0)
    }

    /// The Siri / Shortcuts "Submit a sighting" request: the form when signed in, sign-in otherwise.
    func testSubmitSightingShortcutOpensTheForm() async throws {
        var r = URLRequest(url: URL(string: "\(Self.server)/api/social/sidebar")!); r.timeoutInterval = 3
        let up = (try? await URLSession.shared.data(for: r)).map { ($0.1 as? HTTPURLResponse)?.statusCode == 200 } ?? false
        try XCTSkipUnless(up, "The test Worker isn't running: run ios-native/scripts/test-community.sh")
        let app = XCUIApplication()
        app.launchArguments = ["-tab", "home", "-apiBase", Self.server, "-session", "s-bob", "-requestSubmitSighting"]
        app.launch()
        XCTAssertTrue(app.buttons["sightingSubmit"].waitForExistence(timeout: 20), "signed in: the Submit a sighting form opens")
        XCTAssertTrue(app.tabBars.buttons["Sightings"].isSelected)
        shot(app, "p6-shortcut-submit-signed-in")
        app.terminate()
        let signedOut = XCUIApplication()
        signedOut.launchArguments = ["-tab", "home", "-apiBase", Self.server, "-requestSubmitSighting"]
        signedOut.launch()
        XCTAssertTrue(signedOut.buttons["googleSignIn"].waitForExistence(timeout: 20), "signed out: sign-in first")
        XCTAssertFalse(signedOut.buttons["sightingSubmit"].exists)
    }

    /// The two widgets are offered in the Home Screen gallery and can be added.
    /// (Driving SpringBoard is best effort: it skips, honestly, if its controls aren't found.)
    func testWidgetsAreInTheHomeScreenGallery() throws {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 20))
        XCUIDevice.shared.press(.home)
        let sb = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        sleep(2)
        sb.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.72)).press(forDuration: 1.6)
        let edit = sb.buttons["Edit"].firstMatch
        if edit.waitForExistence(timeout: 4) { edit.tap() }
        let add = sb.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'Add Widget'")).firstMatch
        guard add.waitForExistence(timeout: 6) else { throw XCTSkip("SpringBoard's Add Widget control wasn't found on this simulator") }
        add.tap()
        let search = sb.searchFields.firstMatch
        guard search.waitForExistence(timeout: 8) else { throw XCTSkip("The widget gallery's search field wasn't found") }
        search.tap()
        search.typeText("Cybercab")
        // The gallery's result row: below the search field (a widget added by an earlier
        // run is also labelled "Cybercab Hunter", on the Home Screen behind the sheet).
        let matches = sb.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] 'Cybercab Hunter'"))
        XCTAssertTrue(matches.firstMatch.waitForExistence(timeout: 10), "Cybercab Hunter is in the widget gallery")
        let row = matches.allElementsBoundByIndex.first { $0.isHittable && $0.frame.minY > search.frame.maxY }
        guard let row else { XCTFail("no gallery row below the search field"); return }
        row.tap()
        sleep(2)
        shot(sb, "p6-widget-gallery")
        XCTAssertTrue(sb.staticTexts["Cybercab Fleet"].waitForExistence(timeout: 8) || sb.staticTexts["Cybercab Daily"].exists, "the widget's name")
        let addWidget = sb.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'Add Widget'")).firstMatch
        if addWidget.waitForExistence(timeout: 5) { addWidget.tap() }
        sleep(4)   // the widget's first timeline (live data, read only)
        XCUIDevice.shared.press(.home)
        sleep(2)
        shot(sb, "p6-widget-on-home-screen")
    }
}
