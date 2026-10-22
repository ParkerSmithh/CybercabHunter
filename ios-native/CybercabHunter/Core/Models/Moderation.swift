import Foundation

// Moderation (worker/moderation.js, social.js). Every endpoint checks the
// caller's role on the server (requireModerator); these are only the shapes.

/// GET /api/moderation/vehicle-sightings: pending and needs-review sightings.
struct ModerationQueue: Decodable, Sendable, Equatable {
    struct Sighting: Decodable, Sendable, Equatable, Identifiable {
        let submissionId: String
        let status: String
        let submittedAt: String?
        let observedAt: String?
        let serviceArea: String?
        let approxLocation: String?
        let licensePlate: String?
        let model: String?
        let color: String?
        let notes: String?
        /// Set when the sighting has a photo (the storage key itself is never used by the app).
        let evidenceRef: String?
        let robotaxiVehicleId: String?
        let cameraId: String?
        let cameraName: String?
        var id: String { submissionId }
        var hasPhoto: Bool { evidenceRef != nil }
        /// Only a sighting with a plate and no registry vehicle yet can become one (the site's rule).
        var canPromote: Bool { (licensePlate?.isEmpty == false) && robotaxiVehicleId == nil }
    }
    let sightings: [Sighting]
}

/// GET /api/moderation/approved-photo-sightings (the 24 most recent).
struct ApprovedImages: Decodable, Sendable, Equatable {
    struct Image: Decodable, Sendable, Equatable, Identifiable {
        let submissionId: String
        let reviewedAt: String?
        let observedAt: String?
        let serviceArea: String?
        let approxLocation: String?
        let licensePlate: String?
        let cameraId: String?
        let cameraName: String?
        let onMap: Bool
        let visibleOnMap: Bool
        var id: String { submissionId }
        var cityKey: String { (serviceArea ?? "").trimmingCharacters(in: .whitespaces).lowercased() == "dallas" ? "dallas" : "austin" }
    }
    let sightings: [Image]
}

/// PATCH …/vehicle-sightings/:id and POST …/promote → { success, status, map? }.
struct ReviewResult: Decodable, Sendable, Equatable {
    struct MapPlacement: Decodable, Sendable, Equatable { let onMap: Bool; let visibleOnMap: Bool }
    let success: Bool
    let status: String?
    let map: MapPlacement?

    /// The website's message after an approval (moderation.js approvedMessage).
    func message(_ base: String) -> String {
        guard let map else { return base + "." }
        if !map.onMap { return "\(base). It couldn't be placed on the Zones map. Use Add to map below." }
        return map.visibleOnMap ? "\(base). On the Zones map ✓" : "\(base). Recorded for the map, but it's over 24 hours old, so it won't show on the Zones map."
    }
}

/// POST …/:id/map → { success, already_on_map?, visible_on_map }.
struct MapAdded: Decodable, Sendable, Equatable {
    let success: Bool
    let alreadyOnMap: Bool?
    let visibleOnMap: Bool?
}

/// GET /api/moderation/social/overview.
struct SocialModerationOverview: Decodable, Sendable, Equatable {
    struct Stats: Decodable, Sendable, Equatable { let posts: Int; let comments: Int; let openReportItems: Int; let openReports: Int; let pinned: Int }
    struct Person: Decodable, Sendable, Equatable { let name: String?; let handle: String? }
    struct Pin: Decodable, Sendable, Equatable, Identifiable {
        let id: String
        let body: String
        let createdAt: String?
        let pinnedAt: String?
        let hasPhotos: Bool
        let hasReview: Bool
        let author: Person
    }
    let stats: Stats
    let maxPins: Int
    let pinned: [Pin]
}

/// GET /api/moderation/social/reports: open reports, one entry per item.
struct SocialReports: Decodable, Sendable, Equatable {
    struct Detail: Decodable, Sendable, Equatable { let reason: String; let details: String?; let createdAt: String? }
    struct History: Decodable, Sendable, Equatable { let removals: Int; let posts24h: Int }
    struct Target: Decodable, Sendable, Equatable {
        let body: String?
        let photos: [SocialPhoto]?
        let linkUrl: String?
        let createdAt: String?
        let review: SocialReview?
        let url: String?
    }
    struct Item: Decodable, Sendable, Equatable, Identifiable {
        let targetType: String
        let targetId: String
        let reportCount: Int
        let firstAt: String?
        let lastAt: String?
        let reasons: [String]
        let details: [Detail]
        /// Moderators see the real name and handle (by design).
        let author: SocialModerationOverview.Person?
        /// The repeat-offender facts: earlier removals, posts in the last 24 hours.
        let authorHistory: History?
        let target: Target?
        let targetMissing: Bool
        var id: String { "\(targetType)-\(targetId)" }
    }
    let reports: [Item]
}

