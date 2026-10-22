import Testing
import Foundation
import ImageIO
import UniformTypeIdentifiers
@testable import CybercabHunter

// Phase 5: Sightings, Account, Privacy, Moderation. The fixtures are real
// responses from the Worker's own code over an isolated database
// (scripts/community-test-server.mjs --fixtures).

private func testJPEG(width: Int = 3200, height: Int = 2400, gps: Bool = true) -> Data {
    let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    ctx.setFillColor(CGColor(red: 0.2, green: 0.3, blue: 0.4, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let out = NSMutableData()
    let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil)!
    let meta: [CFString: Any] = gps ? [kCGImagePropertyGPSDictionary: [kCGImagePropertyGPSLatitude: 30.2672, kCGImagePropertyGPSLatitudeRef: "N"]] : [:]
    CGImageDestinationAddImage(dest, ctx.makeImage()!, meta as CFDictionary)
    CGImageDestinationFinalize(dest)
    return out as Data
}

private func bodyJSON(_ data: Data?) -> [String: Any] {
    (data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }) ?? [:]
}

struct SightingDecodingTests {
    @Test func galleryStatsAndPaging() throws {
        let page: PublicSightingsPage = try TestFixtures.decode("sightings-austin")
        #expect(page.seen == 2 && page.order == "desc" && page.sightings.count == 1 && page.nextCursor != nil)
        let s = try #require(page.sightings.first)
        #expect(s.id.count == 32 && s.imageURL.path == "/api/sightings/\(s.id)/photo")
        #expect(s.city == "Austin" && s.cybercab && s.timeZone == "America/Chicago" && s.spotted != nil)
        let stats = try #require(page.stats)
        #expect(stats.total == 2 && stats.today == 2 && stats.last7Days == 2 && stats.peakHour?.count == 2 && stats.bestDay?.count == 2)
        let page2: PublicSightingsPage = try TestFixtures.decode("sightings-austin-page2")
        #expect(page2.stats == nil && page2.nextCursor == nil && page2.sightings.first?.id != s.id)
        let all: PublicSightingsPage = try TestFixtures.decode("sightings-all-asc")
        #expect(all.order == "asc" && all.sightings.count == 3)
        let dates = all.sightings.compactMap(\.spottedAt)
        #expect(dates == dates.sorted(), "least recent first")
        #expect(Set(all.sightings.compactMap(\.city)) == ["Austin", "Dallas"])
        #expect(CommunityStub.errorFixture("error-sightings-invalid-city").0 == 400)
    }

    @Test func publicSightingsNeverNameTheSubmitter() {
        for name in ["sightings-austin", "sightings-all-asc"] {
            let raw = CommunityStub.fixture(name)
            for leak in ["user", "submission", "evidence", "notes", "Charging at the Domain", "bob", "dave"] {
                #expect(!raw.lowercased().contains(leak.lowercased()), "\(name) leaks \(leak)")
            }
        }
    }

    @Test func mySubmissionsAndStatuses() throws {
        let mine: MySubmissions = try TestFixtures.decode("my-submissions")
        #expect(mine.sightings.count == mine.submissions.count)
        #expect(Set(mine.sightings.map(\.status)) == ["approved", "pending", "rejected"])
        #expect(mine.sightings.allSatisfy { SubmissionStatus(rawValue: $0.status) != nil })
        #expect(!CommunityStub.fixture("my-submissions").contains("Too far away"), "no moderator reason reaches the rider")
        #expect(SubmissionStatus.allCases.map(\.rawValue) == ["pending", "approved", "rejected", "needs_review"])
        let submitted: SightingSubmitted = try TestFixtures.decode("sighting-photo-created")
        #expect(submitted.success && !submitted.duplicate && submitted.status == "pending", "a new sighting is pending, never verified")
        let dup: SightingSubmitted = try TestFixtures.decode("sighting-photo-duplicate")
        #expect(dup.duplicate)
    }

