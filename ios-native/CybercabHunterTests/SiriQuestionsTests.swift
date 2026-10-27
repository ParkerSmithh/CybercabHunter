import Testing
import Foundation
import AppIntents
@testable import CybercabHunter

private let questionNow = ISO8601DateFormatter().date(from: "2026-10-23T20:00:00Z")!
private func questionStats(_ city: String = "austin", generated: String = "2026-10-23T19:00:00Z", missingDate: Bool = false, sparseCameraHistory: Bool = true) throws -> HomepageStats {
    var days: [[String: Any]] = (19...23).map { ["date": "2026-10-\($0)", "count": $0 - 18] }
    if missingDate { days.removeFirst() }
    var cameras: [String: Any] = ["detections_24h": 9, "daily": sparseCameraHistory ? [["date": "2026-10-22", "count": 7]] : []]
    cameras["monitored"] = 70
    let o: [String: Any] = ["city": city, "name": city.capitalized, "generated_at": generated,
        "area": ["vehicles": city == "austin" ? 19 : 3, "square_miles": 100],
        "rides": ["rides": 8],
        "sightings": ["total": city == "austin" ? 55 : 12, "last_24h": 11, "last_7_days": 20, "daily": days], "cameras": cameras]
    return try APIClient.makeDecoder().decode(HomepageStats.self, from: JSONSerialization.data(withJSONObject: o))
}

extension SiriSerial {
@MainActor
@Suite(.serialized)
struct SiriQuestionsTests {
    @Test func cityAndTimeAreCapturedByOneFiniteParameter() {
        #expect(CitySightingsQuestion.allCases.count == 12)
        for q in CitySightingsQuestion.allCases {
            #expect(q.city == (q.rawValue.hasPrefix("austin") ? .austin : .dallas))
        }
        #expect(CitySightingsQuestion.austin.period == .allTime)
        #expect(CitySightingsQuestion.dallasYesterday.period == .yesterday)
        #expect(CityActivityQuestion.compareSightingsThisWeek.metric == .sightings)
        #expect(CityActivityQuestion.compareSightingsThisWeek.period == .thisWeek)
        #expect(CityActivityQuestion.dallasCamerasToday.city == .dallas)
        #expect(CybercabShortcuts.appShortcuts.count == 10)
    }

    @Test func calendarDaysAndMondayWeekDifferFromRollingWindows() throws {
        let s = try questionStats()
        #expect(CityActivitySpeech.count(s, metric: .sightings, period: .today, now: questionNow) == 5)
        #expect(CityActivitySpeech.count(s, metric: .sightings, period: .yesterday, now: questionNow) == 4)
        #expect(CityActivitySpeech.count(s, metric: .sightings, period: .thisWeek, now: questionNow) == 15)
        #expect(CityActivitySpeech.count(s, metric: .sightings, period: .last24Hours, now: questionNow) == 11)
        #expect(CityActivitySpeech.count(s, metric: .sightings, period: .last7Days, now: questionNow) == 20)
        let answer = CityActivitySpeech.answer(s, metric: .sightings, period: .allTime, now: questionNow)
        #expect(answer.spoken.contains("55 approved public sightings") && answer.spoken.contains("city lifetime total isn't available"))
    }

    @Test func missingStaleAndZeroRemainDistinct() throws {
        let missing = try questionStats(missingDate: true)
        #expect(CityActivitySpeech.count(missing, metric: .sightings, period: .thisWeek, now: questionNow) == nil)
        let old = try questionStats(generated: "2026-10-22T23:00:00Z")
        #expect(CityActivitySpeech.count(old, metric: .sightings, period: .today, now: questionNow) == nil)
        #expect(CityActivitySpeech.answer(old, metric: .sightings, period: .today, now: questionNow).spoken.contains("can't provide"))
        let zero = try questionStats(sparseCameraHistory: false)
        #expect(CityActivitySpeech.count(zero, metric: .cameras, period: .today, now: questionNow) == 0)
        #expect(CityActivitySpeech.count(zero, metric: .cameras, period: .allTime, now: questionNow) == 0)
        let noHistory: HomepageStats = try APIClient.makeDecoder().decode(HomepageStats.self, from: Data("{\"city\":\"austin\",\"name\":\"Austin\"}".utf8))
        #expect(CityActivitySpeech.count(noHistory, metric: .cameras, period: .allTime, now: questionNow) == nil)
    }

