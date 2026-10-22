import Testing
import Foundation
@testable import CybercabHunter

// Phase 5.1: moderation parity (Registry Vehicles, News, Gmail Link, Import
// Receipt), place autocomplete, avatar URLs, fresh name data and the app's
// display name. Fixtures are real Worker responses over an isolated database
// (scripts/community-test-server.mjs --fixtures); places-* are real
// /api/places answers captured through that server.

private func bodyJSON(_ data: Data?) -> [String: Any] {
    (data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }) ?? [:]
}

private let sightingVehicle = "c3d4e5f6-0000-4000-8000-000000000003"
private let receiptVehicle = "d4e5f6a7-0000-4000-8000-000000000004"

@MainActor
struct RegistryReviewTests {
    @Test func vehiclesDecodeWithTheServersRules() throws {
        let list: ModVehicleList = try TestFixtures.decode("moderation-registry-private")
        let sighting = try #require(list.vehicles.first { $0.id == sightingVehicle })
        #expect(!sighting.isPublic && sighting.fromSighting && sighting.canApprove && !sighting.hasVin)
        #expect(sighting.stateView.badge == "Private: Needs Review" && sighting.stateView.line == "Eligible for Approval")
        #expect(sighting.approval?.notes == ["added_from_sighting"])
        let receipt = try #require(list.vehicles.first { $0.id == receiptVehicle })
        #expect(!receipt.canApprove && receipt.stateView.line == "Not Eligible")
        #expect(receipt.approval?.blockingReasons.map { ModVehicle.label(ModVehicle.reasonLabels, $0) } == ["No counted rides"])
        #expect(receipt.approval?.notes.map { ModVehicle.label(ModVehicle.noteLabels, $0) } == ["No rides on record (orphaned)"])
        let pub: ModVehicleList = try TestFixtures.decode("moderation-registry-public")
        #expect(pub.vehicles.count == 2 && pub.vehicles.allSatisfy { $0.isPublic && $0.stateView.badge == "Public" })
        #expect(Set(pub.vehicles.compactMap(\.approvalBasis)) == ["vin-verified", "manual"])
        let approved: ModVehicleUpdated = try TestFixtures.decode("moderation-registry-approved")
        #expect(approved.vehicle.isPublic && approved.vehicle.approvalBasis == "manual" && approved.vehicle.latestReview?.moderatorDisplayName == "Owner")
    }

    private func stub() -> StubServer {
        let s = StubServer()
        s.responses = ["GET /api/moderation/robotaxi-vehicles": (200, CommunityStub.fixture("moderation-registry-private"))]
        return s
    }

    @Test func listingUsesScopeOrPlate() async throws {
        let s = stub()
        let m = RegistryReviewModel()
        await m.load(api: s.api())
        #expect(m.state == .ready && m.vehicles.count == 5)
        #expect(s.requests.last?.0.url?.query() == "scope=private")
        #expect(s.requests.last?.0.cachePolicy == .reloadIgnoringLocalCacheData, "moderation lists are never served from the device cache")
        m.plate = " XVF5100 "
        await m.load(api: s.api())
        #expect(s.requests.last?.0.url?.query() == "plate=XVF5100", "a plate search ignores the scope")
        m.scope = .noVin
        await m.load(api: s.api())
        #expect(s.requests.last?.0.url?.query() == "plate=XVF5100&scope=no_vin", "except No VIN")
        await m.setScope(.public, api: s.api())
        #expect(m.plate.isEmpty && s.requests.last?.0.url?.query() == "scope=public", "a new scope clears the plate")
    }

    @Test func approveSendsManualOrCybercabAndLeavesThePrivateList() async throws {
        let s = stub()
        let m = RegistryReviewModel()
        await m.load(api: s.api())
        let v = try #require(m.vehicles.first { $0.id == sightingVehicle })
        s.responses["POST /api/moderation/robotaxi-vehicles/\(sightingVehicle)/review"] = (200, CommunityStub.fixture("moderation-registry-approved"))
        s.requests = []
        // Two taps at once send one request.
        async let a: Void = m.approve(v, api: s.api())
        async let b: Void = m.approve(v, api: s.api())
        _ = await (a, b)
        let reviews = s.requests.filter { $0.0.url?.path.hasSuffix("/review") == true }
        #expect(reviews.count == 1)
        #expect(bodyJSON(reviews.first?.1)["action"] as? String == "approve_manual", "no VIN: approved as Manual")
        #expect(m.toast?.text == "Vehicle approved for the public registry (manual, no VIN).")
        #expect(!m.vehicles.contains { $0.id == sightingVehicle }, "a public vehicle leaves the Private list")
        #expect(m.busy.isEmpty)
    }

