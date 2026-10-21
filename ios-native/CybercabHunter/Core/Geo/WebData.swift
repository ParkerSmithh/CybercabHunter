import Foundation
import CoreLocation
import MapKit

/// The website's fixed map data, copied unchanged by
/// ios-native/scripts/sync-web-data.mjs (Resources/WebData).
enum WebData {
    struct Zones: Decodable { let cities: [City] }

    struct City: Decodable, Identifiable, Equatable {
        let key: String
        let name: String
        let state: String
        /// [lng, lat] pairs, as in the site's JS.
        let zone: [[Double]]
        let charging: [ChargingLocation]
        var id: String { key }

        var polygon: [CLLocationCoordinate2D] { zone.map { CLLocationCoordinate2D(latitude: $0[1], longitude: $0[0]) } }

        /// The zone's bounding rect (the map frames it, like the site's fitBounds).
        var zoneRect: MKMapRect {
            polygon.map { MKMapRect(origin: MKMapPoint($0), size: MKMapSize(width: 0, height: 0)) }.reduce(MKMapRect.null) { $0.union($1) }
        }

        static func == (a: City, b: City) -> Bool { a.key == b.key }
    }

    struct ChargingLocation: Decodable, Equatable, Identifiable {
        let name: String
        let lat: Double
        let lng: Double
        let note: String
        var id: String { name }
        var coordinate: CLLocationCoordinate2D { .init(latitude: lat, longitude: lng) }
    }

    struct USMap: Decodable {
        let viewBox: String
        let sources: [Source]
        let sighted: [String]
        let states: [State]
        let cities: [USCity]
        struct Source: Decodable, Identifiable { let name: String; let what: String; let date: String; let url: String; var id: String { name } }
        struct State: Decodable, Identifiable { let id: String; let name: String; let d: String }
        struct USCity: Decodable, Identifiable, Hashable { let name: String; let st: String; let x: Double; let y: Double; let n: Int?; let note: String?; var id: String { "\(name)|\(st)" } }
    }

    static let zones: Zones = load("zones")
    static let usMap: USMap = load("us-map")

    static func city(_ key: String) -> City { zones.cities.first { $0.key == key } ?? zones.cities[0] }

    private static func load<T: Decodable>(_ name: String) -> T {
        guard let url = Bundle.main.url(forResource: name, withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let value = try? JSONDecoder().decode(T.self, from: data) else {
            fatalError("Resources/WebData/\(name).json is missing or invalid: run ios-native/scripts/sync-web-data.mjs")
        }
        return value
    }
}
