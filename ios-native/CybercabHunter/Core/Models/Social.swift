import Foundation

// Community Social (worker/social.js). Field names follow the Worker's JSON
// through APIClient's snake_case → camelCase decoder. Everything here is what
// the server sends: a private author arrives already "Anonymous" with no
// handle, photo or rank, and who liked a post is never sent, only the count.

/// A post or comment author as the public may see them (worker/reviews.js publicPerson
/// + social.js authorJson). `rank` and `level` are nil for anonymous authors.
struct SocialAuthor: Decodable, Sendable, Equatable, Hashable {
    let name: String
    let handle: String?
    let avatarUrl: String?
    let anonymous: Bool
    let rank: SpotterRank?
    let level: Int?
    /// The site account behind announcements ("Cybercab Hunter").
    let official: Bool?

    var avatarURL: URL? { SocialAuthor.avatarURL(avatarUrl) }

    /// Only https photos and the site's own /api/avatars/<key> (served at
    /// /128 or /512, as the website's avatarSrc does).
    static func avatarURL(_ raw: String?, size: Int = 128) -> URL? {
        guard let raw, !raw.isEmpty else { return nil }
        if raw.range(of: #"^/api/avatars/[a-f0-9]{32}$"#, options: .regularExpression) != nil {
            return AppConfig.webURL("\(raw)/\(size > 128 ? 512 : 128)")
        }
        return raw.hasPrefix("https://") ? URL(string: raw) : nil
    }

    /// The website's avatarInitials: first letters of up to two words, "CH" when empty.
    static func initials(_ name: String) -> String {
        let words = name.replacingOccurrences(of: "@", with: "", options: .anchored).split(whereSeparator: \.isWhitespace)
        let letters = words.prefix(2).compactMap(\.first).map(String.init).joined()
        return letters.isEmpty ? "CH" : letters.uppercased()
    }
}

/// A Spotter rank title (worker/progression-config.js RANKS): text, never a badge.
struct SpotterRank: Decodable, Sendable, Equatable, Hashable {
    let key: String
    let name: String
}

struct SocialPhoto: Decodable, Sendable, Equatable, Hashable, Identifiable {
    let id: String
    let url: String
    var fullURL: URL { AppConfig.webURL(url) }
}

/// The optional ride review on a post.
struct SocialReview: Decodable, Sendable, Equatable, Hashable {
    let rating: Int
    let vehicleType: String?
    let quotedFare: Double?
    let pickupWaitMinutes: Int?
    let rideDate: String?

    static let vehicleNames = ["cybercab": "Cybercab", "model_y": "Model Y"]
}

/// An attached public registry vehicle (worker/social.js vehicleJson): a link
/// to the registry, never proof of a sighting.
struct SocialVehicle: Decodable, Sendable, Equatable, Hashable, Identifiable {
    let id: String
    let shortId: String?
    let licensePlate: String?
    let vin: String?
    let serviceArea: String?
    let cybercab: Bool
    let image: String?
    let url: String?

    var route: VehicleRoute { VehicleRoute(id: id, plate: licensePlate) }
}

struct SocialPost: Decodable, Sendable, Equatable, Hashable, Identifiable {
    let id: String
    let body: String
    let category: String
    let linkUrl: String?
    let createdAt: String
    let editedAt: String?
    let author: SocialAuthor
    let photos: [SocialPhoto]
    let review: SocialReview?
    let vehicle: SocialVehicle?
    var likeCount: Int
    var commentCount: Int
    var liked: Bool
    var saved: Bool
    var pinned: Bool
    let canPin: Bool
    let mine: Bool
    let canEdit: Bool
    let canDelete: Bool
    let removed: Bool
    let url: String

    var webURL: URL { AppConfig.webURL(url) }
    var linkURL: URL? { linkUrl.flatMap(URL.init(string:)) }
}

/// The five post types (worker/social.js CATEGORIES), in the composer's order.
enum PostCategory: String, CaseIterable, Identifiable, Sendable {
    case general, sighting, question, news, review
    var id: String { rawValue }
    var title: String { rawValue.prefix(1).uppercased() + rawValue.dropFirst() }
}

struct SocialViewer: Decodable, Sendable, Equatable {
    let signedIn: Bool
    let moderator: Bool
}

struct SocialFeedPage: Decodable, Sendable, Equatable {
    let filter: String
    let sort: String
    let posts: [SocialPost]
    let nextCursor: String?
    let viewer: SocialViewer
}

struct SocialPostResponse: Decodable, Sendable, Equatable {
    let post: SocialPost
    let viewer: SocialViewer?
}

/// POST / PATCH /api/social/posts → { success, post }.
struct SocialPostSaved: Decodable, Sendable, Equatable {
    let success: Bool
    let post: SocialPost
}

struct SocialComment: Decodable, Sendable, Equatable, Hashable, Identifiable {
    let id: String
    let parentId: String?
    var body: String?
    let removed: Bool
    let createdAt: String
    var editedAt: String?
    let author: SocialAuthor
    let mine: Bool
    let canEdit: Bool
    let canDelete: Bool
    /// Top-level comments carry their replies (one level only).
    var replies: [SocialComment]?
}

