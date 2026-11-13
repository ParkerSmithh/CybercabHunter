import Testing
import Foundation
@testable import CybercabHunter

/// Cybercab Daily is always today's answer: Cloudflare serves cached
/// /api/daily with max-age=14400 (4 hours), so every place the app asks for
/// it skips this phone's HTTP cache (the edge cache still answers). Without
/// that, the Home card and the Live Activity showed an old response (5 and 5)
/// after the server's fix (0 and 7).
@MainActor
@Suite(.serialized)
struct DailyFreshnessTests {
    private func body(sightings: Int, detections: Int, generated: String) -> String {
        #"{"today":"2026-11-13","timezone":"America/Chicago","generated_at":"\#(generated)","errors":{},"day":{"date":"2026-11-13","registry":3,"dmv":0,"sightings":\#(sightings),"cameras":\#(detections)},"previous":{"date":"2026-11-12","registry":2,"dmv":0,"sightings":0,"cameras":13}}"#
    }
    private func dailyRequests(_ stub: StubServer) -> [URLRequest] { stub.requests.map(\.0).filter { $0.url?.path == "/api/daily" } }

    @Test func homeAsksPastThePhonesCacheAndNewFiguresReplaceOld() async throws {
        let stub = StubServer()
        stub.responses = ["GET /api/daily": (200, body(sightings: 5, detections: 5, generated: "2026-11-13T15:00:00Z"))]
        let model = HomeModel()
        await model.loadDaily(using: stub.api())
        #expect(dailyRequests(stub).last?.cachePolicy == .reloadIgnoringLocalCacheData, "the phone's 4-hour cache is skipped")
        #expect(model.daily?.day.sightings == 5 && model.daily?.day.cameras == 5)

        stub.responses = ["GET /api/daily": (200, body(sightings: 0, detections: 7, generated: "2026-11-13T18:55:15Z"))]
        await model.loadDaily(using: stub.api())
        let report = try #require(model.daily)
        #expect(report.day.sightings == 0 && report.day.cameras == 7, "the fresh answer replaces the old one")
        #expect(dailyRequests(stub).count == 2, "one request per load, as before")

        // The Live Activity takes the same report: separate figures, the new ones.
        let state = ServiceActivityAttributes.ContentState(report)
        #expect(state.sightings == 0 && state.detections == 7 && state.detectionsYesterday == 13)
    }

    @Test func widgetsAskPastThePhonesCache() async throws {
        let stub = StubServer()
        stub.responses = ["GET /api/daily": (200, body(sightings: 0, detections: 7, generated: "2026-11-13T18:55:15Z"))]
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        let session = URLSession(configuration: config)
        _ = try? await WidgetAPI.get("/api/daily", base: URL(string: "https://\(stub.host)")!, session: session)
        #expect(dailyRequests(stub).last?.cachePolicy == .reloadIgnoringLocalCacheData, "Home Screen widgets: today's figures, never the 4-hour copy")
        _ = try? await WidgetAPI.get("/api/registry/stats", base: URL(string: "https://\(stub.host)")!, session: session)
        #expect(stub.requests.last?.0.cachePolicy == .useProtocolCachePolicy, "other widget requests keep their caching")
    }

    @Test func siriAsksPastThePhonesCache() async throws {
        let stub = StubServer()
        stub.responses = ["GET /api/daily": (200, body(sightings: 0, detections: 7, generated: "2026-11-13T18:55:15Z"))]
        SiriData.testAPI = stub.api(token: nil)
        defer { SiriData.testAPI = nil }
        await SiriData.shared.reset()
        let report: DailyReport = try await SiriData.shared.get("/api/daily")
        #expect(report.day.sightings == 0 && report.day.cameras == 7)
        #expect(dailyRequests(stub).last?.cachePolicy == .reloadIgnoringLocalCacheData)
        await SiriData.shared.reset()
    }
}