    @Test func helpers() {
        let now = Format.instant("2026-10-21 12:00:00")!
        #expect(SightingsModel.ago(Format.instant("2026-10-21 11:48:00"), now: now) == "12m ago")
        #expect(SightingsModel.ago(Format.instant("2026-10-21 07:00:00"), now: now) == "5h ago")
        #expect(SightingsModel.ago(Format.instant("2026-10-18 12:00:00"), now: now) == "3d ago")
        #expect(SightingsModel.normalized("xvf-3582 ") == "XVF3582")
        let s = PublicSighting(id: "x", imageUrl: "/a", city: "Austin", location: nil, plate: nil, cybercab: false, spottedAt: "2026-10-21T16:55:00Z", timeZone: "America/Chicago")
        #expect(s.spottedText.hasPrefix("Oct 21, 2026 · 11:55") && s.spottedText.hasSuffix("CDT"), "the sighting's own zone: \(s.spottedText)")
    }

    @Test func sightingPhotoIsPreparedLikeTheWebsite() throws {
        let jpeg = try PhotoEncoder.sightingJPEG(from: testJPEG())
        let src = CGImageSourceCreateWithData(jpeg as CFData, nil)!
        let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any] ?? [:]
        #expect(props[kCGImagePropertyGPSDictionary] == nil, "no location leaves the phone")
        #expect(max(props[kCGImagePropertyPixelWidth] as? Int ?? 0, props[kCGImagePropertyPixelHeight] as? Int ?? 0) == 2560)
        #expect(jpeg.count <= 10 * 1024 * 1024)
    }
}

@Suite(.serialized)
@MainActor
struct SightingFlowTests {
    @Test func plateOpensTheVehicleOnlyOnAnExactUniqueMatch() async {
        let stub = StubServer()
        let one = #"{"vehicles":[{"id":"v1","license_plate":"XVF-3582"},{"id":"v2","license_plate":"XVF35820"}],"total":2,"limit":10,"offset":0}"#
        stub.responses = ["GET /api/robotaxi-vehicles": (200, one)]
        #expect(await SightingsModel.vehicle(for: "XVF3582", api: stub.api()) == VehicleRoute(id: "v1", plate: "XVF-3582"))
        let two = #"{"vehicles":[{"id":"v1","license_plate":"ABC123"},{"id":"v2","license_plate":"ABC-123"}],"total":2,"limit":10,"offset":0}"#
        stub.responses = ["GET /api/robotaxi-vehicles": (200, two)]
        #expect(await SightingsModel.vehicle(for: "ABC123", api: stub.api()) == nil, "an ambiguous plate opens nothing")
    }

    @Test func galleryPagingAndModeratorDelete() async throws {
        let stub = StubServer()
        stub.responses = [
            "GET /api/service-areas": (200, CommunityStub.fixture("service-areas")),
            "GET /api/sightings": (200, CommunityStub.fixture("sightings-austin")),
            "GET /api/moderation/access": CommunityStub.errorFixture("moderation-access-rider")
        ]
        // The sort is remembered on the device (as on the website); start from the default.
        UserDefaults.standard.removeObject(forKey: "sightingsOrder")
        let model = SightingsModel()
        await model.start(api: stub.api(), signedIn: true)
        #expect(model.items.count == 1 && model.stats?.total == 2 && !model.isModerator)
        stub.requests = []
        stub.responses["GET /api/sightings"] = (200, CommunityStub.fixture("sightings-austin-page2"))
        await model.loadMore(api: stub.api())
        #expect(model.items.count == 2 && model.nextCursor == nil)
        // The paging request itself (the one with the cursor), whatever else was in flight.
        let paging = try #require(stub.requests.first { $0.0.url?.path == "/api/sightings" && ($0.0.url?.query() ?? "").contains("cursor=") },
                                  "requests: \(stub.requests.map { $0.0.url?.absoluteString ?? "" })")
        let q = paging.0.url?.query() ?? ""
        #expect(q.contains("city=austin") && q.contains("order=desc") && !q.contains("stats=1"), "query: \(q)")
        try #require(model.items.count == 2, "both gallery pages loaded")
        stub.responses["DELETE /api/moderation/sightings/\(model.items[0].id)/photo"] = (403, #"{"success":false,"error":"forbidden"}"#)
        await model.deletePhoto(model.items[0], api: stub.api())
        #expect(model.items.count == 2 && model.toast?.text == "Only moderators can delete photos.", "the server decides")
    }