struct SocialCommentsPage: Decodable, Sendable, Equatable {
    let comments: [SocialComment]
    let nextCursor: String?
}

struct SocialCommentCreated: Decodable, Sendable, Equatable {
    let comment: SocialComment
    let commentCount: Int
}

struct SocialCommentUpdated: Decodable, Sendable, Equatable {
    let comment: SocialComment
}

struct SocialCommentDeleted: Decodable, Sendable, Equatable {
    let commentCount: Int
}

struct SocialLikeResult: Decodable, Sendable, Equatable {
    let liked: Bool
    let likeCount: Int
}

struct SocialOK: Decodable, Sendable, Equatable {
    let success: Bool
}

/// GET /api/social/sidebar: stats, Trending this week, the announcement.
struct SocialSidebar: Decodable, Sendable, Equatable {
    struct Stats: Decodable, Sendable, Equatable {
        let posts: Int
        let contributors: Int
        let postsThisWeek: Int
        let reviews: Int
        let averageRating: Double?
    }
    struct Trending: Decodable, Sendable, Equatable, Identifiable {
        let id: String
        let category: String
        let excerpt: String
        let likeCount: Int
        let commentCount: Int
    }
    struct Announcement: Decodable, Sendable, Equatable {
        let body: String
        let linkUrl: String?
        let updatedAt: String?
    }
    let stats: Stats
    let trending: [Trending]
    let announcement: Announcement?
}

/// GET /api/social/notifications (the rider's own; in-app only, no push).
struct SocialNotifications: Decodable, Sendable, Equatable {
    struct Item: Decodable, Sendable, Equatable, Identifiable {
        let id: String
        let type: String
        let actor: SocialAuthor?
        let text: String
        let excerpt: String?
        let url: String
        let createdAt: String
        var read: Bool

        /// The post (and comment) it points at, from its /community?post=…&comment=… link.
        var target: PostRoute? { CommunityLink.post(from: url) }
    }
    let unread: Int
    let notifications: [Item]
}

struct SocialUnread: Decodable, Sendable, Equatable {
    let unread: Int
}

/// GET /api/social/vehicles?q= (the composer's Cybercab search).
struct SocialVehicleSearch: Decodable, Sendable, Equatable {
    let q: String
    let vehicles: [SocialVehicle]
}

/// The report reasons (worker/social.js REPORT_REASONS) as the website labels them.
enum ReportReason: String, CaseIterable, Identifiable, Sendable {
    case spam, harassment, offTopic = "off_topic", misleading, privacy, other
    var id: String { rawValue }
    var title: String {
        switch self {
        case .spam: "Spam"
        case .harassment: "Harassment"
        case .offTopic: "Off-topic"
        case .misleading: "Misleading information"
        case .privacy: "Privacy concern"
        case .other: "Other"
        }
    }
}

/// Where a Community link goes inside the app.
struct PostRoute: Hashable, Sendable {
    let id: String
    var commentId: String? = nil
}

struct RiderRoute: Hashable, Sendable {
    let handle: String
}

/// The site's own links (cybercabhunter.com/community?post=…, /vehicle/…,
/// /rider/…) mapped to native screens, so they never open Safari.
enum CommunityLink: Equatable {
    case post(PostRoute)
    case vehicle(VehicleRoute)
    case rider(RiderRoute)
    case community

    private static let idPattern = #"^[a-f0-9]{32}$"#

    init?(url: URL) {
        let host = url.host()?.lowercased()
        guard host == nil || host == "cybercabhunter.com" || host == "www.cybercabhunter.com" else { return nil }
        let parts = url.pathComponents.filter { $0 != "/" }
        if parts == ["community"] || parts == ["community.html"] {
            if let route = Self.post(from: url.absoluteString) { self = .post(route) } else { self = .community }
        } else if parts.count == 2, parts[0] == "vehicle" {
            self = .vehicle(VehicleRoute(id: parts[1], plate: nil))
        } else if parts.count == 2, parts[0] == "rider", parts[1].range(of: #"^[a-z0-9_]{3,20}$"#, options: [.regularExpression, .caseInsensitive]) != nil {
            self = .rider(RiderRoute(handle: parts[1].lowercased()))
        } else {
            return nil
        }
    }

    /// "/community?post=<id>&comment=<id>" → the post route (ids checked).
    static func post(from link: String) -> PostRoute? {
        guard let items = URLComponents(string: link)?.queryItems,
              let id = items.first(where: { $0.name == "post" })?.value,
              id.range(of: idPattern, options: .regularExpression) != nil else { return nil }
        let comment = items.first(where: { $0.name == "comment" })?.value.flatMap { $0.range(of: idPattern, options: .regularExpression) != nil ? $0 : nil }
        return PostRoute(id: id, commentId: comment)
    }
}
