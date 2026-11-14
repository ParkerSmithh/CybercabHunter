import XCTest

/// Fleet ROI on the device (FleetROI2View): the five fixed values (locked),
/// the removed sections staying gone, fleet presets, Personal vs Fleet,
/// financing, saved configurations (save, duplicate, compare) and Dynamic Type. Screenshots
/// of each step are attached to the result bundle.
final class FleetROI2UITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
    }
    private func reveal(_ e: XCUIElement, in app: XCUIApplication, swipes: Int = 30) {
        var n = 0
        while !(e.exists && e.isHittable) && n < swipes { app.swipeUp(velocity: .slow); n += 1 }
    }
    private func any(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any)[id] }
    private func shown(_ app: XCUIApplication, _ text: String) -> XCUIElement {
        // Result tiles carry their figure in the accessibility value (VoiceOver reads label, then value).
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", text, text)).firstMatch
    }
    private func open(_ app: XCUIApplication) {
        app.launch()
        let explore = app.buttons["homeExplore"]
        XCTAssertTrue(app.scrollViews.firstMatch.waitForExistence(timeout: 20))
        reveal(explore, in: app, swipes: 10)
        explore.tap()
        XCTAssertTrue(app.staticTexts["roiTitle"].waitForExistence(timeout: 10))
    }

    func testFleetROI2() throws {
        let app = XCUIApplication.forTests()
        open(app)
        shot(app, "roi2-hero")

        // Removed: the purchase card, the ownership breakdown, the scenario comparison, the old quick calculator.
        for gone in ["roi2Purchase", "roi2Breakdown", "roi2Scenarios", "roiResults", "roiStartNote", "roiExport"] {
            XCTAssertFalse(any(app, gone).exists, "\(gone) is gone")
        }
        // The five fixed values: shown, locked, not adjustable.
        for (id, value) in [("roi2-price", "$29,990"), ("roi2-deposit", "$1,000"), ("roi2-subscriptionMonthly", "$300/mo"), ("roi2-subscriptionIncludedMonths", "1 month")] {
            let row = any(app, id)
            reveal(row, in: app)
            XCTAssertTrue(row.exists && (row.value as? String ?? "").hasPrefix("\(value), fixed"), "\(id) shows \(value), fixed")
            XCTAssertFalse(app.sliders[id].exists, "\(id) has no slider")
        }
        XCTAssertTrue(any(app, "roi2-subscriptionIncludedMonths").label == "Free Autonomy")
        shot(app, "roi2-locked")
        let share = any(app, "roi2-platformSharePct")
        reveal(share, in: app)
        XCTAssertTrue(share.label == "Tesla Revenue Share" && (share.value as? String ?? "").hasPrefix("25%, fixed"))
        shot(app, "roi2-tesla-share")

        // Fleet builder: 25 vehicles → upfront ×25 ($32,164.375 × 25 = $804,109).
        let preset = app.buttons["roi2Preset-25"]
        reveal(preset, in: app)
        preset.tap()
        XCTAssertTrue(shown(app, "$804,109").waitForExistence(timeout: 5), "upfront cash for 25 cash-bought Cybercabs")
        reveal(any(app, "roi2Metrics"), in: app)
        XCTAssertTrue(shown(app, "$76,094").waitForExistence(timeout: 5), "operating profit a month: 25 × $3,043.76 ($5,184 − $2,140.24, with the 25% Tesla share and $300 subscription)")
        shot(app, "roi2-metrics-25")
        let timeline = any(app, "roi2Timeline")
        reveal(timeline, in: app)
        app.swipeUp(velocity: .slow)   // the whole card in view
        shot(app, "roi2-chart")

        // Personal ownership: no revenue, the permission note.
        let mode = app.segmentedControls["roi2Mode"]
        reveal(mode, in: app)
        mode.buttons["Personal ownership"].tap()
        XCTAssertTrue(shown(app, "doesn't mean you may run it as a commercial Robotaxi").waitForExistence(timeout: 5))
        XCTAssertFalse(shown(app, "Gross revenue / mo").exists, "no revenue in personal mode")
        reveal(any(app, "roi2Metrics"), in: app)
        shot(app, "roi2-personal")
        reveal(mode, in: app)
        mode.buttons["Fleet investment"].tap()

        // Finance: the loan rows appear.
        let pay = app.segmentedControls["roi2Purchase-pay"]
        reveal(pay, in: app)
        pay.buttons["Finance"].tap()
        XCTAssertTrue(any(app, "roi2-aprPct").waitForExistence(timeout: 5), "APR slider")
        shot(app, "roi2-finance")

        // Save twice, duplicate, compare.
        let save = app.buttons["roi2Save"]
        for _ in 0..<12 where !save.isHittable { app.swipeDown(velocity: .slow) }
        if !save.isHittable { reveal(save, in: app) }
        save.tap()
        save.tap()
        let rows = app.descendants(matching: .any).matching(identifier: "roi2SavedRow")
        reveal(any(app, "roi2Saved"), in: app)
        XCTAssertTrue(rows.count >= 2, "two saved configurations")
        let menu = app.descendants(matching: .any).matching(identifier: "roi2SavedMenu").firstMatch
        menu.tap()
        XCTAssertTrue(app.buttons["Duplicate"].waitForExistence(timeout: 3))
        app.buttons["Duplicate"].tap()
        XCTAssertTrue(rows.count >= 3, "duplicated")
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Compare '")).element(boundBy: 0).tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Compare '")).element(boundBy: 1).tap()
        let compare = app.buttons["roi2Compare"]
        reveal(compare, in: app)
        compare.tap()
        XCTAssertTrue(app.navigationBars["Compare"].waitForExistence(timeout: 5), "the comparison sheet")
        shot(app, "roi2-compare")
        app.buttons["Done"].tap()
        reveal(any(app, "roi2Saved"), in: app)
        shot(app, "roi2-saved")
    }

    func testFleetROI2LargeText() throws {
        let app = XCUIApplication.forTests()
        app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityM"]
        open(app)
        reveal(any(app, "roi2Metrics"), in: app)
        shot(app, "roi2-large-metrics")
        reveal(any(app, "roi2-price"), in: app)
        shot(app, "roi2-large-locked")
        reveal(any(app, "roi2Saved"), in: app)
        shot(app, "roi2-large-saved")
    }
}
