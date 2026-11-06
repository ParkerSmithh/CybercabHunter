import XCTest

/// Ride Receipts and Import Receipt against the isolated test Worker (the real
/// Worker over an in-memory database; nothing reaches production). A shared
/// receipt is seeded where the Share extension would leave it
/// (`-seedSharedReceipt`), because UI tests can't drive Mail or Files.
@MainActor
final class ReceiptImportUITests: XCTestCase {
    static let server = "http://127.0.0.1:8799"

    override func setUp() async throws {
        continueAfterFailure = false
        var request = URLRequest(url: URL(string: "\(Self.server)/api/social/sidebar")!)
        request.timeoutInterval = 20
        let ok = (try? await URLSession.shared.data(for: request)).map { ($0.1 as? HTTPURLResponse)?.statusCode == 200 } ?? false
        try XCTSkipUnless(ok, "Start the isolated community-test-server first")
    }

    private func launch(session: String?, extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-tab", "home", "-apiBase", Self.server] + (session.map { ["-session", $0] } ?? []) + extra
        app.launch()
        return app
    }
    private func any(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any)[id].firstMatch }
    private func reveal(_ e: XCUIElement, in app: XCUIApplication) { var n = 0; while !(e.exists && e.isHittable) && n < 10 { app.swipeUp(velocity: .slow); n += 1 } }
    /// A receipt left by another test's share can open Import Receipt at launch: close it.
    private func dismissSharedReceipt(_ app: XCUIApplication) {
        let close = app.buttons["receiptImportClose"]
        if close.waitForExistence(timeout: 4) { close.tap() }
    }
    private func openReceipts(_ app: XCUIApplication) {
        dismissSharedReceipt(app)
        let account = app.buttons.matching(identifier: "accountButton").firstMatch
        XCTAssertTrue(account.waitForExistence(timeout: 15))
        account.tap()
        let rider = app.buttons["riderData"]
        reveal(rider, in: app)
        rider.tap()
        let card = app.buttons["riderGmail"]
        XCTAssertTrue(card.waitForExistence(timeout: 15))
        reveal(card, in: app)
        card.tap()
    }

    func testDashboardShowsSyncImportScanAndRecentImports() {
        let app = launch(session: "s-alice")
        openReceipts(app)
        XCTAssertTrue(any(app, "receiptsHeader").waitForExistence(timeout: 15))
        XCTAssertTrue(any(app, "receiptSyncTitle").waitForExistence(timeout: 15))
        XCTAssertNotEqual(any(app, "receiptSyncTitle").label, "Checking receipt sync…")
        XCTAssertTrue(app.buttons["receiptImportButton"].exists && app.buttons["receiptScanButton"].exists)
        saveShot(app, "receipts-dashboard")
        app.buttons["receiptImportButton"].tap()
        XCTAssertTrue(any(app, "receiptScan").waitForExistence(timeout: 10))
        XCTAssertTrue(any(app, "receiptPhotos").exists && any(app, "receiptFiles").exists && any(app, "receiptCamera").exists)
        saveShot(app, "receipts-import-options")
        app.buttons["receiptImportClose"].tap()
    }

    func testASharedReceiptPhotoIsReadReviewedAndImported() {
        let app = launch(session: "s-bob", extra: ["-seedSharedReceipt", "image"])
        let verdict = any(app, "receiptVerdict")
        XCTAssertTrue(verdict.waitForExistence(timeout: 40), "Import Receipt opens with the shared receipt, already read")
        XCTAssertTrue(verdict.label.contains("new ride"), verdict.label)
        XCTAssertTrue(any(app, "receiptPickupTime").label.contains("1:04 PM"), "the pickup time, not the drop-off time")
        saveShot(app, "receipts-review")
        app.buttons["receiptImportConfirm"].tap()
        let done = any(app, "receiptImportDone")
        XCTAssertTrue(done.waitForExistence(timeout: 20))
        XCTAssertTrue(done.label.contains("New ride imported"), done.label)
        saveShot(app, "receipts-imported")
        app.terminate()
        // The same ride shared again as a PDF: recognized, never a second ride.
        let again = launch(session: "s-bob", extra: ["-seedSharedReceipt", "pdf"])
        let second = any(again, "receiptVerdict")
        XCTAssertTrue(second.waitForExistence(timeout: 40))
        XCTAssertTrue(second.label.contains("already") , second.label)
        saveShot(again, "receipts-duplicate")
        again.buttons["receiptImportClose"].tap()
        again.terminate()
        // Seen and closed: not offered again on the next launch.
        let third = launch(session: "s-bob")
        XCTAssertTrue(third.buttons.matching(identifier: "accountButton").firstMatch.waitForExistence(timeout: 15))
        sleep(3)
        XCTAssertFalse(any(third, "receiptVerdict").exists, "a reviewed duplicate isn't offered again")
    }

    func testSignedOutKeepsTheSharedReceiptUntilSignedIn() {
        let app = launch(session: nil, extra: ["-seedSharedReceipt", "text"])
        let failed = any(app, "receiptImportFailed")
        XCTAssertTrue(failed.waitForExistence(timeout: 30))
        XCTAssertTrue(failed.label.contains("Sign in"), failed.label)
        app.buttons["receiptImportClose"].tap()
        app.terminate()
        // Signed in later: the same shared receipt is still there, offered again.
        let signedIn = launch(session: "s-dave", extra: ["-keepSharedReceipts"])
        XCTAssertTrue(any(signedIn, "receiptVerdict").waitForExistence(timeout: 40), "not lost by signing in")
        signedIn.buttons["receiptImportClose"].tap()   // reviewed and closed: removed
    }

    func testReceiptImportNotificationsSetting() {
        // The notification settings screen, as PushUITests opens it.
        let app = XCUIApplication()
        app.launchArguments = ["-pushSettings"]
        app.launch()
        XCTAssertTrue(app.navigationBars["Notifications"].waitForExistence(timeout: 20))
        let toggle = app.switches["ridesNotificationsToggle"]
        var n = 0; while !toggle.exists && n < 12 { app.swipeUp(); n += 1 }
        if toggle.exists {
            XCTAssertEqual(toggle.value as? String, "0", "off until the rider turns it on")
            saveShot(app, "receipts-notification-setting")
        } else {
            XCTFail("Receipt Import Notifications toggle is missing")
        }
    }
}
