import Foundation

/// GET /api/dmv-registrations (worker/txdmv.js): Tesla Robotaxi's automated
/// vehicles on the Texas DMV roster, polled daily.
struct DMVRegistrations: Decodable, Sendable, Equatable {
    let snapshot: Snapshot?
    let trackingSince: String?
    let series: [Point]?
    let new: NewCounts?
    let matched: Matched?

    struct Snapshot: Decodable, Sendable, Equatable {
        let date: String
        let polledAt: String?
        let total: Int
        let cybercab: Int
        let modelY: Int
    }

    struct Point: Decodable, Sendable, Equatable, Identifiable {
        let date: String
        let cybercab: Int
        let modelY: Int
        let total: Int
        let approx: Bool?
        var id: String { date }
    }

    struct NewCounts: Decodable, Sendable, Equatable {
        let d30: Int?
        let d7: Int?
        let cybercab30d: Int?
        let modelY30d: Int?
    }

    struct Matched: Decodable, Sendable, Equatable {
        let count: Int?
        let spotted30d: Int?
    }
}
