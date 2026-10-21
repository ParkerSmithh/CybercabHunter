import Foundation

/// GET /api/robotaxi-vehicles (worker/vehicles.js): the public registry, only
/// vehicles that are public and have a counted ride or an approval.
struct VehicleList: Decodable, Sendable, Equatable {
    let vehicles: [RegistryVehicle]
    let total: Int
    let limit: Int
    let offset: Int
}

struct RegistryVehicle: Decodable, Sendable, Equatable, Identifiable, Hashable {
    let id: String
    let licensePlate: String?
    let model: String?
    let color: String?
    let serviceArea: String?
    let firstSeenAt: String?
    let lastSeenAt: String?
    let vin: String?
    let approvalBasis: String?
    let tripCount: Int?
    let firstRideDate: String?
    let lastRideDate: String?
    let totalDistance: Double?
    let serviceAreas: String?

    /// Approved as a Cybercab ('vin-verified' or 'manual'): the badge and the render.
    var isApprovedCybercab: Bool { approvalBasis == "vin-verified" || approvalBasis == "manual" }
    /// Its own city, else where its rides were (the Cars page's rule).
    var city: String? { serviceArea ?? serviceAreas?.split(separator: ",").first.map { String($0).trimmingCharacters(in: .whitespaces) } }
}

/// GET /api/robotaxi-vehicles/:id
struct VehicleDetail: Decodable, Sendable, Equatable {
    let vehicle: Vehicle
    let history: History

    struct Vehicle: Decodable, Sendable, Equatable {
        let id: String
        let licensePlate: String?
        let model: String?
        let color: String?
        let serviceArea: String?
        let firstSeenAt: String?
        let lastSeenAt: String?
        let vin: String?
        let approvalBasis: String?
        var isApprovedCybercab: Bool { approvalBasis == "vin-verified" || approvalBasis == "manual" }
    }

    struct History: Decodable, Sendable, Equatable {
        let tripCount: Int?
        let firstRideDate: String?
        let lastRideDate: String?
        let totalDistance: Double?
        let serviceAreas: String?
        var cities: [String] { (serviceAreas ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }
    }
}

/// GET /api/robotaxi-vehicles/:id/sightings: approved community sightings of
/// the vehicle, one per day and area (no submitter, no exact place).
struct VehicleSightings: Decodable, Sendable, Equatable {
    let sightings: [Entry]
    struct Entry: Decodable, Sendable, Equatable, Hashable {
        let date: String
        let serviceArea: String?
    }
}

/// The registry's orders (worker/db.js REGISTRY_SORTS), as the Cars page names them.
enum RegistrySort: String, CaseIterable, Identifiable, Sendable {
    case recent, leastRecent = "least_recent", mostMiles = "most_miles", mostRides = "most_rides"
    var id: String { rawValue }
    var title: String {
        switch self {
        case .recent: "Recently Used"
        case .leastRecent: "Used Least Recently"
        case .mostMiles: "Most Miles"
        case .mostRides: "Most Rides"
        }
    }
}
