import Testing
import Foundation
import CoreLocation
import SwiftUI
import AppIntents
@testable import CybercabHunter

// Siri & Apple Intelligence: what each action says, from which data, and how
// many requests it makes. Siri itself can't run in a test; these pin down
// everything the app decides before Siri speaks.

private func json(_ o: Any) -> String { String(decoding: try! JSONSerialization.data(withJSONObject: o), as: UTF8.self) }
private func decode<T: Decodable>(_ o: Any, as: T.Type = T.self) -> T { try! APIClient.makeDecoder().decode(T.self, from: try! JSONSerialization.data(withJSONObject: o)) }
private let now = ISO8601DateFormatter().date(from: "2026-10-23T20:00:00Z")!

nonisolated(unsafe) private let dmvEvent: [String: Any] = ["date": "2026-10-22", "processed_at": "2026-10-23T03:00:00Z", "previous_date": "2026-10-21", "status": "ok", "added": 55, "returned": 0, "missing": 0, "net": 55, "total": 858, "added_by_model": ["cybercab": 2, "model_y": 53, "other_tesla": 0, "unknown": 0]]
private func overview(update: [String: Any]? = dmvEvent, pending: Int = 0, status: String = "current") -> [String: Any] {
    var o: [String: Any] = [
        "source": ["name": "TxDMV", "company": "Tesla Robotaxi, LLC", "authorization": "AV1", "law": "SB 2807", "url": "https://txmccs.txdmv.gov", "fields": ["VIN"], "schedule": "Daily", "decoder": ["name": "NHTSA vPIC", "url": "https://vpic.nhtsa.dot.gov"]],
        "latest": ["date": "2026-10-23", "polled_at": "2026-10-23T11:30:00Z"],
        "totals": ["cybercab": 351, "model_y": 507, "other_tesla": 0, "unknown": 0, "total": 858],
        "freshness": ["status": status, "last_success": "2026-10-23T11:30:00Z"],
        "tracking_since": "2026-10-09", "processing_pending": pending]
    if let update { o["latest_update"] = update; o["recent_updates"] = [update] } else { o["latest_update"] = NSNull() }
    return o
}
nonisolated(unsafe) private let registry: [String: Any] = ["public_vehicles": 193, "recorded_rides": 8, "sightings_all_time": 535]
nonisolated(unsafe) private let daily: [String: Any] = ["today": "2026-10-23", "generated_at": "2026-10-23T19:00:00Z", "day": ["date": "2026-10-23", "registry": 3, "dmv": 0, "sightings": 2, "cameras": 1], "previous": ["date": "2026-10-22", "registry": 2, "dmv": 55, "sightings": 20, "cameras": 18]]
private func city(_ key: String, sq: Double, vehicles: Int = 193, added7d: Int = 15, s24: Int = 8, c24: Int = 8, since: String = "2025-06-22") -> [String: Any] {
    ["city": key, "name": key.capitalized, "area": ["square_miles": sq, "in_service_since": since, "vehicles": vehicles, "vehicles_added_7d": added7d],
     "sightings": ["total": 257, "last_24h": s24], "cameras": ["detections_24h": c24, "monitored": 70]]
}

/// Both Siri suites share SiriData's cache and its test stub, so they never run at the same time.
@Suite(.serialized) enum SiriSerial {}

extension SiriSerial {
@MainActor
@Suite(.serialized)
struct SiriTests {
    // MARK: plates and VINs

    @Test func plateAndVinNormalization() {
        #expect(VehicleSearchText.normalized(" xvf-1524 ") == "XVF1524")
        #expect(VehicleSearchText.normalized("5yjaj eeu3t a002449") == "5YJAJEEU3TA002449")
        #expect(VehicleSearchText.isVIN("5YJAJEEU3TA002449") && !VehicleSearchText.isVIN("XVF1524") && !VehicleSearchText.isVIN("5YJAJEEU3TA00244O"), "17 characters, never I/O/Q")
        #expect(VehicleSearchText.normalized(String(repeating: "A", count: 40)).count == 17)
    }

    // MARK: fleet