    @Test func submissionChecksMatchTheWebsite() async {
        let stub = StubServer()
        let m = SubmitSightingModel()
        #expect(!m.validate() && m.photoError == "Please add a photo of the Cybercab.")
        await m.setPhoto(testJPEG(width: 400, height: 300))
        #expect(m.photo != nil && m.preview != nil)
        m.locationText = "Congress Ave"
        #expect(!m.validate() && m.locationError == "Choose a city from the list first.")
        stub.responses = ["GET /api/service-areas": (200, CommunityStub.fixture("service-areas")), "GET /data/traffic-cameras.json": (200, CommunityStub.fixture("traffic-cameras"))]
        await m.load(api: stub.api())
        m.cityName = "Austin"
        #expect(m.locationText.isEmpty, "a new city clears the place")
        m.locationText = "Congress Ave"
        m.locationEdited()
        #expect(!m.validate() && m.locationError == "Choose the location from the suggestions list.")
        m.pick(PlaceSearch.Place(id: "W123", label: "Congress Avenue, Austin", city: "Austin"))
        #expect(m.validate())
        m.plate = "XVF-3582 "
        m.notes = String(repeating: "n", count: 300)
        #expect(m.notes.count == 280, "the description is capped at 280")
        m.cameraId = m.cityCameras.first?.cameraId ?? ""
        let fields = Dictionary(m.form(timeZone: TimeZone(identifier: "America/Chicago")!).fields, uniquingKeysWith: { a, _ in a })
        #expect(fields["service_area"] == "Austin" && fields["license_plate"] == "XVF-3582" && fields["time_zone"] == "America/Chicago")
        #expect(fields["approx_location"] == "Congress Avenue, Austin" && fields["location_id"] == "W123" && fields["location_query"] == "Congress Ave")
        #expect(fields["observed_date"] == nil, "no date means today (the server records the time)")
        #expect(fields["camera_id"] != nil && m.cityCameras.allSatisfy { $0.cityKey == "austin" })
        m.cityName = "Dallas"
        #expect(m.cameraId.isEmpty || m.cityCameras.contains { $0.cameraId == m.cameraId }, "a camera from the other city is dropped")
        #expect(m.form().fileCount == 1)
    }

