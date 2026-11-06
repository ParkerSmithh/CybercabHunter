#if DEBUG
import SwiftUI
import AuthenticationServices
import CryptoKit

// Tesla Ride Sync feasibility probe. DEBUG BUILDS ONLY: it is not in the App
// Store build and nothing in the app uses it.
//
// It answers one question before the feature is built: does Tesla's
// ride-history endpoint answer a token minted ON THE PHONE? The Oct 4, 2026
// server-side attempt (commits 31d2b1a..26c95a8) got through sign-in and the
// code exchange, then 401 on every ride-history request.
//
// The flow follows Ethan McKanna's robotaxi-history-exporter (MIT,
// https://github.com/EthanMcKanna/robotaxi-history-exporter, robotaxi_history.py):
// the ownerapi client, PKCE (S256, no client secret), the same scopes, token
// URL, two ride-history hosts and query. One difference: the redirect is
// tesla://auth/callback. Tesla stopped accepting the exporter's
// https://auth.tesla.com/void/callback for this client ("not registered for
// this client_id", seen Oct 4, 2026), and iOS could only catch an https
// redirect on a domain this app owns.
//
// RESULT (Nov 5, 2026, the owner's own account, on the phone): sign-in and the
// code exchange work (HTTP 200, 28,800 s token); ride history answers 401 on
// both hosts, with and without the reference's headers. Tesla documents no
// third-party Robotaxi ride-history API (docs/tesla-ride-sync.md), so this is a
// diagnostic only. It no longer sends the Tesla app's X-Tesla-User-Agent (that
// would pass the request off as Tesla's own app), asks one host once per tap,
// and stops after a 401 on a token that is still in date.
//
// Privacy: the sign-in happens on Tesla's own page (the app never sees the
// password). Tokens live in memory only, never in storage, logs or our
// backend, and are gone when this screen closes. The screen shows HTTP
// statuses, counts and field NAMES, never ride values or tokens.
struct TeslaRideProbeView: View {
    @Environment(\.webAuthenticationSession) private var webAuth
    @State private var probe = TeslaRideProbe()

    var body: some View {
        List {
            Section {
                Text("Development only. Tesla documents no API for Robotaxi ride history; this checks the undocumented one once per tap and stops when it refuses. Shows statuses, counts and token claims, never tokens or ride details. Nothing is saved or sent to Cybercab Hunter.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            Section("Steps") {
                Button("1. Sign in to Tesla") { Task { await probe.signIn(webAuth) } }
                    .disabled(probe.busy)
                    .accessibilityIdentifier("probeSignIn")
                Button("2. Ask for ride history") { Task { await probe.fetchRides() } }
                    .disabled(probe.busy || !probe.hasTokens || probe.stopped)
                    .accessibilityIdentifier("probeRides")
                Button("3. Refresh the token, then ask again") { Task { await probe.refreshAndRetry() } }
                    .disabled(probe.busy || !probe.hasRefresh || probe.stopped)
                    .accessibilityIdentifier("probeRefresh")
                Button("Forget the tokens", role: .destructive) { probe.forget() }
                    .disabled(probe.busy || !probe.hasTokens)
            }
            Section("Results") {
                if probe.log.isEmpty { Text("Nothing yet.").foregroundStyle(.secondary) }
                ForEach(probe.log) { line in
                    Text(line.text).font(.footnote.monospaced()).textSelection(.enabled)
                }
                if probe.busy { ProgressView() }
            }
            .accessibilityIdentifier("probeResults")
        }
        .navigationTitle("Tesla Ride Sync probe")
        .onDisappear { probe.forget() }
    }
}

@MainActor
@Observable
final class TeslaRideProbe {
    struct Line: Identifiable { let id = UUID(); let text: String }
    private(set) var log: [Line] = []
    private(set) var busy = false
    // In memory only, never written anywhere.
    @ObservationIgnored private var tokens: TeslaProbeLogic.Tokens?
    /// Set after a refusal that asking again can't fix: no more ride-history requests.
    private(set) var stopped = false
    private(set) var hasTokens = false
    private(set) var hasRefresh = false

    static let authBase = "https://auth.tesla.com/oauth2/v3"
    static let clientID = "ownerapi"
    static let redirect = "tesla://auth/callback"
    static let scopes = "openid email offline_access phone"
    /// Undocumented and internal to Tesla's app (docs/tesla-ride-sync.md). The
    /// reference also tried an Akamai host and sent the Tesla app's
    /// X-Tesla-User-Agent; this probe does neither.
    static let host = "https://ownership.tesla.com"

    private let http = URLSession(configuration: .ephemeral)

    private func add(_ text: String) { log.append(Line(text: text)) }

