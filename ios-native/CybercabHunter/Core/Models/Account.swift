import Foundation

/// GET /api/me (worker/tesla.js apiMe).
struct MeResponse: Decodable, Sendable, Equatable {
    let authenticated: Bool
    let user: User?
    let tesla: Tesla?

    struct User: Decodable, Sendable, Equatable, Identifiable {
        let id: String
        let createdAt: String?
        let displayName: String?
        let avatarUrl: String?

        /// The avatar as an absolute URL (the Worker returns site-relative paths).
        var avatarURL: URL? {
            guard let avatarUrl, !avatarUrl.isEmpty else { return nil }
            return URL(string: avatarUrl, relativeTo: AppConfig.siteURL)?.absoluteURL
        }
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
