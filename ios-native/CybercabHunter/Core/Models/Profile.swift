import Foundation

/// GET /api/profile (signed in): the rider's own settings. Only `user` is
/// read here; the rest of the response (ride figures) is Rider Data's.
struct ProfileResponse: Decodable, Sendable, Equatable {
    let user: ProfileSettings
}

/// The settings PATCH /api/profile writes, always as a full set (worker/profile.js).
struct ProfileSettings: Decodable, Sendable, Equatable {
    var displayName: String?
    var handle: String?
    var bio: String?
    /// Sent back unchanged (the website's Profile page does the same).
    var profileVisibility: String?
    /// "Community leaderboard & public profile" (on by default).
    var leaderboardOptIn: Bool
    var avatarUrl: String?
    /// "custom" (an upload: Remove applies), "google", or nil (initials).
    /// Absent from an older server: then any picture counts as removable.
    var avatarSource: String?
    /// Whether removing an upload brings a Google picture back.
    var hasGoogleAvatar: Bool?
    var joinedAt: String?

    /// "Remove photo" applies only to an upload (the server keeps a Google picture as the fallback).
    var canRemovePhoto: Bool { avatarSource.map { $0 == "custom" } ?? (avatarUrl != nil) }

    static let handlePattern = #"^[a-z0-9_]{3,20}$"#
    static let maxDisplayName = 60
    static let maxBio = 280

    /// The full JSON body the Worker expects.
    func body() -> [String: Any] {
        [
            "display_name": displayName ?? "",
            "handle": handle ?? "",
            "bio": bio ?? "",
            "profile_visibility": profileVisibility == "public" ? "public" : "private",
            "leaderboard_opt_in": leaderboardOptIn
        ]
    }

    /// The website's check before saving (the server checks again).
    static func handleProblem(_ raw: String) -> String? {
        let h = raw.trimmingCharacters(in: .whitespaces).lowercased()
        if h.isEmpty { return nil }
        return h.range(of: handlePattern, options: .regularExpression) == nil
            ? "Usernames must be 3-20 characters: lowercase letters, numbers, and underscores only." : nil
    }
}

/// PATCH /api/profile → { success, user }.
struct ProfileSaved: Decodable, Sendable, Equatable {
    struct User: Decodable, Sendable, Equatable {
        let displayName: String?
        let handle: String?
        let bio: String?
        let profileVisibility: String?
        let leaderboardOptIn: Bool
    }
    let success: Bool
    let user: User
}

/// POST /api/profile/avatar → { success, avatar_url }.
struct AvatarSaved: Decodable, Sendable, Equatable {
    let success: Bool
    let avatarUrl: String
}

/// DELETE /api/profile/avatar → the picture shown now: the Google one, or none.
struct AvatarRemoved: Decodable, Sendable, Equatable {
    let success: Bool
    let avatarUrl: String?
    let avatarSource: String?
}

/// GET /api/moderation/access: the server's answer about the caller's own role.
struct ModerationAccess: Decodable, Sendable, Equatable {
    let authenticated: Bool
    let moderator: Bool?
}
