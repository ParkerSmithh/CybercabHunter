import Testing
import Foundation
import AppIntents
@testable import CybercabHunter

extension SiriSerial {
@MainActor
@Suite(.serialized)
struct SiriNaturalLanguageTests {
    @Test func conflictingSightingsCityAndEveryExplicitPeriodClarifyBeforeNetworking() async throws {
        let stub = StubServer(); SiriData.testAPI = stub.api(token: nil)
        defer { SiriData.testAPI = nil }
        await SiriData.shared.reset()
        for q in CitySightingsQuestion.allCases {
            let intent = RecentSightingsIntent()
            intent.question = q
            intent.city = q.city == .austin ? .dallas : .austin
            await #expect(throws: (any Error).self) { _ = try await intent.perform() }
            intent.city = q.city
            for p in ActivityPeriod.allCases where p != q.period {
                intent.period = p
                await #expect(throws: (any Error).self) { _ = try await intent.perform() }
            }
        }
        #expect(stub.requests.isEmpty)
    }

    @Test func conflictingFleetInputsAndAmbiguousMetricClarifyBeforeNetworking() async throws {
        let stub = StubServer(); SiriData.testAPI = stub.api(token: nil)
        defer { SiriData.testAPI = nil }
        await SiriData.shared.reset()
        let fleet = FleetStatsIntent()
        fleet.city = .dallas; fleet.activity = .austinRegistry
        await #expect(throws: (any Error).self) { _ = try await fleet.perform() }
        fleet.city = nil; fleet.activity = .compareSightingsToday; fleet.metric = .registry
        await #expect(throws: (any Error).self) { _ = try await fleet.perform() }
        fleet.metric = .overview; fleet.activity = .clarifyActivity
        await #expect(throws: (any Error).self) { _ = try await fleet.perform() }
        let direct = CityActivityIntent()
        await #expect(throws: (any Error).self) { _ = try await direct.perform() }
        direct.question = .clarifyActivity
        await #expect(throws: (any Error).self) { _ = try await direct.perform() }
        #expect(stub.requests.isEmpty)
    }

    @Test func omittedPeriodClarifiesWithoutHidingExplicitConflicts() throws {
        let legacy = RecentSightingsIntent(); legacy.city = .dallas
        #expect(legacy.period == nil)
        #expect(throws: (any Error).self) { try legacy.resolvedSelection() }
        legacy.period = .last24Hours
        #expect(try legacy.resolvedSelection().period == .last24Hours)
        legacy.period = nil
        legacy.question = .dallasToday
        #expect(try legacy.resolvedSelection().period == .today)
        legacy.period = .last24Hours
        #expect(throws: (any Error).self) { try legacy.resolvedSelection() }
    }

    @Test func mapAndSightingsNavigationCannotDefaultToAustin() async throws {
        await #expect(throws: (any Error).self) { _ = try await OpenZonesIntent().perform() }
        await #expect(throws: (any Error).self) { _ = try await OpenSightingsIntent().perform() }
    }

    @Test func matchingFleetParametersRemainSupported() throws {
        let fleet = FleetStatsIntent()
        try fleet.validateSelection() // Existing global overview remains intentional.
        fleet.city = .austin; fleet.activity = .austinRegistry; fleet.metric = .registry
        try fleet.validateSelection()
        fleet.city = nil; fleet.activity = .compareRides; fleet.metric = .rides
        try fleet.validateSelection()
    }

    @Test func everyCityActivityRejectsWrongCityAndWrongDisplayName() async throws {
        let stub = StubServer(); SiriData.testAPI = stub.api(token: nil)
        defer { SiriData.testAPI = nil }
        for q in CityActivityQuestion.allCases where !q.requiresClarification {
            for body in ["{\"city\":\"global\",\"name\":\"Global\"}", "{\"city\":\"\(q.city.rawValue)\",\"name\":\"Incorrect city\"}"] {
                await SiriData.shared.reset(); stub.requests = []
                stub.responses = ["GET /api/homepage-stats": (200, body)]
                await #expect(throws: (any Error).self) { _ = try await CityActivityIntent.answer(q) }
                #expect(stub.requests.allSatisfy { $0.0.url?.path == "/api/homepage-stats" })
                #expect(!stub.requests.isEmpty)
            }
        }
        await SiriData.shared.reset()
    }

