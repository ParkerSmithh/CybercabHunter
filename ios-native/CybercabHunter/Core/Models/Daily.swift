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

extension ServiceActivityAttributes.ContentState {
    /// The Live Activity's figures from the Daily report: today's camera
    /// detections and sightings (Central), yesterday's detections, and when the
    /// server made them.
    init(_ report: DailyReport, now: Date = .now) {
        self.init(detections: report.day.cameras, sightings: report.day.sightings, detectionsYesterday: report.previous?.cameras,
                  day: report.today, updated: Format.instant(report.generatedAt) ?? now)
    }
}
