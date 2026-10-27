import Foundation

/// GET /api/homepage-stats?city= (worker/homepage-stats.js): everything the
/// homepage's per-city rows show, in one cached response.
struct HomepageStats: Decodable, Sendable, Equatable {
    let city: String
    let name: String
    let generatedAt: String?
    let area: Area?
    let rides: Rides?
    let sightings: Sightings?
    let cameras: Cameras?

    struct Hours: Decodable, Sendable, Equatable { let open: String; let close: String }

    struct Area: Decodable, Sendable, Equatable {
        let squareMiles: Double?
        let inServiceSince: String?
        let hours: Hours?
        let description: String?
        let vehicles: Int?
        let vehiclesAdded7d: Int?
        let vehiclesAddedPrev7d: Int?
    }

    struct WeeklyFare: Decodable, Sendable, Equatable, Identifiable {
        let week: String
        let averageFare: Double
        let rides: Int
        var id: String { week }
    }

    struct Rides: Decodable, Sendable, Equatable {
        let rides: Int?
        let miles: Double?
        let rides30d: Int?
        let averageFare: Double?
        let medianFare: Double?
        let perMile: Double?
        let fareRides: Int?
        let averageMiles: Double?
        let longestMiles: Double?
        let averageMinutes: Double?
        let minutesRides: Int?
        let weeklyFares: [WeeklyFare]?
    }

    struct PeakHour: Decodable, Sendable, Equatable { let hour: Int; let count: Int }
    struct DayCount: Decodable, Sendable, Equatable, Identifiable { let date: String; let count: Int; var id: String { date } }
    struct Spot: Decodable, Sendable, Equatable, Identifiable { let location: String; let count: Int; var id: String { location } }

    struct LatestSighting: Decodable, Sendable, Equatable, Identifiable {
        let id: String
        let imageUrl: String?
        let city: String?
        let location: String?
        let plate: String?
        let cybercab: Bool?
        let spottedAt: String?
        let timeZone: String?
        var imageURL: URL? { imageUrl.flatMap { URL(string: $0, relativeTo: AppConfig.siteURL)?.absoluteURL } }
    }

    struct Sightings: Decodable, Sendable, Equatable {
        let total: Int?
        let last24h: Int?
        let prev24h: Int?
        let last7Days: Int?
        let prev7Days: Int?
        let firstDay: String?
        let peakHour: PeakHour?
        let daily: [DayCount]?
        let topSpots: [Spot]?
        let latest: [LatestSighting]?
    }

    struct Cameras: Decodable, Sendable, Equatable {
        let monitored: Int?
        let detections24h: Int?
        let prev24h: Int?
        let reporting24h: Int?
        let lastDetectionAt: String?
        let lastCamera: String?
        /// All nonzero local dates from the existing endpoint (sparse history).
        let daily: [DayCount]?
    }
}