/// POST /api/moderation/social/resolve → { success, status: removed|dismissed }.
struct ResolveResult: Decodable, Sendable, Equatable {
    let success: Bool
    let status: String
}

// MARK: Registry vehicles (worker/moderation.js, db.js toModeratorVehicle)

/// A registry vehicle as moderators see it. Every rule (approval state,
/// blocking reasons, can_approve, can_verify_vin) is the server's; the app
/// only labels it.
struct ModVehicle: Decodable, Sendable, Equatable, Identifiable {
    struct Approval: Decodable, Sendable, Equatable {
        let state: String?
        let canApprove: Bool
        let blockingReasons: [String]
        let notes: [String]
    }
    struct Sources: Decodable, Sendable, Equatable { let receiptEmail: Int?; let receiptImport: Int?; let other: Int? }
    struct Review: Decodable, Sendable, Equatable { let action: String; let createdAt: String?; let moderatorDisplayName: String? }

    let id: String
    let licensePlate: String?
    let visibility: String
    let origin: String?
    let vin: String?
    let verificationStatus: String?
    let approvalBasis: String?
    let countedRideCount: Int
    let needsReviewRideCount: Int?
    let rejectedRideCount: Int?
    let totalTripCount: Int?
    let countedRidesBySource: Sources?
    let firstCountedRideDate: String?
    let lastCountedRideDate: String?
    let firstSeenAt: String?
    let lastSeenAt: String?
    let createdAt: String?
    let publiclyEligible: Bool
    let plateVehicleCount: Int?
    let approval: Approval?
    let canVerifyVin: Bool?
    let latestReview: Review?

    var isPublic: Bool { visibility == "public" }
    var fromSighting: Bool { origin == "sighting" }
    var hasVin: Bool { !(vin ?? "").trimmingCharacters(in: .whitespaces).isEmpty }
    var canApprove: Bool { approval?.canApprove == true }

    static let reasonLabels = ["no_counted_rides": "No counted rides", "duplicate_plate": "Duplicate plate", "no_plate": "No plate recorded", "no_vin": "No VIN saved yet"]
    static let noteLabels = [
        "eligible_counted_ride_present": "Eligible counted ride present", "needs_review_ride_present": "Needs review ride present",
        "rejected_only_history": "Rejected-only history", "no_rides_on_record": "No rides on record (orphaned)",
        "added_from_sighting": "Added from a community sighting"
    ]
    static let basisLabels = ["vin-verified": "VIN verified", "manual": "Manual (approved without a verified VIN)"]
    static func label(_ map: [String: String], _ code: String) -> String { map[code] ?? code }

    /// The website's badge and line (moderation.js vehicleStateView).
    enum Tone: Equatable { case good, warn, info }
    var stateView: (badge: String, line: String, tone: Tone) {
        if approval?.state == "public" { return ("Public", "Visible on the public registry.", .good) }
        if isPublic { return ("Approved: Not Visible", "Not Eligible: approved, but hidden from the public while the reasons below apply.", .warn) }
        if approval?.state == "eligible_for_approval" { return ("Private: Needs Review", "Eligible for Approval", .info) }
        return ("Private: Needs Review", "Not Eligible", .warn)
    }
}

/// GET /api/moderation/robotaxi-vehicles.
struct ModVehicleList: Decodable, Sendable, Equatable { let vehicles: [ModVehicle] }
/// POST …/review and …/vin → { success, vehicle }.
struct ModVehicleUpdated: Decodable, Sendable, Equatable { let vehicle: ModVehicle }
/// A review's 409: the error and the vehicle as it is now.
struct ModVehicleConflict: Decodable, Sendable, Equatable { let error: String?; let blockingReasons: [String]?; let vehicle: ModVehicle? }

// MARK: News (worker/news.js moderation routes)

