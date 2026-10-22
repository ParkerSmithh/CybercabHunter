import Foundation
import CoreLocation
import Observation

/// The Replay (the website's js/replay.js): every camera-recorded Cybercab in
/// a window, in order, from GET /api/camera-sightings/history (paged).
/// Nothing is invented: a sighting is drawn where the camera is, when it was
/// recorded; no movement between sightings is ever drawn.
@MainActor
@Observable
final class ReplayModel {
    enum Range: String, CaseIterable, Identifiable, CustomStringConvertible {
        case month, h24 = "24h", d7 = "7d"
        var id: String { rawValue }
        var description: String { switch self { case .month: "This Month"; case .h24: "Last 24 hours"; case .d7: "Last 7 days" } }
        var span: Double? { switch self { case .month: nil; case .h24: 86_400; case .d7: 7 * 86_400 } }
    }
    enum Phase: Equatable { case idle, loading, loaded, failed(String) }

    struct Sighting: Identifiable, Equatable {
        let id: Int
        let t: Date
        let coordinate: CLLocationCoordinate2D
        let cameraKey: String
        let cameraName: String
        let spotter: Bool
        static func == (a: Sighting, b: Sighting) -> Bool { a.id == b.id }
    }

    static let speeds: [Double] = [1, 4, 16, 60]
    static let playSecondsAt1x: Double = 150   // any window plays in ~2.5 minutes at 1×
    static let maxPages = 40

    let city: String
    var range: Range = .month
    var date: Date?                    // nil = now (the site's ?date=)
    private(set) var phase: Phase = .idle
    private(set) var sightings: [Sighting] = []
    private(set) var cameras: [TrafficCamera] = []
    private(set) var window: (start: Date, end: Date) = (.now, .now)

    // Playback
    var speedIndex = 0
    private(set) var playing = false
    private var anchorWall = Date.now
    private var anchorT = Date.now
    private var pausedT: Date?

    init(city: String) { self.city = city }

    // MARK: the window (js/replay.js windowFor), Austin time

    static func window(for range: Range, date: Date?, now: Date = .now) -> (start: Date, end: Date) {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = Format.central
        switch range {
        case .month:
            let ref = date ?? now
            let start = cal.date(from: cal.dateComponents([.year, .month], from: ref))!
            let next = cal.date(byAdding: .month, value: 1, to: start)!
            return (start, min(now, next))
        case .h24, .d7:
            let end = date.map { min(now, cal.date(byAdding: .day, value: 1, to: cal.startOfDay(for: $0))!) } ?? now
            return (end.addingTimeInterval(-range.span!), end)
        }
    }

    /// Ribbon bars: one per half hour (24h), per 3 hours (7d), per 12 hours (month).
    static func bins(for range: Range, start: Date, end: Date) -> Int {
        switch range {
        case .h24: 48
        case .d7: 56
        case .month: max(2, Int((end.timeIntervalSince(start) / (12 * 3600)).rounded(.up)))
        }
    }

    // MARK: data

    func load(using api: APIClient) async {
        playing = false
        pausedT = nil
        window = Self.window(for: range, date: date)
        phase = .loading
        do {
            async let cams: Void = loadCameras(using: api)
            var all: [Sighting] = []
            var cursor: String?
            let iso = ISO8601DateFormatter()
            for _ in 0..<Self.maxPages {
                var q = [URLQueryItem(name: "from", value: iso.string(from: window.start)), URLQueryItem(name: "to", value: iso.string(from: window.end)), URLQueryItem(name: "limit", value: "1000")]
                if city != "austin" { q.append(URLQueryItem(name: "city", value: city)) }
                if let cursor { q.append(URLQueryItem(name: "cursor", value: cursor)) }
                let page: DetectionHistory = try await api.get("/api/camera-sightings/history", query: q)
                for d in page.detections {
                    guard let t = Format.instant(d.t), d.lat.isFinite, d.lng.isFinite else { continue }
                    all.append(Sighting(id: all.count, t: t, coordinate: .init(latitude: d.lat, longitude: d.lng), cameraKey: d.cameraId ?? "\(d.lat),\(d.lng)", cameraName: d.cameraName ?? "", spotter: d.source == "spotter"))
                }
                cursor = page.nextCursor
                if cursor == nil { break }
            }
            _ = await cams
            sightings = all.sorted { $0.t < $1.t }
            phase = .loaded
            pausedT = window.start
        } catch is CancellationError {
        } catch {
            phase = .failed((error as? LocalizedError)?.errorDescription ?? "Couldn't load the replay.")
        }
    }

    private func loadCameras(using api: APIClient) async {
        guard cameras.isEmpty else { return }
        if let list: [TrafficCamera] = try? await api.get("/data/traffic-cameras.json") { cameras = list.filter { $0.cityKey == city } }
    }

    // MARK: playback

    var speed: Double { Self.speeds[speedIndex] }
    /// Replay time per real second.
    var rate: Double { max(1, window.end.timeIntervalSince(window.start)) / Self.playSecondsAt1x * speed }

    func time(at wall: Date) -> Date {
        if let pausedT { return pausedT }
        let t = anchorT.addingTimeInterval(wall.timeIntervalSince(anchorWall) * rate)
        return min(t, window.end)
    }

    func togglePlay(now: Date = .now) {
        if playing { pausedT = time(at: now); playing = false; return }
        var from = pausedT ?? window.start
        if from >= window.end { from = window.start }
        anchorT = from; anchorWall = now; pausedT = nil; playing = true
    }

    func seek(to t: Date, now: Date = .now) {
        let clamped = min(max(t, window.start), window.end)
        if playing { anchorT = clamped; anchorWall = now } else { pausedT = clamped }
    }

    func setSpeed(_ index: Int, now: Date = .now) {
        let t = time(at: now)
        speedIndex = index
        if playing { anchorT = t; anchorWall = now }
    }

    /// Stops at the end of the window.
    func tick(now: Date) { if playing, time(at: now) >= window.end { pausedT = window.end; playing = false } }

    /// How many sightings landed at or before t (binary search; sorted).
    func count(upTo t: Date) -> Int {
        var lo = 0, hi = sightings.count
        while lo < hi { let mid = (lo + hi) / 2; if sightings[mid].t <= t { lo = mid + 1 } else { hi = mid } }
        return lo
    }

    func histogram() -> [Int] {
        let n = Self.bins(for: range, start: window.start, end: window.end)
        var h = [Int](repeating: 0, count: n)
        let span = window.end.timeIntervalSince(window.start)
        guard span > 0 else { return h }
        for s in sightings {
            let i = min(n - 1, Int(s.t.timeIntervalSince(window.start) / span * Double(n)))
            if i >= 0 { h[i] += 1 }
        }
        return h
    }

    /// Night / Dawn / Midday / Dusk for the replay's clock (Austin time).
    static func dayPart(_ t: Date) -> String {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = Format.central
        let h = cal.component(.hour, from: t)
        switch h { case 5..<8: return "Dawn"; case 8..<17: return "Midday"; case 17..<20: return "Dusk"; default: return "Night" }
    }
}
