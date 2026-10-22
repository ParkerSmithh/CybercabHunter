import XCTest

/// Phase 5.1 acceptance against the REAL Worker over an isolated in-memory
/// database (scripts/community-test-server.mjs; scripts/test-community.sh
/// starts it): native moderation parity, place autocomplete, avatar
/// persistence and display-name sync. Never production.
@MainActor
final class Phase51UITests: XCTestCase {
    static let server = "http://127.0.0.1:8799"

    override func setUp() async throws {
        continueAfterFailure = false
        var request = URLRequest(url: URL(string: "\(Self.server)/api/social/sidebar")!)
        request.timeoutInterval = 3
        let ok = (try? await URLSession.shared.data(for: request)).map { ($0.1 as? HTTPURLResponse)?.statusCode == 200 } ?? false
        try XCTSkipUnless(ok, "The test Worker isn't running: run ios-native/scripts/test-community.sh")
    }

    private func launch(_ tab: String, session: String?) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-tab", tab, "-apiBase", Self.server] + (session.map { ["-session", $0] } ?? [])
        app.launch()
        return app
    }

    private func shot(_ app: XCUIApplication, _ name: String) {
        let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
    }

    private func assertNative(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(app.webViews.count, 0, "a web view appeared", file: file, line: line)
        XCTAssertEqual(XCUIApplication(bundleIdentifier: "com.apple.mobilesafari").state, .notRunning, "Safari opened", file: file, line: line)
    }

    private func text(_ app: XCUIApplication, _ s: String) -> XCUIElement {
        app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", s)).firstMatch
    }

    /// GET a JSON object straight from the test Worker (no cache), for checks that must not rely on the UI.
    private func json(_ path: String, session: String? = nil) -> [String: Any] {
        var r = URLRequest(url: URL(string: Self.server + path)!, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData)
        if let session { r.setValue("Bearer \(session)", forHTTPHeaderField: "Authorization") }
        let done = expectation(description: path)
        nonisolated(unsafe) var out: [String: Any] = [:]
        URLSession.shared.dataTask(with: r) { data, _, _ in
            out = (data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }) ?? [:]
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 10)
        return out
    }
    private func me(_ session: String) -> [String: Any] { (json("/api/me", session: session)["user"] as? [String: Any]) ?? [:] }

    private func openAccount(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let all = app.buttons.matching(identifier: "accountButton")
        XCTAssertTrue(all.firstMatch.waitForExistence(timeout: 15), "an Account button", file: file, line: line)
        let deadline = Date().addingTimeInterval(10)
        var visible: XCUIElement?
        while visible == nil && Date() < deadline {
            visible = all.allElementsBoundByIndex.first { $0.exists && $0.isHittable }
            if visible == nil { usleep(300_000) }
        }
        guard let visible else { XCTFail("no Account button on screen", file: file, line: line); return }
        visible.tap()
    }

    private func reveal(_ e: XCUIElement, in app: XCUIApplication, swipes: Int = 8) {
        var n = 0
        while !(e.exists && e.isHittable) && n < swipes { app.swipeUp(velocity: .slow); n += 1 }
    }

    private func openModeration(_ app: XCUIApplication) {
        openAccount(app)
        XCTAssertTrue(app.buttons["editProfile"].waitForExistence(timeout: 15))
        sleep(2)   // the moderator answer arrives with the settings
        let link = app.buttons["moderationLink"]
        reveal(link, in: app)
        link.tap()
        XCTAssertTrue(app.buttons["modTab-vehicles"].waitForExistence(timeout: 20))
    }

    /// Replaces a text field's contents.
    private func replace(_ field: XCUIElement, with value: String, in app: XCUIApplication) {
        field.tap()
        field.press(forDuration: 1.2)
        if app.menuItems["Select All"].waitForExistence(timeout: 2) { app.menuItems["Select All"].tap() }
        field.typeText(value)
    }

    // MARK: 1. Moderation: Vehicles (sighting queue + Registry Vehicles)

    func test1ModerationRegistryVehicles() throws {
        let app = launch("home", session: "s-mod")
        openModeration(app)
        app.buttons["modTab-vehicles"].tap()
        let title = app.staticTexts["registryVehiclesTitle"]
        reveal(title, in: app)
        XCTAssertTrue(title.exists, "Registry Vehicles is on the Vehicles tab, natively")

        // XVF5100 (added from a sighting): eligible, approved as Manual (no VIN).
        let eligible = app.otherElements["registryCard-XVF5100"]
        reveal(eligible, in: app, swipes: 14)
        XCTAssertTrue(eligible.exists)
        XCTAssertTrue(eligible.staticTexts["Eligible for Approval"].exists)
        let approve = eligible.buttons["registryApprove"]
        reveal(approve, in: app)
        shot(app, "m01-registry-private")
        XCTAssertTrue(approve.isEnabled)
        approve.tap()
        XCTAssertTrue(app.descendants(matching: .any)["toast"].waitForExistence(timeout: 10))
        XCTAssertTrue(eligible.waitForNonExistence(timeout: 10), "a public vehicle leaves the Private list")

        // XVF5200 (receipt, no rides): not eligible, Approve is off.
        let blocked = app.otherElements["registryCard-XVF5200"]
        reveal(blocked, in: app, swipes: 14)
        XCTAssertTrue(blocked.staticTexts["No counted rides"].exists)
        let blockedApprove = blocked.buttons["registryApprove"]
        reveal(blockedApprove, in: app)
        XCTAssertFalse(blockedApprove.isEnabled, "the server says it can't be approved")

        // XVF5300: Delete asks first; Cancel keeps it, Confirm removes it.
        let spare = app.otherElements["registryCard-XVF5300"]
        reveal(spare, in: app, swipes: 14)
        let ask = spare.buttons["registryAskDelete"]
        reveal(ask, in: app)
        ask.tap()
        XCTAssertTrue(spare.buttons["registryConfirmDelete"].waitForExistence(timeout: 5))
        spare.buttons["registryCancelDelete"].tap()
        XCTAssertTrue(spare.buttons["registryAskDelete"].waitForExistence(timeout: 5))
        spare.buttons["registryAskDelete"].tap()
        shot(app, "m02-registry-delete-confirm")
        spare.buttons["registryConfirmDelete"].tap()
        XCTAssertTrue(spare.waitForNonExistence(timeout: 10))

        // Public: XVF5100 is there as Manual; saving its VIN also marks it VIN verified.
        let scope = app.buttons["registryScope"]
        for _ in 0..<20 where !scope.isHittable { app.swipeDown(velocity: .fast) }
        scope.tap()
        app.buttons["Public"].firstMatch.tap()
        let now = app.otherElements["registryCard-XVF5100"]
        reveal(now, in: app, swipes: 14)
        XCTAssertTrue(now.staticTexts["registryBasis"].exists)
        XCTAssertTrue(now.staticTexts["registryBasis"].label.contains("Manual"))
        let vin = now.textFields["registryVinField"]
        reveal(vin, in: app)
        for _ in 0..<3 where !app.keyboards.firstMatch.exists {
            vin.tap()
            _ = app.keyboards.firstMatch.waitForExistence(timeout: 3)
        }
        vin.typeText("7SAYGDEF5TA000555")
        now.buttons["registrySaveVin"].tap()
        XCTAssertTrue(text(app, "VIN verified").waitForExistence(timeout: 10))
        XCTAssertTrue(now.staticTexts["registryVinOnFile"].waitForExistence(timeout: 10))
        shot(app, "m03-registry-public-vin")
        assertNative(app)
    }

    // MARK: 2. Moderation: News, Gmail Link, Import Receipt

    func test2ModerationNewsGmailAndImport() throws {
        let app = launch("home", session: "s-mod")
        openModeration(app)

        // News: stories (hidden ones too), Hide, the lists.
        app.buttons["modTab-news"].tap()
        XCTAssertTrue(app.staticTexts["newsRunLine"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["newsRunLine"].label.contains("12 fetched"))
        let hiddenBefore = app.descendants(matching: .any).matching(identifier: "newsHiddenTag").count
        XCTAssertEqual(hiddenBefore, 1)
        shot(app, "m04-news")
        app.buttons["newsHide"].firstMatch.tap()
        expectation(for: NSPredicate(format: "count == 2"), evaluatedWith: app.descendants(matching: .any).matching(identifier: "newsHiddenTag"))
        waitForExpectations(timeout: 10)
        let save = app.buttons["newsSaveLists"]
        reveal(save, in: app, swipes: 12)
        save.tap()
        XCTAssertTrue(text(app, "Saved. The next run uses these lists.").waitForExistence(timeout: 10))
        shot(app, "m05-news-lists")

        // Gmail Link: aggregate counts only.
        for _ in 0..<20 where !app.buttons["modTab-gmail"].isHittable { app.swipeDown(velocity: .fast) }
        app.buttons["modTab-gmail"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["gmailStats"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.descendants(matching: .any)["gmailFunnel"].waitForExistence(timeout: 15))
        XCTAssertTrue(text(app, "Receipts processed").exists || text(app, "RECEIPTS PROCESSED").exists)
        shot(app, "m06-gmail-link")
        app.swipeUp(velocity: .slow)
        shot(app, "m07-gmail-daily")

        // Import Receipt: rider by display name, then a receipt.
        for _ in 0..<20 where !app.buttons["modImportReceipt"].isHittable { app.swipeDown(velocity: .fast) }
        app.buttons["modImportReceipt"].tap()
        let search = app.textFields["importRiderSearch"]
        XCTAssertTrue(search.waitForExistence(timeout: 15))
        app.buttons["importSubmit"].tap()
        XCTAssertEqual(app.staticTexts["importError"].label, "Choose the rider this receipt belongs to.")
        search.tap()
        search.typeText("Ali")
        let result = app.buttons["importRiderResult"].firstMatch
        XCTAssertTrue(result.waitForExistence(timeout: 10))
        result.tap()
        XCTAssertTrue(app.otherElements["importRiderSelected"].waitForExistence(timeout: 5) || text(app, "Alice A").exists)
        let paste = app.textFields["importText"]
        paste.tap()
        paste.typeText("Hello, this is not a receipt.")
        let submit = app.buttons["importSubmit"]
        reveal(submit, in: app)
        submit.tap()
        let outcome = app.staticTexts["importOutcome"].firstMatch
        XCTAssertTrue(outcome.waitForExistence(timeout: 15))
        XCTAssertEqual(outcome.label, "NOT RECOGNIZED AS A TESLA RECEIPT")
        XCTAssertTrue(app.staticTexts["importSummary"].label.contains("ALICE A"))
        shot(app, "m08-import-receipt")
        assertNative(app)
    }

    // MARK: 3. Place autocomplete above the keyboard (Austin and Dallas)

    func test3PlaceAutocomplete() throws {
        let app = launch("sightings", session: "s-bob")
        XCTAssertTrue(app.buttons["submitSighting"].waitForExistence(timeout: 20))
        app.buttons["submitSighting"].tap()
        let city = app.buttons["sightingCity"]
        XCTAssertTrue(city.waitForExistence(timeout: 10))
        city.tap()
        app.buttons["Austin"].firstMatch.tap()
        let field = app.textFields["sightingLocation"]
        XCTAssertTrue(field.waitForExistence(timeout: 5) && field.isEnabled)
        field.tap()
        field.typeText("Barton")
        let springs = app.buttons.matching(NSPredicate(format: "identifier == 'placeSuggestion' AND label CONTAINS 'Barton Springs'")).firstMatch
        if !springs.waitForExistence(timeout: 20) {
            // Place search is OpenStreetMap through the Worker; say so if it's unreachable.
            if text(app, "Location search isn't available").exists { throw XCTSkip("Place search (OpenStreetMap) was unreachable from the test Worker") }
            XCTFail("no Barton Springs suggestion")
        }
        // Every suggestion sits above the keyboard.
        let keyboard = app.keyboards.firstMatch
        if keyboard.exists { XCTAssertLessThanOrEqual(springs.frame.maxY, keyboard.frame.minY, "the suggestion is visible above the keyboard") }
        XCTAssertTrue(springs.isHittable)
        shot(app, "a01-autocomplete-barton")
        springs.tap()
        let picked = app.staticTexts["sightingPlacePicked"]
        XCTAssertTrue(picked.waitForExistence(timeout: 5))
        XCTAssertTrue((field.value as? String ?? "").contains("Barton Springs"))

        // Dallas: a new city clears the place; its own places come back.
        city.tap()
        app.buttons["Dallas"].firstMatch.tap()
        XCTAssertFalse(picked.exists)
        field.tap()
        field.typeText("Elm St")
        let dallas = app.buttons.matching(NSPredicate(format: "identifier == 'placeSuggestion' AND label CONTAINS 'Dallas'")).firstMatch
        XCTAssertTrue(dallas.waitForExistence(timeout: 20))
        shot(app, "a02-autocomplete-dallas")
        // Nothing found: the site's message.
        field.typeText("qqqzzzxx")
        XCTAssertTrue(app.staticTexts["placesMessage"].waitForExistence(timeout: 20))
        assertNative(app)
    }

    // MARK: 4. Profile pictures survive the photo row and a name change

    func test4AvatarSurvivesPhotoRowAndNameChange() throws {
        let photo = me("s-frank")["avatar_url"] as? String
        XCTAssertEqual(me("s-frank")["avatar_source"] as? String, "custom", "Frank starts with an uploaded photo (and a Google one on record)")
        let app = launch("community", session: "s-frank")
        openAccount(app)
        app.buttons["editProfile"].tap()
        let change = app.buttons["changePhoto"]
        XCTAssertTrue(change.waitForExistence(timeout: 10))
        // The old bug: tapping the photo row also ran Remove. Open the picker and cancel.
        change.tap()
        sleep(3)
        // Close the system picker (a sheet over the form) without choosing.
        let remove = app.buttons["removePhoto"]
        for _ in 0..<3 where !remove.isHittable {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)))
            sleep(2)
        }
        XCTAssertFalse(app.staticTexts["Remove your profile photo?"].exists, "no removal was asked for")
        XCTAssertEqual(me("s-frank")["avatar_url"] as? String, photo, "Change photo never removes the photo")

        // Remove asks first; Cancel keeps it.
        XCTAssertTrue(remove.waitForExistence(timeout: 10) && remove.isHittable, "back on the form")
        remove.tap()
        let dialog = app.staticTexts["Remove your profile photo?"].firstMatch
        XCTAssertTrue(dialog.waitForExistence(timeout: 5), "a confirmation")
        shot(app, "p01-remove-photo-confirm")
        // Dismiss without removing (the sheet's cancel is a tap outside it on iPhone).
        if app.buttons["Cancel"].exists { app.buttons["Cancel"].tap() } else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).tap() }
        XCTAssertTrue(dialog.waitForNonExistence(timeout: 5), "the confirmation closed")
        XCTAssertEqual(me("s-frank")["avatar_url"] as? String, photo, "cancelled: the photo stays")

        // A new name: the photo stays.
        let name = app.textFields["displayNameField"]
        replace(name, with: "Frank Native", in: app)
        app.buttons["saveProfile"].tap()
        expectation(for: NSPredicate(format: "label == 'Frank Native'"), evaluatedWith: app.staticTexts["accountName"])
        waitForExpectations(timeout: 15)
        let after = me("s-frank")
        XCTAssertEqual(after["display_name"] as? String, "Frank Native")
        XCTAssertEqual(after["avatar_url"] as? String, photo, "saving a name never touches the photo")
        shot(app, "p02-name-saved-photo-kept")

        // Remove for real: the Google photo comes back, and Remove goes away (only uploads are removable).
        // (Saving returned to Account: open Edit profile again.)
        app.buttons["editProfile"].tap()
        XCTAssertTrue(app.buttons["removePhoto"].waitForExistence(timeout: 10), "still an upload after the name change")
        app.buttons["removePhoto"].tap()
        XCTAssertTrue(app.staticTexts["Remove your profile photo?"].waitForExistence(timeout: 5))
        XCTAssertTrue(text(app, "Google photo shows instead").exists, "the dialog says what replaces it")
        app.buttons.matching(NSPredicate(format: "label == 'Remove photo'")).allElementsBoundByIndex.last?.tap()
        XCTAssertTrue(app.buttons["removePhoto"].waitForNonExistence(timeout: 10), "a Google photo can't be removed")
        let back = me("s-frank")
        XCTAssertEqual(back["avatar_url"] as? String, "https://lh3.googleusercontent.com/a/test-photo=s96-c", "the Google photo is shown again")
        XCTAssertEqual(back["avatar_source"] as? String, "google")
        shot(app, "p03-google-photo-back")
        assertNative(app)
    }

    // MARK: 5. A new display name shows everywhere at once

    func test5DisplayNameSyncsAcrossCommunity() throws {
        let app = launch("community", session: "s-alice")
        // The leaderboard first, so the old name is on screen (and in any cache).
        XCTAssertTrue(app.buttons["section-leaderboard"].waitForExistence(timeout: 20))
        app.buttons["section-leaderboard"].tap()
        let oldRow = app.buttons.matching(NSPredicate(format: "identifier == 'leaderboardRow' AND label CONTAINS 'Alice A'")).firstMatch
        XCTAssertTrue(oldRow.waitForExistence(timeout: 15))

        func rename(_ to: String) {
            openAccount(app)
            app.buttons["editProfile"].tap()
            let name = app.textFields["displayNameField"]
            XCTAssertTrue(name.waitForExistence(timeout: 10))
            replace(name, with: to, in: app)
            app.buttons["saveProfile"].tap()
            expectation(for: NSPredicate(format: "label == %@", to), evaluatedWith: app.staticTexts["accountName"])
            waitForExpectations(timeout: 15)
            app.buttons["Done"].tap()
        }
        rename("Alice Native")

        // Leaderboard: the new name, without reopening the app.
        let newRow = app.buttons.matching(NSPredicate(format: "identifier == 'leaderboardRow' AND label CONTAINS 'Alice Native'")).firstMatch
        XCTAssertTrue(newRow.waitForExistence(timeout: 15), "the leaderboard shows the new name")
        XCTAssertFalse(oldRow.exists, "the old name is gone")
        shot(app, "n01-leaderboard-new-name")

        // Social: Alice's posts carry the new name.
        for _ in 0..<4 { app.swipeDown(velocity: .fast) }
        app.buttons["section-social"].tap()
        XCTAssertTrue(text(app, "Alice Native").waitForExistence(timeout: 15) || app.buttons["Alice Native"].firstMatch.waitForExistence(timeout: 5))
        shot(app, "n02-social-new-name")

        // Find riders and the public profile.
        app.buttons["findRiders"].tap()
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText("Alice")
        let found = app.buttons["riderResult"].firstMatch
        XCTAssertTrue(found.waitForExistence(timeout: 10))
        XCTAssertTrue(found.label.contains("Alice Native"))
        found.tap()
        XCTAssertTrue(app.staticTexts["riderName"].waitForExistence(timeout: 15))
        XCTAssertEqual(app.staticTexts["riderName"].label, "Alice Native")
        shot(app, "n03-profile-new-name")
        XCTAssertEqual((json("/api/riders/alice_a")["rider"] as? [String: Any])?["name"] as? String, "Alice Native", "the server's public profile")

        // Back to the original name for the other tests.
        for _ in 0..<3 where !app.buttons.matching(identifier: "accountButton").firstMatch.isHittable {
            if app.navigationBars.buttons.firstMatch.exists { app.navigationBars.buttons.firstMatch.tap() }
            if app.buttons["Close"].exists { app.buttons["Close"].tap() }
            sleep(1)
        }
        rename("Alice A")
        assertNative(app)
    }
}