    @Test func fleetKeepsRegistryAndDMVApartAndNeverClaimsLiveCounts() {
        let a = SiriSpeech.fleet(stats: decode(registry), daily: decode(daily), dmv: decode(overview()), now: now)
        #expect(a.spoken.contains("public registry has 193 vehicles documented by riders and spotters"))
        #expect(a.spoken.contains("Texas DMV roster lists 858 Tesla robotaxi VINs, 351 of them Cybercabs, as of October 23"))
        #expect(a.spoken.contains("Today so far: 3 new registry vehicles, 2 approved sightings, and 1 camera detection."))
        #expect(!a.spoken.lowercased().contains("active") && !a.spoken.lowercased().contains("in service"), "never a live or active count")
        #expect(a.figures.map(\.label) == ["Registry", "DMV VINs", "DMV Cybercabs"])
        let noDMV = SiriSpeech.fleet(stats: decode(registry), daily: nil, dmv: nil, now: now)
        #expect(noDMV.spoken == "Cybercab Hunter's public registry has 193 vehicles documented by riders and spotters.", "only what was loaded")
    }

    @Test func cityFleetUsesThatCitysFigures() {
        let a = SiriSpeech.cityFleet(decode(city("dallas", sq: 81, vehicles: 12, added7d: 0, s24: 1, c24: 0)))
        #expect(a.spoken == "In Dallas, Cybercab Hunter's public registry has 12 vehicles. In the last 24 hours: 1 approved sighting and 0 traffic-camera detections.")
    }

    // MARK: Texas DMV

    @Test func dmvSpeaksOfFirstDetectionNeverRegistration() {
        let a = SiriSpeech.dmv(decode(overview()), now: now)
        #expect(a.spoken.contains("lists 858 VINs as of the October 23 dataset: 351 Cybercab and 507 Model Y"))
        #expect(a.spoken.contains("Cybercab Hunter first detected 55 additional VINs in the October 22 dataset: 2 Cybercab · 53 Model Y."))
        #expect(!a.spoken.lowercased().contains("registered on") && !a.spoken.lowercased().contains("began operating"))
        var missing = dmvEvent; missing["missing"] = 3
        #expect(SiriSpeech.dmv(decode(overview(update: missing)), now: now).spoken.contains("3 VINs were missing from that snapshot, which doesn't mean deregistered."))
    }

    @Test func dmvWhileProcessingSaysSoInsteadOfZero() {
        let a = SiriSpeech.dmv(decode(overview(update: nil, pending: 9)), now: now)
        #expect(a.spoken.contains("still processing") && !a.spoken.contains("0 additional"))
        let stale = SiriSpeech.dmv(decode(overview(status: "import_failed")), now: now)
        #expect(stale.spoken.hasSuffix("Data status: import failed."))
    }

    // MARK: briefing and quick status

    @Test func briefingOnlyIncludesWhatTheDataSupports() {
        let b = SiriSpeech.briefing(daily: decode(daily), dmv: decode(overview()), city: nil, now: now)
        #expect(b.spoken == "Here's your Cybercab Hunter briefing. Today so far: 3 new registry vehicles, 2 approved sightings, and 1 camera detection. The latest Texas DMV snapshot, October 23, lists 858 VINs: 351 Cybercab and 507 Model Y; Cybercab Hunter first detected 55 additional VINs in the October 22 dataset.")
        #expect(b.footnote?.contains("not today") == false, "today's report: not stale")
        let austin = SiriSpeech.briefing(daily: decode(daily), dmv: decode(overview()), city: decode(city("austin", sq: 272)), now: now)
        #expect(austin.spoken.contains("In Austin, Cybercab Hunter's public registry has 193 vehicles, 15 added this week.") && austin.spoken.contains("In Austin, in the last 24 hours: 8 approved sightings and 8 traffic-camera detections."))
        let empty = SiriSpeech.briefing(daily: nil, dmv: nil, city: nil, now: now)
        #expect(empty.spoken == "Cybercab Hunter has no new activity to report right now.", "nothing invented")
    }

