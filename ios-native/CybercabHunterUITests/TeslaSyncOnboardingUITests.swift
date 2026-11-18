import XCTest

/// The one-time Tesla Sync invitation (worker/onboarding.js) in the app,
/// against the isolated test Worker (scripts/community-test-server.mjs; no
/// production data): brand-new accounts ("s-new1" … "s-new6", 'pending') see
/// it once, natively; existing accounts never do; Skip, Set Up (the app's own
/// forwarding setup, never a web view) and Done all return the rider to where
/// they were; relaunching (or a fresh install's new session) never repeats it.
/// Run with the server up: ONLY="CybercabHunterUITests/TeslaSyncOnboardingUITests" ios-native/scripts/test-community.sh
@MainActor
final class TeslaSyncOnboardingUITests: XCTestCase {
    static let server = "http://127.0.0.1:8799"
    override func setUp() { continueAfterFailure = false }

    private func launch(_ session: String, tab: String = "community", extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication.forTests()
        app.launchArguments = ["-tab", tab, "-apiBase", Self.server, "-session", session] + extra
        app.launch()
        return app
    }
    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
    }
    private func any(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any)[id] }
    private func invitation(_ app: XCUIApplication) -> XCUIElement { any(app, "onboardingTitle") }
    /// What the server recorded for the account (the test Worker's /api/me).
    private func serverState(_ session: String) -> String? {
        var request = URLRequest(url: URL(string: "\(Self.server)/api/me")!)
        request.setValue("Bearer \(session)", forHTTPHeaderField: "Authorization")
        request.setValue("https://cybercabhunter.com", forHTTPHeaderField: "Origin")
        let done = expectation(description: "/api/me")
        var state: String?
        URLSession.shared.dataTask(with: request) { data, _, _ in
            if let data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let onboarding = json["onboarding"] as? [String: Any] { state = onboarding["tesla_sync"] as? String }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 10)
        return state
    }
    private func waitForServerState(_ session: String, _ want: String) -> Bool {
        for _ in 0..<20 { if serverState(session) == want { return true }; Thread.sleep(forTimeInterval: 0.5) }
        return false
    }
    /// Relaunching (as a reinstall would, with a session for the same account): no invitation.
    private func assertNotOfferedAgain(_ session: String, tab: String = "community", file: StaticString = #filePath, line: UInt = #line) {
        let app = launch(session, tab: tab)
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 20), file: file, line: line)
        sleep(6)   // well past /api/me
        XCTAssertFalse(invitation(app).exists, "not offered again", file: file, line: line)
        app.terminate()
    }

    func testNewAccountSeesTheInvitationOnceAndSkips() throws {
        let app = launch("s-new1")
        XCTAssertTrue(invitation(app).waitForExistence(timeout: 20), "a brand-new account: the invitation")
        XCTAssertEqual(invitation(app).label, "Welcome to CybercabHunter")
        XCTAssertEqual(any(app, "onboardingSubtitle").label, "Set Up Tesla Sync")
        XCTAssertTrue(any(app, "onboardingDescription").label.contains("Automatically track your Tesla Robotaxi rides by forwarding your Tesla receipts to CybercabHunter."))
        XCTAssertTrue(app.buttons["onboardingSetUp"].isHittable && app.buttons["onboardingSkip"].isHittable)
        XCTAssertEqual(app.webViews.count, 0, "native, no web view")
        shot(app, "onboarding-ios")
        app.buttons["onboardingSkip"].tap()
        XCTAssertTrue(invitation(app).waitForNonExistence(timeout: 5), "Skip for Now closes it")
        XCTAssertTrue(app.tabBars.buttons["Community"].isSelected, "back where they were (Community)")
        XCTAssertTrue(waitForServerState("s-new1", "skipped"), "recorded on the server: skipped")
        shot(app, "onboarding-ios-after-skip")
        app.terminate()
        assertNotOfferedAgain("s-new1")
    }

    func testSetUpOpensTheNativeForwardingSetupAndCanBeLeft() throws {
        let app = launch("s-new2", tab: "sightings")
        XCTAssertTrue(invitation(app).waitForExistence(timeout: 20))
        app.buttons["onboardingSetUp"].tap()
        XCTAssertTrue(app.staticTexts["gmailTitle"].waitForExistence(timeout: 10), "the app's own forwarding setup")
        XCTAssertTrue(app.staticTexts["gmailAddress"].waitForExistence(timeout: 15), "with the rider's private address")
        XCTAssertEqual(app.webViews.count, 0, "never a web view")
        shot(app, "onboarding-ios-setup")
        // Back to the invitation, then out with Skip for Now from the setup itself.
        app.buttons["onboardingSetupSkip"].tap()
        XCTAssertTrue(any(app, "teslaSyncOnboarding").waitForNonExistence(timeout: 5), "leaving the setup never traps the rider")
        XCTAssertTrue(app.tabBars.buttons["Sightings"].isSelected, "back on Sightings")
        XCTAssertTrue(waitForServerState("s-new2", "skipped"), "recorded: skipped")
        app.terminate()
        assertNotOfferedAgain("s-new2", tab: "sightings")
    }

    func testCompletingSetupConfirmsAndContinues() throws {
        let app = launch("s-new3", tab: "home")
        XCTAssertTrue(invitation(app).waitForExistence(timeout: 20))
        app.buttons["onboardingSetUp"].tap()
        let done = app.buttons["gmailDone"]
        XCTAssertTrue(app.staticTexts["gmailAddress"].waitForExistence(timeout: 15))
        // Tapped directly (XCUITest scrolls to it): a scroll swipe could land on it and tap it early.
        XCTAssertTrue(done.waitForExistence(timeout: 5) && done.isEnabled)
        done.tap()
        XCTAssertTrue(app.staticTexts["Tesla Sync is set up"].waitForExistence(timeout: 8) || any(app, "onboardingSuccess").exists, "a short success confirmation")
        shot(app, "onboarding-ios-success")
        XCTAssertTrue(any(app, "teslaSyncOnboarding").waitForNonExistence(timeout: 8), "then into the app")
        XCTAssertTrue(app.tabBars.buttons["Home"].isSelected)
        XCTAssertTrue(waitForServerState("s-new3", "completed"), "recorded on the server: completed")
        app.terminate()
        assertNotOfferedAgain("s-new3", tab: "home")
    }

    func testExistingAccountGoesStraightIn() throws {
        let app = launch("s-alice")
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 20))
        sleep(6)
        XCTAssertFalse(invitation(app).exists, "an account from before: never offered")
        XCTAssertNil(serverState("s-alice"), "and nothing recorded for it")
        app.terminate()
    }

    func testSignInFromTheAccountSheetReturnsThere() throws {
        // The account sheet is where sign-in happens: the invitation opens over it and closes back to it.
        let app = launch("s-new5", tab: "home", extra: ["-account"])
        XCTAssertTrue(invitation(app).waitForExistence(timeout: 20))
        shot(app, "onboarding-ios-over-account")
        app.buttons["onboardingSkip"].tap()
        XCTAssertTrue(invitation(app).waitForNonExistence(timeout: 5))
        XCTAssertTrue(any(app, "accountName").waitForExistence(timeout: 5), "back on the account sheet")
        app.terminate()
    }

    func testClosingTheAppDuringSetupDoesNotRepeatIt() throws {
        let app = launch("s-new6")
        XCTAssertTrue(invitation(app).waitForExistence(timeout: 20))
        app.buttons["onboardingSetUp"].tap()
        XCTAssertTrue(app.staticTexts["gmailTitle"].waitForExistence(timeout: 10))
        XCTAssertTrue(waitForServerState("s-new6", "presented"), "shown: recorded as presented")
        app.terminate()
        assertNotOfferedAgain("s-new6")
    }

    func testLargeTextAndVoiceOverLabels() throws {
        let app = launch("s-new4", extra: ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityL"])
        XCTAssertTrue(invitation(app).waitForExistence(timeout: 20))
        let setUp = app.buttons["onboardingSetUp"], skip = app.buttons["onboardingSkip"]
        XCTAssertEqual(setUp.label, "Set Up Gmail")
        XCTAssertEqual(skip.label, "Skip for Now")
        shot(app, "onboarding-ios-large")
        for _ in 0..<8 where !skip.isHittable { app.swipeUp(velocity: .slow) }
        XCTAssertTrue(setUp.exists && skip.isHittable, "both actions reachable at large text")
        shot(app, "onboarding-ios-large-actions")
        skip.tap()
        XCTAssertTrue(invitation(app).waitForNonExistence(timeout: 5))
        app.terminate()
    }
}
