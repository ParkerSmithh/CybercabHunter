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
    /// Receipt Import Notifications: "New Tesla ride imported" (opt-in).
    var rides = false

    static func key(_ user: String?) -> String { "push.preferences.v1.\(user ?? "signed-out")" }
    static func load(_ user: String?) -> Self {
        UserDefaults.standard.data(forKey: key(user)).flatMap { try? JSONDecoder().decode(Self.self, from: $0) } ?? Self()
    }
    func save(_ user: String?) {
        if let data = try? JSONEncoder().encode(self) { UserDefaults.standard.set(data, forKey: Self.key(user)) }
    }
}
// Settings saved before a newer key existed (on this iPhone, or from an older
// server) still load: a missing key keeps its default instead of failing the
// whole decode, which would quietly reset every setting.
extension PushPreferences {
    private enum Keys: String, CodingKey { case version, master, timezone, quiet, quietStart, quietEnd, majorDuringQuiet, group, frequency, news, dmv, daily, dailyTime, dailyMetrics, comparison, registry, sightings, cameras, comments, replies, mentions, likes, weekly, weeklyDay, weeklyTime, weeklyMetrics, rides }
    init(from decoder: Decoder) throws {
        self.init()
        let c = try decoder.container(keyedBy: Keys.self)
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? version
        master = try c.decodeIfPresent(Bool.self, forKey: .master) ?? master
        timezone = try c.decodeIfPresent(String.self, forKey: .timezone) ?? timezone
        quiet = try c.decodeIfPresent(Bool.self, forKey: .quiet) ?? quiet
        quietStart = try c.decodeIfPresent(Int.self, forKey: .quietStart) ?? quietStart
        quietEnd = try c.decodeIfPresent(Int.self, forKey: .quietEnd) ?? quietEnd
        majorDuringQuiet = try c.decodeIfPresent(Bool.self, forKey: .majorDuringQuiet) ?? majorDuringQuiet
        group = try c.decodeIfPresent(Bool.self, forKey: .group) ?? group
        frequency = try c.decodeIfPresent(String.self, forKey: .frequency) ?? frequency
        news = try c.decodeIfPresent(String.self, forKey: .news) ?? news
        dmv = try c.decodeIfPresent(String.self, forKey: .dmv) ?? dmv
        daily = try c.decodeIfPresent(Bool.self, forKey: .daily) ?? daily
        dailyTime = try c.decodeIfPresent(Int.self, forKey: .dailyTime) ?? dailyTime
        dailyMetrics = try c.decodeIfPresent([String].self, forKey: .dailyMetrics) ?? dailyMetrics
        comparison = try c.decodeIfPresent(Bool.self, forKey: .comparison) ?? comparison
        registry = try c.decodeIfPresent(String.self, forKey: .registry) ?? registry
        sightings = try c.decodeIfPresent(String.self, forKey: .sightings) ?? sightings
        cameras = try c.decodeIfPresent(String.self, forKey: .cameras) ?? cameras
        comments = try c.decodeIfPresent(Bool.self, forKey: .comments) ?? comments
        replies = try c.decodeIfPresent(Bool.self, forKey: .replies) ?? replies
        mentions = try c.decodeIfPresent(Bool.self, forKey: .mentions) ?? mentions
        likes = try c.decodeIfPresent(Bool.self, forKey: .likes) ?? likes
        weekly = try c.decodeIfPresent(Bool.self, forKey: .weekly) ?? weekly
        weeklyDay = try c.decodeIfPresent(Int.self, forKey: .weeklyDay) ?? weeklyDay
        weeklyTime = try c.decodeIfPresent(Int.self, forKey: .weeklyTime) ?? weeklyTime
        weeklyMetrics = try c.decodeIfPresent([String].self, forKey: .weeklyMetrics) ?? weeklyMetrics
        rides = try c.decodeIfPresent(Bool.self, forKey: .rides) ?? rides
    }
}
struct PushPreferencesResponse: Decodable, Sendable { let preferences: PushPreferences? }
struct PushWriteResponse: Decodable, Sendable { let ok: Bool }
