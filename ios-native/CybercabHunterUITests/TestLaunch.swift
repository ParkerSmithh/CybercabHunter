import XCTest

extension XCUIApplication {
    /// The app as the UI tests launch it: the opening animation stays off
    /// (StartupIntro reads CCH_SKIP_INTRO), so the first tap reaches the app.
    /// StartupIntroUITests passes -playIntro to see it. An environment value,
    /// so a test that replaces launchArguments keeps it.
    static func forTests() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["CCH_SKIP_INTRO"] = "1"
        return app
    }
}
