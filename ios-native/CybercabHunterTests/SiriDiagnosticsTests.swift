import Testing
import Foundation
import AppIntents
import CoreLocation
import MachO
@testable import CybercabHunter

private func diagnosticCity(_ city: String) throws -> String {
    let body: [String: Any] = ["city": city, "name": city.capitalized,
        "generated_at": ISO8601DateFormatter().string(from: .now),
        "area": ["vehicles": city == "dallas" ? 2 : 10, "square_miles": 81],
        "sightings": ["daily": [["date": SiriSpeech.iso(.now), "count": city == "dallas" ? 1 : 12]]]]
    return String(decoding: try JSONSerialization.data(withJSONObject: body), as: UTF8.self)
}

extension SiriSerial {
@MainActor
@Suite(.serialized)
struct SiriDiagnosticsTests {
    @Test func startupMetadataDistinguishesPresentAbsentInvalidAndUnavailable() throws {
        let valid = Data("{\"actions\":{\"FleetGrowthIntent\":{},\"FleetStatsIntent\":{}}}".utf8)
        let present = SiriStartupDiagnostics.Metadata(data: valid)
        #expect(present.status == "readable" && present.growth == "present" && present.actions == 2)
        #expect(present.sha256.count == 64 && present == SiriStartupDiagnostics.Metadata(data: valid))
        let absent = SiriStartupDiagnostics.Metadata(data: Data("{\"actions\":{}}".utf8))
        #expect(absent.status == "readable" && absent.growth == "absent" && absent.actions == 0)
        for data in [Data("not json".utf8), Data("{}".utf8), Data("{\"actions\":{\"FleetGrowthIntent\":null}}".utf8)] {
            let invalid = SiriStartupDiagnostics.Metadata(data: data)
            #expect(invalid.status == "invalid" && invalid.growth == "unknown")
        }
        #expect(SiriStartupDiagnostics.Metadata(data: nil).growth == "unknown")
        #expect(SiriStartupDiagnostics.Metadata(data: Data(count: SiriStartupDiagnostics.metadataLimit + 1)).status == "too_large")
        #expect(SiriStartupDiagnostics.Metadata(data: nil, unavailable: "unreadable").status == "unreadable")
    }

    @Test func startupReadsTheActualHostAppsBundledMetadata() {
        let metadata = SiriStartupDiagnostics.bundledMetadata()
        #expect(metadata.status == "readable")
        #expect(metadata.growth == "present" && metadata.actions == 22)
        #expect(metadata.sha256.count == 64)
    }

    @Test func startupIdentityHasNoMetadataPayloadOrUntrustedValues() {
        let secret = "private VIN transcript coordinates"
        let metadata = SiriStartupDiagnostics.Metadata(data: Data("{\"actions\":{},\"secret\":\"\(secret)\"}".utf8))
        let line = SiriStartupDiagnostics.snapshotLine(version: "0.1", build: "3", executableUUID: "00000000-0000-0000-0000-000000000003", metadata: metadata)
        #expect(line.contains("version=0.1 build=3") && line.contains("FleetGrowthIntent=absent"))
        #expect(line.contains("executable_uuid=00000000-0000-0000-0000-000000000003"))
        #expect(!line.contains(secret) && !line.contains("actions\""))
        let unsafe = SiriStartupDiagnostics.snapshotLine(version: secret, build: secret, executableUUID: secret, metadata: metadata)
        #expect(!unsafe.contains(secret) && unsafe.contains("executable_uuid=unavailable"))
        #expect(SiriStartupDiagnostics.executableUUID().flatMap(UUID.init(uuidString:)) != nil)
    }

    @Test func loadedExecutableIdentityMatchesTheAppFileRatherThanRuntimeImageZero() throws {
        let url = try #require(Bundle.main.executableURL)
        let data = try Data(contentsOf: url)
        let fileUUID = data.withUnsafeBytes { bytes -> String? in
            guard let base = bytes.baseAddress else { return nil }
            return SiriStartupDiagnostics.uuid(header: base.assumingMemoryBound(to: mach_header.self))
        }
        #expect(try #require(fileUUID) == SiriStartupDiagnostics.executableUUID())
    }

