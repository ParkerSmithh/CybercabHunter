import Foundation
import Observation
import AuthenticationServices

/// The signed-in rider, app-wide. The session is the website's own 90-day
/// bearer token (the same account and the same sessions as the website),
/// kept in the Keychain.
@MainActor
@Observable
final class SessionStore {
    enum State: Equatable {
        case restoring
        case signedOut
        case signedIn(MeResponse.User)
    }

    private(set) var state: State = .restoring
    private(set) var isSigningIn = false
    var signInError: String?

    let api: APIClient
    private let keychain: KeychainStore

    init(keychain: KeychainStore = KeychainStore(service: "com.cybercabhunter.native.session"), session: URLSession = .shared) {
        if DebugLaunch.usesTestSession {
            // UI tests against the local test Worker: a separate Keychain item.
            let test = KeychainStore(service: "com.cybercabhunter.native.uitest")
            if let token = DebugLaunch.session { try? test.write(token, account: KeychainTokenProvider.account) } else { test.delete(KeychainTokenProvider.account) }
            self.keychain = test
        } else {
            self.keychain = keychain
        }
        self.api = APIClient(session: session, tokens: KeychainTokenProvider(keychain: self.keychain))
    }

    /// The current session token (moderator-only photos are fetched with it).
    var token: String? { keychain.read(KeychainTokenProvider.account) }

    var user: MeResponse.User? {
        if case .signedIn(let user) = state { return user }
        return nil
    }

    /// On launch: a stored session is checked with /api/me (it may have
    /// expired or been revoked since).
    func restore() async {
        guard keychain.read(KeychainTokenProvider.account) != nil else { state = .signedOut; return }
        await refreshAccount()
    }

    func refreshAccount() async {
        do {
            let me: MeResponse = try await api.get("/api/me", authenticated: true, fresh: true)
            if me.authenticated, let user = me.user { state = .signedIn(user) } else { signOut() }
        } catch APIError.unauthorized {
            signOut()
        } catch is CancellationError {
            return
        } catch {
            // Offline or a server hiccup: keep the stored session; the UI can retry.
            if case .restoring = state { state = .signedOut }
        }
    }

    /// Google sign-in in Apple's system sign-in sheet. `authenticate` is
    /// SwiftUI's WebAuthenticationSession (ASWebAuthenticationSession), so
    /// Google never runs inside an embedded web view.
    func signIn(authenticate: (URL, String) async throws -> URL) async {
        guard !isSigningIn else { return }
        isSigningIn = true
        signInError = nil
        defer { isSigningIn = false }
        let pkce = PKCE.generate()
        do {
            let callback = try await authenticate(GoogleSignInFlow.startURL(challenge: pkce.challenge), AppConfig.oauthCallbackScheme)
            switch GoogleSignInFlow.parse(callback: callback) {
            case .failed(let reason):
                if reason != "cancelled" { signInError = "Sign-in didn't finish (\(reason)). Try again." }
            case .code(let code):
                let exchange: AppSessionExchange = try await api.post("/oauth/app/exchange", json: ["code": code, "verifier": pkce.verifier])
                try keychain.write(exchange.session, account: KeychainTokenProvider.account)
                await refreshAccount()
                Haptics.success()
            }
        } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
            return   // the rider closed the sheet
        } catch is CancellationError {
            return
        } catch {
            signInError = (error as? LocalizedError)?.errorDescription ?? "Sign-in failed. Try again."
        }
    }

    /// Forgets the session on this device, as signing out on the website does.
    func signOut() {
        keychain.delete(KeychainTokenProvider.account)
        state = .signedOut
        Task { await ImagePipeline.shared.removeAll() }
    }
}