    @Test func aConflictShowsTheCurrentFacts() async throws {
        let s = stub()
        let m = RegistryReviewModel()
        await m.load(api: s.api())
        let v = try #require(m.vehicles.first { $0.id == receiptVehicle })
        s.responses["POST /api/moderation/robotaxi-vehicles/\(receiptVehicle)/review"] = CommunityStub.errorFixture("error-registry-not-eligible")
        await m.approve(v, api: s.api())
        #expect(m.toast?.text == "Not approved. Not eligible: No counted rides." && m.toast?.isError == true)
        #expect(m.vehicles.contains { $0.id == receiptVehicle }, "the card stays, with the server's facts")
        s.responses["POST /api/moderation/robotaxi-vehicles/\(receiptVehicle)/review"] = CommunityStub.errorFixture("error-registry-already-public")
        await m.returnToPrivate(v, api: s.api())
        #expect(m.toast?.text == "That vehicle is already public.")
        s.responses["POST /api/moderation/robotaxi-vehicles/\(receiptVehicle)/review"] = (404, #"{"success":false,"error":"not_found"}"#)
        await m.approve(v, api: s.api())
        #expect(!m.vehicles.contains { $0.id == receiptVehicle } && m.toast?.text == "That vehicle no longer exists. Removed from the list.")
    }

    @Test func vinSaveClearAndVerify() async throws {
        let s = stub()
        let m = RegistryReviewModel()
        await m.load(api: s.api())
        let v = try #require(m.vehicles.first { $0.id == sightingVehicle })
        await m.setVin(v, raw: "  ", api: s.api())
        #expect(m.toast?.text == "Enter a VIN first.", "an empty box with no VIN on file sends nothing")
        let path = "POST /api/moderation/robotaxi-vehicles/\(sightingVehicle)/vin"
        s.responses[path] = CommunityStub.errorFixture("error-registry-invalid-vin")
        await m.setVin(v, raw: "nope", api: s.api())
        #expect(m.toast?.text == "That doesn't look like a valid VIN. Check it and try again.")
        #expect(bodyJSON(s.requests.last?.1)["vin"] as? String == "NOPE", "sent upper-cased")
        // A public Manual vehicle: saving the VIN also marks it VIN verified.
        s.responses[path] = (200, CommunityStub.fixture("moderation-registry-vin-saved"))
        s.responses["POST /api/moderation/robotaxi-vehicles/\(sightingVehicle)/review"] = (200, CommunityStub.fixture("moderation-registry-vin-saved"))
        s.requests = []
        await m.setVin(v, raw: "7sayGDEF5TA000555", api: s.api())
        #expect(s.requests.map { $0.0.url?.path ?? "" } == ["/api/moderation/robotaxi-vehicles/\(sightingVehicle)/vin", "/api/moderation/robotaxi-vehicles/\(sightingVehicle)/review"])
        #expect(bodyJSON(s.requests.last?.1)["action"] as? String == "verify_vin")
        #expect(m.toast?.text == "VIN saved. Vehicle is now VIN verified.")
    }

    @Test func deleteAndLostAccess() async throws {
        let s = stub()
        let m = RegistryReviewModel()
        await m.load(api: s.api())
        let v = try #require(m.vehicles.first { $0.id == receiptVehicle })
        s.responses["DELETE /api/moderation/robotaxi-vehicles/\(receiptVehicle)"] = (200, CommunityStub.fixture("moderation-registry-deleted"))
        await m.delete(v, api: s.api())
        #expect(!m.vehicles.contains { $0.id == receiptVehicle } && m.toast?.text == "Vehicle and its ride history removed. The receipt can be resent.")
        s.responses["GET /api/moderation/robotaxi-vehicles"] = CommunityStub.errorFixture("error-moderation-forbidden")
        await m.load(api: s.api())
        #expect(m.accessLost == .forbidden, "the server decides who moderates")
    }
}

@MainActor
struct NewsModerationTests {
    @Test func storiesRunLineAndLists() async throws {
        let s = StubServer()
        s.responses = ["GET /api/moderation/news": (200, CommunityStub.fixture("moderation-news"))]
        let m = NewsModerationModel()
        await m.load(api: s.api())
        #expect(m.state == .ready && m.stories.count == 3)
        #expect(m.stories.contains { $0.hidden } && m.stories.contains { $0.featured && $0.importance == 2 })
        #expect(m.runLine.hasPrefix("Last step ") && m.runLine.contains("(google-news): 12 fetched, 3 kept, 9 dropped (1 by publisher), 3 new"), "\(m.runLine)")
        #expect(m.blockedCount == "Last run: 1 story blocked by publisher.")
        #expect(!m.allow.isEmpty && !m.publishers.isEmpty)
        #expect(NewsModerationModel.runLine(nil, prune: nil) == "The ingest has not run yet.")

        let story = try #require(m.stories.first { !$0.hidden })
        s.responses["POST /api/moderation/news/\(story.id)"] = (200, CommunityStub.fixture("moderation-news-hidden"))
        s.requests = []
        await m.act(story, "hide", api: s.api())
        #expect(bodyJSON(s.requests.first?.1)["action"] as? String == "hide")
        #expect(s.requests.last?.0.url?.path == "/api/moderation/news", "the list reloads after")

        let count = m.publishers.count
        m.publisherInput = "  Some   Outlet "
        m.addPublisher()
        m.publisherInput = "some outlet"
        m.addPublisher()
        #expect(m.publishers.count == count + 1 && m.publishers.last == "Some Outlet" && m.configNote == "Not saved yet.")

        s.responses["PUT /api/moderation/news-config"] = CommunityStub.errorFixture("error-news-empty-allowlist")
        m.allow = " "
        m.majorKeywords = "launch\n\n expands "
        await m.save(api: s.api())
        #expect(m.configNote == "The allowlist needs at least one rule.")
        let sent = bodyJSON(s.requests.last?.1)
        #expect(sent["major_keywords"] as? [String] == ["launch", "expands"], "one rule per line, blanks dropped")
        #expect((sent["publisher_blocklist"] as? [String])?.contains("Some Outlet") == true)
    }
}

@MainActor
struct GmailLinkTests {
    @Test func countsDecodeAndLabel() async throws {
        let s = StubServer()
        s.responses = [
            "GET /api/moderation/forwarding-stats": (200, CommunityStub.fixture("moderation-forwarding-stats")),
            "GET /api/moderation/forwarding-detail": (200, CommunityStub.fixture("moderation-forwarding-detail"))
        ]
        let m = GmailLinkModel()
        await m.load(api: s.api())
        guard case .ready(let stats) = m.stats, case .ready(let d) = m.detail else { Issue.record("not loaded"); return }
        #expect(stats.setupCompleted == 1 && stats.activelyReceiving == 1 && stats.receiving7d == 1 && stats.linked30d == 1 && stats.receiptsProcessed == 3)
        #expect(d.funnel.setupCompleted == 1 && d.funnel.confirmationReceived == 1 && d.funnel.receiving7d == 1)
        #expect(d.receipts.total == 3 && d.receipts.last24h == 1 && d.receipts.last7d == 3 && d.receipts.daily.count == 14)
        #expect(GmailLinkModel.count(d.receipts.byStatus, "accepted") == 1 && GmailLinkModel.count(d.receipts.byStatus, "duplicate") == 1)
        #expect(GmailLinkModel.count(d.receipts.byStatus, "needs_review") == 0 && GmailLinkModel.count(d.receipts.byStatus, "parse_error") == 0)
        #expect(GmailLinkModel.percent(1, of: 3) == "33%" && GmailLinkModel.percent(1, of: 0) == "—")
        #expect(GmailLinkModel.when(nil) == "never" && GmailLinkModel.shortDay("2026-10-21") == "Oct 21")
        for leak in ["alice", "bob", "carol", "dave", "tok-", "@"] {
            #expect(!CommunityStub.fixture("moderation-forwarding-detail").contains(leak), "aggregate counts only (\(leak))")
        }
        s.responses["GET /api/moderation/forwarding-detail"] = (500, "{}")
        let failing = GmailLinkModel()
        await failing.loadDetail(api: s.api())
        #expect(failing.detail == .failed)
    }
}

@MainActor
struct ImportReceiptTests {
    @Test func riderPickerAndChecks() async throws {
        let s = StubServer()
        s.responses = ["GET /api/moderation/riders": (200, CommunityStub.fixture("moderation-riders"))]
        let m = ImportReceiptModel()
        await m.submit(api: s.api())
        #expect(m.formError == "Choose the rider this receipt belongs to.")
        m.query = "ali"
        await m.searchRiders(api: s.api())
        #expect(m.riders.map(\.displayName) == ["Alice A"])
        #expect(s.requests.last?.0.url?.query() == "display_name=ali")
        m.choose(m.riders[0])
        #expect(m.rider?.id == "alice")
        await m.submit(api: s.api())
        #expect(m.formError == "Choose a receipt file or paste the receipt text.")
        m.addFile(name: "empty.eml", data: Data("  ".utf8))
        #expect(m.formError == "empty.eml is empty." && m.files.isEmpty)
        s.responses["GET /api/moderation/riders"] = (200, #"{"success":true,"riders":[]}"#)
        m.query = "zzz"
        await m.searchRiders(api: s.api())
        #expect(m.riderStatus == "No rider with that display name.")
    }

    @Test func importResultsAndErrors() async throws {
        let s = StubServer()
        s.responses = ["POST /api/moderation/receipt-import": (200, CommunityStub.fixture("moderation-receipt-import"))]
        let m = ImportReceiptModel()
        m.choose(.init(id: "dave", displayName: "Dave D", handle: "dave_d"))
        m.addFile(name: "receipt.eml", data: Data("From: Tesla\n\nReceipt".utf8))
        m.pasted = "Hello, this is not a receipt."
        await m.submit(api: s.api())
        let sent = bodyJSON(s.requests.last?.1)
        #expect(sent["rider_user_id"] as? String == "dave")
        #expect((sent["items"] as? [[String: String]])?.map { $0["kind"] ?? "" } == ["eml", "text"])
        let r = try #require(m.result)
        #expect(r.results.map(\.outcome) == ["created", "rejected"])
        #expect(m.labels == ["receipt.eml", "Pasted text"] && m.files.isEmpty && m.pasted.isEmpty && m.rider?.id == "dave", "the rider stays for the next receipt")
        #expect(m.summary == "Added to Dave Spotter's Rider Data · 2 processed · 1 added · 1 rejected", "the server's name for the rider")
        let ride = try #require(r.results.first?.ride)
        #expect(ImportReceiptModel.time(ride.pickupTime) == "1:04 PM" && ImportReceiptModel.fare(ride.fareAmountCents, ride.currency) == "$6.92")
        #expect(ImportReceiptModel.distance(ride.distance, ride.distanceUnit) == "2.8 mi" && ImportReceiptModel.date(ride.rideDate) == "Jun 9, 2026")
        let v = try #require(r.results.first?.vehicle)
        #expect(v.created && v.visibility == "private" && !v.publiclyEligible, "nothing is made public by an import")
        #expect(ImportReceiptModel.reasons[r.results[1].reason ?? ""] == "This doesn't look like a Tesla Robotaxi receipt.")

        s.responses["POST /api/moderation/receipt-import"] = CommunityStub.errorFixture("error-receipt-import-rider")
        m.pasted = "x"
        await m.submit(api: s.api())
        #expect(m.rider == nil && m.formError == "That rider no longer exists. Choose another.")
    }
}

@MainActor
struct PlaceAutocompleteTests {
    private func model(_ s: StubServer, city: String) async -> SubmitSightingModel {
        s.responses["GET /api/service-areas"] = (200, CommunityStub.fixture("service-areas"))
        s.responses["GET /data/traffic-cameras.json"] = (200, CommunityStub.fixture("traffic-cameras"))
        let m = SubmitSightingModel()
        await m.load(api: s.api())
        m.cityName = city
        return m
    }

