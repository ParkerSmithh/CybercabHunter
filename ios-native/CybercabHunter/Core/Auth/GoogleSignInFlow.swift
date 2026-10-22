import Foundation

/// The URLs of the Worker's app sign-in flow (worker/google-auth.js):
///   GET  /oauth/google/start?app=ios&challenge=<S256>&returnTo=/   (in Apple's sign-in sheet)
///   →    cybercabhunter://oauth/callback?code=<one-time code>       (or ?signin=<reason>)
///   POST /oauth/app/exchange { code, verifier } → { session, return_to }
enum GoogleSignInFlow {
    enum Callback: Equatable {
        case code(String)
        case failed(reason: String)
    }

    static func startURL(challenge: String, returnTo: String = "/") -> URL {
        var components = URLComponents(url: AppConfig.siteURL, resolvingAgainstBaseURL: false)!
        components.path = "/oauth/google/start"
        components.queryItems = [
            URLQueryItem(name: "app", value: "ios"),
            URLQueryItem(name: "challenge", value: challenge),
            URLQueryItem(name: "returnTo", value: returnTo)
        ]
        return components.url!
    }

    static func parse(callback url: URL) -> Callback {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        if let code = items.first(where: { $0.name == "code" })?.value, !code.isEmpty { return .code(code) }
        return .failed(reason: items.first(where: { $0.name == "signin" })?.value ?? "error")
    }
}
