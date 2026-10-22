import Testing
import Foundation
@testable import CybercabHunter

private struct FixedToken: TokenProvider {
    let token: String?
    func currentToken() -> String? { token }
}

/// A URLProtocol that answers from a table, so APIClient runs end to end with no network.
final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var responses: [String: (Int, String)] = [:]
    nonisolated(unsafe) static var lastRequest: URLRequest?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lastRequest = request
        let key = request.url?.path ?? ""
        let (status, body) = Self.responses[key] ?? (404, #"{"error":"not_found"}"#)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}

    static func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: config)
    }
}

@Suite(.serialized)
struct NetworkingTests {
    @Test func bearerOnlyWhenAskedAndSignedIn() {
        let signedIn = APIClient(tokens: FixedToken(token: "abc"))
        #expect(signedIn.makeRequest("/api/me", authenticated: true).value(forHTTPHeaderField: "Authorization") == "Bearer abc")
        #expect(signedIn.makeRequest("/api/registry/stats").value(forHTTPHeaderField: "Authorization") == nil)
        let signedOut = APIClient(tokens: FixedToken(token: nil))
        #expect(signedOut.makeRequest("/api/me", authenticated: true).value(forHTTPHeaderField: "Authorization") == nil)
    }

    @Test func requestURLs() {
        let api = APIClient(tokens: FixedToken(token: nil))
        let request = api.makeRequest("/api/homepage-stats", query: [URLQueryItem(name: "city", value: "dallas")])
        #expect(request.url?.absoluteString == "https://cybercabhunter.com/api/homepage-stats?city=dallas")
        #expect(request.httpMethod == "GET")
    }

    // Bodies below are real responses from cybercabhunter.com (Oct 20, 2026).
    @Test func decodesRealResponses() async throws {
        StubURLProtocol.responses = [
            "/api/registry/stats": (200, #"{"public_vehicles":182,"recorded_rides":8,"sightings_all_time":483}"#),
            "/api/service-areas": (200, #"{"areas":[{"key":"austin","name":"Austin"},{"key":"dallas","name":"Dallas"}]}"#),
            "/api/me": (200, #"{"authenticated":true,"user":{"id":"u1","created_at":"2026-06-01 12:00:00","display_name":"Parker","avatar_url":"/api/avatars/0123456789abcdef0123456789abcdef"},"tesla":{"connected":false}}"#)
        ]
        let api = APIClient(session: StubURLProtocol.session(), tokens: FixedToken(token: "t"))
        let stats: RegistryStats = try await api.get("/api/registry/stats")
        #expect(stats == RegistryStats(publicVehicles: 182, recordedRides: 8, sightingsAllTime: 483))
        let areas: ServiceAreasResponse = try await api.get("/api/service-areas")
        #expect(areas.areas.map(\.name) == ["Austin", "Dallas"])
        let me: MeResponse = try await api.get("/api/me", authenticated: true)
        #expect(me.user?.displayName == "Parker")
        #expect(me.user?.avatarURL?.absoluteString == "https://cybercabhunter.com/api/avatars/0123456789abcdef0123456789abcdef/128", "the site's own picture at its 128 px variant")
        #expect(me.tesla?.connected == false)
    }

    @Test func errorsMapToWhatTheUIHandles() async {
        StubURLProtocol.responses = [
            "/api/me": (401, #"{"authenticated":false}"#),
            "/oauth/app/exchange": (400, #"{"error":"invalid_verifier"}"#),
            "/api/registry/stats": (200, #"{"unexpected":true}"#)
        ]
        let api = APIClient(session: StubURLProtocol.session(), tokens: FixedToken(token: "t"))
        await #expect(throws: APIError.unauthorized) { let _: MeResponse = try await api.get("/api/me", authenticated: true) }
        await #expect(throws: APIError.http(status: 400, code: "invalid_verifier")) {
            let _: AppSessionExchange = try await api.post("/oauth/app/exchange", json: ["code": "c", "verifier": "v"])
        }
        await #expect { let _: RegistryStats = try await api.get("/api/registry/stats") } throws: { error in
            if case APIError.decoding = error { return true }
            return false
        }
    }

    @Test func exchangeSendsCodeAndVerifierAsJSON() async throws {
        StubURLProtocol.responses = ["/oauth/app/exchange": (200, #"{"session":"s123","return_to":"/"}"#)]
        let api = APIClient(session: StubURLProtocol.session(), tokens: FixedToken(token: nil))
        let result: AppSessionExchange = try await api.post("/oauth/app/exchange", json: ["code": "c1", "verifier": "v1"])
        #expect(result == AppSessionExchange(session: "s123", returnTo: "/"))
        let sent = try #require(StubURLProtocol.lastRequest)
        #expect(sent.httpMethod == "POST")
        #expect(sent.value(forHTTPHeaderField: "Content-Type") == "application/json")
    }
}