    @Test func bartonFindsBartonSprings() async throws {
        let s = StubServer()
        s.responses["GET /api/places"] = (200, CommunityStub.fixture("places-barton"))
        let m = await model(s, city: "Austin")
        m.locationText = "Barton"
        await m.searchPlaces(api: s.api())
        #expect(!m.searchingPlaces && m.placesMessage == nil)
        let springs = try #require(m.places.first { $0.label.hasPrefix("Barton Springs") })
        let q = s.requests.last?.0.url?.query() ?? ""
        #expect(q.contains("q=Barton") && q.contains("area=austin"), "\(q)")
        m.pick(springs)
        #expect(m.locationText == "Barton Springs Pool, Austin, TX" && m.places.isEmpty && m.locationError == nil)
        #expect(Dictionary(m.form().fields, uniquingKeysWith: { a, _ in a })["location_id"] == "W:27442711")
    }

    @Test func dallasEmptyShortAndFailures() async {
        let s = StubServer()
        s.responses["GET /api/places"] = (200, CommunityStub.fixture("places-elm-dallas"))
        let m = await model(s, city: "Dallas")
        m.locationText = "Elm St"
        await m.searchPlaces(api: s.api())
        #expect(!m.places.isEmpty && (s.requests.last?.0.url?.query() ?? "").contains("area=dallas"))
        m.locationText = "El"
        await m.searchPlaces(api: s.api())
        #expect(m.places.isEmpty && m.placesMessage == nil, "under 3 characters asks nothing")
        s.responses["GET /api/places"] = (200, #"{"places":[]}"#)
        m.locationText = "Qqqqzz"
        await m.searchPlaces(api: s.api())
        #expect(m.placesMessage == "No matching places in Dallas. Try a street or landmark.")
        s.responses["GET /api/places"] = (502, #"{"success":false,"error":"location_unavailable"}"#)
        m.locationText = "Main Street"
        await m.searchPlaces(api: s.api())
        #expect(m.places.isEmpty && m.placesMessage == "Location search isn't available right now." && !m.searchingPlaces)
    }
}

@MainActor
struct AccountConsistencyTests {
    @Test func avatarURLsUseTheSizedVariant() {
        let key = "/api/avatars/0123456789abcdef0123456789abcdef"
        #expect(SocialAuthor.avatarURL(key, size: 512)?.absoluteString == "https://cybercabhunter.com\(key)/512")
        #expect(SocialAuthor.avatarURL(key)?.absoluteString == "https://cybercabhunter.com\(key)/128")
        let google = "https://lh3.googleusercontent.com/a/abc=s96-c"
        #expect(SocialAuthor.avatarURL(google)?.absoluteString == google, "a Google picture is used as is")
        #expect(SocialAuthor.avatarURL(nil) == nil)
    }

    @Test func freshRequestsSkipTheDeviceCache() async throws {
        let s = StubServer()
        s.responses["GET /api/community/leaderboard"] = (200, CommunityStub.fixture("leaderboard-xp"))
        let api = s.api()
        let _: Leaderboard = try await api.get("/api/community/leaderboard", fresh: true)
        #expect(s.requests.last?.0.cachePolicy == .reloadIgnoringLocalCacheData)
        let _: Leaderboard = try await api.get("/api/community/leaderboard")
        #expect(s.requests.last?.0.cachePolicy == .useProtocolCachePolicy)
    }

    @Test func theLeaderboardAsksForFreshData() async {
        let s = StubServer()
        s.responses["GET /api/community/leaderboard"] = (200, CommunityStub.fixture("leaderboard-xp"))
        let m = LeaderboardModel()
        await m.load(api: s.api())
        await m.load(api: s.api(), force: true)
        #expect(s.requests.count == 2 && s.requests.allSatisfy { $0.0.cachePolicy == .reloadIgnoringLocalCacheData }, "a name change shows on the next load")
    }

    @Test func photoSourceAndGoogleFallback() async throws {
        let custom: ProfileResponse = try TestFixtures.decode("profile-custom-avatar")
        #expect(custom.user.avatarSource == "custom" && custom.user.hasGoogleAvatar == true && custom.user.canRemovePhoto)
        let google: ProfileResponse = try TestFixtures.decode("profile-google-avatar")
        #expect(google.user.avatarSource == "google" && !google.user.canRemovePhoto, "a Google picture is the fallback, not removable")
        let older: ProfileResponse = try TestFixtures.decode("profile")
        #expect(older.user.avatarSource == nil && older.user.canRemovePhoto == (older.user.avatarUrl != nil), "an older server: as before")
        let me: MeResponse = try TestFixtures.decode("me-custom-avatar")
        #expect(me.user?.avatarSource == "custom" && me.user?.avatarURL?.absoluteString.hasSuffix("/128") == true)

        // Remove: the model shows what the server shows now (the Google picture).
        let stub = StubServer()
        stub.responses = [
            "GET /api/profile": (200, CommunityStub.fixture("profile-custom-avatar")),
            "DELETE /api/profile/avatar": (200, CommunityStub.fixture("avatar-removed-google"))
        ]
        let model = AccountModel()
        await model.load(api: stub.api())
        #expect(model.settings?.canRemovePhoto == true)
        #expect(await model.removeAvatar(api: stub.api()) == nil)
        #expect(model.settings?.avatarUrl == "https://lh3.googleusercontent.com/a/gina=s96-c" && model.settings?.avatarSource == "google" && model.settings?.canRemovePhoto == false)
        #expect(model.settings?.displayName == "Gina G", "nothing else changes")
    }

    @Test func theAppIsCalledCybercabHunter() {
        #expect(Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String == "Cybercab Hunter")
        #expect(Bundle.main.bundleIdentifier == "com.cybercabhunter.native")
    }
}