    @Test func refreshReportsCallReturnWithoutClaimingSystemRegistration() {
        var events: [String] = []
        var calls = 0
        SiriStartupDiagnostics.refresh(request: { calls += 1; events.append("call") }, record: { events.append($0) })
        #expect(calls == 1 && events.count == 3)
        #expect(events[0].contains("refresh_requested") && events[1] == "call")
        #expect(events[2].contains("refresh_call_returned") && events[2].contains("system_completion=unobservable"))
        #expect(!events.contains { $0.contains("registration_succeeded") })
    }

    @Test func suppliedDefaultAndUnsetParametersRemainDistinguishable() {
        let fleet = FleetStatsIntent()
        let omitted = fleet.diagnosticParameters
        #expect(omitted.city == "missing" && omitted.cityState == .unset)
        #expect(omitted.metric == "overview" && omitted.metricState == .unset)
        fleet.city = .dallas; fleet.metric = .overview
        let explicit = fleet.diagnosticParameters
        #expect(explicit.city == "dallas" && explicit.cityState == .set)
        #expect(explicit.metric == "overview" && explicit.metricState == .set)
        let zone = ServiceZoneIntent()
        #expect(zone.diagnosticParameters.city == "missing")
        #expect(zone.diagnosticParameters.cityState == .unset)
        zone.city = .austin; zone.compare = false
        #expect(zone.diagnosticParameters.cityState == .set)
        #expect(zone.diagnosticParameters.compareState == .set)
        let growth = FleetGrowthIntent()
        #expect(growth.diagnosticParameters.model == "all" && growth.diagnosticParameters.modelState == .unset)
        #expect(growth.diagnosticParameters.period == "week" && growth.diagnosticParameters.periodState == .unset)
        growth.model = .all; growth.period = .week
        #expect(growth.diagnosticParameters.modelState == .set && growth.diagnosticParameters.periodState == .set)
        growth.from = .now
        #expect(growth.diagnosticParameters.customFrom && growth.diagnosticParameters.fromState == .set)
        #expect(!growth.diagnosticParameters.customTo && growth.diagnosticParameters.toState == .unset)
    }

    @Test func fleetAndComparisonLogActualSelectionsWithoutExtraRequests() async throws {
        let stub = StubServer()
        stub.responses = ["GET /api/homepage-stats?city=dallas": (200, try diagnosticCity("dallas")),
                          "GET /api/homepage-stats?city=austin": (200, try diagnosticCity("austin"))]
        SiriData.testAPI = stub.api(token: nil)
        var events: [SiriDiagnostics.Event] = []
        SiriDiagnostics.testObserver = { events.append($0) }
        defer { SiriData.testAPI = nil; SiriDiagnostics.testObserver = nil }
        await SiriData.shared.reset()
        let fleet = FleetStatsIntent(); fleet.city = .dallas; fleet.metric = .overview
        _ = try await fleet.perform()
        let entered = try #require(events.first { $0.intent == "FleetStatsIntent" && $0.phase == "entered" })
        #expect(entered.parameters.city == "dallas" && entered.parameters.cityState == .set)
        #expect(entered.parameters.metric == "overview" && entered.parameters.activity == "missing")
        #expect(events.last?.phase == "completed" && events.last?.id == entered.id)
        events = []
        fleet.city = nil
        fleet.activity = .compareSightingsToday
        _ = try await fleet.perform()
        let comparison = try #require(events.first { $0.intent == "CityActivityIntent" && $0.phase == "entered" })
        #expect(comparison.parameters.city == "austin,dallas")
        #expect(comparison.parameters.metric == "sightings" && comparison.parameters.period == "today")
        #expect(comparison.parameters.activity == "compareSightingsToday" && comparison.parameters.activityState == .set)
        #expect(stub.requests.count == 2, "Logging must not fetch data; existing cache is reused")
        events = []
        let direct = CityActivityIntent() // Missing selection must clarify before any fetch.
        await #expect(throws: (any Error).self) { _ = try await direct.perform() }
        #expect(events.isEmpty)
        direct.question = .compareSightingsThisWeek
        #expect(direct.question == .compareSightingsThisWeek)
        await SiriData.shared.reset()
    }