    /// "Give me a rundown of the Cybercab Hunter data": fleet totals, today's
    /// sightings and camera detections, the latest DMV snapshot — each source named.
    @Test func rundownCoversEveryDataSourceWithActualNumbers() {
        let r = SiriSpeech.briefing(stats: decode(registry), daily: decode(daily), dmv: decode(overview()), city: nil, now: now)
        #expect(r.spoken == "Here's your Cybercab Hunter briefing. Cybercab Hunter's public registry has 193 vehicles documented by riders and spotters. Today so far: 3 new registry vehicles, 2 approved sightings, and 1 camera detection. The latest Texas DMV snapshot, October 23, lists 858 VINs: 351 Cybercab and 507 Model Y; Cybercab Hunter first detected 55 additional VINs in the October 22 dataset.")
        #expect(r.figures.map(\.label) == ["Registry", "Sightings today", "DMV VINs"])
        let processing = SiriSpeech.briefing(stats: decode(registry), daily: nil, dmv: decode(overview(update: nil, pending: 9)), city: nil, now: now)
        #expect(processing.spoken.hasSuffix("recent changes are still being processed.") && !processing.spoken.contains("0 additional"), "processing: said so, no misleading zero")
    }

    @Test func quickStatusIsTwoSentencesAndStaleDataIsFlagged() {
        let q = SiriSpeech.briefing(daily: decode(daily), dmv: decode(overview()), city: decode(city("austin", sq: 272)), quick: true, now: now)
        #expect(!q.spoken.hasPrefix("Here's") && q.spoken.components(separatedBy: ". ").count <= 2)
        var old = daily; old["today"] = "2026-10-21"
        #expect(SiriSpeech.briefing(daily: decode(old), dmv: nil, city: nil, now: now).footnote == "Figures are from October 21, not today.")
        var oldUpdate = dmvEvent; oldUpdate["date"] = "2026-10-01"
        let old2 = SiriSpeech.briefing(daily: nil, dmv: decode(overview(update: oldUpdate)), city: nil, now: now).spoken
        #expect(old2.contains("lists 858 VINs") && !old2.contains("first detected"), "the snapshot yes; a change over a week old isn't today's news")
    }

    // MARK: near me

