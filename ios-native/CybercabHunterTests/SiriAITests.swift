import Testing
import Foundation
import AppIntents
@testable import CybercabHunter

// Siri AI: the entities Apple Intelligence and Spotlight see (what they say,
// what's indexed, how they resolve), the in-app search schema, donations and
// the counts-first sightings answer. Siri itself can't run here.

private func json(_ o: Any) -> String { String(decoding: try! JSONSerialization.data(withJSONObject: o), as: UTF8.self) }
private func decode<T: Decodable>(_ o: Any, as: T.Type = T.self) -> T { try! APIClient.makeDecoder().decode(T.self, from: try! JSONSerialization.data(withJSONObject: o)) }
private let now = ISO8601DateFormatter().date(from: "2026-10-23T20:00:00Z")!

nonisolated(unsafe) private let growthAll: [String: Any] = ["range": "all", "enough_history": true, "points": [
    ["date": "2026-10-09", "total": 739, "cybercab": 319, "model_y": 420, "baseline": true, "added": NSNull()],
    ["date": "2026-10-10", "total": 739, "cybercab": 319, "model_y": 420, "baseline": false, "added": NSNull()],
    ["date": "2026-10-15", "total": 769, "cybercab": 349, "model_y": 420, "baseline": false, "added": ["cybercab": 30, "model_y": 0, "other_tesla": 0, "unknown": 0]],
    ["date": "2026-10-17", "total": 803, "cybercab": 349, "model_y": 454, "baseline": false, "added": ["cybercab": 0, "model_y": 34, "other_tesla": 0, "unknown": 0]],
    ["date": "2026-10-22", "total": 858, "cybercab": 351, "model_y": 507, "baseline": false, "added": ["cybercab": 2, "model_y": 53, "other_tesla": 0, "unknown": 0]],
    ["date": "2026-10-23", "total": 858, "cybercab": 351, "model_y": 507, "baseline": false, "added": NSNull()]
]]
private func city(_ key: String, sq: Double) -> [String: Any] {
    ["city": key, "name": key.capitalized, "generated_at": "2026-10-23T19:00:00Z",
     "area": ["square_miles": sq, "in_service_since": "2025-06-22", "vehicles": 193, "vehicles_added_7d": 15],
     "sightings": ["total": 257, "last_24h": 8], "cameras": ["detections_24h": 6, "monitored": 70]]
}
private func sighting(_ id: String, city: String = "Austin", plate: String? = "XVF1524", at: String = "2026-10-23T18:00:00Z") -> [String: Any] {
    ["id": id, "image_url": "/api/sightings/\(id)/photo", "city": city, "location": "Congress Ave", "plate": plate ?? NSNull(), "cybercab": plate != nil, "spotted_at": at, "time_zone": "America/Chicago"]
}

extension SiriSerial {
@MainActor
@Suite(.serialized)
struct SiriAITests {
    // MARK: what Apple Intelligence reads

    @Test func entitySummariesAreFactualAndKeepSourcesApart() {
        let s = SightingEntity(decode(sighting("a1b2")), now: now)
        #expect(s.summary == "Approved Cybercab sighting (moderator-reviewed photo) in Austin, near Congress Ave, October 23, plate XVF1524. A sighting is one moment, not where the car is now.")
        let z = ServiceZoneEntity(decode(city("austin", sq: 272)))
        #expect(z.summary == "Austin Cybercab service zone: about 272 square miles (Cybercab Hunter's mapped boundary, traced from Tesla's in-app map, not an official Tesla figure). In service since June 22, 2025. 193 public registry vehicles. In the last 24 hours: 8 approved sightings and 6 traffic-camera detections.")
        #expect(z.squareMiles == 272 && z.approvedSightings24h == 8 && z.cameraDetections24h == 6, "numbers from the data, not hard-coded")
        let f = FleetSummaryEntity(registry: 193, rides: 8, sightingsAllTime: 535, today: decode(["date": "2026-10-23", "registry": 3, "sightings": 2, "cameras": 1]), dmvTotal: 858, dmvCybercab: 351)
        #expect(f.summary.contains("public registry: 193 vehicles") && f.summary.contains("Texas DMV roster: 858 Tesla robotaxi VINs, 351 Cybercabs") && f.summary.hasSuffix("Neither figure is the number of cars in service right now."))
        #expect(f.id == "fleet" && f.approvedSightingsToday == 2 && f.cameraDetectionsToday == 1)
    }

