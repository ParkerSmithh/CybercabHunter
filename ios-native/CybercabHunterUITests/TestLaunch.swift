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

    /// The Duo displays its tabs in a side rail outside the TabBar hierarchy.
    func tabButton(_ title: String) -> XCUIElement {
        let tabBarButton = tabBars.buttons[title]
        return tabBarButton.exists ? tabBarButton : buttons[title]
    }
}
