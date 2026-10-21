import Foundation
import Observation

/// The Cars list: GET /api/robotaxi-vehicles?city=&sort=&q=&limit=50&offset=,
/// 50 at a time (as the website), the next page as the end comes into view.
@MainActor
@Observable
final class RegistryModel {
    enum Phase: Equatable { case idle, loading, loaded, failed(String) }

    static let pageSize = 50
    private(set) var vehicles: [RegistryVehicle] = []
    private(set) var total = 0
    private(set) var phase: Phase = .idle
    private(set) var loadingMore = false
    private var generation = 0

    var city = "austin"
    var sort: RegistrySort = .recent
    var query = ""

    var hasMore: Bool { vehicles.count < total }

    /// A fresh list for the current city, sort and search.
    func reload(using api: APIClient) async {
        generation += 1
        let mine = generation
        if vehicles.isEmpty { phase = .loading }
        do {
            let page = try await fetch(offset: 0, using: api)
            guard mine == generation else { return }
            vehicles = page.vehicles
            total = page.total
            phase = .loaded
        } catch is CancellationError {
        } catch {
            guard mine == generation else { return }
            phase = .failed((error as? LocalizedError)?.errorDescription ?? "Couldn't load the registry.")
        }
    }

    func loadMore(using api: APIClient) async {
        guard hasMore, !loadingMore, phase == .loaded else { return }
        loadingMore = true
        defer { loadingMore = false }
        let mine = generation
        if let page = try? await fetch(offset: vehicles.count, using: api), mine == generation {
            let seen = Set(vehicles.map(\.id))
            vehicles += page.vehicles.filter { !seen.contains($0.id) }
            total = page.total
        }
    }

    private func fetch(offset: Int, using api: APIClient) async throws -> VehicleList {
        var query = [URLQueryItem(name: "limit", value: String(Self.pageSize)),
                     URLQueryItem(name: "offset", value: String(offset)),
                     URLQueryItem(name: "sort", value: sort.rawValue),
                     URLQueryItem(name: "city", value: city)]
        let q = self.query.trimmingCharacters(in: .whitespacesAndNewlines)
        if !q.isEmpty { query.append(URLQueryItem(name: "q", value: String(q.prefix(60)))) }
        return try await api.get("/api/robotaxi-vehicles", query: query)
    }
}