    func signIn(_ webAuth: WebAuthenticationSession) async {
        busy = true; defer { busy = false }
        let verifier = Self.randomURLSafe(32)
        let state = Self.randomURLSafe(16)
        var c = URLComponents(string: Self.authBase + "/authorize")!
        c.queryItems = [
            .init(name: "response_type", value: "code"), .init(name: "client_id", value: Self.clientID),
            .init(name: "redirect_uri", value: Self.redirect), .init(name: "scope", value: Self.scopes),
            .init(name: "state", value: state), .init(name: "code_challenge", value: Self.challenge(verifier)),
            .init(name: "code_challenge_method", value: "S256")
        ]
        do {
            let callback = try await webAuth.authenticate(using: c.url!, callbackURLScheme: "tesla", preferredBrowserSession: .ephemeral)
            switch TeslaProbeLogic.parseCallback(callback, expectedState: state) {
            case .teslaError(let e): add("Sign-in: Tesla returned \(e).")
            case .stateMismatch: add("Sign-in: the callback's state didn't match this sign-in; ignored.")
            case .noCode: add("Sign-in: the callback had no code.")
            case .code(let code):
                add("Sign-in: callback received with a code.")
                stopped = false
                await exchange(["grant_type": "authorization_code", "client_id": Self.clientID, "code": code,
                                "code_verifier": verifier, "redirect_uri": Self.redirect], label: "Code exchange")
            }
        } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
            add("Sign-in: cancelled.")
        } catch {
            add("Sign-in failed: \(error.localizedDescription)")
        }
    }

    /// One request, one host. A 401 on an in-date token ends the probe: asking
    /// again, elsewhere or with other headers, is what this no longer does.
    func fetchRides() async {
        guard let tokens, !stopped else { return }
        busy = true; defer { busy = false }
        var c = URLComponents(string: Self.host + "/mobile-app/ride/history")!
        c.queryItems = [.init(name: "pageNo", value: "1"), .init(name: "deviceLanguage", value: "en"),
                        .init(name: "deviceCountry", value: "US"), .init(name: "ttpLocale", value: "en_US")]
        var r = URLRequest(url: c.url!, timeoutInterval: 20)
        r.setValue("Bearer \(tokens.access)", forHTTPHeaderField: "Authorization")
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        var status: Int?, body = Data()
        do {
            let (data, resp) = try await http.data(for: r)
            status = (resp as? HTTPURLResponse)?.statusCode; body = data
        } catch { status = nil }
        let verdict = TeslaProbeLogic.verdict(status: status, body: body, tokenExpiresAt: tokens.expiresAt)
        add("Ride history: \(status.map { "HTTP \($0)" } ?? "no answer"). " + TeslaProbeLogic.message(verdict))
        if verdict == .notAccepted || verdict == .forbidden { stopped = true }
    }

    func refreshAndRetry() async {
        guard let refresh = tokens?.refresh else { return }
        busy = true
        await exchange(["grant_type": "refresh_token", "client_id": Self.clientID, "refresh_token": refresh], label: "Token refresh")
        busy = false
        // A refresh that works is not proof ride history is allowed: only an
        // expired token gets a retry; a refused one stays refused.
        if hasTokens && !stopped { await fetchRides() }
    }

    func forget() {
        tokens = nil; hasTokens = false; hasRefresh = false; stopped = false
    }

    // MARK: -

    private func exchange(_ form: [String: String], label: String) async {
        var r = URLRequest(url: URL(string: Self.authBase + "/token")!, timeoutInterval: 20)
        r.httpMethod = "POST"
        r.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        r.httpBody = form.map { "\($0.key)=\(Self.formEncode($0.value))" }.joined(separator: "&").data(using: .utf8)
        do {
            let (data, resp) = try await http.data(for: r)
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            switch TeslaProbeLogic.tokenOutcome(status: status, body: data, previousRefresh: tokens?.refresh) {
            case .refused(let s, let e):
                add("\(label): HTTP \(s)\(e.map { " — \($0)" } ?? "").")
                if label == "Token refresh" { forget(); add("Sign in again to continue.") }
            case .tokens(let t):
                let rotated = t.refresh != nil && t.refresh != tokens?.refresh && tokens != nil
                tokens = t; hasTokens = true; hasRefresh = t.refresh != nil
                add("\(label): HTTP 200, tokens received (refresh token: \(t.refresh == nil ? "no" : rotated ? "new one" : "yes")).")
                let missing = TeslaProbeLogic.missingScopes(requested: Self.scopes, granted: t.scopes)
                if !missing.isEmpty { add("Scopes not granted: \(missing.joined(separator: ", "))") }
                if let claims = TeslaProbeLogic.claims(of: t.access) {
                    add("Token claims: audience \(claims.audience.isEmpty ? "none" : claims.audience.joined(separator: ", ")); scopes \(claims.scopes.joined(separator: " ")); issuer \(claims.issuer ?? "none").")
                } else {
                    add("Token claims: not a readable JWT.")
                }
            }
        } catch {
            add("\(label): no answer (\(error.localizedDescription))")
        }
    }

    static func randomURLSafe(_ bytes: Int) -> String {
        var b = [UInt8](repeating: 0, count: bytes)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes, &b)
        return base64URL(Data(b))
    }
    static func challenge(_ verifier: String) -> String { base64URL(Data(SHA256.hash(data: Data(verifier.utf8)))) }
    static func base64URL(_ d: Data) -> String {
        d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    static func formEncode(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")) ?? s
    }
}
#endif
