import Testing
import Foundation
@testable import CybercabHunter

/// Replay's city and autoplay (ReplayModel): opened from Zones it plays once
/// the sightings are in, never when there are none, and switching city
/// replaces everything of the last city.
@MainActor
struct ReplayCityTests {
    private func history(_ times: [Date], lat: Double = 30.27) -> String {
        let iso = ISO8601DateFormatter()
        let rows = times.enumerated().map { i, t in
            #"{"t":"\#(iso.string(from: t))","lat":\#(lat),"lng":-97.74,"camera_id":"c\#(i)","camera_name":"Cam \#(i)","source":"camera"}"#
        }
        return #"{"detections":[\#(rows.joined(separator: ","))],"next_cursor":null}"#
    }
    private let recent = [Date().addingTimeInterval(-3600), Date().addingTimeInterval(-1800)]
    /// The last replay-history request's query (the camera list is fetched alongside).
    private func lastHistoryQuery(_ stub: StubServer) -> String {
        stub.requests.last { $0.0.url?.path == "/api/camera-sightings/history" }?.0.url?.query ?? ""
    }

    @Test func fromZonesItPlaysOnceTheSightingsAreIn() async {
        let stub = StubServer()
        stub.responses = ["GET /api/camera-sightings/history": (200, history(recent))]
        let m = ReplayModel(city: "austin", autoplay: true)
        #expect(!m.playing, "nothing plays before the data")
        await m.load(using: stub.api())
        #expect(m.sightings.count == 2 && m.playing, "playing on its own")
    }

    @Test func otherwiseItWaitsForPlay() async {
        let stub = StubServer()
        stub.responses = ["GET /api/camera-sightings/history": (200, history(recent))]
        let m = ReplayModel(city: "austin")
        await m.load(using: stub.api())
        #expect(m.sightings.count == 2 && !m.playing, "Sightings' Replay Map link doesn't autoplay")
    }

    @Test func noSightingsMeansNotPlaying() async {
        let stub = StubServer()
        stub.responses = ["GET /api/camera-sightings/history": (200, history([]))]
        let m = ReplayModel(city: "austin", autoplay: true)
        await m.load(using: stub.api())
        #expect(m.phase == .loaded && m.sightings.isEmpty && !m.playing, "an empty window never pretends to play")
    }

    @Test func aFailedLoadDoesntPlay() async {
        let stub = StubServer()   // 404 for everything
        let m = ReplayModel(city: "austin", autoplay: true)
        await m.load(using: stub.api())
        if case .failed = m.phase {} else { Issue.record("expected a failure, got \(m.phase)") }
        #expect(!m.playing)
    }

    @Test func switchingCityLoadsThatCityAndKeepsPlaying() async {
        let stub = StubServer()
        stub.responses = ["GET /api/camera-sightings/history": (200, history(recent))]
        let api = stub.api()
        let m = ReplayModel(city: "austin")
        await m.load(using: api)
        m.togglePlay()
        #expect(m.playing)

        m.switchCity("dallas")
        #expect(m.city == "dallas" && m.sightings.isEmpty && m.cameras.isEmpty && !m.playing, "nothing of Austin is left on the Dallas map")
        await m.load(using: api)
        let q = lastHistoryQuery(stub)
        #expect(q.contains("city=dallas"), "Dallas's sightings: \(q)")
        #expect(m.playing, "it was playing, so it plays again with Dallas's data")

        m.switchCity("atlantis")
        #expect(m.city == "dallas", "only Austin or Dallas")
    }

    @Test func aPausedReplayStaysPausedAfterSwitching() async {
        let stub = StubServer()
        stub.responses = ["GET /api/camera-sightings/history": (200, history(recent))]
        let api = stub.api()
        let m = ReplayModel(city: "dallas")
        await m.load(using: api)
        m.switchCity("austin")
        await m.load(using: api)
        #expect(!m.playing)
        let q = lastHistoryQuery(stub)
        #expect(!q.isEmpty && !q.contains("city="), "Austin is the API's default city: \(q)")
    }

    @Test func aLateAnswerForTheOldCityIsDropped() async {
        let stub = StubServer()
        stub.responses = ["GET /api/camera-sightings/history": (200, history(recent))]
        let m = ReplayModel(city: "austin")
        let austin = Task { await m.load(using: stub.api()) }
        while m.phase != .loading { await Task.yield() }   // Austin's request is out
        m.switchCity("dallas")   // before Austin's answer lands
        await austin.value
        #expect(m.city == "dallas" && m.sightings.isEmpty, "Austin's late answer never lands on Dallas")
    }

    @Test func bothZonesFitTheirMap() {
        for key in ["austin", "dallas"] {
            let r = WebData.city(key).zoneRect
            #expect(!r.isNull && r.width > 0 && r.height > 0, "\(key) has a zone to frame")
        }
        #expect(ReplayMapView.framePadding > 0 && ReplayMapView.framePadding < 0.15, "room around the zone, not a distant view")
    }
}
