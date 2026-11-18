import Testing
import Foundation
@testable import CybercabHunter

/// The one-time Tesla Sync invitation (worker/onboarding.js): what the app
/// reads from /api/me and from the server's answer when it records a choice.
/// The presentation itself is covered by TeslaSyncOnboardingUITests.
@MainActor
struct TeslaSyncOnboardingTests {
    private func me(_ json: String) throws -> MeResponse {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(MeResponse.self, from: Data(json.utf8))
    }

    @Test func aNewAccountIsPendingFromTheServer() throws {
        let m = try me(#"{"authenticated":true,"user":{"id":"u1","created_at":"2026-11-17 10:00:00","display_name":"New","avatar_url":null},"tesla":{"connected":false},"onboarding":{"tesla_sync":"pending"}}"#)
        #expect(m.onboarding?.teslaSync == "pending")
    }

    @Test func existingAccountsAndOlderServersHaveNothingDue() throws {
        let existing = try me(#"{"authenticated":true,"user":{"id":"u2","created_at":"2025-06-01 10:00:00","display_name":"Old","avatar_url":null},"tesla":{"connected":false},"onboarding":{"tesla_sync":null}}"#)
        #expect(existing.onboarding?.teslaSync == nil)
        // A server from before the invitation: no "onboarding" at all, and /api/me still decodes.
        let older = try me(#"{"authenticated":true,"user":{"id":"u3","created_at":"2025-06-01 10:00:00","display_name":"Old","avatar_url":null},"tesla":{"connected":false}}"#)
        #expect(older.onboarding == nil && older.user?.id == "u3")
    }

    @Test func handledStatesAreNotDue() throws {
        for state in ["presented", "skipped", "completed"] {
            let m = try me(#"{"authenticated":true,"user":{"id":"u4","created_at":null,"display_name":null,"avatar_url":null},"tesla":null,"onboarding":{"tesla_sync":"\#(state)"}}"#)
            #expect(m.onboarding?.teslaSync == state && m.onboarding?.teslaSync != "pending")
        }
    }

    @Test func recordingAChoiceAsksTheServerForThisAccountOnly() async throws {
        let stub = StubServer()
        stub.responses = ["POST /api/onboarding/tesla-sync": (200, #"{"success":true,"tesla_sync":"skipped"}"#)]
        struct Answer: Decodable, Sendable { let teslaSync: String? }
        let answer: Answer = try await stub.api().post("/api/onboarding/tesla-sync", json: ["action": "skip"], authenticated: true)
        #expect(answer.teslaSync == "skipped")
        let (request, body) = try #require(stub.requests.last)
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer s-test", "the session names the account")
        let sent = try JSONSerialization.jsonObject(with: body) as? [String: String]
        #expect(sent == ["action": "skip"], "nothing but the action: no account id in the request")
    }
}
