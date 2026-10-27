import Foundation
import CoreLocation
import Observation

/// The Zones screen's data, all real (worker/camera-sightings.js, fleet-stats,
/// homepage-stats, /data/traffic-cameras.json):
///   live    each camera's latest Cybercab detection in the last 24 h (refreshed every 60 s)
///   heat    detections per camera for a period, cached per city + period
///   cameras the camera inventory (dots in Heatmap mode)
///   fleet   Fleet & Fares; facts: the zone facts
@MainActor
@Observable
final class ZonesModel {
    enum Mode: String, CaseIterable, Identifiable { case normal, heat; var id: String { rawValue } }
    enum Load<T: Equatable>: Equatable { case idle, loading, loaded(T), failed(String) }

    var city = "austin"
    var mode: Mode = .normal
    var heatRange: HeatRange = .d7
    var heatHour: Int?

    private(set) var live: [String: [CameraDetection]] = [:]
    private(set) var liveError: String?
    private(set) var heat: [String: Load<CameraHeat>] = [:]
    private(set) var cameras: [TrafficCamera] = []
    private(set) var fleet: [String: FleetStats] = [:]
    private(set) var facts: [String: HomepageStats] = [:]

    var cityData: WebData.City { WebData.city(city) }
    var heatKey: String { "\(city)|\(heatRange.rawValue)" }
    var currentHeat: Load<CameraHeat> { heat[heatKey] ?? .idle }

    // MARK: loading

    func loadLive(using api: APIClient) async {
        let asked = city
        do {
            let query = asked == "austin" ? [] : [URLQueryItem(name: "city", value: asked)]
            let list: [CameraDetection] = try await api.get("/api/camera-sightings", query: query)
            guard asked == city else { return }   // the city changed meanwhile
            var seen = Set<String>()
            live[asked] = list.filter { seen.insert($0.cameraId).inserted && $0.lat.isFinite && $0.lng.isFinite }
            liveError = nil
        } catch is CancellationError {
        } catch {
            liveError = (error as? LocalizedError)?.errorDescription
        }
    }

    func loadHeat(using api: APIClient) async {
        let key = heatKey, asked = city, range = heatRange
        if case .loaded = heat[key] { return }
        heat[key] = .loading
        do {
            async let h: CameraHeat = api.get("/api/camera-sightings/heat", query: [URLQueryItem(name: "city", value: asked), URLQueryItem(name: "range", value: range.rawValue)])
            async let c: Void = loadCameras(using: api)
            let value = try await h
            _ = await c
            heat[key] = .loaded(value)
        } catch is CancellationError {
            heat[key] = nil
        } catch {
            heat[key] = .failed("Couldn't load the detection history. Try again shortly.")
        }
    }

    func loadCameras(using api: APIClient) async {
        guard cameras.isEmpty else { return }
        if let list: [TrafficCamera] = try? await api.get("/data/traffic-cameras.json") { cameras = list }
    }

    func loadPanel(using api: APIClient) async {
        let asked = city
        async let f: FleetStats? = try? api.get("/api/fleet-stats", query: [URLQueryItem(name: "city", value: asked)])
        async let s: HomepageStats? = try? api.get("/api/homepage-stats", query: [URLQueryItem(name: "city", value: asked)], fresh: true)
        if let v = await f { fleet[asked] = v }
        if let v = await s { facts[asked] = v }
    }

    // MARK: heat for the selection (js/zones-heatmap.js draw())

    struct HeatPoint: Identifiable, Equatable { let id: String; let coordinate: CLLocationCoordinate2D; let weight: Double
        static func == (a: HeatPoint, b: HeatPoint) -> Bool { a.id == b.id && a.weight == b.weight } }
    struct CameraDot: Identifiable, Equatable { let id: String; let name: String; let coordinate: CLLocationCoordinate2D; let count: Int
        static func == (a: CameraDot, b: CameraDot) -> Bool { a.id == b.id && a.count == b.count } }

    /// Heat at the cameras with detections, square-root weights (the busiest
    /// camera hottest; a single detection still glows faintly).
    var heatPoints: [HeatPoint] {
        guard case .loaded(let h) = currentHeat else { return [] }
        let rows = h.cameras.map { ($0, CameraHeat.stats(for: $0, hour: heatHour).count) }.filter { $0.1 > 0 }
        let maxCount = Double(rows.map(\.1).max() ?? 1)
        return rows.map { HeatPoint(id: $0.0.cameraId, coordinate: .init(latitude: $0.0.lat, longitude: $0.0.lng), weight: (Double($0.1) / maxCount).squareRoot()) }
    }

    /// Every camera of the city as a dot (and any detecting camera missing from the list).
    var cameraDots: [CameraDot] {
        guard case .loaded(let h) = currentHeat else { return [] }
        var counts: [String: Int] = [:]
        for c in h.cameras { counts[c.cameraId] = CameraHeat.stats(for: c, hour: heatHour).count }
        var dots = cameras.filter { $0.cityKey == city }.map { CameraDot(id: $0.cameraId, name: $0.name, coordinate: .init(latitude: $0.lat, longitude: $0.lng), count: counts[$0.cameraId] ?? 0) }
        let listed = Set(dots.map(\.id))
        for c in h.cameras where !listed.contains(c.cameraId) {
            dots.append(CameraDot(id: c.cameraId, name: c.cameraName, coordinate: .init(latitude: c.lat, longitude: c.lng), count: counts[c.cameraId] ?? 0))
        }
        return dots
    }

    var heatSpan: String { heatRange.phrase + (heatHour.map { ", \(Self.hourSpan($0))" } ?? "") }

    /// "69 detections at 25 cameras · the last 7 days" / "No Cybercab detections in …"
    var heatStatus: String {
        switch currentHeat {
        case .idle, .loading: return "Loading detections…"
        case .failed(let m): return m
        case .loaded(let h):
            let rows = h.cameras.map { CameraHeat.stats(for: $0, hour: heatHour).count }.filter { $0 > 0 }
            let total = rows.reduce(0, +)
            if total == 0 { return "No Cybercab detections in \(heatSpan)." }
            return "\(Format.plural(total, "detection", "detections")) at \(Format.plural(rows.count, "camera", "cameras")) · \(heatSpan)"
        }
    }

    func heatCamera(_ id: String) -> CameraHeat.Camera? {
        guard case .loaded(let h) = currentHeat else { return nil }
        return h.cameras.first { $0.cameraId == id }
    }

    static let days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
    static func hourName(_ h: Int) -> String { "\(h % 12 == 0 ? 12 : h % 12) \(h < 12 ? "AM" : "PM")" }
    static func hourSpan(_ h: Int) -> String { "\(hourName(h))–\(hourName((h + 1) % 24))" }
}
