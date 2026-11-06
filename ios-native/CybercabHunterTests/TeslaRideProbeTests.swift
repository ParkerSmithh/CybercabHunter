#if DEBUG
import Testing
import Foundation
@testable import CybercabHunter

// The Tesla Ride Sync probe's decisions with mocked answers: no Tesla account,
// no network. See docs/tesla-ride-sync.md.
@MainActor
struct TeslaRideProbeTests {
    typealias L = TeslaProbeLogic
    private func json(_ o: [String: Any]) -> Data { try! JSONSerialization.data(withJSONObject: o) }
    /// A fake JWT with the given claims (header and signature are placeholders).
    private func jwt(_ claims: [String: Any]) -> String {
        let p = json(claims).base64EncodedString().replacingOccurrences(of: "=", with: "").replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
        return "eyJhbGciOiJub25lIn0.\(p).sig"
    }

    // MARK: PKCE and encoding

    @Test func pkceChallengeMatchesTheRFCExample() {
        #expect(TeslaRideProbe.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk") == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }
    @Test func verifierIsURLSafeAndLongEnough() {
        let v = TeslaRideProbe.randomURLSafe(32)
        #expect(v.count >= 43 && v.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" })
    }
    @Test func formEncodingEscapesReservedCharacters() {
        #expect(TeslaRideProbe.formEncode("a+b/c=d&e f") == "a%2Bb%2Fc%3Dd%26e%20f")
        #expect(TeslaRideProbe.formEncode("tesla://auth/callback") == "tesla%3A%2F%2Fauth%2Fcallback")
    }

    // MARK: OAuth

    @Test func validCallbackGivesTheCode() {
        #expect(L.parseCallback(URL(string: "tesla://auth/callback?code=abc&state=s1")!, expectedState: "s1") == .code("abc"))
    }
    @Test func aWrongStateIsRefused() {
        #expect(L.parseCallback(URL(string: "tesla://auth/callback?code=abc&state=other")!, expectedState: "s1") == .stateMismatch)
        #expect(L.parseCallback(URL(string: "tesla://auth/callback?code=abc")!, expectedState: "s1") == .stateMismatch)
    }
    @Test func teslaErrorsAndMissingCodes() {
        #expect(L.parseCallback(URL(string: "tesla://auth/callback?error=access_denied&state=s1")!, expectedState: "s1") == .teslaError("access_denied"))
        #expect(L.parseCallback(URL(string: "tesla://auth/callback?state=s1")!, expectedState: "s1") == .noCode)
    }
    @Test func failedCodeExchangeKeepsOnlyTheErrorCode() {
        let out = L.tokenOutcome(status: 400, body: json(["error": "invalid_grant", "error_description": "secret detail", "access_token": ""]))
        #expect(out == .refused(status: 400, error: "invalid_grant"))
    }
    @Test func successfulExchangeAndExpiry() {
        let now = Date(timeIntervalSince1970: 1_000)
        guard case .tokens(let t) = L.tokenOutcome(status: 200, body: json(["access_token": "A", "refresh_token": "R", "expires_in": 28800, "scope": "openid email offline_access phone"]), now: now) else { Issue.record("no tokens"); return }
        #expect(t.access == "A" && t.refresh == "R" && t.expiresAt == now.addingTimeInterval(28800))
    }
    @Test func missingScopesAreNamed() {
        #expect(L.missingScopes(requested: "openid email offline_access phone", granted: ["openid", "email"]) == ["offline_access", "phone"])
        #expect(L.missingScopes(requested: "openid email", granted: []) == [], "a response that lists no scopes proves nothing")
    }
    @Test func refreshRotationReplacesOrKeepsTheRefreshToken() {
        guard case .tokens(let rotated) = L.tokenOutcome(status: 200, body: json(["access_token": "A2", "refresh_token": "R2", "expires_in": 60]), previousRefresh: "R1"),
              case .tokens(let kept) = L.tokenOutcome(status: 200, body: json(["access_token": "A2", "expires_in": 60]), previousRefresh: "R1") else { Issue.record("no tokens"); return }
        #expect(rotated.refresh == "R2", "a new single-use refresh token replaces the old one")
        #expect(kept.refresh == "R1", "no new refresh token: the old one stays")
    }
    @Test func failedRefreshIsARefusal() {
        #expect(L.tokenOutcome(status: 401, body: json(["error": "login_required"]), previousRefresh: "R1") == .refused(status: 401, error: "login_required"))
    }
    @Test func claimsShowAudienceAndScopesButNotTheToken() throws {
        let c = try #require(L.claims(of: jwt(["iss": "https://auth.tesla.com/oauth2/v3", "aud": ["https://owner-api.teslamotors.com/"], "scp": ["openid", "offline_access"], "exp": 2_000_000_000, "sub": "private"])))
        #expect(c.issuer == "https://auth.tesla.com/oauth2/v3" && c.audience == ["https://owner-api.teslamotors.com/"] && c.scopes == ["openid", "offline_access"])
        #expect(L.claims(of: "not-a-jwt") == nil)
    }
    @Test func concurrentRefreshesShareOneRequest() async {
        final class Counter: @unchecked Sendable { var n = 0; let lock = NSLock(); func bump() { lock.lock(); n += 1; lock.unlock() } }
        let counter = Counter()
        let refresher = TeslaTokenRefresher {
            counter.bump()
            try? await Task.sleep(for: .milliseconds(150))
            return .refused(status: 401, error: nil)
        }
        async let a = refresher.refresh()
        async let b = refresher.refresh()
        async let c = refresher.refresh()
        _ = await (a, b, c)
        #expect(counter.n == 1, "one refresh for three callers: the single-use refresh token is spent once")
    }

    // MARK: Ride history answers

    @Test func ridesAreCountedAndDuplicatesDropped() {
        let body = json(["code": 200, "data": ["rides": [["rideId": "r1"], ["rideId": "r2"], ["rideId": "r1"]]]])
        #expect(L.verdict(status: 200, body: body, tokenExpiresAt: .distantFuture) == .rides(count: 2, duplicatesDropped: 1))
        #expect(L.verdict(status: 200, body: json(["code": 200, "data": ["rides": []]]), tokenExpiresAt: .distantFuture) == .empty)
    }
    @Test func a401OnAnInDateTokenIsNotFixedByRefreshing() {
        #expect(L.verdict(status: 401, body: Data(), tokenExpiresAt: .distantFuture) == .notAccepted)
        #expect(L.message(.notAccepted).hasPrefix("Ride History Unavailable"))
    }
    @Test func a401OnAnExpiredTokenAsksForARefresh() {
        #expect(L.verdict(status: 401, body: Data(), tokenExpiresAt: .distantPast) == .expired)
        #expect(L.message(.expired).hasPrefix("Connection Expired"))
    }
    @Test func otherAnswers() {
        #expect(L.verdict(status: 403, body: Data(), tokenExpiresAt: .distantFuture) == .forbidden)
        #expect(L.verdict(status: 429, body: Data(), tokenExpiresAt: .distantFuture) == .rateLimited)
        #expect(L.verdict(status: 500, body: Data(), tokenExpiresAt: .distantFuture) == .serverError(500))
        #expect(L.verdict(status: 404, body: Data(), tokenExpiresAt: .distantFuture) == .unsupported(404))
        #expect(L.verdict(status: nil, body: Data(), tokenExpiresAt: .distantFuture) == .noAnswer, "a timeout")
        #expect(L.message(.rateLimited).hasPrefix("Sync Failed") && L.message(.serverError(503)).hasPrefix("Sync Failed"))
    }

    // MARK: Receipt fallback display (the parser itself: tests/receipt-pipeline.test.mjs)

    @Test func receiptTimesDisplayAndAMissingTimeStaysUnknown() {
        #expect(ImportReceiptModel.time("17:05") == "5:05 PM")
        #expect(ImportReceiptModel.time("12:00") == "12:00 PM" && ImportReceiptModel.time("00:05") == "12:05 AM")
        #expect(ImportReceiptModel.time(nil) == "—" && ImportReceiptModel.time("") == "—", "never a made-up time")
    }
}
#endif
