import Testing
import Foundation
import AppIntents
@testable import CybercabHunter

// Public aggregates captured with exactly one request per city on Oct 23, 2026.
// The frozen clock makes these historical-response replays stable on later days.
private let cityReplayNow = ISO8601DateFormatter().date(from: "2026-10-24T03:03:00Z")!
private func replayBody(_ city: String) -> String { CommunityStub.fixture("siri-city-\(city)-2026-10-23") }
private func runtimeCity(_ city: String, missingDay: Bool = false) throws -> String {
    let now = Date.now
    var days: [[String: Any]] = (0..<7).map { offset in
        ["date": SiriSpeech.iso(CityActivitySpeech.calendar.date(byAdding: .day, value: -offset, to: now)!), "count": city == "austin" ? 9 : 2]
    }
    if missingDay { days.removeFirst() }
    let o: [String: Any] = ["city": city, "name": city.capitalized,
        "generated_at": ISO8601DateFormatter().string(from: now),
        "sightings": ["total": 200, "daily": days],
        "cameras": ["detections_24h": 500], "area": ["vehicles": 600]]
    return String(decoding: try JSONSerialization.data(withJSONObject: o), as: UTF8.self)
}
private func cityKey(_ city: String) -> String { "GET /api/homepage-stats?city=\(city)" }

extension SiriSerial {
@MainActor
@Suite(.serialized)
struct SiriCityExecutionTests {
    @Test func oldSightingsWithoutResolvedParametersThrowsBeforeAnyRequest() async throws {
        let stub = StubServer()
        SiriData.testAPI = stub.api(token: nil)
        defer { SiriData.testAPI = nil }
        await SiriData.shared.reset()
        let unresolved = RecentSightingsIntent()
        await #expect(throws: (any Error).self) { _ = try await unresolved.perform() }
        #expect(stub.requests.isEmpty)
        await SiriData.shared.reset()
    }

    @Test func fixedDallasWeeklyNeverUsesWarmAustinCache() async throws {
        let stub = StubServer()
        stub.responses = [cityKey("austin"): (200, try runtimeCity("austin")), cityKey("dallas"): (200, try runtimeCity("dallas"))]
        SiriData.testAPI = stub.api(token: nil)
        defer { SiriData.testAPI = nil }
        await SiriData.shared.reset()
        var austin = RecentSightingsIntent(); austin.question = .austinToday
        #expect(try #require(try await austin.perform().value).hasPrefix("In Austin,"))
        for _ in 0..<2 {
            let text = try #require(try await DallasWeeklySightingsIntent().perform().value)
            let count = CityActivitySpeech.dates(.thisWeek, now: .now).count * 2
            #expect(text.hasPrefix("In Dallas,"))
            #expect(text.contains("\(count) approved public sightings this week"))
            #expect(!text.contains("Austin") && !text.contains("DMV") && !text.contains("camera"))
        }
        #expect(stub.requests.count == 2)
        #expect(Set(stub.requests.map { $0.0.url?.query }) == ["city=austin", "city=dallas"])
        await SiriData.shared.reset()
    }

    @Test func missingCityNeverFallsBackAndExplicitCitiesRemainSupported() throws {
        let missing = RecentSightingsIntent()
        #expect(throws: (any Error).self) { try missing.resolvedSelection() }
        for city in [ServiceCity.austin, .dallas] {
            var explicit = RecentSightingsIntent(); explicit.city = city; explicit.period = .thisWeek
            #expect(try explicit.resolvedSelection().city == city)
            #expect(try explicit.resolvedSelection().period == .thisWeek)
        }
    }

    @Test func DallasWrapperRejectsWrongCityResponseAndAPIFailures() async throws {
        let stub = StubServer()
        SiriData.testAPI = stub.api(token: nil)
        defer { SiriData.testAPI = nil }
        for response in [(200, try runtimeCity("austin")), (503, "{}"), (200, "not json")] {
            await SiriData.shared.reset(); stub.requests = []
            stub.responses = [cityKey("dallas"): response]
            await #expect(throws: IntentFailure.self) { _ = try await DallasWeeklySightingsIntent().perform() }
            #expect(stub.requests.count == 1)
            #expect(stub.requests.first?.0.url?.query == "city=dallas")
        }
        await SiriData.shared.reset()
    }

    @Test func replayFourCityAndPeriodCombinationsFromActualPublicResponses() async throws {
        let stub = StubServer()
        stub.responses = [cityKey("austin"): (200, replayBody("austin")), cityKey("dallas"): (200, replayBody("dallas"))]
        SiriData.testAPI = stub.api(token: nil)
        defer { SiriData.testAPI = nil }
        await SiriData.shared.reset()
        let cases: [(ServiceCity, ActivityPeriod, Int)] = [(.austin, .today, 12), (.austin, .thisWeek, 68), (.dallas, .today, 1), (.dallas, .thisWeek, 4)]
        for (city, period, n) in cases {
            let a = try await RecentSightingsIntent.answer(city: city, period: period, now: cityReplayNow)
            #expect(a.spoken == "In \(city.title), Cybercab Hunter has \(n) approved public \(n == 1 ? "sighting" : "sightings") \(period.wording).")
        }
        #expect(stub.requests.count == 2, "each city response is reused across periods")
        #expect(Set(stub.requests.map { $0.0.url?.query }) == Set(["city=austin", "city=dallas"].map(Optional.some)))
        await SiriData.shared.reset()
    }

