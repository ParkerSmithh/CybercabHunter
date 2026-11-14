import XCTest

/// Fleet ROI and Fleet ETA on the device, as compact segmented screens
/// (Fleet ROI: Overview | Settings | Timeline; Fleet ETA: Estimates | Fleet |
/// Method): results first, the five fixed values locked in a collapsed group,
/// values kept while switching segments and views, the removed sections
/// staying gone, saved configurations (save, duplicate, compare), Dynamic Type
/// and VoiceOver labels. Screenshots of each step are attached to the result bundle.
final class FleetROI2UITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
    }
    private func reveal(_ e: XCUIElement, in app: XCUIApplication, swipes: Int = 20) {
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
    private func segment(_ app: XCUIApplication, _ bar: String, _ name: String) {
        let b = app.segmentedControls[bar].buttons[name]
        XCTAssertTrue(b.waitForExistence(timeout: 5), "\(bar) › \(name)")
        b.tap()
    }

    func testFleetROI2() throws {
        let app = XCUIApplication.forTests()
        open(app)
        // Overview first: the main results without scrolling.
        XCTAssertTrue(app.segmentedControls["roi2Segments"].exists, "the segment bar")
        XCTAssertTrue(shown(app, "$32,164").waitForExistence(timeout: 5) && shown(app, "$32,164").isHittable, "upfront cash on screen at once")
        shot(app, "roi2-overview")

        // Removed: the purchase card, the ownership breakdown, the scenario comparison, the old quick calculator.
        for gone in ["roi2Purchase", "roi2Breakdown", "roi2Scenarios", "roiResults", "roiStartNote", "roiExport"] {
            XCTAssertFalse(any(app, gone).exists, "\(gone) is gone")
        }

        // Fleet builder: 25 vehicles → upfront ×25 ($32,164.375 × 25 = $804,109).
        app.buttons["roi2Preset-25"].tap()
        XCTAssertTrue(shown(app, "$804,109").waitForExistence(timeout: 5), "upfront cash for 25 cash-bought Cybercabs")
        reveal(any(app, "roi2Metrics"), in: app)
        XCTAssertTrue(shown(app, "$76,094").waitForExistence(timeout: 5), "operating profit a month: 25 × $3,043.76")
        shot(app, "roi2-metrics-25")

        // Settings: groups; the fixed values locked in a collapsed group.
        segment(app, "roi2Segments", "Settings")
        XCTAssertTrue(any(app, "roi2KeyFigures").waitForExistence(timeout: 5), "the key figures stay in view while editing")
        XCTAssertTrue(shown(app, "$76,094").exists, "…with the current numbers")
        XCTAssertTrue(app.segmentedControls["roi2Purchase-pay"].exists, "Fleet & Financing is open by default")
        XCTAssertTrue(any(app, "roi2-ridesPerDay").exists, "Revenue & Operations is open by default")
        XCTAssertFalse(any(app, "roi2-insuranceMonthly").exists, "Monthly Expenses starts collapsed")
        XCTAssertFalse(any(app, "roi2-price").exists, "Fixed Tesla values start collapsed")
        shot(app, "roi2-settings")
        let fixed = any(app, "roi2Group-fixed")
        reveal(fixed, in: app)
        fixed.buttons.firstMatch.tap()
        for (id, value) in [("roi2-price", "$29,990"), ("roi2-deposit", "$1,000"), ("roi2-subscriptionMonthly", "$300/mo"), ("roi2-subscriptionIncludedMonths", "1 month"), ("roi2-platformSharePct", "25%")] {
            let row = any(app, id)
            XCTAssertTrue(row.waitForExistence(timeout: 5), id)
            XCTAssertTrue((row.value as? String ?? "").hasPrefix("\(value), fixed"), "\(id) shows \(value), fixed")
            XCTAssertFalse(app.sliders[id].exists, "\(id) has no slider")
        }
        XCTAssertTrue(any(app, "roi2-subscriptionIncludedMonths").label == "Free Autonomy" && any(app, "roi2-platformSharePct").label == "Tesla Revenue Share")
        reveal(any(app, "roi2-platformSharePct"), in: app)
        shot(app, "roi2-fixed-values")

        // Finance: the loan rows appear (Fleet & Financing).
        for _ in 0..<15 where !app.segmentedControls["roi2Purchase-pay"].isHittable { app.swipeDown(velocity: .slow) }
        app.segmentedControls["roi2Purchase-pay"].buttons["Finance"].tap()
        XCTAssertTrue(any(app, "roi2-aprPct").waitForExistence(timeout: 5), "APR slider")
        shot(app, "roi2-finance")

        // Values persist across segments and the Fleet ETA view.
        segment(app, "roi2Segments", "Overview")
        XCTAssertTrue(shown(app, "$804,109").exists == false && shown(app, "$204,309").waitForExistence(timeout: 5), "25 vehicles, financed: $204,309 up front, still")
        for _ in 0..<15 where !app.buttons["simTab-eta"].isHittable { app.swipeDown(velocity: .fast) }
        app.buttons["simTab-eta"].tap()
        XCTAssertTrue(app.staticTexts["etaTitle"].waitForExistence(timeout: 10))
        app.buttons["simTab-roi"].tap()
        XCTAssertTrue(shown(app, "$204,309").waitForExistence(timeout: 5), "kept after visiting Fleet ETA")

        // Personal ownership: no revenue, the permission note.
        let mode = app.segmentedControls["roi2Mode"]
        mode.buttons["Personal ownership"].tap()
        XCTAssertTrue(shown(app, "doesn't mean you may run it as a commercial Robotaxi").waitForExistence(timeout: 5))
        XCTAssertFalse(shown(app, "Gross revenue / mo").exists, "no revenue in personal mode")
        shot(app, "roi2-personal")
        mode.buttons["Fleet investment"].tap()

        // Timeline: the chart (interactive) and saved configurations.
        segment(app, "roi2Segments", "Timeline")
        // Swift Charts passes the identifier to its own parts: the chart is the first match.
        let chart = app.descendants(matching: .any).matching(identifier: "roi2Chart").firstMatch
        XCTAssertTrue(chart.waitForExistence(timeout: 5))
        chart.press(forDuration: 0.6)   // scrubbing shows a month's figures
        shot(app, "roi2-chart")

        // Save twice (Settings), duplicate, compare (Timeline).
        segment(app, "roi2Segments", "Settings")
        let save = app.buttons["roi2Save"]
        reveal(save, in: app, swipes: 25)
        save.tap()
        save.tap()
        segment(app, "roi2Segments", "Timeline")
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

    func testFleetEtaSegments() throws {
        let app = XCUIApplication.forTests()
        open(app)
        app.buttons["simTab-eta"].tap()
        XCTAssertTrue(app.staticTexts["etaTitle"].waitForExistence(timeout: 10))
        // Estimates first: both model cards and the scenario / trip controls.
        let card = app.otherElements["etaCard-cybercab"]
        XCTAssertTrue(card.waitForExistence(timeout: 20), "the Cybercab card")
        XCTAssertTrue(app.staticTexts["etaFare-cybercab"].isHittable, "the main fare on screen at once")
        shot(app, "eta-estimates")
        app.buttons["scenario-busy"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["etaAssumed"].label.contains("Busy"))
        // Fleet: the mix, availability and the service day.
        segment(app, "etaSegments", "Fleet")
        XCTAssertTrue(any(app, "etaMix").waitForExistence(timeout: 10))
        XCTAssertTrue(any(app, "etaFleet").waitForExistence(timeout: 10))
        shot(app, "eta-fleet")
        // Method: the accuracy check, how it's estimated, report a fare.
        segment(app, "etaSegments", "Method")
        XCTAssertTrue(any(app, "etaMethod").waitForExistence(timeout: 10))
        XCTAssertTrue(any(app, "etaCalibration").exists)
        shot(app, "eta-method")
        // Back: the scenario is kept.
        segment(app, "etaSegments", "Estimates")
        XCTAssertTrue(app.staticTexts["etaAssumed"].waitForExistence(timeout: 5) && app.staticTexts["etaAssumed"].label.contains("Busy"), "the Busy scenario is kept")
        XCTAssertEqual(app.webViews.count, 0)
    }

    func testFleetROI2LargeText() throws {
        let app = XCUIApplication.forTests()
        app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityM"]
        open(app)
        reveal(any(app, "roi2Metrics"), in: app)
        shot(app, "roi2-large-overview")
        segment(app, "roi2Segments", "Settings")
        shot(app, "roi2-large-settings")
        segment(app, "roi2Segments", "Timeline")
        reveal(any(app, "roi2Saved"), in: app)
        shot(app, "roi2-large-timeline")
        for _ in 0..<15 where !app.buttons["simTab-eta"].isHittable { app.swipeDown(velocity: .fast) }
        app.buttons["simTab-eta"].tap()
        XCTAssertTrue(app.otherElements["etaCard-cybercab"].waitForExistence(timeout: 20))
        shot(app, "eta-large-estimates")
    }
}
