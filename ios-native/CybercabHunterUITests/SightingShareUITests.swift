import XCTest

/// Take Photo / Choose from Photo Library, and a photo shared to Cybercab
/// Hunter (the Share extension's inbox, seeded with `-seedSharedSighting`)
/// arriving in the Submit a sighting form. Uses the isolated test Worker;
/// nothing is ever submitted.
@MainActor
final class SightingShareUITests: XCTestCase {
    override func setUp() async throws {
        continueAfterFailure = false
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8799/api/social/sidebar")!)
        request.timeoutInterval = 3
        let response = try? await URLSession.shared.data(for: request)
        try XCTSkipUnless((response?.1 as? HTTPURLResponse)?.statusCode == 200, "Start the isolated community-test-server first")
    }

    private func launch(_ extra: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-tab", "sightings", "-apiBase", "http://127.0.0.1:8799"] + extra
        app.launch()
        return app
    }

    func testASharedPhotoOpensTheFormWithItAttached() {
        let app = launch(["-session", "s-bob", "-seedSharedSighting"])
        let chosen = app.descendants(matching: .any)["sightingPhotoChosen"]
        XCTAssertTrue(chosen.waitForExistence(timeout: 20), "the form opened with the shared photo")
        XCTAssertTrue(app.staticTexts["Shared from Photos · Change Photo"].exists)
        XCTAssertFalse(app.staticTexts["sightingSubmitted"].exists, "nothing is submitted until the rider does")
        saveShot(app, "sighting-shared-photo")
        // Removing it leaves the empty photo box.
        app.buttons["Remove photo"].tap()
        XCTAssertTrue(app.staticTexts["Upload Photo"].waitForExistence(timeout: 5))
    }

    func testSignedOutTheSharedPhotoWaitsForSignIn() {
        // Signed out: the sign-in screen, and the photo stays in the inbox.
        var app = launch(["-seedSharedSighting"])
        XCTAssertTrue(app.buttons["Sign in with Google"].waitForExistence(timeout: 20), "signed out: sign in first")
        XCTAssertFalse(app.descendants(matching: .any)["sightingPhotoChosen"].exists)
        saveShot(app, "sighting-shared-signed-out")
        app.terminate()
        // Signed in (no new share): the waiting photo is attached.
        app = launch(["-session", "s-bob"])
        XCTAssertTrue(app.descendants(matching: .any)["sightingPhotoChosen"].waitForExistence(timeout: 20), "the photo survived until sign-in")
        app.terminate()
        // Attached once: the next launch doesn't open it again.
        app = launch(["-session", "s-bob"])
        XCTAssertTrue(app.buttons["submitSighting"].waitForExistence(timeout: 20))
        XCTAssertFalse(app.descendants(matching: .any)["sightingPhotoChosen"].exists)
    }

    func testUploadPhotoOffersCameraAndLibrary() {
        let app = launch(["-session", "s-bob"])
        XCTAssertTrue(app.buttons["submitSighting"].waitForExistence(timeout: 20))
        app.buttons["submitSighting"].tap()
        let box = app.buttons["sightingPhotoPicker"]
        XCTAssertTrue(box.waitForExistence(timeout: 10))
        box.tap()
        let take = app.buttons["Take Photo"], library = app.buttons["Choose from Photo Library"]
        if take.waitForExistence(timeout: 5) {
            // A device (or simulator) with a camera: the native menu (iOS shows it as a
            // popover from the photo box; tapping outside cancels).
            XCTAssertTrue(library.exists)
            saveShot(app, "sighting-photo-menu")
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).tap()
            XCTAssertTrue(take.waitForNonExistence(timeout: 5), "cancelled: the menu closes")
            XCTAssertTrue(box.exists && app.staticTexts["Upload Photo"].exists, "back to the form, nothing changed")
        } else {
            // No camera: Apple's photo picker opens directly.
            saveShot(app, "sighting-photo-library")
        }
    }
}
