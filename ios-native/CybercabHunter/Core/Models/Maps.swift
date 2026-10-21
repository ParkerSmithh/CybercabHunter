import Foundation
import CoreLocation

/// GET /api/camera-sightings[?city=]: each camera's latest detection in the
/// last 24 hours (worker/camera-sightings.js). A camera saw a Cybercab there;
/// it is not a live vehicle position and carries no vehicle id.
struct CameraDetection: Decodable, Sendable, Equatable, Identifiable {
    let cameraId: String
    let cameraName: String
    let lat: Double
    let lng: Double
    let observedAt: String
    let imageUrl: String?
    var id: String { cameraId }
    var coordinate: CLLocationCoordinate2D { .init(latitude: lat, longitude: lng) }
    /// Only the API's own image route is trusted (as the website checks).
    var imageURL: URL? {
        guard let imageUrl, imageUrl.range(of: #"^/api/camera-sightings/[A-Za-z0-9-]+/image$"#, options: .regularExpression) != nil else { return nil }
        return URL(string: imageUrl, relativeTo: AppConfig.siteURL)?.absoluteURL
    }
}

/// GET /api/camera-sightings/heat?city=&range=: detections per camera for a
/// period, with a 7×24 weekday×hour grid (Austin time) for the hour filter.
struct CameraHeat: Decodable, Sendable, Equatable {
    let city: String
    let range: String
    let from: String?
    let to: String?
    let total: Int
    let cameras: [Camera]

    struct Camera: Decodable, Sendable, Equatable, Identifiable {
        let cameraId: String
        let cameraName: String
        let lat: Double
        let lng: Double
        let count: Int
        let last: String?
        let grid: [Int]?
        let lastByHour: [String?]?
        var id: String { cameraId }
    }

    /// One camera's numbers for the selection (js/zones-heatmap.js statsFor):
    /// hour nil = all hours.
    struct Stats: Equatable { let count: Int; let last: String?; let busiestHour: Int?; let busiestDay: Int? }

    static func stats(for cam: Camera, hour: Int?) -> Stats {
        let g = cam.grid ?? []
        var byHour = [Int](repeating: 0, count: 24), byDay = [Int](repeating: 0, count: 7)
        for d in 0..<7 {
            for h in 0..<24 {
                let n = d * 24 + h < g.count ? g[d * 24 + h] : 0
                if let hour, h != hour { continue }
                byHour[h] += n; byDay[d] += n
            }
        }
        func argmax(_ a: [Int]) -> Int? {
            var best = -1, index = -1
            for (k, v) in a.enumerated() where v > best { best = v; index = k }
            return best > 0 ? index : nil
        }
        let last: String? = hour == nil ? cam.last : (hour.flatMap { h in (cam.lastByHour ?? []).count > h ? cam.lastByHour?[h] ?? nil : nil })
        return Stats(count: byDay.reduce(0, +), last: last, busiestHour: argmax(byHour), busiestDay: argmax(byDay))
    }
}

/// The heat periods (js/zones-heatmap.js RANGES).
enum HeatRange: String, CaseIterable, Identifiable, CustomStringConvertible, Sendable {
    case h24 = "24h", d7 = "7d", d30 = "30d", all = "all"
    var id: String { rawValue }
    var description: String { switch self { case .h24: "24H"; case .d7: "7D"; case .d30: "30D"; case .all: "All" } }
    var phrase: String { switch self { case .h24: "the last 24 hours"; case .d7: "the last 7 days"; case .d30: "the last 30 days"; case .all: "all time" } }
}

/// /data/traffic-cameras.json: every camera in the watch (the real inventory).
struct TrafficCamera: Decodable, Sendable, Equatable, Identifiable {
    let cameraId: String
    let name: String
    let lat: Double
    let lng: Double
    let city: String?
    var id: String { cameraId }
    var cityKey: String { city ?? "austin" }   // an untagged camera is Austin (as the site reads it)

    enum CodingKeys: String, CodingKey { case cameraId, name, lat, lng, city }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // Ids are strings in the file; tolerate numbers.
        if let s = try? c.decode(String.self, forKey: .cameraId) { cameraId = s } else { cameraId = String(try c.decode(Int.self, forKey: .cameraId)) }
        name = try c.decode(String.self, forKey: .name)
        lat = try c.decode(Double.self, forKey: .lat)
        lng = try c.decode(Double.self, forKey: .lng)
        city = try c.decodeIfPresent(String.self, forKey: .city)
    }
}

/// GET /api/camera-sightings/history?from=&to=&limit=&cursor=[&city=]: every
/// detection in a window, paged, for the Replay.
struct DetectionHistory: Decodable, Sendable, Equatable {
    let detections: [Detection]
    let nextCursor: String?

    struct Detection: Decodable, Sendable, Equatable {
        let t: String
        let lat: Double
        let lng: Double
        let cameraId: String?
        let cameraName: String?
        let source: String?
    }
}

/// GET /api/fleet-stats?city=: the Zones panel's Fleet & Fares.
struct FleetStats: Decodable, Sendable, Equatable {
    let city: String
    let cybercabs: Int?
    let fares: Fares?
    struct Fares: Decodable, Sendable, Equatable {
        let rides: Int?
        let computedAt: String?
        let medianFare: Double?
        let averageFare: Double?
        let perMile: Double?
    }
}

/// GET /api/places/map?v=2&q=&area=: place search on the Zones map.
struct PlaceResults: Decodable, Sendable, Equatable {
    let places: [Place]
    struct Place: Decodable, Sendable, Equatable, Identifiable, Hashable {
        let id: String
        let label: String
        let lat: Double
        let lng: Double
    }
}