struct NewsModeration: Decodable, Sendable, Equatable {
    struct Story: Decodable, Sendable, Equatable, Identifiable {
        let id: String
        let title: String
        let url: String
        let source: String
        let sourceType: String?
        let publishedAt: String?
        let importance: Int?
        let sourceCount: Int?
        let hidden: Bool
        let featured: Bool
        let aiMajor: Int?
        let aiReason: String?
    }
    struct Run: Decodable, Sendable, Equatable {
        struct AI: Decodable, Sendable, Equatable { let checked: Int?; let promoted: Int?; let failed: Int? }
        struct Thumbs: Decodable, Sendable, Equatable { let done: Int?; let failed: Int?; let skipped: Int?; let unavailable: Bool? }
        let at: String
        let feeds: [String]?
        let fetched: Int?
        let kept: Int?
        let dropped: Int?
        let blockedPublisher: Int?
        let new: Int?
        let notModified: Int?
        let errors: [AnyErrorEntry]?
        let ai: AI?
        let rescored: Int?
        let thumbs: Thumbs?
    }
    /// A feed error entry (only counted).
    struct AnyErrorEntry: Decodable, Sendable, Equatable { init(from decoder: Decoder) throws {} }
    struct Prune: Decodable, Sendable, Equatable { let day: String?; let storiesPruned: Int?; let thumbsDeleted: Int? }
    struct Config: Decodable, Sendable, Equatable {
        let allow: String
        let block: String
        let publisherBlocklist: [String]
        let thumbBlocklist: [String]?
        let majorKeywords: [String]?
    }
    let stories: [Story]
    let nextCursor: String?
    let lastRun: Run?
    let lastPrune: Prune?
    let config: Config
}
struct NewsConfigSaved: Decodable, Sendable, Equatable { let config: NewsModeration.Config }

// MARK: Gmail Link (worker/moderation.js forwarding-stats / forwarding-detail)

/// Aggregate counts only: no rider, address or email is ever sent.
struct ForwardingStats: Decodable, Sendable, Equatable {
    let addressesIssued: Int
    let setupCompleted: Int
    let activelyReceiving: Int
    let receiving7d: Int
    let linked30d: Int
    let receiptsProcessed: Int
}

struct ForwardingDetail: Decodable, Sendable, Equatable {
    struct Funnel: Decodable, Sendable, Equatable { let issued: Int; let confirmationReceived: Int; let setupCompleted: Int; let receiving: Int; let receiving7d: Int; let revoked: Int }
    struct Day: Decodable, Sendable, Equatable { let date: String; let n: Int }
    struct Receipts: Decodable, Sendable, Equatable {
        let total: Int
        let last24h: Int
        let last7d: Int
        let last30d: Int
        let lastReceivedAt: String?
        let byStatus: [String: Int]
        let daily: [Day]
    }
    struct GmailAPI: Decodable, Sendable, Equatable { let active: Int; let error: Int; let revoked: Int; let backfillDone: Int; let lastSuccessAt: String? }
    let funnel: Funnel
    let receipts: Receipts
    let gmailApi: GmailAPI
}

// MARK: Import Receipt (worker/moderation.js receipt-import, riders)

struct RiderSearchResult: Decodable, Sendable, Equatable {
    struct Rider: Decodable, Sendable, Equatable, Identifiable { let id: String; let displayName: String; let handle: String? }
    let riders: [Rider]
}

struct ReceiptImportResult: Decodable, Sendable, Equatable {
    struct Ride: Decodable, Sendable, Equatable {
        let rideDate: String?
        let pickupTime: String?
        let distance: Double?
        let distanceUnit: String?
        let fareAmountCents: Int?
        let currency: String?
        let reviewState: String?
    }
    struct Vehicle: Decodable, Sendable, Equatable { let id: String; let licensePlate: String?; let created: Bool; let visibility: String?; let hasVin: Bool; let publiclyEligible: Bool }
    struct Item: Decodable, Sendable, Equatable, Identifiable {
        let index: Int
        let outcome: String
        let reason: String?
        let rideDate: String?
        let ride: Ride?
        let vehicle: Vehicle?
        var id: Int { index }
    }
    struct Run: Decodable, Sendable, Equatable { let processed: Int?; let added: Int?; let updated: Int?; let duplicates: Int?; let needsReview: Int?; let rejected: Int?; let errors: Int? }
    let rider: RiderSearchResult.Rider?
    let run: Run?
    let results: [Item]
}
