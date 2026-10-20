import Foundation
import UIKit
import WebKit
import AuthenticationServices
import CryptoKit
import Capacitor

/// Google Sign-In for the app. Registered by AppViewController (a
/// CAPInstancePlugin, so the bridge doesn't auto-register a second copy).
///
/// Google refuses OAuth inside embedded web views ("disallowed_useragent"),
/// so when the site navigates to /oauth/google/start this plugin cancels that
/// navigation and runs the same sign-in in Apple's system sign-in sheet
/// (ASWebAuthenticationSession), which Google allows and which shares Safari's
/// Google login.
///
/// The Worker sees `app=ios` and, instead of redirecting to the website with
/// the session, redirects to cybercabhunter://oauth/callback?code=… with a
/// one-time code. Only the code-verifier generated here can redeem it
/// (POST /oauth/app/exchange, PKCE-style), so another app claiming the
/// cybercabhunter:// scheme can't use an intercepted code. The session that
/// comes back is handed to the page exactly the way the website receives it
/// (#tesla_session=…, read by js/main.js into localStorage). No secret lives
/// in the app: the Google client secret stays in the Worker.
@objc(NativeSignInPlugin)
public class NativeSignInPlugin: CAPInstancePlugin, CAPBridgedPlugin, ASWebAuthenticationPresentationContextProviding {
    public let identifier = "NativeSignInPlugin"
    public let jsName = "NativeSignIn"
    public let pluginMethods: [CAPPluginMethod] = []

    private static let site = URL(string: "https://cybercabhunter.com")!
    // The site's "Sign in with Google" link goes to the Worker's own host; both
    // hosts are the same Worker and session store.
    private static let signInHosts: Set<String> = ["cybercabhunter.com", "cybercabhunter.contactjoeclos.workers.dev"]
    private static let callbackScheme = "cybercabhunter"
    private var authSession: ASWebAuthenticationSession?

    @objc override public func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        guard let url = navigationAction.request.url,
              let host = url.host, Self.signInHosts.contains(host),
              url.path == "/oauth/google/start" else { return nil }
        DispatchQueue.main.async { self.startGoogleSignIn(from: url) }
        return true   // cancel the in-web-view navigation
    }

    private func startGoogleSignIn(from startURL: URL) {
        guard authSession == nil else { return }
        let verifier = Self.randomVerifier()
        guard var components = URLComponents(url: startURL, resolvingAgainstBaseURL: false) else { return }
        var items = (components.queryItems ?? []).filter { $0.name != "app" && $0.name != "challenge" }
        items.append(URLQueryItem(name: "app", value: "ios"))
        items.append(URLQueryItem(name: "challenge", value: Self.challenge(for: verifier)))
        components.queryItems = items
        guard let url = components.url else { return }

        let session = ASWebAuthenticationSession(url: url, callbackURLScheme: Self.callbackScheme) { [weak self] callbackURL, error in
            guard let self = self else { return }
            self.authSession = nil
            if error != nil { return }   // cancelled or failed: the visitor stays where they were
            guard let callbackURL = callbackURL,
                  let query = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false)?.queryItems else { return }
            if let code = query.first(where: { $0.name == "code" })?.value {
                self.redeem(code: code, verifier: verifier)
            } else {
                let outcome = query.first(where: { $0.name == "signin" })?.value ?? "error"
                self.load(path: "/signin", signin: outcome, session: nil)
            }
        }
        session.presentationContextProvider = self
        session.prefersEphemeralWebBrowserSession = false
        authSession = session
        session.start()
    }

    private func redeem(code: String, verifier: String) {
        var request = URLRequest(url: Self.site.appendingPathComponent("oauth/app/exchange"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["code": code, "verifier": verifier])
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            guard let self = self else { return }
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            if ok, let session = json?["session"] as? String {
                self.load(path: json?["return_to"] as? String ?? "/", signin: "success", session: session)
            } else {
                self.load(path: "/signin", signin: "error", session: nil)
            }
        }.resume()
    }

    /// Opens a page of the site; with a session, in the same #tesla_session=
    /// form the website's own sign-in redirect uses.
    private func load(path: String, signin: String, session: String?) {
        let safePath = path.hasPrefix("/") && !path.hasPrefix("//") ? path : "/"
        guard var components = URLComponents(url: Self.site, resolvingAgainstBaseURL: false),
              let target = URLComponents(string: safePath) else { return }
        components.path = target.path
        components.queryItems = (target.queryItems ?? []) + [URLQueryItem(name: "signin", value: signin)]
        if let session = session { components.fragment = "tesla_session=\(session)" }
        guard let url = components.url else { return }
        DispatchQueue.main.async { _ = self.bridge?.webView?.load(URLRequest(url: url)) }
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }

    // PKCE-style verifier (32 random bytes) and its S256 challenge, base64url.
    private static func randomVerifier() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return base64url(Data(bytes))
    }
    private static func challenge(for verifier: String) -> String {
        base64url(Data(SHA256.hash(data: Data(verifier.utf8))))
    }
    private static func base64url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