    @Test func austinRegistryAndZoneUseCityEndpointAndDistinctMetrics() async throws {
        let stub = StubServer(); SiriData.testAPI = stub.api(token: nil)
        defer { SiriData.testAPI = nil }
        await SiriData.shared.reset()
        stub.responses = ["GET /api/homepage-stats?city=austin": (200,
            "{\"city\":\"austin\",\"name\":\"Austin\",\"area\":{\"vehicles\":17,\"square_miles\":81},\"sightings\":{\"total\":999},\"cameras\":{\"detections_24h\":555}}")]
        let fleet = FleetStatsIntent(); fleet.activity = .austinRegistry
        let registry = try #require(try await fleet.perform().value)
        #expect(registry.contains("17 public registry vehicles") && !registry.contains("999") && !registry.contains("555"))
        fleet.activity = .austinZone
        let zone = try #require(try await fleet.perform().value)
        #expect(zone.contains("81") && zone.contains("square miles") && zone.contains("Austin"))
        #expect(stub.requests.count == 1 && stub.requests.first?.0.url?.query == "city=austin")
        await SiriData.shared.reset()
    }

    @Test func cityBriefingCannotDegradeToGlobalWhenCityFailsOrIsMislabeled() async throws {
        let stub = StubServer(); SiriData.testAPI = stub.api(token: nil)
        defer { SiriData.testAPI = nil }
        for response in [(503, "{}"), (200, "{\"city\":\"austin\",\"name\":\"Austin\"}"), (200, "{\"city\":\"dallas\",\"name\":\"Austin\"}")] {
            await SiriData.shared.reset(); stub.requests = []
            stub.responses = ["GET /api/homepage-stats?city=dallas": response,
                              "GET /api/daily": (200, CommunityStub.fixture("daily"))]
            await #expect(throws: (any Error).self) { _ = try await DailyBriefingIntent.compose(city: .dallas, quick: false) }
            #expect(!stub.requests.contains { $0.0.url?.path == "/api/registry/stats" })
        }
        await SiriData.shared.reset()
    }

    @Test func cityFleetFailureCannotFetchGlobalEvenWhenGlobalDataIsAvailable() async throws {
        let stub = StubServer(); SiriData.testAPI = stub.api(token: nil)
        defer { SiriData.testAPI = nil }
        await SiriData.shared.reset()
        stub.responses = ["GET /api/homepage-stats?city=dallas": (503, "{}"),
                          "GET /api/registry/stats": (200, "{}")]
        let fleet = FleetStatsIntent(); fleet.city = .dallas
        await #expect(throws: IntentFailure.self) { _ = try await fleet.perform() }
        #expect(stub.requests.count == 1 && stub.requests.first?.0.url?.query == "city=dallas")
        await SiriData.shared.reset()
    }

    @Test func centralCalendarHandlesBothDSTTransitionsAndYearBoundary() throws {
        func date(_ s: String) -> Date { ISO8601DateFormatter().date(from: s)! }
        #expect(CityActivitySpeech.dates(.today, now: date("2026-03-08T07:30:00Z")) == ["2026-03-08"])
        #expect(CityActivitySpeech.dates(.today, now: date("2026-03-08T08:30:00Z")) == ["2026-03-08"])
        #expect(CityActivitySpeech.dates(.yesterday, now: date("2026-03-09T05:30:00Z")) == ["2026-03-08"])
        #expect(CityActivitySpeech.dates(.thisWeek, now: date("2026-03-09T05:30:00Z")) == ["2026-03-09"])
        #expect(CityActivitySpeech.dates(.today, now: date("2026-11-01T06:30:00Z")) == ["2026-11-01"])
        #expect(CityActivitySpeech.dates(.today, now: date("2026-11-01T07:30:00Z")) == ["2026-11-01"])
        #expect(CityActivitySpeech.dates(.thisWeek, now: date("2027-01-01T18:00:00Z")).first == "2026-12-28")
    }
}
}