    @Test func camerasCountObservationsNotLatestPerCameraOrVehicles() throws {
        let s = try questionStats()
        #expect(CityActivitySpeech.count(s, metric: .cameras, period: .today, now: questionNow) == 0)
        #expect(CityActivitySpeech.count(s, metric: .cameras, period: .yesterday, now: questionNow) == 7)
        #expect(CityActivitySpeech.count(s, metric: .cameras, period: .thisWeek, now: questionNow) == 7)
        #expect(CityActivitySpeech.count(s, metric: .cameras, period: .allTime, now: questionNow) == 7)
        #expect(CityActivitySpeech.count(s, metric: .cameras, period: .last7Days, now: questionNow) == nil, "daily buckets cannot establish an exact rolling boundary")
    }

    @Test func midnightAndDSTUseCentralCalendarDays() {
        let earlyUTC = ISO8601DateFormatter().date(from: "2026-10-24T02:00:00Z")!
        #expect(CityActivitySpeech.dates(.today, now: earlyUTC) == ["2026-10-23"])
        let afterDST = ISO8601DateFormatter().date(from: "2026-11-02T06:30:00Z")!
        #expect(CityActivitySpeech.dates(.yesterday, now: afterDST) == ["2026-11-01"])
        #expect(CityActivitySpeech.dates(.thisWeek, now: afterDST) == ["2026-11-02"])
        let sunday = ISO8601DateFormatter().date(from: "2026-11-02T05:30:00Z")!
        #expect(CityActivitySpeech.dates(.thisWeek, now: sunday).count == 7)
        #expect(CityActivitySpeech.dates(.thisWeek, now: sunday).first == "2026-10-26")
    }

    @Test func comparisonsRequireBothCountsAndHandleEquality() throws {
        let a = try questionStats(), d = try questionStats("dallas")
        let r = CityActivitySpeech.compare(a, d, metric: .registry, period: .allTime, now: questionNow)
        #expect(r.spoken == "Austin has 19 public registry vehicles and Dallas has 3 public registry vehicles. Austin has 16 more.")
        let equal = CityActivitySpeech.compare(a, d, metric: .sightings, period: .today, now: questionNow)
        #expect(equal.spoken.contains("counts are equal"))
        let old = try questionStats("dallas", generated: "2026-10-21T12:00:00Z")
        #expect(CityActivitySpeech.compare(a, old, metric: .sightings, period: .today, now: questionNow).spoken.contains("doesn't have comparable counts"))
    }

    @Test func unavailableVehicleHistoryIsNeverClaimedEmptyAndCapIsNamed() throws {
        let d = try APIClient.makeDecoder().decode(VehicleDetail.self, from: Data(CommunityStub.fixture("vehicle").utf8))
        let failed = SiriSpeech.vehicleHistory(d, sightings: nil, dmvFirst: nil, now: questionNow)
        #expect(failed.spoken.contains("temporarily unavailable") && !failed.spoken.contains("doesn't have a public sighting history"))
        #expect(!failed.figures.contains { $0.label == "History entries" })
        let entry = VehicleSightings.Entry(date: "2026-10-22", serviceArea: "Austin")
        let capped = SiriSpeech.vehicleHistory(d, sightings: Array(repeating: entry, count: 50), dmvFirst: nil, now: questionNow)
        #expect(capped.spoken.contains("latest 50, not a lifetime count"))
        #expect(capped.spoken.contains("day and area entries"))
    }

