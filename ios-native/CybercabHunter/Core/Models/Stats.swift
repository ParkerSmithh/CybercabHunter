import Foundation

/// GET /api/registry/stats: the homepage's lifetime headline counters
/// (site_stat_counters; they only ever go up).
struct RegistryStats: Decodable, Sendable, Equatable {
    let publicVehicles: Int
    let recordedRides: Int
    let sightingsAllTime: Int
}

/// GET /api/service-areas: the cities Cybercab Hunter covers, in order.
struct ServiceAreasResponse: Decodable, Sendable, Equatable {
    let areas: [ServiceArea]
}

struct ServiceArea: Decodable, Sendable, Hashable, Identifiable {
    let key: String
    let name: String
    var id: String { key }
}
