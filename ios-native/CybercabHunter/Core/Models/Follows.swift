import Foundation

// Followers & Following (worker/follows.js). The server decides who may see
// what: nil counts or a nil profile mean this viewer may not.

/// The viewer's relationship with an account, as the server says it.
enum FollowState: String, Decodable, Sendable, Equatable {
    case follow, following, requested
    case followBack = "follow_back"
    case signedOut = "signed_out"
    case isSelf = "self"

    var title: String {
        switch self {
        case .follow, .signedOut, .isSelf: "Follow"
        case .following: "Following"
        case .requested: "Requested"
        case .followBack: "Follow Back"
        }
    }
    /// Following or requested: tapping undoes it.
    var isActive: Bool { self == .following || self == .requested }
}

/// GET / PUT / DELETE /api/follows/:handle.
struct FollowStatus: Decodable, Sendable, Equatable {
    struct Counts: Decodable, Sendable, Equatable { let followers: Int; let following: Int }
    /// A private account's identity, for its owner and approved followers only.
    struct Profile: Decodable, Sendable, Equatable {
        let name: String
        let avatarUrl: String?
        let rank: SpotterRank?
        let level: Int?
        let bio: String?
        let joined: String?
    }
    let handle: String
    let `private`: Bool
    let canView: Bool
    let relationship: FollowState
    let followsYou: Bool
    let requestedYou: Bool
    let counts: Counts?
    let profile: Profile?
}

/// One account in a Followers / Following list or a Follow Request.
struct FollowPerson: Decodable, Sendable, Equatable, Identifiable {
    let name: String
    let handle: String?
    let avatarUrl: String?
    let rank: SpotterRank?
    let level: Int?
    let relationship: FollowState?
    /// The owner's own followers: what Remove names.
    let followId: String?
    var id: String { followId ?? handle ?? name }
}

/// GET /api/follows/:handle/followers | following.
struct FollowListPage: Decodable, Sendable, Equatable {
    let users: [FollowPerson]
    let nextCursor: String?
    let total: Int?
    let hiddenCount: Int?
}

/// GET /api/follow-requests.
struct FollowRequestsPage: Decodable, Sendable, Equatable {
    struct Request: Decodable, Sendable, Equatable, Identifiable {
        let id: String
        let createdAt: String
        let user: FollowPerson
    }
    let count: Int
    let requests: [Request]
    let nextCursor: String?
}

struct FollowOK: Decodable, Sendable, Equatable { let success: Bool }
