import Testing
import Foundation
import UserNotifications
@testable import CybercabHunter

struct PushTests {
    @Test func initialPreferences() throws {
        let p = PushPreferences()
        #expect(p.master && p.daily && p.comments && p.replies && p.mentions)
        #expect(p.news == "major" && p.dmv == "instant")
        #expect(p.registry == "off" && p.sightings == "off" && p.cameras == "off")
        #expect(!p.weekly && !p.quiet && !p.majorDuringQuiet)
        #expect(p.dailyTime == 480 && p.weeklyTime == 540 && p.weeklyDay == 0)
        #expect(Set(p.dailyMetrics) == ["registry", "dmv", "sightings", "cameras"])
        #expect(try JSONDecoder().decode(PushPreferences.self, from: JSONEncoder().encode(p)) == p)
    }
    @Test func independentPersistenceAndMasterSwitch() {
        let id = "push-test-" + UUID().uuidString
        defer { UserDefaults.standard.removeObject(forKey: PushPreferences.key(id)) }
        var p = PushPreferences()
        p.news = "all"; p.dmv = "daily"; p.registry = "instant"
        p.dailyTime = 547; p.quiet = true; p.master = false
        p.save(id)
        let restored = PushPreferences.load(id)
        #expect(restored == p)
        #expect(restored.news == "all" && restored.registry == "instant")
        #expect(PushPreferences.load(id + "other").master)
    }
    @Test func serverDecoding() throws {
        let p = PushPreferences()
        let raw = "{\"preferences\":" + String(decoding: try JSONEncoder().encode(p), as: UTF8.self) + "}"
        let response = try APIClient.makeDecoder().decode(PushPreferencesResponse.self, from: Data(raw.utf8))
        #expect(response.preferences == p)
    }
    @Test @MainActor func permissionStatesAndNoImplicitPrompt() {
        let coordinator = PushCoordinator()
        for status in [UNAuthorizationStatus.notDetermined, .denied] {
            coordinator.authorization = status
            #expect(!coordinator.allowed)
        }
        for status in [UNAuthorizationStatus.authorized, .provisional, .ephemeral] {
            coordinator.authorization = status
            #expect(coordinator.allowed)
        }
        #expect(!coordinator.registered)
    }
}