    @Test func dmvSpecificQuestionsRespectModelsProcessingAndFreshness() throws {
        var o: [String: Any] = [
            "source": ["name": "TxDMV", "company": "Tesla", "authorization": "AV1", "law": "SB 2807", "url": "https://txmccs.txdmv.gov", "fields": ["VIN"], "schedule": "Daily", "decoder": ["name": "vPIC", "url": "https://vpic.nhtsa.dot.gov"]],
            "latest": ["date": "2026-10-23"], "totals": ["cybercab": 351, "model_y": 507, "other_tesla": 0, "unknown": 0, "total": 858],
            "freshness": ["status": "import_failed"], "processing_pending": 0,
            "latest_update": ["date": "2026-10-22", "added": 55, "returned": 0, "missing": 0, "net": 55, "total": 858,
                              "added_by_model": ["cybercab": 2, "model_y": 53, "other_tesla": 0, "unknown": 0]]]
        func decodeOverview() throws -> DMVOverview { try APIClient.makeDecoder().decode(DMVOverview.self, from: JSONSerialization.data(withJSONObject: o)) }
        let d = try decodeOverview()
        #expect(SiriSpeech.dmv(d, question: .cybercab, now: questionNow).spoken.contains("351 Cybercab VINs"))
        #expect(SiriSpeech.dmv(d, question: .modelY, now: questionNow).spoken.contains("507 Model Y VINs"))
        let additions = SiriSpeech.dmv(d, question: .cybercabAdditions, now: questionNow)
        #expect(additions.spoken.contains("2 additional Cybercab VINs in the October 22"))
        #expect(additions.spoken.contains("import failed"))
        o["processing_pending"] = 3
        #expect(SiriSpeech.dmv(try decodeOverview(), question: .additions).spoken.contains("still processing"))
        o["processing_pending"] = NSNull()
        #expect(SiriSpeech.dmv(try decodeOverview(), question: .additions).spoken.contains("status is unavailable"))
    }

    @Test func growthCanSelectCybercabOrModelYInsteadOfAllVINs() throws {
        let o: [String: Any] = ["range": "all", "enough_history": true, "points": [
            ["date": "2026-10-20", "total": 100, "cybercab": 20, "model_y": 80, "baseline": true],
            ["date": "2026-10-23", "total": 110, "cybercab": 22, "model_y": 88, "baseline": false,
             "added": ["cybercab": 2, "model_y": 8, "other_tesla": 0, "unknown": 0]]]]
        let g = try APIClient.makeDecoder().decode(DMVGrowth.self, from: JSONSerialization.data(withJSONObject: o))
        let c = SiriSpeech.growth(g, start: nil, end: nil, processed: true, model: .cybercab)
        #expect(c?.net == 2 && c?.newlyDetected == 2)
        let y = SiriSpeech.growth(g, start: nil, end: nil, processed: true, model: .modelY)
        #expect(y?.net == 8 && y?.startTotal == 80 && y?.endTotal == 88)
        #expect(SiriSpeech.growthAnswer(y, now: questionNow, model: .modelY).spoken.contains("Model Y roster went from 80 to 88"))
        let unknown = SiriSpeech.growth(g, start: nil, end: nil, processed: false, model: .cybercab)
        #expect(unknown?.newlyDetected == nil)
    }

    @Test func sightingsAndComparisonsReuseOnlyTwoPublicRequests() async throws {
        let stub = StubServer()
        let o: [String: Any] = ["city": "austin", "name": "Austin", "generated_at": ISO8601DateFormatter().string(from: .now), "sightings": ["total": 21]]
        stub.responses = ["GET /api/homepage-stats": (200, String(decoding: try JSONSerialization.data(withJSONObject: o), as: UTF8.self))]
        SiriData.testAPI = stub.api(token: nil)
        defer { SiriData.testAPI = nil }
        await SiriData.shared.reset()
        let answer = try await RecentSightingsIntent.answer(city: .austin, period: .allTime)
        #expect(answer.spoken.contains("21 approved public sightings"))
        #expect(stub.requests.count == 1)
        stub.responses["GET /api/homepage-stats?city=dallas"] = (200, "{\"city\":\"dallas\",\"name\":\"Dallas\",\"sightings\":{\"total\":2}}")
        _ = try await CityActivityIntent.answer(.compareSightings)
        #expect(stub.requests.count == 2, "Austin is reused; only Dallas is fetched")
        #expect(stub.requests.allSatisfy { $0.0.value(forHTTPHeaderField: "Authorization") == nil })
        stub.responses["GET /api/homepage-stats?city=dallas"] = (503, "{}")
        await SiriData.shared.reset()
        await #expect(throws: IntentFailure.self) { _ = try await RecentSightingsIntent.answer(city: .dallas, period: .today) }
        await SiriData.shared.reset()
    }
}
}
