import Foundation
import Observation

/// Everything Home shows, all real and public:
///   /api/registry/stats         lifetime headline counters
///   /api/daily                  Cybercab Daily (today vs yesterday, Central)
///   /api/dmv-registrations      the Texas DMV roster
///   /api/service-areas          the cities
///   /api/homepage-stats?city=   per city: area facts, rides, sightings, cameras
///   /api/robotaxi-vehicles      paged, for fleet growth (first_seen_at per vehicle, as the website does)
@MainActor
@Observable
final class HomeModel {
    private(set) var registry: RegistryStats?
    private(set) var daily: DailyReport?
    private(set) var dmv: DMVRegistrations?
    private(set) var areas: [ServiceArea] = [ServiceArea(key: "austin", name: "Austin"), ServiceArea(key: "dallas", name: "Dallas")]
    private(set) var cityStats: [String: HomepageStats] = [:]
    private(set) var cityErrors: [String: String] = [:]
    /// Fleet growth per city name: one point per distinct first_seen_at.
    private(set) var growth: [String: [GrowthPoint]] = [:]
    private(set) var growthLoaded = false
    private(set) var errors: [String: String] = [:]

    var city: String = "austin"

    struct GrowthPoint: Identifiable, Equatable, Sendable {
        let date: Date
        let count: Int
        let added: Int
        var id: Date { date }
    }

    func cityName(_ key: String) -> String { areas.first { $0.key == key }?.name ?? key.capitalized }

    /// The whole screen (first open and pull-to-refresh).
    func loadAll(using api: APIClient) async {
        async let r: Void = load("registry", using: api) { self.registry = try await api.get("/api/registry/stats") }
        async let d: Void = load("daily", using: api) { self.daily = try await api.get("/api/daily", query: [URLQueryItem(name: "day", value: Self.centralToday())]) }
        async let m: Void = load("dmv", using: api) { self.dmv = try await api.get("/api/dmv-registrations") }
        async let a: Void = load("areas", using: api) { self.areas = (try await api.get("/api/service-areas", as: ServiceAreasResponse.self)).areas }
        async let c: Void = loadCity(city, using: api, force: true)
        async let g: Void = loadGrowth(using: api)
        _ = await (r, d, m, a, c, g)
        // Spotlight / Siri: the fleet as a whole, from what Home just loaded.
        let (r2, d2, m2) = (registry, daily, dmv)
        SiriIndex.later { await SiriIndex.fleet(registry: r2, daily: d2, dmv: m2) }
    }

    func loadCity(_ key: String, using api: APIClient, force: Bool = false) async {
        if !force, cityStats[key] != nil { return }
        do {
            let stats: HomepageStats = try await api.get("/api/homepage-stats", query: [URLQueryItem(name: "city", value: key)])
            cityStats[key] = stats
            SiriIndex.later { await SiriIndex.zone(stats) }   // Spotlight / Siri: that city's zone and its last 24 hours
            cityErrors[key] = nil
        } catch is CancellationError {
        } catch {
            cityErrors[key] = (error as? LocalizedError)?.errorDescription ?? "Couldn't load \(cityName(key))."
        }
    }

    /// The registry, page by page (100 at a time, as the website's chart does),
    /// grouped by each vehicle's own city.
    func loadGrowth(using api: APIClient) async {
        var all: [RegistryVehicle] = []
        do {
            var offset = 0
            while true {
                let page: VehicleList = try await api.get("/api/robotaxi-vehicles", query: [URLQueryItem(name: "limit", value: "100"), URLQueryItem(name: "offset", value: String(offset))])
                all += page.vehicles
                offset += page.vehicles.count
                if page.vehicles.isEmpty || offset >= page.total { break }
            }
        } catch is CancellationError {
            return
        } catch {
            errors["growth"] = (error as? LocalizedError)?.errorDescription ?? "Couldn't load fleet growth."
            return
        }
        var byCity: [String: [Date]] = [:]
        for v in all {
            guard let city = v.serviceArea, let seen = Format.instant(v.firstSeenAt) else { continue }
            byCity[city, default: []].append(seen)
        }
        growth = byCity.mapValues { dates in
            var points: [GrowthPoint] = []
            var total = 0
            for (date, n) in Dictionary(grouping: dates, by: { $0 }).map({ ($0.key, $0.value.count) }).sorted(by: { $0.0 < $1.0 }) {
                total += n
                points.append(GrowthPoint(date: date, count: total, added: n))
            }
            return points
        }
        growthLoaded = true
        errors["growth"] = nil
    }

    private func load(_ key: String, using api: APIClient, _ work: @MainActor () async throws -> Void) async {
        do {
            try await work()
            errors[key] = nil
        } catch is CancellationError {
        } catch {
            errors[key] = (error as? LocalizedError)?.errorDescription ?? "Couldn't load."
        }
    }

    static func centralToday(_ now: Date = .now) -> String {
        now.formatted(Date.ISO8601FormatStyle(timeZone: Format.central).year().month().day())
    }
}
