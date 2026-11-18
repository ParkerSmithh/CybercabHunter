import Foundation

/// GET /api/me (worker/tesla.js apiMe).
struct MeResponse: Decodable, Sendable, Equatable {
    let authenticated: Bool
    let user: User?
    let tesla: Tesla?
    /// The one-time Tesla Sync invitation (worker/onboarding.js); absent from an older server.
    var onboarding: Onboarding? = nil

    struct Onboarding: Decodable, Sendable, Equatable {
        /// "pending" (offer it now), "presented", "skipped", "completed", or nil
        /// for every account that existed before the invitation.
        let teslaSync: String?
    }

    struct User: Decodable, Sendable, Equatable, Identifiable {
        let id: String
        let createdAt: String?
        let displayName: String?
        let avatarUrl: String?
        /// "custom", "google" or nil (a newer server; absent from an older one).
        var avatarSource: String? = nil

        /// The avatar as a loadable URL: a Google https photo as is, or the
        /// site's own picture ("/api/avatars/<key>") at its 128 px variant (the
        /// bare path is not a file; the website's avatarSrc adds the size too).
        var avatarURL: URL? { SocialAuthor.avatarURL(avatarUrl, size: 128) }
    }

    struct Tesla: Decodable, Sendable, Equatable {
        let connected: Bool
    }
}

/// POST /oauth/app/exchange (worker/google-auth.js exchangeAppCode).
struct AppSessionExchange: Decodable, Sendable, Equatable {
    let session: String
    let returnTo: String?
}