    @Test func nearbyUsesTimeAndDistanceAndNeverSaysItIsStillThere() {
        let cams: [CameraDetection] = decode([
            ["camera_id": "1", "camera_name": "6TH ST / LAMAR BLVD", "lat": 30.271538, "lng": -97.753967, "observed_at": "2026-10-23T19:35:00Z"],
            ["camera_id": "2", "camera_name": "FAR AWAY", "lat": 30.45, "lng": -97.6, "observed_at": "2026-10-23T19:50:00Z"],
            ["camera_id": "3", "camera_name": "CONGRESS AVE / RIVERSIDE DR", "lat": 30.257143, "lng": -97.746872, "observed_at": "2026-10-21T12:00:00Z"]
        ])
        let me = CLLocation(latitude: 30.2672, longitude: -97.7431)
        let hits = SiriSpeech.nearby(cams, from: me, radiusMiles: 3, window: 24 * 3600, now: now)
        #expect(hits.map(\.camera) == ["6th St / Lamar Blvd"], "within 3 miles and 24 hours only")
        let precise = SiriSpeech.nearbyAnswer(hits: hits, radiusMiles: 3, precise: true, cityName: "Austin", latestInCity: nil, now: now)
        #expect(precise.spoken == "A Cybercab was detected by a traffic camera at 6th St / Lamar Blvd, about 0.7 miles from you, 25 minutes ago.")
        let approx = SiriSpeech.nearbyAnswer(hits: hits, radiusMiles: 6, precise: false, cityName: "Austin", latestInCity: nil, now: now)
        #expect(approx.spoken.contains("in your area") && !approx.spoken.contains("miles from you"), "approximate location: no exact distance")
        for a in [precise, approx] { #expect(!a.spoken.lowercased().contains("next to you") && !a.spoken.lowercased().contains("is near you")) }
        let none = SiriSpeech.nearbyAnswer(hits: [], radiusMiles: 3, precise: true, cityName: "Austin", latestInCity: .init(camera: "Far Away", miles: 0, at: now.addingTimeInterval(-600)), now: now)
        #expect(none.spoken == "No Cybercab camera detections within about 3 miles of you in the last 24 hours. The latest in Austin was at Far Away, 10 minutes ago.")
    }

    @Test func nearbyFindsTheServiceAreaOrNone() {
        #expect(NearbySightingsIntent.nearestCity(to: CLLocation(latitude: 30.27, longitude: -97.74)) == .austin)
        #expect(NearbySightingsIntent.nearestCity(to: CLLocation(latitude: 32.78, longitude: -96.80)) == .dallas)
        #expect(NearbySightingsIntent.nearestCity(to: CLLocation(latitude: 29.76, longitude: -95.37)) == nil, "Houston: outside both")
        #expect(String(localized: IntentFailure.locationDenied.localizedStringResource).contains("Austin or Dallas"), "denied: a city alternative")
    }

    // MARK: fleet growth

    private func growth(processed: Bool = true) -> DMVGrowth {
        decode(["range": "all", "enough_history": true, "points": [
            ["date": "2026-10-09", "total": 739, "cybercab": 319, "model_y": 420, "baseline": true, "added": NSNull()],
            ["date": "2026-10-15", "total": 769, "cybercab": 349, "model_y": 420, "baseline": false, "added": ["cybercab": 30, "model_y": 0, "other_tesla": 0, "unknown": 0]],
            ["date": "2026-10-17", "total": 803, "cybercab": 349, "model_y": 454, "baseline": false, "added": ["cybercab": 0, "model_y": 34, "other_tesla": 0, "unknown": 0]],
            ["date": "2026-10-22", "total": 858, "cybercab": 351, "model_y": 507, "baseline": false, "added": ["cybercab": 2, "model_y": 53, "other_tesla": 0, "unknown": 0]],
            ["date": "2026-10-23", "total": 858, "cybercab": 351, "model_y": 507, "baseline": false, "added": NSNull()]
        ]])
    }

    @Test func growthComparesActualSnapshotsOnly() {
        let (s, e) = FleetGrowthIntent.window(period: .week, from: nil, to: nil, latest: "2026-10-23")
        #expect(s == "2026-10-16" && e == "2026-10-23")
        let g = SiriSpeech.growth(growth(), start: s, end: e, processed: true)!
        #expect(g.from == "2026-10-17" && g.to == "2026-10-23" && g.startTotal == 803 && g.endTotal == 858 && g.net == 55 && g.newlyDetected == 55)
        let a = SiriSpeech.growthAnswer(g, now: now)
        #expect(a.spoken.hasPrefix("Between the October 17 and October 23 Texas DMV snapshots, the roster went from 803 to 858 VINs, up 55, or 6.8 percent."))
        #expect(a.spoken.contains("Cybercab Hunter first detected 55 additional VINs in that period."))
    }

    @Test func growthNeverInventsHistory() {
        let early = SiriSpeech.growth(growth(), start: "2026-09-01", end: "2026-10-23", processed: true)!
        #expect(early.from == "2026-10-09" && early.clampedStart, "before tracking: the first actual snapshot, said so")
        #expect(SiriSpeech.growthAnswer(early, now: now).spoken.contains("Tracking began October 9"))
        let pending = SiriSpeech.growth(growth(), start: "2026-10-15", end: "2026-10-22", processed: false)!
        #expect(pending.newlyDetected == nil && SiriSpeech.growthAnswer(pending, now: now).spoken.contains("still being processed"))
        #expect(SiriSpeech.growth(growth(), start: "2026-10-23", end: "2026-10-23", processed: true) == nil, "one snapshot: nothing to compare")
        #expect(SiriSpeech.growthAnswer(nil).spoken.contains("doesn't have two Texas DMV snapshots"))
        let custom = FleetGrowthIntent.window(period: .month, from: SiriSpeech.calendarDate("2026-10-10"), to: SiriSpeech.calendarDate("2026-10-20"), latest: "2026-10-23")
        #expect(custom.0 == "2026-10-10" && custom.1 == "2026-10-20", "custom dates win over the period")
    }

    // MARK: one vehicle

    @Test func vehicleHistoryDistinguishesSourcesAndAdmitsGaps() throws {
        let d: VehicleDetail = try APIClient.makeDecoder().decode(VehicleDetail.self, from: Data(CommunityStub.fixture("vehicle").utf8))
        let none = SiriSpeech.vehicleHistory(d, sightings: [], dmvFirst: nil, now: now)
        #expect(none.spoken.contains("Cybercab Hunter doesn't have a public sighting history for it yet."))
        let s: [VehicleSightings.Entry] = decode([["date": "2026-10-11", "service_area": "Austin"], ["date": "2026-10-02", "service_area": "Austin"]])
        let with = SiriSpeech.vehicleHistory(d, sightings: s, dmvFirst: (date: "2026-10-09", baseline: true), now: now)
        #expect(with.spoken.contains("2 approved sighting day and area entries, the latest on October 11 in Austin."))
        #expect(with.spoken.contains("already on the Texas DMV roster when tracking began on October 9"))
        #expect(with.footnote?.contains("not continuous operation") == true)
    }

    // MARK: service zones

    @Test func zonesReadTheirFiguresAndNameTheirSource() {
        let austin = SiriSpeech.zone(decode(city("austin", sq: 272)), now: now)
        #expect(austin.spoken == "The Austin service area covers about 272 square miles. That's Cybercab Hunter's mapped boundary, traced from Tesla's in-app map, not an official Tesla figure. Service there began June 22, 2025.")
        let other = SiriSpeech.zone(decode(city("austin", sq: 300)), now: now)
        #expect(other.spoken.contains("about 300 square miles"), "read from the data, not hard-coded")
        let both = SiriSpeech.compareZones(decode(city("austin", sq: 272)), decode(city("dallas", sq: 81, since: "2026-04-18")))
        #expect(both.spoken.hasPrefix("Austin covers about 272 square miles and Dallas about 81, so Austin's area is about 3.4 times larger.") && both.spoken.contains("Dallas's is Cybercab Hunter's currently listed coverage figure") && !both.spoken.contains("Tesla's own figure"))
    }

    // MARK: the data layer: cached, bounded, never signed in

    @Test func siriDataReusesResponsesAndForgetsFailures() async throws {
        let s = StubServer()
        s.responses = ["GET /api/dmv/overview": (200, json(overview())), "GET /api/registry/stats": (200, json(registry)), "GET /api/daily": (200, json(daily))]
        SiriData.testAPI = s.api(token: nil)
        defer { SiriData.testAPI = nil }
        await SiriData.shared.reset()
        _ = try await FleetStatsIntent.answer(city: nil)
        let afterFleet = s.requests.count
        #expect(afterFleet == 3, "registry, Daily, DMV: one request each")
        _ = try await DailyBriefingIntent.compose(city: nil, quick: false)
        #expect(s.requests.count == afterFleet, "the briefing reuses the fleet answer's responses")
        #expect(s.requests.allSatisfy { $0.0.value(forHTTPHeaderField: "Authorization") == nil }, "never sends a session")
        s.responses["GET /api/homepage-stats"] = (503, "{}")
        await #expect(throws: (any Error).self) { _ = try await FleetStatsIntent.answer(city: .dallas) }
        s.responses["GET /api/homepage-stats"] = (200, json(city("dallas", sq: 81)))
        let dallas = try await FleetStatsIntent.answer(city: .dallas)
        #expect(dallas.spoken.hasPrefix("In Dallas"), "a failure isn't cached: the next ask fetches again")
        await SiriData.shared.reset()
    }

    @Test func offlineIsAShortSpokenError() async {
        let s = StubServer()
        s.responses = ["GET /api/dmv/overview": (500, "{}")]
        SiriData.testAPI = s.api(token: nil)
        defer { SiriData.testAPI = nil }
        await SiriData.shared.reset()
        await #expect(throws: IntentFailure.self) { _ = try await CheckDMVIntent().perform() }
        #expect(String(localized: IntentFailure.unavailable.localizedStringResource) == "Cybercab Hunter couldn't be reached. Check your connection and try again.")
        await SiriData.shared.reset()
    }

    // MARK: navigation

    @Test func openScreenUsesTheAppsOwnRouting() async throws {
        let r = AppRouter.shared
        _ = try await OpenScreenIntent(.dmvTracker).perform()
        #expect(r.selectedTab == .home && r.homePath.count == 1, "the DMV tracker is pushed on Home")
        _ = try await OpenScreenIntent(.map).perform()
        #expect(r.selectedTab == .zones)
        _ = try await OpenScreenIntent(.alertSettings).perform()
        #expect(r.accountRequest == .alerts)
        r.accountRequest = nil
        var sightings = OpenSightingsIntent(); sightings.city = .dallas
        _ = try await sightings.perform()
        #expect(r.selectedTab == .sightings && r.sightingsCity == "dallas")
        r.sightingsCity = nil
        _ = try await OpenScreenIntent(.home).perform()
        #expect(r.selectedTab == .home && r.homePath.isEmpty)
        #expect(OpenScreenIntent.openAppWhenRun && !CheckDMVIntent.openAppWhenRun && !DailyBriefingIntent.openAppWhenRun && !NearbySightingsIntent.openAppWhenRun, "answers stay in Siri; only Open… opens the app")
    }

    @Test func tenAppShortcutsAtMost() {
        #expect(CybercabShortcuts.appShortcuts.count == 10, "Apple's limit per app")
    }

    // MARK: Activity Alerts

    @Test func alertsAreOffByDefaultAndPersist() {
        let d = UserDefaults(suiteName: "alerts-\(UUID().uuidString)")!
        let fresh = ActivityAlertSettings.load(d)
        #expect(!fresh.enabled && fresh.categories.isEmpty, "OFF until the rider turns them on")
        var s = fresh; s.enabled = true; s.city = .dallas; s.categories = [.dmvVINs]; s.save(d)
        #expect(ActivityAlertSettings.load(d) == s)
        #expect(!ActivityAlertDelivery.isAvailable, "no delivery is claimed")
    }

    @Test func alertPolicyFiltersAndNeverRepeats() {
        var s = ActivityAlertSettings(); s.categories = [.verifiedSightings, .dmvVINs]; s.city = .austin; s.quietHours = false
        let sighting = AlertEvent(key: "s1", category: .verifiedSightings, city: "Austin", at: now.addingTimeInterval(-600), magnitude: 1)
        #expect(!ActivityAlertPolicy.shouldNotify(sighting, settings: s, delivered: [], now: now), "disabled: nothing, ever")
        s.enabled = true
        #expect(ActivityAlertPolicy.shouldNotify(sighting, settings: s, delivered: [], now: now))
        #expect(!ActivityAlertPolicy.shouldNotify(sighting, settings: s, delivered: ["s1"], now: now), "no duplicates")
        #expect(!ActivityAlertPolicy.shouldNotify(AlertEvent(key: "s2", category: .verifiedSightings, city: "Dallas", at: now, magnitude: 1), settings: s, delivered: [], now: now), "another city")
        #expect(!ActivityAlertPolicy.shouldNotify(AlertEvent(key: "s3", category: .verifiedSightings, city: "Austin", at: now.addingTimeInterval(-5 * 3600), magnitude: 1), settings: s, delivered: [], now: now), "stale sighting")
        #expect(!ActivityAlertPolicy.shouldNotify(AlertEvent(key: "c1", category: .cameraDetections, city: "Austin", at: now, magnitude: 1), settings: s, delivered: [], now: now), "a category not chosen")
        let dmv = AlertEvent(key: "d1", category: .dmvVINs, city: nil, at: now.addingTimeInterval(-3600), magnitude: 5)
        #expect(ActivityAlertPolicy.shouldNotify(dmv, settings: s, delivered: [], now: now), "statewide DMV news reaches any city")
        s.significantOnly = true
        #expect(!ActivityAlertPolicy.shouldNotify(dmv, settings: s, delivered: [], now: now) && !ActivityAlertPolicy.shouldNotify(sighting, settings: s, delivered: [], now: now))
        s.significantOnly = false; s.quietHours = true; s.quietStart = 22; s.quietEnd = 7
        let night = ISO8601DateFormatter().date(from: "2026-10-24T05:00:00Z")!   // midnight Central
        #expect(!ActivityAlertPolicy.shouldNotify(AlertEvent(key: "d2", category: .dmvVINs, city: nil, at: night, magnitude: 5), settings: s, delivered: [], now: night), "quiet hours")
        #expect(!ActivityAlertPolicy.lockScreenTitle(sighting).contains("XVF"), "no plate or person on the lock screen")
    }
}
}
