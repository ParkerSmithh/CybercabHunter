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
/// GET /api/sightings/following (worker/sightings-public.js): the maps' Following
/// filter. The server decides everything: signed in, accepted follows only, the
/// public gallery's sightings, never cached. A position is rounded to about 110 m;
/// sightings without one are in `unplaced`, never drawn at a guess.
struct FollowingMapPage: Decodable, Sendable, Equatable {
    struct Sighting: Decodable, Sendable, Equatable, Hashable, Identifiable {
        struct Spotter: Decodable, Sendable, Equatable, Hashable {
            let name: String
            let handle: String?
            let avatarUrl: String?
        }
        let id: String
        let imageUrl: String
        let city: String?
        let location: String?
        let plate: String?
        let cybercab: Bool
        let spottedAt: String?
        let timeZone: String?
        let vehicleId: String?
        let lat: Double?
        let lng: Double?
        let spotter: Spotter

        /// The gallery's own form, so the time reads the same everywhere.
        var gallery: PublicSighting { .init(id: id, imageUrl: imageUrl, city: city, location: location, plate: plate, cybercab: cybercab, spottedAt: spottedAt, timeZone: timeZone) }
    }
    /// On the first page only.
    let followingCount: Int?
    let sightings: [Sighting]
    let unplaced: [Sighting]
    let nextCursor: String?
}

/// One marker on the Following map: a vehicle at its latest sighting (or, with no
/// public vehicle, one spot), holding every sighting it stands for, newest first.
struct FollowingMapSpot: Identifiable, Equatable, Hashable, Sendable {
    let id: String
    let lat: Double
    let lng: Double
    let sightings: [FollowingMapPage.Sighting]

    static func group(_ list: [FollowingMapPage.Sighting]) -> [FollowingMapSpot] {
        var order: [String] = []
        var groups: [String: [FollowingMapPage.Sighting]] = [:]
        for s in list where s.lat != nil && s.lng != nil {
            let key = s.vehicleId.map { "v:\($0)" } ?? "p:\(s.lat!),\(s.lng!)"
            if groups[key] == nil { order.append(key) }
            groups[key, default: []].append(s)
        }
        return order.map { key in
            let members = groups[key]!
            return FollowingMapSpot(id: key, lat: members[0].lat!, lng: members[0].lng!, sightings: members)
        }
    }
}

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
