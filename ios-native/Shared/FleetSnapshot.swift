import Foundation

// Compiled into BOTH the app and the widget extension (the Shared folder is a
// synchronized group of both targets), so the widget, Siri and the app read
// the fleet the same way, from the same public endpoints as Home.

/// The headline fleet figures and today's Cybercab Daily:
/// GET /api/registry/stats (lifetime counters) and GET /api/daily (today, by
/// Central date). Public, read only; a count the server couldn't produce is nil.
struct FleetSnapshot: Codable, Equatable, Sendable {
    var registered: Int
    var rides: Int
    var sightings: Int
    /// Today's Cybercab Daily (Central date): new Cybercabs, sightings, camera detections.
    var date: String?
    var todayNewCybercabs: Int?
    var todaySightings: Int?
    var todayDetections: Int?
    var fetchedAt: Date

    /// What a widget shows before anything has loaded (never presented as real data: the views redact it).
    static let placeholder = FleetSnapshot(registered: 0, rides: 0, sightings: 0, date: nil,
                                           todayNewCybercabs: nil, todaySightings: nil, todayDetections: nil, fetchedAt: .distantPast)

    private struct Stats: Decodable { let publicVehicles: Int; let recordedRides: Int; let sightingsAllTime: Int }
    private struct Daily: Decodable {
        struct Day: Decodable { let date: String; let registry: Int?; let sightings: Int?; let cameras: Int? }
        let today: String
        let day: Day
    }

    enum LoadError: Error, Equatable { case http(Int), unreadable }

    /// Both endpoints at once. The counters are required; Daily is best effort
    /// (the widget still shows the counters if it fails).
    static func load(base: URL, session: URLSession = .shared, now: Date = .now) async throws -> FleetSnapshot {
        async let statsData = fetch(base, "/api/registry/stats", session)
        async let dailyData = try? fetch(base, "/api/daily", session)
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        guard let stats = try? decoder.decode(Stats.self, from: try await statsData) else { throw LoadError.unreadable }
        let daily = await dailyData.flatMap { try? decoder.decode(Daily.self, from: $0) }
        return FleetSnapshot(registered: stats.publicVehicles, rides: stats.recordedRides, sightings: stats.sightingsAllTime,
                             date: daily?.day.date, todayNewCybercabs: daily?.day.registry, todaySightings: daily?.day.sightings,
                             todayDetections: daily?.day.cameras, fetchedAt: now)
    }

    private static func fetch(_ base: URL, _ path: String, _ session: URLSession) async throws -> Data {
        var request = URLRequest(url: base.appending(path: path))
        request.timeoutInterval = 15
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw LoadError.http(status) }
        return data
    }

    /// "Today: +2 Cybercabs · 14 sightings · 5 camera detections" (the parts the server had).
    var todayLine: String? {
        var parts: [String] = []
        if let n = todayNewCybercabs { parts.append("+\(n) \(n == 1 ? "Cybercab" : "Cybercabs")") }
        if let n = todaySightings { parts.append("\(n) \(n == 1 ? "sighting" : "sightings")") }
        if let n = todayDetections { parts.append("\(n) camera \(n == 1 ? "detection" : "detections")") }
        return parts.isEmpty ? nil : "Today: " + parts.joined(separator: " · ")
    }

    /// The sentence Siri says (and the Shortcuts result).
    var spokenSummary: String {
        let base = "Cybercab Hunter has \(registered.formatted()) registered \(registered == 1 ? "Cybercab" : "Cybercabs"), \(rides.formatted()) recorded \(rides == 1 ? "ride" : "rides") and \(sightings.formatted()) \(sightings == 1 ? "sighting" : "sightings")."
        return todayLine.map { "\(base) \($0)." } ?? base
    }
}

/// Links a widget opens in the app: `cybercabhunter-widget://<tab>[?city=…]`
/// (AppRouter.open(widgetURL:)). Separate from the sign-in callback scheme.
enum WidgetLink {
    static let scheme = "cybercabhunter-widget"
    static func url(_ tab: String, city: String? = nil) -> URL {
        URL(string: "\(scheme)://\(tab)\(city.map { "?city=\($0)" } ?? "")")!
    }
}