    @Test func errorsPreserveCategoriesAndEmitOneTerminalFailure() async throws {
        let stub = StubServer()
        stub.responses = ["GET /api/service-areas": (503, "{}"), "GET /api/dmv/growth": (503, "{}"), "GET /api/homepage-stats?city=dallas": (503, "{}")]
        SiriData.testAPI = stub.api(token: nil)
        var events: [SiriDiagnostics.Event] = []
        SiriDiagnostics.testObserver = { events.append($0) }
        defer { SiriData.testAPI = nil; SiriDiagnostics.testObserver = nil }
        await SiriData.shared.reset()
        let zone = ServiceZoneIntent(); zone.city = .dallas; zone.compare = false
        await #expect(throws: IntentFailure.self) { _ = try await zone.perform() }
        #expect(events.first?.parameters.city == "dallas" && events.first?.parameters.compare == "false")
        #expect(events.filter { $0.phase == "failed" }.count == 1)
        #expect(events.last?.error == "http_503" && !events.contains { $0.phase == "completed" })
        events = []
        let fleet = FleetStatsIntent(); fleet.city = .dallas
        await #expect(throws: IntentFailure.self) { _ = try await fleet.perform() }
        let underlying = try #require(events.first { $0.phase == "data_failed" })
        #expect(underlying.error == "http_503" && underlying.parameters.city == "dallas")
        #expect(events.last?.phase == "failed" && events.last?.id == underlying.id)
        #expect(events.filter { $0.phase == "failed" }.count == 1)
        events = []
        let growth = FleetGrowthIntent(); growth.model = .cybercab; growth.period = .week
        await #expect(throws: IntentFailure.self) { _ = try await growth.perform() }
        #expect(events.first?.parameters.model == "cybercab" && events.first?.parameters.modelState == .set)
        #expect(events.first?.parameters.period == "week" && events.last?.phase == "failed")
        #expect(events.last?.error == "http_503")
        await SiriData.shared.reset()
    }

    @Test func zoneSuccessAndInsufficientGrowthCompleteWithoutChangingBehavior() async throws {
        let stub = StubServer()
        let growth = "{\"range\":\"all\",\"enough_history\":false,\"points\":[{\"date\":\"2026-10-23\",\"total\":5,\"cybercab\":5,\"model_y\":0,\"baseline\":true}]}"
        stub.responses = ["GET /api/service-areas": (200, "{\"areas\":[{\"key\":\"dallas\",\"name\":\"Dallas\"}]}"),
                          "GET /api/homepage-stats?city=dallas": (200, try diagnosticCity("dallas")),
                          "GET /api/dmv/growth": (200, growth)]
        SiriData.testAPI = stub.api(token: nil)
        var events: [SiriDiagnostics.Event] = []
        SiriDiagnostics.testObserver = { events.append($0) }
        defer { SiriData.testAPI = nil; SiriDiagnostics.testObserver = nil }
        await SiriData.shared.reset()
        let zone = ServiceZoneIntent(); zone.city = .dallas
        _ = try await zone.perform()
        #expect(events.last?.phase == "completed" && events.last?.outcome == "answer_composed")
        #expect(events.last?.parameters.city == "dallas")
        #expect(stub.requests.count == 2)
        events = []
        let intent = FleetGrowthIntent(); intent.model = .cybercab; intent.period = .week
        _ = try await intent.perform()
        #expect(events.last?.phase == "completed" && events.last?.outcome == "insufficient_history")
        #expect(events.last?.parameters.model == "cybercab")
        #expect(!events.contains { $0.phase == "failed" })
        await SiriData.shared.reset()
    }

