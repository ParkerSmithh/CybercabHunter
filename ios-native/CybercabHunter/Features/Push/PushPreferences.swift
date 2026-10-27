import Foundation

struct PushPreferences: Codable, Equatable, Sendable {
    var version = 1
    var master = true
    var timezone = TimeZone.current.identifier
    var quiet = false
    var quietStart = 1320
    var quietEnd = 420
    var majorDuringQuiet = false
    var group = true
    var frequency = "standard"
    var news = "major"
    var dmv = "instant"
    var daily = true
    var dailyTime = 480
    var dailyMetrics = ["registry", "dmv", "sightings", "cameras"]
    var comparison = false
    var registry = "off"
    var sightings = "off"
    var cameras = "off"
    var comments = true
    var replies = true
    var mentions = true
    var likes = true
    var weekly = false
    var weeklyDay = 0
    var weeklyTime = 540
    var weeklyMetrics = ["registry", "dmv", "sightings", "cameras"]

    static func key(_ user: String?) -> String { "push.preferences.v1.\(user ?? "signed-out")" }
    static func load(_ user: String?) -> Self {
        UserDefaults.standard.data(forKey: key(user)).flatMap { try? JSONDecoder().decode(Self.self, from: $0) } ?? Self()
    }
    func save(_ user: String?) {
        if let data = try? JSONEncoder().encode(self) { UserDefaults.standard.set(data, forKey: Self.key(user)) }
    }
}
struct PushPreferencesResponse: Decodable, Sendable { let preferences: PushPreferences? }
struct PushWriteResponse: Decodable, Sendable { let ok: Bool }