    @Test func submitOutcomesKeepTheFormOnFailure() async {
        let stub = StubServer()
        let m = SubmitSightingModel()
        await m.setPhoto(testJPEG(width: 400, height: 300))
        m.plate = "XVF3582"
        m.notes = "On Congress"
        // Session ended: nothing typed is lost.
        stub.responses = ["POST /api/vehicle-sightings/photo": CommunityStub.errorFixture("error-sighting-signed-out")]
        await m.submit(api: stub.api())
        #expect(m.needsSignIn && m.photo != nil && m.plate == "XVF3582" && m.notes == "On Congress" && m.outcome == .editing)
        // The server's messages, where the website shows them.
        stub.responses = ["POST /api/vehicle-sightings/photo": CommunityStub.errorFixture("error-sighting-invalid-location")]
        await m.submit(api: stub.api())
        #expect(m.locationError == "Choose the location from the suggestions list." && m.photo != nil)
        stub.responses = ["POST /api/vehicle-sightings/photo": CommunityStub.errorFixture("error-sighting-invalid-plate")]
        await m.submit(api: stub.api())
        #expect(m.error == "That doesn't look like a valid license plate.")
        stub.responses = ["POST /api/vehicle-sightings/photo": (413, #"{"success":false,"error":"file_too_large"}"#)]
        await m.submit(api: stub.api())
        #expect(m.photoError == "That photo is too large. Please choose one under 10 MB.")
        // A duplicate is reported, not shown as a new sighting.
        stub.responses = ["POST /api/vehicle-sightings/photo": (200, CommunityStub.fixture("sighting-photo-duplicate"))]
        await m.submit(api: stub.api())
        #expect(m.outcome == .duplicate && m.error == "That sighting was already submitted.")
        // Success: the website's success screen, the form cleared.
        await m.setPhoto(testJPEG(width: 400, height: 300))
        stub.requests = []
        stub.responses = ["POST /api/vehicle-sightings/photo": (201, CommunityStub.fixture("sighting-photo-created"))]
        await m.submit(api: stub.api())
        #expect(m.outcome == .submitted && m.photo == nil)
        let sent = String(decoding: stub.requests.last?.1 ?? Data(), as: UTF8.self)
        #expect(sent.contains("name=\"photo\"; filename=\"sighting.jpg\"") && sent.contains("Content-Type: image/jpeg"))
        #expect(stub.requests.last?.0.value(forHTTPHeaderField: "Authorization") == "Bearer s-test")
    }
}

@Suite(.serialized)
@MainActor
struct AccountTests {
    @Test func profileAndPrivacyUseTheFullSet() async throws {
        let stub = StubServer()
        let profile: ProfileResponse = try TestFixtures.decode("profile")
        #expect(profile.user.handle == "alice_a" && profile.user.leaderboardOptIn && profile.user.profileVisibility == "public")
        stub.responses = [
            "GET /api/profile": (200, CommunityStub.fixture("profile")),
            "GET /api/xp/me": (200, CommunityStub.fixture("xp-me")),
            "GET /api/moderation/access": CommunityStub.errorFixture("moderation-access-rider"),
            "PATCH /api/profile": (200, #"{"success":true,"user":{"display_name":"Alice A","handle":"alice_a","bio":"Austin spotter. Mostly South Congress and the Domain.","profile_visibility":"public","leaderboard_opt_in":false}}"#)
        ]
        let model = AccountModel()
        await model.load(api: stub.api())
        #expect(model.settings?.handle == "alice_a" && model.progress?.xp == 740 && !model.isModerator)
        final class Flag: @unchecked Sendable { var on = false }
        let notified = Flag()
        let token = NotificationCenter.default.addObserver(forName: .profileChanged, object: nil, queue: nil) { _ in notified.on = true }
        defer { NotificationCenter.default.removeObserver(token) }
        stub.requests = []
        await model.setOptIn(false, api: stub.api())
        let sent = bodyJSON(stub.requests.last?.1)
        #expect(sent["leaderboard_opt_in"] as? Bool == false)
        #expect(sent["display_name"] as? String == "Alice A" && sent["handle"] as? String == "alice_a" && sent["bio"] as? String == profile.user.bio, "nothing else is cleared")
        #expect(sent["profile_visibility"] as? String == "public", "sent back unchanged")
        #expect(model.settings?.leaderboardOptIn == false && model.privacyError == nil && notified.on)
    }

    @Test func privacySwitchLocksWhileSaving() async {
        let stub = StubServer()
        stub.responses = [
            "GET /api/profile": (200, CommunityStub.fixture("profile")),
            "PATCH /api/profile": (200, #"{"success":true,"user":{"display_name":"Alice A","handle":"alice_a","bio":null,"profile_visibility":"public","leaderboard_opt_in":false}}"#)
        ]
        let model = AccountModel()
        await model.load(api: stub.api())
        #expect(model.optInShown)
        model.requestOptIn(false, api: stub.api())
        #expect(model.savingPrivacy && !model.optInShown, "disabled and showing the new value at once")
        model.requestOptIn(true, api: stub.api())
        #expect(!model.optInShown, "a second flip while saving is ignored")
        while model.savingPrivacy { try? await Task.sleep(for: .milliseconds(20)) }
        #expect(!model.optInShown && model.settings?.leaderboardOptIn == false && model.privacyError == nil)
        #expect(stub.requests.filter { $0.0.httpMethod == "PATCH" }.count == 1, "one save")
    }

    @Test func profileErrorsUseTheWebsitesWords() async throws {
        let stub = StubServer()
        let model = AccountModel()
        var s = ProfileSettings(displayName: "Bob", handle: "No Spaces!", bio: nil, profileVisibility: "private", leaderboardOptIn: true)
        #expect(await model.save(s, api: stub.api()) == "Usernames must be 3-20 characters: lowercase letters, numbers, and underscores only.", "checked before sending")
        s.handle = "alice_a"
        stub.responses = ["PATCH /api/profile": CommunityStub.errorFixture("error-handle-taken")]
        #expect(await model.save(s, api: stub.api()) == "That username is already taken.")
        let updated: ProfileSaved = try TestFixtures.decode("profile-updated")
        #expect(updated.user.leaderboardOptIn == false && updated.user.handle == "dave_d")
    }

    @Test func avatarUploadSendsBothSquares() async {
        let stub = StubServer()
        stub.responses = ["POST /api/profile/avatar": (200, #"{"success":true,"avatar_url":"/api/avatars/0123456789abcdef0123456789abcdef"}"#)]
        stub.requests = []
        let model = AccountModel()
        #expect(await model.uploadAvatar(large: Data([1]), thumb: Data([2]), api: stub.api()) == nil)
        let sent = String(decoding: stub.requests.last?.1 ?? Data(), as: UTF8.self)
        #expect(sent.contains("name=\"large\"; filename=\"avatar-512\"") && sent.contains("name=\"thumb\"; filename=\"avatar-128\""))
        stub.responses = ["POST /api/profile/avatar": (400, #"{"success":false,"error":"invalid_dimensions"}"#)]
        #expect(await model.uploadAvatar(large: Data([1]), thumb: Data([2]), api: stub.api()) == "That image couldn't be used. Please try another.")
    }

    @Test func accountDeletionNeedsConfirmationAndReportsTheServer() async {
        let stub = StubServer()
        #expect(CommunityStub.errorFixture("error-account-confirm-required").0 == 400)
        #expect(CommunityStub.errorFixture("account-deleted").0 == 200)
        #expect(CommunityStub.errorFixture("account-deleted-session-ended").0 == 401, "every session of a deleted account ends")
        stub.requests = []
        stub.responses = ["DELETE /api/account": CommunityStub.errorFixture("error-account-last-moderator")]
        #expect(await AccountModel.deleteAccount(api: stub.api()) == "You are the last moderator. Transfer the role before deleting your account.")
        #expect(bodyJSON(stub.requests.last?.1)["confirm"] as? String == "DELETE")
        stub.responses = ["DELETE /api/account": (429, #"{"success":false,"error":"rate_limited"}"#)]
        #expect(await AccountModel.deleteAccount(api: stub.api()) == "Too many attempts. Please wait a minute and try again.")
        stub.responses = ["DELETE /api/account": CommunityStub.errorFixture("account-deleted")]
        #expect(await AccountModel.deleteAccount(api: stub.api()) == nil)
    }

    @Test func expiredSessionSignsOut() async throws {
        let stub = StubServer()
        stub.responses = ["GET /api/me": CommunityStub.errorFixture("account-deleted-session-ended")]
        await #expect(throws: APIError.unauthorized) { let _: MeResponse = try await stub.api().get("/api/me", authenticated: true) }
    }
}

@Suite(.serialized)
@MainActor
struct ModerationTests {
    @Test func accessComesFromTheServer() throws {
        struct Wrap: Decodable { let status: Int; let body: ModerationAccess }
        let mod = try TestFixtures.decode("moderation-access-moderator", as: Wrap.self)
        let rider = try TestFixtures.decode("moderation-access-rider", as: Wrap.self)
        #expect(mod.body.moderator == true && rider.body.moderator == false && rider.status == 200)
        #expect(CommunityStub.errorFixture("moderation-access-signed-out").0 == 401)
        #expect(CommunityStub.errorFixture("error-moderation-forbidden").0 == 403)
    }

    @Test func queueAndApprovedDecode() throws {
        let q: ModerationQueue = try TestFixtures.decode("moderation-sightings")
        // Two photo sightings with new plates (each already a private registry
        // vehicle, so not promotable) and one text-only sighting.
        try #require(q.sightings.count == 3, "three pending sightings, got \(q.sightings.count)")
        #expect(q.sightings.filter(\.hasPhoto).count == 2)
        let photo = try #require(q.sightings.first { $0.licensePlate == "ZZZ1234" })
        #expect(photo.hasPhoto)
        #expect(photo.licensePlate == "ZZZ1234" && photo.robotaxiVehicleId != nil && !photo.canPromote, "an unknown plate already became a private vehicle")
        let json = try #require(q.sightings.first { !$0.hasPhoto })
        #expect(json.model == "Cybercab" && json.color == "Gold")
        let approved: ApprovedImages = try TestFixtures.decode("moderation-approved-images")
        #expect(approved.sightings.count == 3 && approved.sightings.allSatisfy { !$0.onMap })
        #expect(approved.sightings.contains { $0.cityKey == "dallas" })
        let r: ReviewResult = try TestFixtures.decode("moderation-review-approved")
        #expect(r.status == "approved" && r.message("Sighting approved") == "Sighting approved.")
        #expect(ReviewResult(success: true, status: "approved", map: .init(onMap: true, visibleOnMap: true)).message("Sighting approved") == "Sighting approved. On the Zones map ✓")
    }

    @Test func reviewActionsAndConflicts() async throws {
        let stub = StubServer()
        stub.responses = [
            "GET /api/moderation/vehicle-sightings": (200, CommunityStub.fixture("moderation-sightings")),
            "GET /api/moderation/approved-photo-sightings": (200, CommunityStub.fixture("moderation-approved-images")),
            "GET /api/moderation/social/overview": (200, CommunityStub.fixture("moderation-social-overview")),
            "GET /api/moderation/social/reports": (200, CommunityStub.fixture("moderation-social-reports")),
            "GET /api/social/sidebar": (200, CommunityStub.fixture("social-sidebar"))
        ]
        let model = ModerationModel()
        await model.load(api: stub.api())
        // The moderation data the rest of this test acts on: two pending
        // sightings (one with a photo), one reported item, the pin limit.
        try #require(model.access == .ok, "the queue loaded")
        try #require(model.queue.count == 3, "three pending sightings, got \(model.queue.count)")
        #expect(model.reports?.count == 2 && model.overview?.maxPins == 3)
        #expect(model.withPhoto.count == 2 && model.withoutPhoto.count == 1)
        let first = model.queue[0], second = model.queue[1]
        // Reject needs a reason: nothing is sent without one.
        stub.requests = []
        await model.reject(first, reason: "  ", api: stub.api())
        #expect(stub.requests.isEmpty && model.toast?.text == "A rejection reason is required.")
        // Approve.
        stub.responses["PATCH /api/moderation/vehicle-sightings/\(first.submissionId)"] = (200, CommunityStub.fixture("moderation-review-approved"))
        await model.approve(first, api: stub.api())
        #expect(!model.queue.contains { $0.submissionId == first.submissionId } && model.toast?.text == "Sighting approved.")
        // Someone else reviewed it first: removed, not acted on again.
        stub.responses["PATCH /api/moderation/vehicle-sightings/\(second.submissionId)"] = CommunityStub.errorFixture("error-already-reviewed")
        await model.approve(second, api: stub.api())
        #expect(model.queue.count == 1 && !model.queue.contains { $0.submissionId == second.submissionId })
        #expect(model.toast?.text == "That sighting was already reviewed. Removed from the queue.")
        // Reject sends the reason.
        let rejecting = ModerationQueue.Sighting(submissionId: "s9", status: "pending", submittedAt: nil, observedAt: nil, serviceArea: nil, approxLocation: nil, licensePlate: nil, model: nil, color: nil, notes: nil, evidenceRef: nil, robotaxiVehicleId: nil, cameraId: nil, cameraName: nil)
        stub.responses["PATCH /api/moderation/vehicle-sightings/s9"] = (200, #"{"success":true,"submission_id":"s9","status":"rejected"}"#)
        await model.reject(rejecting, reason: "Blurry", api: stub.api())
        let sent = bodyJSON(stub.requests.last?.1)
        #expect(sent["action"] as? String == "reject" && sent["rejection_reason"] as? String == "Blurry")
        // Promote conflict, in the website's words.
        stub.responses["POST /api/moderation/vehicle-sightings/s9/promote"] = (409, CommunityStub.fixture("moderation-promoted"))
        await model.promote(rejecting, api: stub.api())
        #expect(model.toast?.text == "A registry vehicle with that plate already exists. Approve the sighting instead.")
    }

    @Test func revokedModeratorSeesForbidden() async {
        let stub = StubServer()
        stub.responses = ["GET /api/moderation/vehicle-sightings": CommunityStub.errorFixture("error-moderation-forbidden")]
        let model = ModerationModel()
        await model.load(api: stub.api())
        #expect(model.access == .forbidden && model.queue.isEmpty)
        stub.responses = ["GET /api/moderation/vehicle-sightings": (401, #"{"authenticated":false}"#)]
        let signedOut = ModerationModel()
        await signedOut.load(api: stub.api(token: nil))
        #expect(signedOut.access == .signedOut)
    }

    @Test func socialReportsAndResolve() async throws {
        let stub = StubServer()
        let reports: SocialReports = try TestFixtures.decode("moderation-social-reports")
        try #require(reports.reports.count == 2, "two reported items in the fixture")
        let r = try #require(reports.reports.first { $0.author?.handle == "carol_c" })
        #expect(r.reportCount == 2 && r.reasons == ["off_topic", "spam"] && r.author?.handle == "carol_c")
        #expect(r.authorHistory == SocialReports.History(removals: 0, posts24h: 0), "the repeat-offender facts (no earlier removals)")
        #expect(r.details.first?.details == "Not about a Cybercab.")
        let overview: SocialModerationOverview = try TestFixtures.decode("moderation-social-overview")
        #expect(overview.pinned.count == 1 && overview.stats.openReportItems == 2)
        stub.responses = [
            "POST /api/moderation/social/resolve": (200, CommunityStub.fixture("moderation-social-dismissed")),
            "GET /api/moderation/social/overview": (200, CommunityStub.fixture("moderation-social-overview")),
            "GET /api/moderation/social/reports": (200, #"{"success":true,"reports":[]}"#),
            "GET /api/social/sidebar": (200, CommunityStub.fixture("social-sidebar"))
        ]
        stub.requests = []
        let model = ModerationModel()
        await model.resolve(r, remove: false, note: "Fine as is.", api: stub.api())
        let sent = bodyJSON(stub.requests.first { $0.0.url?.path == "/api/moderation/social/resolve" }?.1)
        #expect(sent["action"] as? String == "dismiss" && sent["target_type"] as? String == "post" && sent["reason"] as? String == "Fine as is.")
        #expect(model.reports?.isEmpty == true && model.toast?.text == "Dismissed.")
        stub.responses["PUT /api/moderation/social/announcement"] = (400, #"{"success":false,"error":"invalid_link"}"#)
        #expect(await model.publishAnnouncement(body: "Hi", link: "not a link", notify: false, api: stub.api()) == "That link doesn't look right.")
        #expect(await model.publishAnnouncement(body: "  ", link: "", notify: false, api: stub.api()) == "Write the announcement first.")
    }
}
