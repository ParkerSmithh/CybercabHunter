import Testing
import AppIntents
import Foundation
@testable import CybercabHunter

extension SiriSerial {
@MainActor
@Suite(.serialized)
struct SiriReliabilityTests {
    @Test func cameraBindingsCannotSelectZoneOrAnotherCity() throws {
        for q in CameraCityPeriod.allCases {
            let fleet = FleetStatsIntent(); fleet.cameraQuestion = q
            let selected = try #require(try fleet.resolvedActivity())
            #expect(selected.city == q.city && selected.metric == .cameras && selected.period == q.period)
            fleet.city = q.city == .austin ? .dallas : .austin
            #expect(throws: (any Error).self) { try fleet.resolvedActivity() }
        }
        let fleet = FleetStatsIntent(); fleet.cameraQuestion = .dallasToday; fleet.activity = .austinZone
        #expect(throws: (any Error).self) { try fleet.resolvedActivity() }
    }

    @Test func additiveBindingsRejectConflictsAndPreserveAllPeriods() throws {
        for period in ActivityPeriod.allCases {
            let fleet = FleetStatsIntent(); fleet.comparisonPeriod = period
            #expect(try fleet.resolvedActivity() == ActivitySelection(city: nil, metric: .sightings, period: period))
            fleet.activityPeriod = period == .today ? .yesterday : .today
            #expect(throws: (any Error).self) { try fleet.resolvedActivity() }
        }
        for city in [ServiceCity.austin, .dallas] {
            let fleet = FleetStatsIntent(); fleet.registryCity = city
            #expect(try fleet.resolvedActivity() == ActivitySelection(city: city, metric: .registry, period: .allTime))
            fleet.metric = .rides
            #expect(throws: (any Error).self) { try fleet.resolvedActivity() }
            let sightings = RecentSightingsIntent(); sightings.city = city
            #expect(throws: (any Error).self) { try sightings.resolvedSelection() }
            for period in ActivityPeriod.allCases {
                sightings.period = period
                #expect(try sightings.resolvedSelection().period == period)
            }
        }
    }

    @Test func contextSpecificClarificationPreservesKnownValues() throws {
        var events: [SiriDiagnostics.Event] = []
        SiriDiagnostics.testObserver = { events.append($0) }
        defer { SiriDiagnostics.testObserver = nil }
        let fleet = FleetStatsIntent(); fleet.activity = .clarifyCamerasThisWeek
        #expect(throws: (any Error).self) { try fleet.resolvedActivity() }
        #expect(events.last?.selection == "missing_city")
        fleet.city = .dallas
        #expect(try fleet.resolvedActivity() == ActivitySelection(city: .dallas, metric: .cameras, period: .thisWeek))
        fleet.activityPeriod = .last7Days
        #expect(throws: (any Error).self) { try fleet.resolvedActivity() }
        fleet.city = nil; fleet.activityPeriod = nil; fleet.activity = .clarifyComparison
        #expect(throws: (any Error).self) { try fleet.resolvedActivity() }
        #expect(events.last?.selection == "missing_metric")
        fleet.activityMetric = .sightings
        #expect(throws: (any Error).self) { try fleet.resolvedActivity() }
        #expect(events.last?.selection == "missing_period")
        fleet.activityPeriod = .last7Days
        #expect(try fleet.resolvedActivity() == ActivitySelection(city: nil, metric: .sightings, period: .last7Days))
        fleet.activity = .clarifyComparisonToday; fleet.activityPeriod = nil
        #expect(try fleet.resolvedActivity()?.period == .today)
        fleet.activityPeriod = .thisWeek
        #expect(throws: (any Error).self) { try fleet.resolvedActivity() }
    }

    @Test func directCityActivityRetainsClarificationContext() throws {
        let direct = CityActivityIntent(); direct.question = .clarifyCamerasThisWeek
        #expect(throws: (any Error).self) { try direct.resolvedActivity() }
        direct.city = .dallas
        #expect(try direct.resolvedActivity() == ActivitySelection(city: .dallas, metric: .cameras, period: .thisWeek))
        direct.city = nil; direct.question = .clarifyComparison
        #expect(throws: (any Error).self) { try direct.resolvedActivity() }
        direct.activityMetric = .sightings
        #expect(throws: (any Error).self) { try direct.resolvedActivity() }
        direct.activityPeriod = .last7Days
        #expect(try direct.resolvedActivity() == ActivitySelection(city: nil, metric: .sightings, period: .last7Days))
        direct.question = .dallasCamerasToday
        #expect(throws: (any Error).self) { try direct.resolvedActivity() }
    }

    @Test func allExistingCompleteActivityMappingsRemainIdentical() throws {
        for q in CityActivityQuestion.allCases where !q.requiresClarification {
            let fleet = FleetStatsIntent(); fleet.activity = q
            #expect(try fleet.resolvedActivity() == ActivitySelection(city: q.comparesCities ? nil : q.city, metric: q.metric, period: q.period))
        }
        for q in CitySightingsQuestion.allCases {
            let sightings = RecentSightingsIntent(); sightings.question = q
            #expect(try sightings.resolvedSelection().city == q.city)
            #expect(try sightings.resolvedSelection().period == q.period)
        }
    }
}
}
