import Testing
import Foundation
import AppIntents
@testable import CybercabHunter

private func routingJSON(_ value: Any) throws -> String {
    String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
}

private func routingOverview() throws -> String {
    try routingJSON([
        "source": ["name": "TxDMV", "company": "Tesla", "authorization": "AV1", "law": "SB2807", "url": "https://txmccs.txdmv.gov", "fields": ["VIN"], "schedule": "Daily", "decoder": ["name": "vPIC", "url": "https://vpic.nhtsa.dot.gov"]],
        "latest": ["date": SiriSpeech.iso(.now)], "totals": ["total": 9876, "cybercab": 6543, "model_y": 3333, "unknown": 0, "other_tesla": 0],
        "freshness": ["status": "current"], "processing_pending": 0
    ])
}

private func routingCity(_ city: ServiceCity) throws -> String {
    let now = Date.now
    let dates = (0..<7).map { i in
        ["date": SiriSpeech.iso(CityActivitySpeech.calendar.date(byAdding: .day, value: -i, to: now)!), "count": 3] as [String: Any]
    }
    return try routingJSON(["city": city.rawValue, "name": city.title,
        "generated_at": ISO8601DateFormatter().string(from: now),
        "sightings": ["total": 31, "last_24h": 11, "last_7_days": 21, "daily": dates],
        "cameras": ["detections_24h": 777], "area": ["vehicles": 888]])
}

extension SiriSerial {
@MainActor
@Suite(.serialized)
struct SiriRoutingTests {
    /// Invokes every finite selection with matching saved parameters. Every
    /// request stays on the selected city's approved-sightings endpoint.
    @Test func everySightingsChoiceUsesOnlyItsCityDataSource() async throws {
        let stub = StubServer()
        SiriData.testAPI = stub.api(token: nil)
        defer { SiriData.testAPI = nil }
        for choice in CitySightingsQuestion.allCases {
            await SiriData.shared.reset()
            stub.requests = []
            stub.responses = ["GET /api/homepage-stats": (200, try routingCity(choice.city)),
                              "GET /api/dmv/overview": (200, try routingOverview())]
            var intent = RecentSightingsIntent()
            intent.city = choice.city
            intent.period = choice.period
            intent.question = choice
            let text = try #require(try await intent.perform().value)
            #expect(text.contains(choice.city.title))
            #expect(!text.contains("DMV") && !text.contains("VIN") && !text.contains("9,876") && !text.contains("6,543"))
            #expect(!text.contains("777") && !text.contains("888"), "neither cameras nor registry vehicles are sightings")
            if choice.period == .today || choice.period == .yesterday { #expect(text.contains("3 approved public sightings")) }
            #expect(stub.requests.count == 1)
            let request = try #require(stub.requests.first?.0)
            #expect(request.url?.path == "/api/homepage-stats")
            let query = URLComponents(url: try #require(request.url), resolvingAgainstBaseURL: false)?.queryItems
            #expect(query?.first { $0.name == "city" }?.value == choice.city.rawValue)
            #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
        }
        await SiriData.shared.reset()
    }

    @Test func warmDMVCacheCannotContaminateSightingsAnswer() async throws {
        let stub = StubServer()
        stub.responses = ["GET /api/dmv/overview": (200, try routingOverview()),
                          "GET /api/homepage-stats": (200, try routingCity(.austin))]
        SiriData.testAPI = stub.api(token: nil)
        defer { SiriData.testAPI = nil }
        await SiriData.shared.reset()
        var dmv = CheckDMVIntent(); dmv.question = .cybercab
        let dmvText = try #require(try await dmv.perform().value)
        #expect(dmvText.contains("6543") || dmvText.contains("6,543"))
        var sight = RecentSightingsIntent(); sight.question = .austinToday
        let a = try #require(try await sight.perform().value)
        let b = try #require(try await sight.perform().value)
        #expect(a == b && a.contains("3 approved public sightings today"))
        #expect(!a.contains("DMV") && !a.contains("VIN"))
        #expect(stub.requests.map { $0.0.url?.path } == ["/api/dmv/overview", "/api/homepage-stats"])
        await SiriData.shared.reset()
    }

    @Test func wrongPayloadAndSightingsOutageNeverFallBackToDMV() async throws {
        let stub = StubServer()
        SiriData.testAPI = stub.api(token: nil)
        defer { SiriData.testAPI = nil }
        var intent = RecentSightingsIntent(); intent.question = .austinToday
        for response in [(200, try routingOverview()), (503, "{}"), (200, "not json")] {
            await SiriData.shared.reset()
            stub.requests = []
            stub.responses = ["GET /api/homepage-stats": response, "GET /api/dmv/overview": (200, try routingOverview())]
            await #expect(throws: IntentFailure.self) { _ = try await intent.perform() }
            #expect(stub.requests.map { $0.0.url?.path } == ["/api/homepage-stats"])
            // Failure is not cached; the identical next ask can recover.
            stub.responses["GET /api/homepage-stats"] = (200, try routingCity(.austin))
            let recovered = try #require(try await intent.perform().value)
            #expect(recovered.contains("3 approved public sightings today"))
        }
        await SiriData.shared.reset()
    }

    @Test func dmvNeverRequestsCitySightings() async throws {
        let stub = StubServer()
        stub.responses = ["GET /api/dmv/overview": (200, try routingOverview())]
        SiriData.testAPI = stub.api(token: nil)
        defer { SiriData.testAPI = nil }
        await SiriData.shared.reset()
        var intent = CheckDMVIntent(); intent.question = .total
        let text = try #require(try await intent.perform().value)
        #expect(text.contains("9876") || text.contains("9,876"))
        #expect(!text.contains("approved public sightings"))
        #expect(stub.requests.map { $0.0.url?.path } == ["/api/dmv/overview"])
        await SiriData.shared.reset()
    }

    @Test func publicAnswersAreAvailableWithoutDeviceAuthentication() {
        #expect(RecentSightingsIntent.authenticationPolicy == .alwaysAllowed)
        #expect(CheckDMVIntent.authenticationPolicy == .alwaysAllowed)
        #expect(!RecentSightingsIntent.openAppWhenRun && !CheckDMVIntent.openAppWhenRun)
    }

    @Test func diagnosticsClassifyFailuresWithoutLoggingServerText() {
        #expect(SiriDiagnostics.errorCategory(APIError.http(status: 503, code: "private-details")) == "http_503")
        #expect(SiriDiagnostics.errorCategory(APIError.decoding("payload")) == "decoding")
        #expect(SiriDiagnostics.errorCategory(APIError.transport("URL or other details")) == "transport")
        #expect(SiriDiagnostics.errorCategory(CancellationError()) == "cancelled")
    }
}
}
