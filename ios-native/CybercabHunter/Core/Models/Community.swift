import Foundation

// Community: leaderboards, streaks, Spotter XP and public rider profiles
// (worker/community.js, community-summary.js, streaks.js, progression.js).
// Every figure is computed by the server; the app never derives a streak,
// a rank, a level or an XP total of its own.

/// GET /api/community/leaderboard?board=
struct Leaderboard: Decodable, Sendable, Equatable {
    struct Board: Decodable, Sendable, Equatable, Identifiable, Hashable { let id: String; let label: String }
    struct Entry: Decodable, Sendable, Equatable, Identifiable {
        let rank: Int
        let score: Double
        let count: Double
        let name: String
        let handle: String?
        let avatarUrl: String?
        let profile: Bool
        let discovered: Int?
        let rides: Int?
        let miles: Double?
        let uniqueVehicles: Int?
        let cities: Int?
        let xp: Int?
        let level: Int?
        let spotterRank: String?
        let spotterRankKey: String?
        var id: String { "\(rank)-\(handle ?? name)" }
    }
    struct Totals: Decodable, Sendable, Equatable { let spotters: Int; let vehicles: Int }

    let board: String
    let label: String
    let help: String?
    let unit: [String]
    let boards: [Board]
    let entries: [Entry]
    let totals: Totals?

    func unit(for value: Double) -> String { value == 1 ? (unit.first ?? "") : (unit.last ?? "") }
}

/// GET /api/community/summary (precomputed once a day).
struct CommunitySummary: Decodable, Sendable, Equatable {
    struct Day: Decodable, Sendable, Equatable { let date: String; let n: Int }
    struct Sightings: Decodable, Sendable, Equatable {
        let verified: Int
        let photosSubmitted: Int
        let cities: Int
        let siteStart: String?
        let last14Days: [Day]
    }
    struct Streaks: Decodable, Sendable, Equatable {
        let activeDaily: Int
        let activeWeekly: Int
        let recordDaily: Int
        let recordWeekly: Int
        let verifiedThisWeek: Int
    }
    struct XP: Decodable, Sendable, Equatable {
        let total: Int
        let spotters: Int
        let missionsThisWeek: Int
        let topRank: String
    }
    let computedAt: String?
    let sightings: Sightings?
    let streaks: Streaks?
    let xp: XP?
}

/// GET /api/streaks/me (the rider's own, live).
struct MyStreaks: Decodable, Sendable, Equatable {
    struct Run: Decodable, Sendable, Equatable {
        let current: Int
        let longest: Int
        let todayDone: Bool?
        let weekDone: Bool?
        var done: Bool { todayDone ?? weekDone ?? false }
    }
    struct Verified: Decodable, Sendable, Equatable { let sightings: Int; let days: Int }
    struct Calendar: Decodable, Sendable, Equatable {
        struct Day: Decodable, Sendable, Equatable { let date: String; let count: Int }
        let from: String
        let to: String
        let days: [Day]
    }
    struct Milestone: Decodable, Sendable, Equatable, Identifiable {
        let type: String
        let n: Int
        let unlocked: Bool
        let unlockedOn: String?
        var id: String { "\(type)-\(n)" }
    }
    let timezone: String
    let today: String
    let weekStart: String
    let daily: Run
    let weekly: Run
    let verified: Verified
    let calendar: Calendar
    let milestones: [Milestone]

    /// The milestone tiers (worker/streaks.js DAILY_MILESTONES / WEEKLY_MILESTONES),
    /// as the server lists them.
    func tiers(_ type: String) -> [Int] { milestones.filter { $0.type == type }.map(\.n) }
}