    @Test func replayActualEquivalentWeeklySightingsComparison() async throws {
        let stub = StubServer()
        stub.responses = [cityKey("austin"): (200, replayBody("austin")), cityKey("dallas"): (200, replayBody("dallas"))]
        SiriData.testAPI = stub.api(token: nil)
        defer { SiriData.testAPI = nil }
        await SiriData.shared.reset()
        let a = try await CityActivityIntent.answer(.compareSightingsThisWeek, now: cityReplayNow)
        #expect(a.spoken == "Austin has 68 approved public sightings and Dallas has 4 approved public sightings this week so far, since Monday. Austin has 64 more.")
        #expect(a.figures.map(\.value) == ["68", "4"])
        #expect(stub.requests.count == 2)
        #expect(stub.requests.allSatisfy { $0.0.url?.path == "/api/homepage-stats" })
        await SiriData.shared.reset()
    }

    @Test func actualPerformEntryPointsResolveAllFourCityPeriodChoices() async throws {
        let stub = StubServer()
        stub.responses = [cityKey("austin"): (200, try runtimeCity("austin")), cityKey("dallas"): (200, try runtimeCity("dallas"))]
        SiriData.testAPI = stub.api(token: nil)
        defer { SiriData.testAPI = nil }
        await SiriData.shared.reset()
        for choice in [CitySightingsQuestion.austinToday, .austinThisWeek, .dallasToday, .dallasThisWeek] {
            var intent = RecentSightingsIntent()
            intent.city = choice.city
            intent.period = choice.period
            intent.question = choice
            let text = try #require(try await intent.perform().value)
            let days = choice.period == .today ? 1 : CityActivitySpeech.dates(.thisWeek, now: .now).count
            let count = days * (choice.city == .austin ? 9 : 2)
            #expect(text.contains("\(count) approved public sightings \(choice.period.wording)"))
            #expect(text.hasPrefix("In \(choice.city.title),"))
            #expect(!text.contains("DMV") && !text.contains("camera") && !text.contains("600"))
        }
        #expect(stub.requests.count == 2)
        await SiriData.shared.reset()
    }

    @Test func comparisonWorksThroughAdvertisedFleetEntryPointAndCityActivityEntryPoint() async throws {
        let stub = StubServer()
        stub.responses = [cityKey("austin"): (200, try runtimeCity("austin")), cityKey("dallas"): (200, try runtimeCity("dallas"))]
        SiriData.testAPI = stub.api(token: nil)
        defer { SiriData.testAPI = nil }
        await SiriData.shared.reset()
        var fleet = FleetStatsIntent()
        fleet.activity = .compareSightingsThisWeek
        fleet.metric = .overview // The compatible summary default must not trigger global data.
        let text = try #require(try await fleet.perform().value)
        var direct = CityActivityIntent(); direct.question = .compareSightingsThisWeek
        let directText = try #require(try await direct.perform().value)
        #expect(text == directText)
        let days = CityActivitySpeech.dates(.thisWeek, now: .now).count
        #expect(text.contains("Austin has \(days * 9) approved public sightings and Dallas has \(days * 2) approved public sightings"))
        #expect(!text.contains("DMV") && !text.contains("VIN") && !text.contains("camera"))
        #expect(Set(stub.requests.map { $0.0.url?.query }) == Set(["city=austin", "city=dallas"].map(Optional.some)))
        #expect(stub.requests.count == 2)
        await SiriData.shared.reset()
    }

    @Test func comparisonMissingDataNeverSubstitutesZeroOrOtherMetrics() async throws {
        let stub = StubServer()
        stub.responses = [cityKey("austin"): (200, try runtimeCity("austin")), cityKey("dallas"): (200, try runtimeCity("dallas", missingDay: true))]
        SiriData.testAPI = stub.api(token: nil)
        defer { SiriData.testAPI = nil }
        await SiriData.shared.reset()
        var intent = FleetStatsIntent(); intent.activity = .compareSightingsThisWeek
        let text = try #require(try await intent.perform().value)
        #expect(text.contains("doesn't have comparable counts"))
        #expect(!text.contains("Dallas has 0") && !text.contains("camera") && !text.contains("VIN"))
        await SiriData.shared.reset()
    }

    @Test func comparisonAndDallasAPIFailuresDoNotFallBackToAustinOrDMV() async throws {
        let stub = StubServer()
        SiriData.testAPI = stub.api(token: nil)
        defer { SiriData.testAPI = nil }
        for broken in [(503, "{}"), (200, "not json")] {
            await SiriData.shared.reset()
            stub.requests = []
            stub.responses = [cityKey("austin"): (200, try runtimeCity("austin")), cityKey("dallas"): broken]
            var comparison = FleetStatsIntent(); comparison.activity = .compareSightingsThisWeek
            await #expect(throws: IntentFailure.self) { _ = try await comparison.perform() }
            var dallas = RecentSightingsIntent(); dallas.question = .dallasThisWeek
            await #expect(throws: IntentFailure.self) { _ = try await dallas.perform() }
            #expect(stub.requests.allSatisfy { $0.0.url?.path == "/api/homepage-stats" && $0.0.value(forHTTPHeaderField: "Authorization") == nil })
        }
        await SiriData.shared.reset()
    }
}
}
