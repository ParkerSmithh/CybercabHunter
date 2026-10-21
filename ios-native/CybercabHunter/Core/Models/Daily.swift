import Foundation

/// GET /api/daily (worker/daily.js): today's Cybercab Daily and yesterday,
/// by Central date. A count the server couldn't produce is null.
struct DailyReport: Decodable, Sendable, Equatable {
    let today: String
    let generatedAt: String?
    let day: Day
    let previous: Day?

    struct Day: Decodable, Sendable, Equatable {
        let date: String
        let registry: Int?
        let dmv: Int?
        let sightings: Int?
        let cameras: Int?
    }
}
