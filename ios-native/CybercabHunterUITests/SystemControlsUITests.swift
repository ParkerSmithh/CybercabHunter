import XCTest

/// iPhone system entry points (Control Center / Lock Screen controls, the Action
/// Button, Shortcuts). UI tests can't press a control or the Action Button, so
/// they deliver the same request the control's intent makes, two ways:
///   `-quickAction <action>` at launch  (a cold launch from a control)
///   `cybercabhunter-widget://action?do=<action>`  (the app running or in the background)
/// Both reach AppRouter.perform, the one path every system entry point uses.
/// Signed-in checks use the isolated local Worker (scripts/community-test-server.mjs).
@MainActor
final class SystemControlsUITests: XCTestCase {
    static let server = "http://127.0.0.1:8799"
    override func setUp() { continueAfterFailure = false }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
    }
    private func requireServer() async throws {
        var r = URLRequest(url: URL(string: "\(Self.server)/api/social/sidebar")!); r.timeoutInterval = 3
        let up = (try? await URLSession.shared.data(for: r)).map { ($0.1 as? HTTPURLResponse)?.statusCode == 200 } ?? false
        try XCTSkipUnless(up, "The test Worker isn't running: node ios-native/scripts/community-test-server.mjs --serve 8799")
    }
    private func launch(_ args: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-apiBase", Self.server] + args
        app.launch()
        return app
    }
    private func tab(_ app: XCUIApplication, _ name: String) -> XCUIElement { app.tabBars.buttons[name] }
    private func waitSelected(_ e: XCUIElement, _ message: String) {
        XCTAssertTrue(e.waitForExistence(timeout: 20), message)
        waitIsSelected(e)
    }
    private func waitIsSelected(_ e: XCUIElement) {
        let deadline = Date().addingTimeInterval(10)
        while !e.isSelected && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.2)) }
        XCTAssertTrue(e.isSelected, "\(e) selected")
    }
    /// A link delivered the way the system delivers one (a tapped link or control),
    /// to the app as it is: running, in the background or closed.
    private func openLink(_ app: XCUIApplication, _ action: String) {
        XCUIDevice.shared.system.open(URL(string: "cybercabhunter-widget://action?do=\(action)")!)
        // iOS may confirm opening another app from a link.
        let sb = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let confirm = sb.buttons["Open"]
        if confirm.waitForExistence(timeout: 2) { confirm.tap() }
        _ = app.wait(for: .runningForeground, timeout: 10)
    }
    /// The app's process (Debug readout): unchanged means it wasn't relaunched.
    private func processID(_ app: XCUIApplication) -> String {
        let label = app.descendants(matching: .any)["quickActionState"].label
        return label.split(separator: " ").first.map(String.init) ?? ""
    }
    /// No permission prompt (camera, location) was raised by SpringBoard.
    private func assertNoSystemAlert(_ message: String) {
        let sb = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let alert = sb.alerts.firstMatch
        if alert.waitForExistence(timeout: 2) {
            let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); a.name = "unexpected-alert"; a.lifetime = .keepAlways; add(a)
            XCTFail("\(message): \(alert.label) \(alert.staticTexts.allElementsBoundByIndex.map(\.label))")
        }
    }

    // MARK: Cold launch (the app was closed)

    func testColdLaunchOpensEachDestination() async throws {
        try await requireServer()
        var app = launch(["-tab", "home", "-quickAction", "map"])
        waitSelected(tab(app, "Zones"), "Cybercab Map: Zones")
        XCTAssertTrue(app.otherElements["zonesMap"].waitForExistence(timeout: 15) || app.descendants(matching: .any)["zonesMap"].waitForExistence(timeout: 5))
        assertNoSystemAlert("opening the map never asks for location")
        shot(app, "sc-cold-map")
        app.terminate()

        app = launch(["-tab", "zones", "-quickAction", "fleet"])
        waitSelected(tab(app, "Home"), "Fleet Stats: Home")
        shot(app, "sc-cold-fleet")
        app.terminate()

        app = launch(["-tab", "home", "-quickAction", "community"])
        waitSelected(tab(app, "Community"), "Community")
        shot(app, "sc-cold-community")
        app.terminate()

        app = launch(["-tab", "registry", "-quickAction", "open"])
        waitSelected(tab(app, "Cars"), "Open Cybercab Hunter leaves the app where it was")
    }

    // MARK: Signed in / signed out sighting requests

    func testNewSightingSignedInOpensTheForm() async throws {
        try await requireServer()
        let app = launch(["-tab", "home", "-session", "s-bob", "-quickAction", "camera"])
        XCTAssertTrue(app.buttons["sightingSubmit"].waitForExistence(timeout: 20), "the sighting form opens (the Simulator has no camera, so the form itself)")
        XCTAssertTrue(tab(app, "Sightings").isSelected)
        XCTAssertTrue(app.buttons["sightingPhotoPicker"].exists, "Take Photo / Choose from Library is one tap away")
        assertNoSystemAlert("no camera prompt where no camera can be used")
        shot(app, "sc-new-sighting-form")
        app.terminate()

        let form = launch(["-tab", "zones", "-session", "s-bob", "-quickAction", "new-sighting"])
        XCTAssertTrue(form.buttons["sightingSubmit"].waitForExistence(timeout: 20), "Start Sighting Submission: the form")
        XCTAssertEqual(form.navigationBars.matching(identifier: "Submit a sighting").count, 1, "one form")
    }

    func testNewSightingSignedOutAsksToSignInFirst() async throws {
        try await requireServer()
        let app = launch(["-tab", "home", "-quickAction", "camera"])
        XCTAssertTrue(app.buttons["googleSignIn"].waitForExistence(timeout: 20), "signed out: sign in first")
        XCTAssertFalse(app.buttons["sightingSubmit"].exists, "never the form without an account")
        shot(app, "sc-new-sighting-signed-out")
    }

    // MARK: Already open, and back from the background

    func testRunningAndBackgroundAppNavigate() async throws {
        try await requireServer()
        let app = launch(["-tab", "home"])
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 20))
        let pid = processID(app)
        // Already open.
        openLink(app, "community")
        waitSelected(tab(app, "Community"), "running: Community")
        openLink(app, "map")
        waitSelected(tab(app, "Zones"), "running: the map")
        // In the background.
        XCUIDevice.shared.press(.home)
        sleep(1)
        openLink(app, "fleet")
        waitSelected(tab(app, "Home"), "from the background: Home")
        XCTAssertEqual(app.state, .runningForeground)
        XCTAssertEqual(processID(app), pid, "the same process: running and backgrounded, not relaunched")
        shot(app, "sc-background-fleet")
    }

    /// A control tapped twice (or delivered as intent and link) navigates once:
    /// one form, not two stacked.
    func testDuplicateRequestsOpenOneForm() async throws {
        try await requireServer()
        let app = launch(["-tab", "home", "-session", "s-bob"])
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 20))
        let pid = processID(app)
        openLink(app, "new-sighting"); openLink(app, "new-sighting")
        XCTAssertTrue(app.buttons["sightingSubmit"].waitForExistence(timeout: 20))
        sleep(2)
        XCTAssertEqual(app.navigationBars.matching(identifier: "Submit a sighting").count, 1, "one form")
        XCTAssertEqual(processID(app), pid, "the running app handled both, without relaunching")
    }

    /// The map control reopens the city the rider chose, after the app was closed.
    /// The map control opens the session's city: Dallas while the app runs,
    /// Austin again once the app was closed (the city isn't saved).
    func testMapOpensTheSessionsCity() async throws {
        try await requireServer()
        var app = launch(["-tab", "zones"])
        let dallas = app.otherElements["zonesCityPicker"].buttons["Dallas"]
        XCTAssertTrue(dallas.waitForExistence(timeout: 20))
        dallas.tap()
        waitIsSelected(dallas)
        tab(app, "Home").tap()
        openLink(app, "map")
        waitSelected(app.otherElements["zonesCityPicker"].buttons["Dallas"], "same session: the control reopens Dallas")
        app.terminate()
        app = launch(["-tab", "home", "-quickAction", "map"])
        waitSelected(app.otherElements["zonesCityPicker"].buttons["Austin"], "a fresh launch: Austin")
        shot(app, "sc-map-fresh-launch-austin")
    }

    /// The rider's work is never thrown away: a form with notes stays open when
    /// another control is used; an empty one makes way.
    func testAnotherControlKeepsADraftButClosesAnEmptyForm() async throws {
        try await requireServer()
        let app = launch(["-tab", "home", "-session", "s-bob", "-quickAction", "new-sighting"])
        XCTAssertTrue(app.buttons["sightingSubmit"].waitForExistence(timeout: 20))
        let pid = processID(app)
        openLink(app, "community")
        XCTAssertTrue(app.buttons["sightingSubmit"].waitForNonExistence(timeout: 10), "an empty form closes for Community")
        waitSelected(tab(app, "Community"), "Community shows")

        openLink(app, "new-sighting")
        XCTAssertTrue(app.buttons["sightingSubmit"].waitForExistence(timeout: 20))
        let notes = app.textViews.firstMatch.exists ? app.textViews.firstMatch : app.textFields.element(boundBy: app.textFields.count - 1)
        notes.tap(); notes.typeText("Spotted on Congress")
        shot(app, "sc-draft-typed")
        let st0 = XCTAttachment(string: app.descendants(matching: .any)["quickActionState"].label); st0.name = "router-before-map"; st0.lifetime = .keepAlways; add(st0)
        let state = app.descendants(matching: .any)["sightingDraftState"]
        XCTAssertEqual(state.label, "draft", "the form reports the rider's work to the router")
        openLink(app, "map")
        sleep(2)
        shot(app, "sc-draft-after-map")
        let st = XCTAttachment(string: app.descendants(matching: .any)["quickActionState"].label); st.name = "router-after-map"; st.lifetime = .keepAlways; add(st)
        let keep = app.buttons["Keep Editing"]
        XCTAssertTrue(keep.waitForExistence(timeout: 10), "a form with the rider's work asks before leaving")
        shot(app, "sc-draft-asks")
        keep.tap()
        XCTAssertTrue(app.buttons["sightingSubmit"].waitForExistence(timeout: 5), "Keep Editing: the form and its text stay")
        XCTAssertTrue(app.textFields.containing(NSPredicate(format: "value CONTAINS %@", "Congress")).firstMatch.exists || app.textViews.containing(NSPredicate(format: "value CONTAINS %@", "Congress")).firstMatch.exists)
        openLink(app, "community")
        let leave = app.buttons["Leave"]
        XCTAssertTrue(leave.waitForExistence(timeout: 10))
        leave.tap()
        XCTAssertTrue(app.buttons["sightingSubmit"].waitForNonExistence(timeout: 10), "Leave: the form closes")
        waitSelected(tab(app, "Community"), "… and the requested screen opens")
        XCTAssertEqual(processID(app), pid, "all in the running app")
        shot(app, "sc-draft-kept")
    }
    /// The four controls are offered in Control Center's gallery (Add a Control).
    /// Driving SpringBoard is best effort: it skips, honestly, if a step isn't found.
    func testControlsAreInTheControlCenterGallery() throws {
        let app = XCUIApplication()
        app.launch()   // iOS registers an app's controls once it has been installed and run
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 20))
        XCUIDevice.shared.press(.home)
        let sb = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        func snap(_ name: String) { let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a) }
        // Control Center: swipe down from the top-right corner.
        let start = sb.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.005))
        start.press(forDuration: 0.1, thenDragTo: sb.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.6)))
        sleep(2)
        snap("cc-open")
        // Edit mode: the + at the top left, then "Add a Control".
        let plus = sb.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'add' OR identifier CONTAINS[c] 'edit' OR label == 'Edit'")).firstMatch
        if plus.waitForExistence(timeout: 3) { plus.tap() } else {
            sb.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 1.5)
        }
        sleep(1)
        let addControl = sb.buttons["Add a Control"]
        try XCTSkipUnless(addControl.waitForExistence(timeout: 5), "Control Center's Add a Control wasn't found on this simulator")
        addControl.tap()
        sleep(2)
        let search = sb.searchFields.firstMatch
        try XCTSkipUnless(search.waitForExistence(timeout: 5), "the controls gallery's search field wasn't found")
        search.tap()
        search.typeText("Cybercab")
        sleep(2)
        snap("cc-gallery-cybercab")
        for name in ["New Sighting", "Cybercab Map", "Fleet Stats", "Community"] {
            XCTAssertTrue(sb.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", name)).firstMatch.exists, "\(name) is offered")
        }
        // Leave Control Center as it was: no control is added.
        XCUIDevice.shared.press(.home); sleep(1); XCUIDevice.shared.press(.home)
    }
}
