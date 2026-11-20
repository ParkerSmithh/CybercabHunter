import Foundation

enum TrackerCity: String, CaseIterable, Identifiable, Sendable {
    // No "All cities" in the app (owner's decision, 2026-11-20). A saved "all"
    // from an older build no longer decodes, so it falls back to Austin.
    case austin, dallas
    static let storageKey = "tracker.city"
    var id: String { rawValue }
    var title: String { rawValue.capitalized }
    static var selected: Self {
        get { UserDefaults.standard.string(forKey: storageKey).flatMap(Self.init(rawValue:)) ?? .austin }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: storageKey) }
    }
}

enum PublicSnapshotSource: String, Sendable {
    case cities, fleet, fares, site

    func client(_ api: APIClient) -> APIClient {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-dallasPreviewAPIs") {
            let alias: String?
            switch self {
            case .cities: alias = "codex-cities"
            case .fleet: alias = "codex-history"
            case .fares: alias = "fares"
            case .site: alias = nil
            }
            if let alias, let url = URL(string: "https://\(alias)-cybercabhunter.contactjoeclos.workers.dev") {
                return APIClient(baseURL: url, session: api.session, tokens: api.tokens)
            }
        }
        #endif
        return api
    }
}

struct PublicSnapshot<Value: Sendable>: Sendable {
    let value: Value
    let fetchedAt: Date
    let cached: Bool
}

/// Public responses only. The cache key includes the host and the full query so
/// staging and production, and each city, keep independent snapshots.
actor PublicSnapshotCache {
    static let shared = PublicSnapshotCache()
    private struct Entry: Codable, Sendable {
        let data: Data
        let fetchedAt: Date
    }
    private var pending: [URL: Task<Entry, Error>] = [:]

    func load<Value: Decodable & Sendable>(_ path: String, query: [URLQueryItem] = [],
        source: PublicSnapshotSource = .site, api: APIClient, as type: Value.Type = Value.self,
        maximumAge: TimeInterval = 3600, allowFallback: Bool = true) async throws -> PublicSnapshot<Value> {
        let client = source.client(api)
        let request = client.makeRequest(path, query: query, authenticated: false)
        guard let url = request.url else { throw URLError(.badURL) }
        let key = "public.snapshot.v1." + url.absoluteString
        let stored = UserDefaults.standard.data(forKey: key)
            .flatMap { try? PropertyListDecoder().decode(Entry.self, from: $0) }
        if let stored, Date.now.timeIntervalSince(stored.fetchedAt) < maximumAge,
           let value: Value = try? client.decode(stored.data) {
            return PublicSnapshot(value: value, fetchedAt: stored.fetchedAt, cached: true)
        }
        let task = pending[url] ?? Task {
            let (data, status) = try await client.exchange(request)
            let _: Value = try client.result(data, status: status)
            return Entry(data: data, fetchedAt: .now)
        }
        pending[url] = task
        defer { pending[url] = nil }
        do {
            let entry = try await task.value
            let value: Value = try client.decode(entry.data)
            if let serialized = try? PropertyListEncoder().encode(entry) {
                UserDefaults.standard.set(serialized, forKey: key)
            }
            return PublicSnapshot(value: value, fetchedAt: entry.fetchedAt, cached: false)
        } catch {
            // A server takedown or schema failure must never resurrect a public record.
            guard allowFallback, case APIError.transport = error, let stored else { throw error }
            let value: Value = try client.decode(stored.data)
            return PublicSnapshot(value: value, fetchedAt: stored.fetchedAt, cached: true)
        }
    }
}

struct TrackerCityList: Decodable, Sendable {
    let cities: [TrackerCityFacts]
}

struct TrackerCityFacts: Decodable, Sendable {
    struct Hours: Decodable, Sendable { let allDay: Bool; let open: String; let close: String }
    struct Zone: Decodable, Sendable { let squareMiles: Int; let inServiceSince: String; let hours: Hours }
    struct Stats: Decodable, Sendable { let registry: Int; let cybercabSince: String? }
    let key: String
    let name: String
    let zone: Zone
    let stats: Stats?
    let cybercabSince: String?
}
