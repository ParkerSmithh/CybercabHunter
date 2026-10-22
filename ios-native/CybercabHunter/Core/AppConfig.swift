import Foundation

/// App-wide constants. The app talks only to the website's Cloudflare Worker;
/// there are no secrets here (the Worker holds every key).
enum AppConfig {
    /// The Worker that serves cybercabhunter.com and its API.
    static let siteURL = DebugLaunch.apiBase ?? URL(string: "https://cybercabhunter.com")!
    /// The scheme the Worker redirects to at the end of the app's Google
    /// sign-in (worker/google-auth.js APP_CALLBACK). Only the system sign-in
    /// sheet that started the flow receives it; the app does not register it.
    static let oauthCallbackScheme = "cybercabhunter"
    /// Where the website starts Tesla linking (js/main.js TESLA_WORKER_URL):
    /// the Worker's own host, whose callback is the one registered with Tesla.
    static let teslaOAuthOrigin = DebugLaunch.apiBase ?? URL(string: "https://cybercabhunter.contactjoeclos.workers.dev")!

    /// A page of the website (the fallback for screens not yet native).
    static func webURL(_ path: String) -> URL {
        URL(string: path, relativeTo: siteURL)?.absoluteURL ?? siteURL
    }
}