    @Test func dmvSnapshotsComeFromActualSnapshotsOnly() {
        let g: DMVGrowth = decode(growthAll)
        let all = DMVSnapshotEntity.all(g, processed: true)
        #expect(all.map(\.id) == ["2026-10-09", "2026-10-10", "2026-10-15", "2026-10-17", "2026-10-22", "2026-10-23"], "no invented days")
        let oct22 = all.first { $0.id == "2026-10-22" }!
        #expect(oct22.totalVINs == 858 && oct22.cybercabVINs == 351 && oct22.newlyDetected == 55 && oct22.newlyDetectedCybercabs == 2)
        #expect(oct22.summary == "Texas DMV dataset of October 22: 858 Tesla Robotaxi VINs, 351 Cybercab and 507 Model Y. Cybercab Hunter first detected 55 VINs in it, 2 of them Cybercabs. TxDMV publishes no registration dates.")
        #expect(all.first!.newlyDetected == nil, "the baseline: nothing counted as new")
        let pending = DMVSnapshotEntity.all(g, processed: false).first { $0.id == "2026-10-22" }!
        #expect(pending.newlyDetected == nil && !pending.summary.contains("first detected"), "unprocessed: no newly detected count")
    }

    // MARK: what's indexed (bounded)

    @Test func indexingIsBoundedAndRecentFirst() {
        let list = SiriIndex.indexableDMV(decode(growthAll), processed: true)
        #expect(list.map(\.id) == ["2026-10-23", "2026-10-22", "2026-10-17", "2026-10-15"], "the latest, then the ones that changed")
        #expect(list.count <= 6 && SiriIndex.sightingsPerCity == 12)
    }

    // MARK: resolving entities (Siri, Spotlight taps, Shortcuts)

    @Test func entitiesResolveThroughTheCachedPublicAPI() async throws {
        let s = StubServer()
        s.responses = [
            "GET /api/homepage-stats": (200, json(city("austin", sq: 272))),
            "GET /api/dmv/growth": (200, json(growthAll)),
            "GET /api/dmv/overview": (500, "{}"),
            "GET /api/sightings": (200, json(["seen": 2, "order": "desc", "sightings": [sighting("a1"), sighting("b2", city: "Dallas", plate: nil)]])),
            "GET /api/registry/stats": (200, json(["public_vehicles": 193, "recorded_rides": 8, "sightings_all_time": 535])),
            "GET /api/daily": (200, json(["today": "2026-10-23", "day": ["date": "2026-10-23", "registry": 3, "sightings": 2, "cameras": 1]]))
        ]
        SiriData.testAPI = s.api(token: nil)
        defer { SiriData.testAPI = nil }
        await SiriData.shared.reset()
        let zones = try await ServiceZoneQuery().entities(for: ["austin", "houston"])
        #expect(zones.map(\.id) == ["austin"], "only real service areas")
        let snaps = try await DMVSnapshotQuery().entities(for: ["2026-10-22", "2026-09-01"])
        #expect(snaps.map(\.id) == ["2026-10-22"] && snaps[0].newlyDetected == nil, "unknown processing state: no newly detected count claimed")
        let sights = try await SightingQuery().entities(for: ["b2", "gone"])
        #expect(sights.map(\.id) == ["b2"] && sights[0].plate == nil)
        let fleet = try await FleetSummaryQuery().uniqueEntity()
        #expect(fleet.registryVehicles == 193 && fleet.dmvVINs == nil, "DMV down: left out, not zero")
        #expect(s.requests.allSatisfy { $0.0.value(forHTTPHeaderField: "Authorization") == nil })
        await SiriData.shared.reset()
    }

    // MARK: the in-app search schema and donations

    @Test func searchSchemaFillsTheCarsSearch() async throws {
        guard #available(iOS 27.0, *) else { return }
        var intent = SearchCybercabsIntent()
        intent.criteria = StringSearchCriteria(term: "XVF1524")
        _ = try await intent.perform()
        let r = AppRouter.shared
        #expect(r.selectedTab == .registry && r.registryQuery == "XVF1524")
        r.registryQuery = nil
    }

    @Test func donationsHappenOncePerActionPerLaunch() {
        SiriDonations.donate("test-dmv", CheckDMVIntent())
        SiriDonations.donate("test-dmv", CheckDMVIntent())
        #expect(SiriDonations.done.contains("test-dmv"))
        #expect(SiriDonations.done.filter { $0 == "test-dmv" }.count == 1)
    }

    // MARK: answers

    @Test func sightingsAnswerLeadsWithTheCount() {
        let latest: [PublicSighting] = decode([sighting("a1", at: "2026-10-23T18:00:00Z")])
        let a = SiriSpeech.sightings(city: decode(city("austin", sq: 272)), latest: latest, cityName: "Austin", now: now)
        #expect(a.spoken.hasPrefix("In Austin, Cybercab Hunter recorded 8 approved sightings and 6 traffic-camera detections in the last 24 hours."))
        #expect(a.spoken.contains("The latest approved sighting in Austin was 2 hours ago, near Congress Ave, plate X V F 1 5 2 4."))
        #expect(a.footnote?.contains("reports still in review aren't public") == true, "user-submitted reports kept apart")
    }

    @Test func stillTenAppShortcuts() {
        #expect(CybercabShortcuts.appShortcuts.count == 10)
    }
}
}
