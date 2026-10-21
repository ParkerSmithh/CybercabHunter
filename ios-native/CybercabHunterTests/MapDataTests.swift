import Testing
import Foundation
import MapKit
@testable import CybercabHunter

/// Real map responses (Oct 20, 2026) and the website's map rules.
struct MapDataTests {
    @Test func liveCameraDetections() throws {
        let live: [CameraDetection] = try TestFixtures.decode("camera-sightings-austin")
        #expect(!live.isEmpty)
        let first = try #require(live.first)
        #expect(first.cameraId == "133" && first.cameraName == "6TH ST / CONGRESS AVE")
        #expect(abs(first.coordinate.latitude - 30.268066) < 1e-9 && abs(first.coordinate.longitude - -97.742813) < 1e-9)
        #expect(first.imageURL?.absoluteString.hasPrefix("https://cybercabhunter.com/api/camera-sightings/") == true)
        #expect(Set(live.map(\.cameraId)).count == live.count, "one marker per camera")
    }

    @Test func untrustedImagePathsAreIgnored() throws {
        let json = #"[{"camera_id":"1","camera_name":"X","lat":30,"lng":-97,"observed_at":"2026-10-20T00:00:00Z","image_url":"https://evil.example/x.png"}]"#
        let d = try APIClient.makeDecoder().decode([CameraDetection].self, from: Data(json.utf8))
        #expect(d.first?.imageURL == nil)
    }

    @Test func heatDecodingAndHourFilterMatchTheWebsite() throws {
        let heat: CameraHeat = try TestFixtures.decode("camera-heat-austin-7d")
        #expect(heat.city == "austin" && heat.range == "7d")
        #expect(heat.cameras.reduce(0) { $0 + $1.count } == heat.total)
        #expect(heat.cameras.allSatisfy { ($0.grid ?? []).count == 168 })
        // Expected values computed by the website's own statsFor (js/zones-heatmap.js).
        struct Case: Decodable { let camera_id: String; let hour: Int?; let stats: S; struct S: Decodable { let count: Int; let last: String?; let busiestHour: Int?; let busiestDay: Int? } }
        let cases = try JSONDecoder().decode([Case].self, from: TestFixtures.data("heat-stats-expected"))
        #expect(cases.count == 40)
        for c in cases {
            let cam = try #require(heat.cameras.first { $0.cameraId == c.camera_id })
            let s = CameraHeat.stats(for: cam, hour: c.hour)
            #expect(s == CameraHeat.Stats(count: c.stats.count, last: c.stats.last, busiestHour: c.stats.busiestHour, busiestDay: c.stats.busiestDay), "camera \(c.camera_id) hour \(String(describing: c.hour))")
        }
    }

    @Test func cameraInventoryIsTheRealList() throws {
        let cams: [TrafficCamera] = try TestFixtures.decode("traffic-cameras")
        let byCity = Dictionary(grouping: cams, by: \.cityKey).mapValues(\.count)
        #expect(byCity["austin"] == 70 && byCity["dallas"] == 50)
        #expect(Set(cams.map(\.cameraId)).count == cams.count)
    }

    @Test func historyFleetStatsAndPlaces() throws {
        let h: DetectionHistory = try TestFixtures.decode("history-7d")
        #expect(h.detections.count == 70)
        #expect(h.detections.allSatisfy { $0.source == "watch" || $0.source == "spotter" })
        #expect(h.detections.allSatisfy { Format.instant($0.t) != nil })
        let f: FleetStats = try TestFixtures.decode("fleet-stats-dallas")
        #expect(f.city == "dallas" && f.cybercabs == 0 && f.fares?.medianFare == 6.4 && f.fares?.rides == 2)
        let p: PlaceResults = try TestFixtures.decode("places-congress")
        #expect(p.places.first?.label.contains("Congress") == true)
    }
}
