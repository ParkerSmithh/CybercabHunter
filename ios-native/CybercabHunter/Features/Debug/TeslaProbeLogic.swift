#if DEBUG
import Foundation

// The Tesla Ride Sync probe's decisions, separated from the network so they can
// be tested with mocked answers (CybercabHunterTests/TeslaRideProbeTests.swift).
// DEBUG builds only. See docs/tesla-ride-sync.md for why there is no product
// feature behind this: Tesla documents no third-party Robotaxi ride-history API.
enum TeslaProbeLogic {
    // MARK: Sign-in callback

    enum Callback: Equatable { case code(String), teslaError(String), stateMismatch, noCode }

    /// The redirect back from Tesla. The state must be the one this sign-in sent.
    static func parseCallback(_ url: URL, expectedState: String) -> Callback {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let value = { (n: String) in items.first { $0.name == n }?.value }
        if let error = value("error") { return .teslaError(error) }
        guard value("state") == expectedState else { return .stateMismatch }
        guard let code = value("code"), !code.isEmpty else { return .noCode }
        return .code(code)
    }

    // MARK: Tokens

    struct Tokens: Equatable {
        var access: String
        var refresh: String?
        var expiresAt: Date
        var scopes: Set<String>
    }

    enum TokenOutcome: Equatable {
        case tokens(Tokens)
        /// Tesla refused: its error code only, never a token or a body.
        case refused(status: Int, error: String?)
    }

    /// A token response. A refresh that returns no new refresh token keeps the old
    /// one; one that returns a new refresh token replaces it (rotation: Tesla's
    /// refresh tokens are single use).
    static func tokenOutcome(status: Int, body: Data, previousRefresh: String? = nil, now: Date = .now) -> TokenOutcome {
        let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
        guard status == 200, let access = json["access_token"] as? String, !access.isEmpty else {
            return .refused(status: status, error: json["error"] as? String)
        }
        let seconds = (json["expires_in"] as? NSNumber)?.doubleValue ?? 0
        let scopes = Set(((json["scope"] as? String) ?? "").split(separator: " ").map(String.init))
        return .tokens(Tokens(access: access, refresh: (json["refresh_token"] as? String) ?? previousRefresh,
                              expiresAt: now.addingTimeInterval(seconds), scopes: scopes))
    }

    /// Scopes the probe asked for that Tesla didn't grant (empty when the response lists none).
    static func missingScopes(requested: String, granted: Set<String>) -> [String] {
        guard !granted.isEmpty else { return [] }
        return requested.split(separator: " ").map(String.init).filter { !granted.contains($0) }
    }

    /// The parts of a JWT access token that explain a 401: who it is for, what it
    /// grants and when it ends. Never the token, its subject or its signature.
    struct Claims: Equatable { var issuer: String?; var audience: [String]; var scopes: [String]; var expires: Date? }
    static func claims(of token: String) -> Claims? {
        let parts = token.split(separator: ".")
        guard parts.count == 3 else { return nil }
        var b64 = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64 += "=" }
        guard let data = Data(base64Encoded: b64), let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        let list = { (v: Any?) -> [String] in (v as? [String]) ?? ((v as? String).map { $0.split(separator: " ").map(String.init) } ?? []) }
        return Claims(issuer: json["iss"] as? String, audience: list(json["aud"]), scopes: list(json["scp"] ?? json["scope"]),
                      expires: (json["exp"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue) })
    }

    // MARK: Ride history answers

    enum Verdict: Equatable {
        case rides(count: Int, duplicatesDropped: Int)
        case empty
        /// 401 with a token that is still in date: the endpoint doesn't accept this
        /// sign-in. Refreshing can't change that, so the probe stops asking.
        case notAccepted
        /// 401 with a token past its expiry: a refresh is the right next step.
        case expired
        case forbidden
        case rateLimited
        case serverError(Int)
        case unsupported(Int)
        case noAnswer
    }

    static func verdict(status: Int?, body: Data, tokenExpiresAt: Date, now: Date = .now) -> Verdict {
        guard let status else { return .noAnswer }
        switch status {
        case 200:
            let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
            let rides = ((json?["data"] as? [String: Any])?["rides"] as? [[String: Any]]) ?? (json?["rides"] as? [[String: Any]]) ?? []
            if rides.isEmpty { return .empty }
            var seen = Set<String>(), kept = 0
            for ride in rides {
                let id = (ride["rideId"] as? String) ?? (ride["rideIntegerId"] as? NSNumber)?.stringValue ?? UUID().uuidString
                if seen.insert(id).inserted { kept += 1 }
            }
            return .rides(count: kept, duplicatesDropped: rides.count - kept)
        case 401: return tokenExpiresAt <= now ? .expired : .notAccepted
        case 403: return .forbidden
        case 429: return .rateLimited
        case 500...599: return .serverError(status)
        default: return .unsupported(status)
        }
    }

    /// What a rider would be told for each verdict (docs/tesla-ride-sync.md).
    static func message(_ v: Verdict) -> String {
        switch v {
        case .rides(let n, let d): "Ride history answered: \(n) ride\(n == 1 ? "" : "s")\(d > 0 ? ", \(d) duplicate\(d == 1 ? "" : "s") dropped" : "")."
        case .empty: "Ride history answered with no rides."
        case .notAccepted: "Ride History Unavailable: Tesla sign-in worked, but ride history doesn't accept this sign-in. Refreshing won't change that; stopped."
        case .expired: "Connection Expired: the sign-in has ended. Refresh or sign in again."
        case .forbidden: "Ride History Unavailable: Tesla refused access (403)."
        case .rateLimited: "Sync Failed: Tesla asked to slow down (429). Try again later."
        case .serverError(let s): "Sync Failed: Tesla had a problem (\(s)). Try again later."
        case .unsupported(let s): "Ride History Unavailable: unexpected answer (\(s))."
        case .noAnswer: "Sync Failed: no answer (offline or timed out)."
        }
    }
}

/// One refresh at a time: concurrent callers share the refresh that is already
/// running instead of each spending the single-use refresh token.
actor TeslaTokenRefresher {
    private var running: Task<TeslaProbeLogic.TokenOutcome, Never>?
    private let perform: @Sendable () async -> TeslaProbeLogic.TokenOutcome
    init(perform: @escaping @Sendable () async -> TeslaProbeLogic.TokenOutcome) { self.perform = perform }

    func refresh() async -> TeslaProbeLogic.TokenOutcome {
        if let running { return await running.value }
        let task = Task { await perform() }
        running = task
        let outcome = await task.value
        running = nil
        return outcome
    }
}
#endif
