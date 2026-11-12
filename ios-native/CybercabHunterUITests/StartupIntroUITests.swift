import XCTest

/// The opening animation (AppOpeningAnimation.mp4) on a cold launch: plays once,
/// crossfades into Home, never replays from the background, steps aside for a
/// system control, and never strands the rider when the video can't play.
/// UI tests normally skip it; these ask for it with -playIntro.
@MainActor
final class StartupIntroUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    private func launch(_ extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-apiBase", "http://127.0.0.1:8799", "-playIntro"] + extra
        app.launch()
        return app
    }

    private func state(_ app: XCUIApplication) -> String {
        app.descendants(matching: .any)["quickActionState"].label
    }

    private func waitForState(_ app: XCUIApplication, contains text: String, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if state(app).contains(text) { return true }
            usleep(100_000)
        }
        return false
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
    }

    func testPlaysOnceOnColdLaunchThenHome() throws {
        let app = launch()
        let intro = app.descendants(matching: .any)["startupIntro"]
        // XCTest attaches about as late as the 2.35 s video lasts, so this test
        // proves the outcome ("intro=played"); testCoversTheAppAndCantGetStuck
        // looks at the intro itself.
        _ = intro.waitForExistence(timeout: 3)

        XCTAssertTrue(waitForState(app, contains: "intro=played", timeout: 8), "it plays to the end: \(state(app))")
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: intro)
        wait(for: [gone], timeout: 4)   // the 0.2 s crossfade, with room for a slow simulator
        let brand = app.descendants(matching: .any)["homeBrand"]
        XCTAssertTrue(brand.waitForExistence(timeout: 5) && brand.isHittable, "Home, after the crossfade")
        shot(app, "intro-home")

        // Back from the Home Screen: same process, no replay.
        let pid = state(app).split(separator: " ").first.map(String.init)
        XCUIDevice.shared.press(.home)
        sleep(2)
        app.activate()
        XCTAssertTrue(brand.waitForExistence(timeout: 5))
        sleep(1)
        XCTAssertFalse(intro.exists, "returning from the background never replays it")
        XCTAssertEqual(state(app).split(separator: " ").first.map(String.init), pid, "the same app session")
    }

    /// Held on its first frame: it covers the whole screen, and the timeout
    /// still brings the app back.
    func testCoversTheAppAndCantGetStuck() throws {
        let app = launch(["-introHold"])
        let intro = app.descendants(matching: .any)["startupIntro"]
        XCTAssertTrue(intro.waitForExistence(timeout: 10), "the intro is the first screen")
        // (XCTest lists the tab bar beneath it: it doesn't apply the intro's
        // isModal trait, which VoiceOver does. The screenshot shows what's seen.)
        XCTAssertTrue(intro.frame.equalTo(app.windows.firstMatch.frame), "edge to edge: \(intro.frame)")
        shot(app, "intro-held")
        XCTAssertTrue(waitForState(app, contains: "intro=timedOut", timeout: 12), "never stuck: \(state(app))")
        XCTAssertTrue(app.descendants(matching: .any)["homeBrand"].waitForExistence(timeout: 5))
    }

    func testStepsAsideForASystemControl() throws {
        let app = launch(["-quickAction", "community"])
        XCTAssertTrue(waitForState(app, contains: "intro=skipped", timeout: 10), "the control's destination wins: \(state(app))")
        XCTAssertTrue(app.tabBars.buttons["Community"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.tabBars.buttons["Community"].isSelected, "opened where the control asked")
        XCTAssertFalse(app.descendants(matching: .any)["startupIntro"].exists)
    }

    func testAVideoThatCantPlayFallsBackToTheApp() throws {
        let app = launch(["-introURL", "missing"])
        XCTAssertTrue(waitForState(app, contains: "intro=failed", timeout: 5), "never stuck: \(state(app))")
        XCTAssertTrue(app.descendants(matching: .any)["homeBrand"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.descendants(matching: .any)["startupIntro"].exists)
    }
}
