import Foundation

// Sightings (worker/sightings-public.js, sightings.js, submissions.js). The
// public gallery is approved PHOTO sightings only; nothing in it names the
// submitter. A submitted sighting is pending and private until a moderator
// approves it; the app never sets a status.

/// GET /api/sightings?city=&order=&limit=&cursor=&stats=1
struct PublicSightingsPage: Decodable, Sendable, Equatable {
    let seen: Int
    let sightingsAllTime: Int?
    let order: String
    let stats: SightingStats?
    let sightings: [PublicSighting]
    let nextCursor: String?
}

struct PublicSighting: Decodable, Sendable, Equatable, Hashable, Identifiable {
    /// The random public id (never a submission or user id).
    let id: String
    let imageUrl: String
    let city: String?
    /// Street / place and city only, never a house number.
    let location: String?
    /// Only a publicly eligible registry vehicle's plate.
    let plate: String?
    let cybercab: Bool
    let spottedAt: String?
    let timeZone: String?

    var imageURL: URL { AppConfig.webURL(imageUrl) }
    var spotted: Date? { Format.instant(spottedAt) }

    /// "Oct 21, 2026 · 11:55 AM CDT" in the sighting's own zone (the site's fmtSpotted).
    var spottedText: String {
        guard let date = spotted else { return "" }
        let zone = timeZone.flatMap(TimeZone.init(identifier:)) ?? .current
        let day = date.formatted(Date.FormatStyle(timeZone: zone).month(.abbreviated).day().year())
        var time = Date.FormatStyle(timeZone: zone).hour().minute()
        if timeZone != nil { time = time.timeZone(.specificName(.short)) }
        return "\(day) · \(date.formatted(time))"
    }
}

/// The Sightings page's stat cards (worker/sightings-public.js buildSightingStats).
struct SightingStats: Decodable, Sendable, Equatable {
    struct PeakHour: Decodable, Sendable, Equatable { let hour: Int; let count: Int }
    struct BestDay: Decodable, Sendable, Equatable { let date: String; let count: Int }
    let timeZone: String
    let total: Int
    let last7Days: Int
    let today: Int
    let thisMonth: Int
    /// Only when the data clearly shows one hour (else "not enough data yet").
    let peakHour: PeakHour?
    let bestDay: BestDay?
    let firstDay: String?
    let sightingsAllTime: Int?
}

/// GET /api/submissions: the rider's own submissions (status and dates only).
struct MySubmissions: Decodable, Sendable, Equatable {
    struct Item: Decodable, Sendable, Equatable, Identifiable {
        let id: String
        let submissionType: String
        let evidenceType: String?
        let status: String
        let submittedAt: String
        let reviewedAt: String?
    }
    let submissions: [Item]
    /// Sightings only (ride receipts are Rider Data).
    var sightings: [Item] { submissions.filter { $0.submissionType == "vehicle_sighting" } }
}

/// The submission statuses the database allows (migrations/0002).
enum SubmissionStatus: String, CaseIterable, Sendable {
    case pending, approved, rejected, needsReview = "needs_review"
    var title: String {
        switch self {
        case .pending: "Pending review"
        case .approved: "Approved"
        case .rejected: "Not approved"
        case .needsReview: "Needs review"
        }
    }
}

/// POST /api/vehicle-sightings/photo → 201 { success, duplicate, submission_id, status }.
struct SightingSubmitted: Decodable, Sendable, Equatable {
    let success: Bool
    let duplicate: Bool
    let submissionId: String
    let status: String?
}

/// GET /api/places?q=&area= (signed in): real places, never coordinates.
struct PlaceSearch: Decodable, Sendable, Equatable {
    struct Place: Decodable, Sendable, Equatable, Identifiable, Hashable { let id: String; let label: String; let city: String? }
    let places: [Place]
}
