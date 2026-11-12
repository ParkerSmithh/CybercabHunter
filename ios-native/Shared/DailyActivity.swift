import Foundation
#if canImport(ActivityKit)
import ActivityKit
#endif

// The Dynamic Island / Lock Screen Live Activity's data: today's Cybercab
// Daily (GET /api/daily, worker/daily.js), shared by the app (which starts and
// updates it) and the widget extension (which draws it). Robotaxi service runs
// 24/7 in Austin and Dallas, so it shows no service countdown: it shows
// today's camera detections and sightings, Central time, and when they were
// last updated. The figures cover both cities (the Daily totals).
//
// Nothing polls in the background (no push service): the app updates it when
// fresh Daily figures arrive while it's open. It turns stale an hour after its
// figures, or at the next Central midnight (when "today" becomes yesterday),
// whichever comes first, and says so.

enum CentralTime {
    static let zone = TimeZone(identifier: "America/Chicago")!
    static var calendar: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = zone
        return c
    }
    /// The next midnight in Central time after `date` (DST-safe).
    static func nextMidnight(after date: Date) -> Date {
        let cal = calendar
        return cal.date(byAdding: .day, value: 1, to: cal.startOfDay(for: date)) ?? date.addingTimeInterval(86_400)
    }
    /// "10:41 AM" in Central time.
    static func clock(_ date: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US"); f.timeZone = zone; f.dateFormat = "h:mm a"
        return f.string(from: date)
    }
}

#if canImport(ActivityKit)
struct ServiceActivityAttributes: ActivityAttributes, Hashable {
    struct ContentState: Codable, Hashable, Sendable {
        /// Camera detections today (Central), nil until the server has a figure.
        var detections: Int?
        /// Approved sightings today.
        var sightings: Int?
        /// Yesterday's detections (for "vs yesterday"), when known.
        var detectionsYesterday: Int?
        /// The Central date the figures are for ("2026-11-12").
        var day: String
        /// When the server produced them.
        var updated: Date

        init(detections: Int?, sightings: Int?, detectionsYesterday: Int?, day: String, updated: Date) {
            self.detections = detections
            self.sightings = sightings
            self.detectionsYesterday = detectionsYesterday
            self.day = day
            self.updated = updated
        }

        // An activity started by an earlier build carried the service countdown
        // (live / since / until): it decodes as "no figures yet", drawn as
        // needing an update, until the app replaces it.
        private enum Keys: String, CodingKey { case detections, sightings, detectionsYesterday, day, updated }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            detections = try c.decodeIfPresent(Int.self, forKey: .detections)
            sightings = try c.decodeIfPresent(Int.self, forKey: .sightings)
            detectionsYesterday = try c.decodeIfPresent(Int.self, forKey: .detectionsYesterday)
            day = try c.decodeIfPresent(String.self, forKey: .day) ?? ""
            updated = try c.decodeIfPresent(Date.self, forKey: .updated) ?? .distantPast
        }
        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: Keys.self)
            try c.encodeIfPresent(detections, forKey: .detections)
            try c.encodeIfPresent(sightings, forKey: .sightings)
            try c.encodeIfPresent(detectionsYesterday, forKey: .detectionsYesterday)
            try c.encode(day, forKey: .day)
            try c.encode(updated, forKey: .updated)
        }

        /// When the figures stop being current: an hour after they were made, or
        /// the next Central midnight, whichever comes first.
        var staleDate: Date { min(updated.addingTimeInterval(3600), CentralTime.nextMidnight(after: updated)) }
    }
    /// The area the figures cover.
    var cityName: String

    /// The Daily figures cover both cities.
    static let coverage = "Austin & Dallas"
}
#endif
