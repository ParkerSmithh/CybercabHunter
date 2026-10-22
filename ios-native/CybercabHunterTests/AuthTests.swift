import Testing
import Foundation
@testable import CybercabHunter

/// The app's half of the Worker's app sign-in flow (worker/google-auth.js).
struct AuthTests {
    @Test func challengeMatchesTheWorker() {
        // The expected value was computed with the Worker's own code
        // (crypto.subtle SHA-256 + base64url, worker/google-auth.js exchangeAppCode).
        #expect(PKCE.challenge(for: "dBjftJeZ4CVP-mJ92ZTZnN8xqz9V6Y9FY8lzu5jHu0w") == "d3Eel7WWJ16csR7H3orylDpxn5bSRHLz8PQ-4PgESt4")
    }

    @Test func generatedPairsFitTheWorkersRules() {
        let pkce = PKCE.generate()
        // VERIFIER_RE = /^[A-Za-z0-9_-]{43,128}$/, CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/
        #expect(pkce.verifier.range(of: "^[A-Za-z0-9_-]{43,128}$", options: .regularExpression) != nil)
        #expect(pkce.challenge.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil)
        #expect(pkce.challenge == PKCE.challenge(for: pkce.verifier))
        #expect(PKCE.generate().verifier != pkce.verifier)
    }

    @Test func startURLAsksForTheAppFlow() throws {
        let url = GoogleSignInFlow.startURL(challenge: "c".padding(toLength: 43, withPad: "c", startingAt: 0))
        let parts = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
        #expect(parts.scheme == "https" && parts.host == "cybercabhunter.com" && parts.path == "/oauth/google/start")
        let query = Dictionary(uniqueKeysWithValues: (parts.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        #expect(query["app"] == "ios")
        #expect(query["challenge"]?.count == 43)
        #expect(query["returnTo"] == "/")
    }

    @Test func callbackParsing() throws {
        let code = String(repeating: "a", count: 64)
        #expect(GoogleSignInFlow.parse(callback: try #require(URL(string: "cybercabhunter://oauth/callback?code=\(code)"))) == .code(code))
        #expect(GoogleSignInFlow.parse(callback: try #require(URL(string: "cybercabhunter://oauth/callback?signin=cancelled"))) == .failed(reason: "cancelled"))
        #expect(GoogleSignInFlow.parse(callback: try #require(URL(string: "cybercabhunter://oauth/callback"))) == .failed(reason: "error"))
    }

    @Test func keychainRoundTrip() throws {
        let keychain = KeychainStore(service: "com.cybercabhunter.native.tests.\(UUID().uuidString)")
        #expect(keychain.read("session") == nil)
        try keychain.write("first", account: "session")
        #expect(keychain.read("session") == "first")
        try keychain.write("second", account: "session")
        #expect(keychain.read("session") == "second")
        keychain.delete("session")
        #expect(keychain.read("session") == nil)
        #expect(KeychainTokenProvider(keychain: keychain).currentToken() == nil)
    }
}
