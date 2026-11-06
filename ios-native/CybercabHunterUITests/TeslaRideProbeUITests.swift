import XCTest

/// DEBUG builds only, opt-in (see below): the Tesla Ride Sync probe opens
/// Tesla's own sign-in page in the system sheet. No credentials are entered: this only shows what Tesla's page says
/// for this client and redirect before the owner signs in.
@MainActor
final class TeslaRideProbeUITests: XCTestCase {
    /// Opens Tesla's live sign-in page over the network, so it never runs in
    /// routine test runs. Opt in with:
    ///   TEST_RUNNER_CCH_LIVE_TESLA_PROBE=1 xcodebuild test … -only-testing:CybercabHunterUITests/TeslaRideProbeUITests
    func testProbeOpensTeslasSignInPage() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["CCH_LIVE_TESLA_PROBE"] == "1",
                          "Live-network check: set TEST_RUNNER_CCH_LIVE_TESLA_PROBE=1 to run it")
        let app = XCUIApplication()
        app.launchArguments = ["-account"]
        app.launch()
        let link = app.descendants(matching: .any)["teslaProbeLink"]
        for _ in 0..<6 where !link.exists { app.swipeUp() }
        XCTAssertTrue(link.waitForExistence(timeout: 10))
        link.tap()
        app.buttons["probeSignIn"].tap()
        // "Cybercab Hunter wants to use tesla.com to sign in": Continue.
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let cont = springboard.buttons["Continue"]
        if cont.waitForExistence(timeout: 10) { cont.tap() }
        sleep(35)
        saveShot(app, "tesla-probe-signin-page")
    }
}
