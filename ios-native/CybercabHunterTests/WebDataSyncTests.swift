import Testing
import Foundation
import MapKit
@testable import CybercabHunter

/// The bundled zones, charging locations and US map are the website's own
/// (ios-native/scripts/sync-web-data.mjs). These read the website's files from
/// the repository (the simulator runs on this Mac) and fail if they drifted:
/// rerun the script.
struct WebDataSyncTests {
    private func site(_ path: String) throws -> String {
        try String(contentsOf: TestFixtures.repoRoot.appendingPathComponent("public/\(path)"), encoding: .utf8)
    }
    /// The [lng, lat] pairs of a `const NAME = [ … ];` in the site's JS.
    private func pairs(in source: String, constant: String) throws -> [[Double]] {
        let start = try #require(source.range(of: "const \(constant) = ["))
        let end = try #require(source.range(of: "];", range: start.upperBound..<source.endIndex))
        let body = String(source[start.upperBound..<end.lowerBound])
        let regex = try NSRegularExpression(pattern: #"\[\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*\]"#)
        return regex.matches(in: body, range: NSRange(body.startIndex..., in: body)).map { m in
            [Double(body[Range(m.range(at: 1), in: body)!])!, Double(body[Range(m.range(at: 2), in: body)!])!]
        }
    }

    @Test func zonesMatchTheWebsite() throws {
        let js = try site("js/austin-map.js")
        #expect(WebData.city("austin").zone == (try pairs(in: js, constant: "SERVICE_ZONE")))
        #expect(WebData.city("dallas").zone == (try pairs(in: js, constant: "DALLAS_SERVICE_ZONE")))
        // The Zones page keeps its own Austin copy; it must be the same.
        #expect(WebData.city("austin").zone == (try pairs(in: try site("infrastructure.html"), constant: "serviceZoneCoords")))
        #expect(WebData.city("austin").polygon.count == 42 && WebData.city("dallas").polygon.count == 23)
    }

    @Test func chargingLocationsMatchTheWebsite() throws {
        let js = try site("js/austin-map.js"), page = try site("infrastructure.html")
        for c in WebData.city("austin").charging { #expect(js.contains("name: '\(c.name)', lat: \(c.lat), lng: \(c.lng)")) }
        for c in WebData.city("dallas").charging { #expect(page.contains("name: '\(c.name)', lat: \(c.lat), lng: \(c.lng)")) }
        #expect(WebData.city("austin").charging.map(\.name) == ["St. Elmo Robotaxi Charging Hub", "Ridgepoint Robotaxi Charging Site"])
        #expect(WebData.city("dallas").charging.map(\.name) == ["Irving Robotaxi Hub"])
    }

    @Test func usMapMatchesTheWebsite() throws {
        let js = try site("js/us-sightings-data.js")
        let map = WebData.usMap
        #expect(map.states.count == 51 && map.cities.count == 211)
        for s in map.states.prefix(5) { #expect(js.contains(#""id":"\#(s.id)","name":"\#(s.name)""#)) }
        for c in map.cities.prefix(10) { #expect(js.contains(#""name":"\#(c.name)","st":"\#(c.st)""#)) }
        #expect(map.sighted.allSatisfy { js.contains("\"\($0)\"") })
    }

    @Test func zoneFramesCoverTheirCity() {
        let austin = WebData.city("austin").zoneRect, dallas = WebData.city("dallas").zoneRect
        #expect(austin.contains(MKMapPoint(CLLocationCoordinate2D(latitude: 30.2672, longitude: -97.7431))))   // downtown Austin
        #expect(dallas.contains(MKMapPoint(CLLocationCoordinate2D(latitude: 32.7767, longitude: -96.7970))))   // downtown Dallas
        #expect(!austin.intersects(dallas))
    }
}
