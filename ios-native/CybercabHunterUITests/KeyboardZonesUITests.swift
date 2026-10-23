import XCTest

/// Cars' search keyboard always goes away (scroll, Search, Done, a tap outside,
/// opening a car, the filter menu, another tab) and never comes back on its own;
/// the Zones map runs to the top edge. Live site, read only.
@MainActor
final class KeyboardZonesUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }
    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a); saveShot(app, name)
    }
    private func keyboardGone(_ app: XCUIApplication, _ why: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 3), "keyboard dismissed: \(why)", file: file, line: line)
    }
    private func drag(_ app: XCUIApplication, by dy: CGFloat, y: CGFloat = 0.5) {
        let s = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: y))
        s.press(forDuration: 0.05, thenDragTo: s.withOffset(CGVector(dx: 0, dy: dy)), withVelocity: 900, thenHoldForDuration: 0.3)
        sleep(1)
    }

    func testCarsKeyboardAlwaysDismisses() throws {
        let app = XCUIApplication()
        app.launch()
        app.tabBars.buttons["Cars"].tap()
        let inline = app.textFields["registrySearch"], floating = app.textFields["registryFloatingSearch"]
        XCTAssertTrue(inline.waitForExistence(timeout: 20))
        let card = app.descendants(matching: .any).matching(identifier: "vehicleCard").firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 20))

        // 1. Search key.
        inline.tap(); XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        inline.typeText("XVF\n")
        keyboardGone(app, "Search key")
        sleep(2)
        XCTAssertEqual(inline.value as? String, "XVF")

        // 2. Done above the keyboard.
        inline.tap(); XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        app.buttons["registryKeyboardDone"].tap()
        keyboardGone(app, "Done")

        // 3. A tap outside the field (the title).
        inline.tap(); XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        app.staticTexts["CYBERCABS"].tap()
        keyboardGone(app, "tap outside")

        // 4. Scrolling the list.
        inline.tap(); XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        drag(app, by: -200, y: 0.45)
        keyboardGone(app, "scroll")
        shot(app, "kb-after-scroll")

        // 5. The floating copy: type, then scroll; it must not re-open on its own.
        drag(app, by: -400, y: 0.6)
        XCTAssertTrue(floating.waitForExistence(timeout: 3))
        floating.tap(); XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        drag(app, by: -150, y: 0.45)
        keyboardGone(app, "scroll from the floating field")
        for _ in 0..<4 { drag(app, by: 450, y: 0.4) }   // back to the top: the copies swap
        sleep(1)
        XCTAssertFalse(app.keyboards.firstMatch.exists, "the keyboard didn't come back when the fields swapped")
        shot(app, "kb-top-after-swap")

        // 6. Opening a car, then back.
        inline.tap(); XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        let tappable = app.descendants(matching: .any).matching(identifier: "vehicleCard").allElementsBoundByIndex.first { $0.isHittable }
        XCTAssertNotNil(tappable)
        tappable?.tap()
        XCTAssertTrue(app.staticTexts["rideHistoryTitle"].waitForExistence(timeout: 15), "the card opened its car")
        keyboardGone(app, "opening a car")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(inline.waitForExistence(timeout: 10))
        sleep(1)
        XCTAssertFalse(app.keyboards.firstMatch.exists, "no keyboard after coming back")

        // 7. The filter menu.
        inline.tap(); XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        app.buttons["registryFilter"].tap()
        keyboardGone(app, "filter menu")
        XCTAssertTrue(app.buttons["Most Rides"].firstMatch.waitForExistence(timeout: 5))
        app.buttons["Most Rides"].firstMatch.tap()
        sleep(2)
        XCTAssertEqual(inline.value as? String, "XVF", "search kept with the new order")

        // 8. Another tab. (The open keyboard covers the tab bar, so a person puts it
        // away first; a switch made by the app, e.g. a widget link, resigns it itself.)
        inline.tap(); XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        app.buttons["registryKeyboardDone"].tap()
        keyboardGone(app, "Done before switching tabs")
        app.tabBars.buttons["Home"].tap()
        sleep(1)
        app.tabBars.buttons["Cars"].tap()
        sleep(1)
        XCTAssertFalse(app.keyboards.firstMatch.exists, "no keyboard on returning to Cars")

        // Restore.
        app.buttons["Clear search"].firstMatch.tap()
        keyboardGone(app, "clearing doesn't trap focus")
        app.buttons["registryFilter"].tap(); app.buttons["Recently Used"].firstMatch.tap()
    }

    func testZonesMapReachesTheTop() throws {
        let app = XCUIApplication()
        app.launch()
        app.tabBars.buttons["Zones"].tap()
        XCTAssertTrue(app.buttons["zoneDetailsButton"].waitForExistence(timeout: 15))
        sleep(4)
        shot(app, "zones-top")
        XCTAssertTrue(app.buttons["accountButton"].firstMatch.isHittable)
        app.buttons["Dallas"].firstMatch.tap(); sleep(3)
        shot(app, "zones-top-dallas")
        app.buttons["Austin"].firstMatch.tap()
        // Other pages keep the soft edge.
        app.tabBars.buttons["Home"].tap(); sleep(2)
        drag(app, by: -300, y: 0.6)
        shot(app, "home-soft-edge")
    }
}
