import Testing
import Foundation
import MapKit
@testable import CybercabHunter

/// The bundled zones, Robotaxi facilities and US map are the website's own
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
        #expect(WebData.city("austin").polygon.count == 32 && WebData.city("dallas").polygon.count == 16)
    }

    /// Robotaxi facilities: the app ships the website's very file, and reads it the same way.
    @Test @MainActor func facilitiesMatchTheWebsite() throws {
        let site = try Data(contentsOf: TestFixtures.repoRoot.appendingPathComponent("public/data/facilities.json"))
        let bundled = try Data(contentsOf: try #require(Bundle.main.url(forResource: "facilities", withExtension: "json")))
        #expect(bundled == site, "rerun ios-native/scripts/sync-web-data.mjs")
        let data = try #require(FacilityStore.decode(bundled))
        #expect(data.facilities.map(\.id) == ["austin-st-elmo", "austin-ridgepoint", "irving-royal-lane", "dallas-cedar-springs"])
        // The marker labels use the file's own words.
        for kind in [Facility.Kind.charging, .staging, .combined] { #expect(FacilityStore.typeTitle(kind) == data.labels.type[kind.rawValue]) }
        let store = FacilityStore()
        #expect(store.facilities(in: "austin").map(\.name) == ["St. Elmo Robotaxi Charging Hub", "Ridgepoint Robotaxi Charging Site"])
        #expect(store.facilities(in: "dallas").map(\.name) == ["Irving Robotaxi Hub", "Dallas Cedar Springs Staging Ground"])
    }

    /// The filter, per city: a combined site shows under both; one city's filter leaves the other alone.
    @Test @MainActor func facilityFiltersPerCity() {
        let store = FacilityStore()
        store.filters["dallas"] = .charging
        #expect(store.visible(in: "dallas").map(\.id) == ["irving-royal-lane"])
        store.filters["dallas"] = .staging
        #expect(store.visible(in: "dallas").map(\.id) == ["irving-royal-lane", "dallas-cedar-springs"])
        #expect(store.filter(for: "austin") == .all && store.visible(in: "austin").count == 2)
        store.filters["austin"] = .staging
        #expect(store.visible(in: "austin").isEmpty)
    }

    /// Cedar Springs: a staging ground with the owner's photos from the site, never charging.
    @Test @MainActor func cedarSpringsIsAStagingGround() throws {
        let c = try #require(FacilityStore().facility("dallas-cedar-springs"))
        #expect(c.type == .staging && c.charging.isEmpty && !c.hasCharging)
        #expect(c.photos.count == 3 && c.photos.allSatisfy { $0.url?.absoluteString.hasPrefix("https://cybercabhunter.com/images/facilities/dallas-cedar-springs/") == true })
        #expect(c.webURL.absoluteString.hasSuffix("/infrastructure?city=dallas&facility=dallas-cedar-springs"))
        #expect(Facility.day(c.lastVerified) == "Nov 16, 2026")
        // Only the site's own facility images, never a hotlink.
        #expect(Facility.Photo.url("https://evil.example/x.webp") == nil && Facility.Photo.url("/images/other/x.webp") == nil)
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