    @Test func fixedDallasFleetUsesZeroDallasRegistryEvenWithWarmAustinAndGlobalCaches() async throws {
        let stub = StubServer()
        let dallas = try diagnosticCity("dallas").replacingOccurrences(of: "\"vehicles\":2", with: "\"vehicles\":0")
        stub.responses = ["GET /api/homepage-stats?city=dallas": (200, dallas),
                          "GET /api/homepage-stats?city=austin": (200, try diagnosticCity("austin")),
                          "GET /api/registry/stats": (200, "{\"public_vehicles\":193,\"recorded_rides\":8,\"sightings_all_time\":535}")]
        SiriData.testAPI = stub.api(token: nil)
        defer { SiriData.testAPI = nil }
        await SiriData.shared.reset()
        let global = try await FleetStatsIntent.answer(city: nil)
        #expect(global.spoken.contains("193 vehicles"))
        _ = try await FleetStatsIntent.answer(city: .austin)
        let count = stub.requests.count
        for _ in 0..<2 {
            let text = try #require(try await DallasFleetSummaryIntent().perform().value)
            #expect(text.hasPrefix("In Dallas,"))
            #expect(text.contains("0 vehicles") && !text.contains("193") && !text.contains("Austin"))
        }
        #expect(stub.requests.count == count + 1)
        #expect(stub.requests.last?.0.url?.query == "city=dallas")
        await SiriData.shared.reset()
    }

    @Test func missingZoneCityClarifiesBeforeFetchingAndFixedDallasNeverUsesAustin() async throws {
        let stub = StubServer()
        SiriData.testAPI = stub.api(token: nil)
        var events: [SiriDiagnostics.Event] = []
        SiriDiagnostics.testObserver = { events.append($0) }
        defer { SiriData.testAPI = nil; SiriDiagnostics.testObserver = nil }
        await SiriData.shared.reset()
        await #expect(throws: (any Error).self) { _ = try await ServiceZoneIntent().perform() }
        #expect(stub.requests.isEmpty)
        #expect(events.last?.phase == "clarification_requested" && events.last?.parameters.city == "missing")
        for size in [81, 105] {
            await SiriData.shared.reset(); stub.requests = []; events = []
            let body = try diagnosticCity("dallas").replacingOccurrences(of: "81", with: String(size))
            stub.responses = ["GET /api/service-areas": (200, "{\"areas\":[{\"key\":\"dallas\",\"name\":\"Dallas\"}]}"),
                              "GET /api/homepage-stats?city=dallas": (200, body)]
            _ = try await DallasServiceZoneIntent().perform()
            #expect(events.first?.intent == "DallasServiceZoneIntent")
            #expect(events.first?.parameters.city == "dallas" && events.first?.parameters.cityState == .derived)
            #expect(events.contains { $0.intent == "ServiceZoneIntent" && $0.parameters.city == "dallas" && $0.phase == "completed" })
            #expect(events.last?.phase == "completed")
            #expect(stub.requests.count == 2)
            #expect(stub.requests.allSatisfy { $0.0.url?.query != "city=austin" })
            let stats = try APIClient.makeDecoder().decode(HomepageStats.self, from: Data(body.utf8))
            #expect(SiriSpeech.zone(stats).spoken.contains("\(size) square miles"))
        }
        await SiriData.shared.reset()
    }

    @Test func fixedDallasRoutesRejectOtherCityPayloadsAndAPIErrors() async throws {
        let stub = StubServer()
        SiriData.testAPI = stub.api(token: nil)
        defer { SiriData.testAPI = nil }
        for response in [(200, try diagnosticCity("austin")), (503, "{}"), (200, "not json")] {
            await SiriData.shared.reset()
            stub.responses = ["GET /api/service-areas": (200, "{\"areas\":[{\"key\":\"dallas\",\"name\":\"Dallas\"}]}"),
                              "GET /api/homepage-stats?city=dallas": response]
            await #expect(throws: IntentFailure.self) { _ = try await DallasFleetSummaryIntent().perform() }
            await #expect(throws: IntentFailure.self) { _ = try await DallasServiceZoneIntent().perform() }
            #expect(stub.requests.allSatisfy { $0.0.url?.path != "/api/registry/stats" && $0.0.url?.query != "city=austin" })
        }
        await SiriData.shared.reset()
    }

