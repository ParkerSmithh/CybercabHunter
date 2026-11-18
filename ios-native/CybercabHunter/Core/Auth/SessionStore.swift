import Foundation
import Observation
import AuthenticationServices
import WidgetKit

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

    // MARK: The one-time Tesla Sync invitation (worker/onboarding.js)
    // The server decides: an account Google sign-in just created is "pending"
    // (the website and the app share the one record). Nothing on the device
    // makes an account "new", so a reinstall, a second device or cleared
    // storage changes nothing.
    /// The server's state for this account, from /api/me.
    private(set) var teslaSyncOnboarding: String?
    /// The invitation is on screen (TeslaSyncOnboardingView).
    var teslaSyncInviteShowing = false
    /// Accounts offered it during this launch: never twice, even when the
    /// server couldn't be told (the next sign-in, anywhere, offers it again).
    private var teslaSyncOffered: Set<String> = []
    /// Account screens on screen: the topmost presents the invitation (the
    /// account sheet a sign-in happens in; RootView when there is none).
    var accountScreens = 0

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
            if me.authenticated, let user = me.user {
                state = .signedIn(user)
                shareWithWidgets(token)
                teslaSyncOnboarding = me.onboarding?.teslaSync
                offerTeslaSyncIfDue()
            } else { signOut() }
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
        // Capture the credential before the Keychain is cleared, so the device
        // removal request cannot accidentally use the next signed-in account.
        if let credential = token {
            let snapshot = APIClient(baseURL: api.baseURL, session: api.session, tokens: PushSignOutToken(value: credential))
            Task { await PushCoordinator.shared.unregister(api: snapshot) }
        }
        keychain.delete(KeychainTokenProvider.account)
        shareWithWidgets(nil)
        teslaSyncInviteShowing = false
        teslaSyncOnboarding = nil
        state = .signedOut
        Task { await ImagePipeline.shared.removeAll() }
    }
}

extension SessionStore {
    /// Offers the invitation when the server says it is due, once per launch.
    /// Refreshing the account (a resume, a restore) never offers it twice.
    fileprivate func offerTeslaSyncIfDue() {
        guard let id = user?.id, teslaSyncOnboarding == "pending", !teslaSyncOffered.contains(id) else { return }
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-noOnboarding") { return }
        #endif
        teslaSyncOffered.insert(id)
        teslaSyncInviteShowing = true
    }

    /// Tells the server: "presented" (now on screen), "skip" or "complete".
    /// It only moves forward and only for this account; a failure is harmless
    /// (the invitation already closed, and it was offered only once here).
    func recordTeslaSync(_ action: String) async {
        struct Answer: Decodable, Sendable { let teslaSync: String? }
        if let answer: Answer = try? await api.post("/api/onboarding/tesla-sync", json: ["action": action], authenticated: true) {
            teslaSyncOnboarding = answer.teslaSync
        }
    }

    /// Skip for Now / setup finished: the invitation closes at once and the
    /// rider is back where they were.
    func finishTeslaSyncInvite(_ action: String) {
        teslaSyncInviteShowing = false
        Task { await recordTeslaSync(action) }
    }
}

extension SessionStore {
    /// My Spotting Progress and the leaderboard widget read the rider's own data
    /// with this session (Shared/Widgets/WidgetSession.swift): a confirmed
    /// session is shared, a signed-out one removed, and those widgets refresh.
    /// UI tests' sessions are never shared.
    fileprivate func shareWithWidgets(_ token: String?) {
        guard !DebugLaunch.usesTestSession, WidgetSession.write(token) else { return }
        WidgetCenter.shared.reloadTimelines(ofKind: "CybercabSpottingProgress")
        WidgetCenter.shared.reloadTimelines(ofKind: "CybercabLeaderboard")
    }
}

private struct PushSignOutToken: TokenProvider { let value: String; func currentToken() -> String? { value } }