/// GET /api/streaks/leaderboard?board=daily|weekly|longest (precomputed daily).
struct StreakBoard: Decodable, Sendable, Equatable {
    struct Entry: Decodable, Sendable, Equatable, Identifiable {
        let rank: Int
        let tied: Bool
        let name: String
        let handle: String?
        let avatarUrl: String?
        let profile: Bool
        let dailyCurrent: Int
        let weeklyCurrent: Int
        let longestDaily: Int
        let longestWeekly: Int
        var id: String { "\(rank)-\(handle ?? name)" }
    }
    let board: String
    let label: String
    let computedAt: String?
    let entries: [Entry]
}

/// GET /api/xp/me (the rider's own progress).
struct MyProgress: Decodable, Sendable, Equatable {
    struct Level: Decodable, Sendable, Equatable { let n: Int; let floor: Int; let next: Int?; let into: Int; let span: Int? }
    struct Rank: Decodable, Sendable, Equatable {
        struct Next: Decodable, Sendable, Equatable { let key: String; let name: String; let xp: Int; let needed: Int }
        let key: String
        let name: String
        let next: Next?
    }
    struct Missions: Decodable, Sendable, Equatable {
        let day: String
        let week: String
        let daily: [Mission]
        let weekly: [Mission]
    }
    struct Mission: Decodable, Sendable, Equatable, Identifiable {
        let id: String
        let title: String
        let description: String
        let reward: Int
        let required: Int
        let progress: Int
        let pending: Int
        let state: String
    }
    struct Recent: Decodable, Sendable, Equatable { let amount: Int; let reason: String; let at: String }
    let xp: Int
    let level: Level
    let rank: Rank
    let ranks: [XPRules.Rank]
    let missions: Missions
    let recent: [Recent]
    let rewards: [XPRules.Reward]
}

/// GET /api/xp/rules (public: what earns XP, the ranks, the missions).
struct XPRules: Decodable, Sendable, Equatable {
    struct Reward: Decodable, Sendable, Equatable, Identifiable { let id: String; let xp: Int; let label: String }
    struct Rank: Decodable, Sendable, Equatable, Identifiable { let key: String; let name: String; let xp: Int; var id: String { key } }
    struct Mission: Decodable, Sendable, Equatable, Identifiable {
        let id: String
        let period: String
        let title: String
        let description: String
        let required: Int
        let reward: Int
    }
    let rewards: [Reward]
    let ranks: [Rank]
    let missions: [Mission]
}

/// GET /api/riders/:handle (public profiles only; anything else is a 404).
struct RiderProfile: Decodable, Sendable, Equatable {
    struct Rider: Decodable, Sendable, Equatable { let name: String; let handle: String; let avatarUrl: String?; let bio: String?; let joined: String? }
    struct Vehicle: Decodable, Sendable, Equatable, Identifiable { let id: String; let licensePlate: String?; let model: String?; let color: String?; let serviceArea: String? }
    struct Discovered: Decodable, Sendable, Equatable { let count: Int; let vehicles: [Vehicle] }
    struct City: Decodable, Sendable, Equatable, Identifiable { let name: String; let rides: Int; var id: String { name } }
    struct Rides: Decodable, Sendable, Equatable { let count: Int; let vehicles: Int; let cities: [City] }
    struct Review: Decodable, Sendable, Equatable, Identifiable {
        struct Car: Decodable, Sendable, Equatable { let id: String; let licensePlate: String? }
        let id: String
        let rating: Int
        let body: String
        let createdAt: String
        let vehicle: Car?
        let likeCount: Int
        let commentCount: Int
    }
    struct Reviews: Decodable, Sendable, Equatable { let count: Int; let average: Double?; let recent: [Review] }
    let rider: Rider
    let discovered: Discovered
    let rides: Rides
    let reviews: Reviews
}

/// GET /api/rider-search?q= (public profiles only, at most 8).
struct RiderSearch: Decodable, Sendable, Equatable {
    struct Result: Decodable, Sendable, Equatable, Identifiable { let name: String; let handle: String; let avatarUrl: String?; var id: String { handle } }
    let q: String
    let results: [Result]
}