    @Test func nearbyErrorsAreObservableWithoutRequestingLocationPermission() async throws {
        let stub = StubServer(); SiriData.testAPI = stub.api(token: nil)
        var events: [SiriDiagnostics.Event] = []
        SiriDiagnostics.testObserver = { events.append($0) }
        defer {
            SiriData.testAPI = nil; SiriDiagnostics.testObserver = nil
            OneShotLocation.testCurrent = nil; OneShotLocation.testAuthorization = nil
        }
        let cases: [(CLAuthorizationStatus, LocationFailure, String)] = [
            (.notDetermined, .notDetermined, "location_not_configured"),
            (.denied, .denied, "location_denied"),
            (.authorizedWhenInUse, .unavailable, "location_unavailable")]
        for (status, error, category) in cases {
            events = []; OneShotLocation.testAuthorization = status
            OneShotLocation.testCurrent = { throw error }
            await #expect(throws: IntentFailure.self) { _ = try await NearbySightingsIntent().perform() }
            #expect(events.first?.intent == "NearbySightingsIntent")
            #expect(events.first?.parameters.period == "last24Hours")
            #expect(events.last?.phase == "failed" && events.last?.error == category)
            #expect(events.filter { $0.phase == "failed" }.count == 1)
        }
        #expect(stub.requests.isEmpty)
    }

    @Test func nearbySuccessLogsOnlyBroadCityAndDoesNotAddRequests() async throws {
        let stub = StubServer(); stub.responses = ["GET /api/camera-sightings": (200, "[]")]
        SiriData.testAPI = stub.api(token: nil)
        var events: [SiriDiagnostics.Event] = []
        SiriDiagnostics.testObserver = { events.append($0) }
        OneShotLocation.testAuthorization = .authorizedWhenInUse
        OneShotLocation.testCurrent = { CLLocation(latitude: 30.2672, longitude: -97.7431) }
        defer {
            SiriData.testAPI = nil; SiriDiagnostics.testObserver = nil
            OneShotLocation.testCurrent = nil; OneShotLocation.testAuthorization = nil
        }
        await SiriData.shared.reset()
        _ = try await NearbySightingsIntent().perform()
        #expect(events.first?.parameters.city == "not_resolved")
        #expect(events.contains { $0.phase == "parameters_resolved" && $0.parameters.city == "austin" })
        #expect(events.last?.phase == "completed" && events.last?.outcome == "no_nearby_detections")
        #expect(events.allSatisfy { !$0.line.contains("30.2672") && !$0.line.contains("97.7431") })
        #expect(stub.requests.count == 1)
        await SiriData.shared.reset()
    }

    @Test func diagnosticsNeverSerializeErrorPayloadOrCustomDates() {
        var p = SiriDiagnostics.Parameters(); p.customFrom = true; p.fromState = .set
        var events: [SiriDiagnostics.Event] = []
        SiriDiagnostics.testObserver = { events.append($0) }
        defer { SiriDiagnostics.testObserver = nil }
        var trace = SiriDiagnostics.Invocation("FleetGrowthIntent", parameters: p)
        trace.fail(APIError.http(status: 503, code: "secret VIN 123 private-coordinate 30.123"))
        trace.fail(IntentFailure.unavailable) // translated error must not obscure original category
        #expect(events.count == 2 && events.last?.error == "http_503")
        #expect(events.allSatisfy { !$0.line.contains("secret") && !$0.line.contains("30.123") && !$0.line.contains("VIN 123") })
        #expect(events.last?.parameters.customFrom == true)
    }
}
}
