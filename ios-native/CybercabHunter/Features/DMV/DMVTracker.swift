import SwiftUI
import Observation

/// The Texas DMV tracker's data (worker/txdmv-activity.js), the same
/// endpoints as public/dmv.html (js/dmv-tracker.js):
///   GET /api/dmv/overview          the four numbers, freshness, recent updates, insights
///   GET /api/dmv/growth?range=     actual daily snapshots and each one's new VINs
///   GET /api/dmv/activity?…        registration history, paged and filtered
///   GET /api/dmv/activity/:date    one update's VINs (new / missing / returned)
///   GET /api/dmv/vins?…            the VIN directory;  /api/dmv/vins/:vin one VIN
/// "First detected" is the snapshot Cybercab Hunter first saw a VIN in; TxDMV
/// publishes no registration date, so none is ever shown as one.

/// Vehicles per class. The class is the decoded VIN's (NHTSA vPIC, checked
/// against TxDMV's label); a conflict or a failed decode stays unknown.
struct DMVClassCounts: Decodable, Sendable, Equatable {
    var cybercab = 0
    var modelY = 0
    var otherTesla = 0
    var unknown = 0
    var total: Int?
    var sum: Int { cybercab + modelY + otherTesla + unknown }
}

enum DMVClass: String, CaseIterable, Sendable {
    case cybercab, modelY = "model_y", otherTesla = "other_tesla", unknown
    init(_ raw: String?) { self = DMVClass(rawValue: raw ?? "") ?? .unknown }
    var label: String { switch self { case .cybercab: "Cybercab"; case .modelY: "Model Y"; case .otherTesla: "Other Tesla"; case .unknown: "Unknown" } }
    var color: Color { switch self { case .cybercab: .brandGold; case .modelY: .chModelY; case .otherTesla: Color(hex: 0x94A3B8); case .unknown: Color(hex: 0x64748B) } }
    func count(_ c: DMVClassCounts) -> Int { switch self { case .cybercab: c.cybercab; case .modelY: c.modelY; case .otherTesla: c.otherTesla; case .unknown: c.unknown } }
}

/// One processed snapshot that changed the roster (or the baseline).
struct DMVEvent: Decodable, Sendable, Equatable, Identifiable {
    let date: String
    let processedAt: String?
    let previousDate: String?
    let status: String?
    let added: Int
    let returned: Int
    let missing: Int
    let net: Int
    let total: Int
    let addedByModel: DMVClassCounts?
    var id: String { date }
}

struct DMVOverview: Decodable, Sendable, Equatable {
    struct Link: Decodable, Sendable, Equatable { let name: String; let url: String }
    struct Source: Decodable, Sendable, Equatable {
        let name: String
        let company: String
        let authorization: String
        let law: String
        let url: String
        let fields: [String]
        let schedule: String
        let decoder: Link
    }
    struct Snapshot: Decodable, Sendable, Equatable { let date: String; let polledAt: String? }
    struct Previous: Decodable, Sendable, Equatable { let date: String; let total: Int; let net: Int }
    struct Freshness: Decodable, Sendable, Equatable { let status: String; let lastSuccess: String? }
    struct Milestone: Decodable, Sendable, Equatable, Identifiable { let metric: String; let threshold: Int; let date: String; let label: String; var id: String { "\(metric)\(threshold)" } }
    struct Insight: Decodable, Sendable, Equatable, Identifiable { let key: String; let text: String; var id: String { key } }

    let source: Source
    let latest: Snapshot?
    let totals: DMVClassCounts?
    let latestUpdate: DMVEvent?
    let previousSnapshot: Previous?
    let freshness: Freshness
    let milestones: [Milestone]?
    let insights: [Insight]?
    let trackingSince: String?
    let recentUpdates: [DMVEvent]?
    let updateCount: Int?
    /// Snapshots not compared yet (right after the migration, until the next daily run).
    var processingPending: Int? = nil
}

struct DMVGrowth: Decodable, Sendable, Equatable {
    struct Point: Decodable, Sendable, Equatable, Identifiable {
        let date: String
        let total: Int
        let cybercab: Int
        let modelY: Int
        let baseline: Bool
        let added: DMVClassCounts?
        var id: String { date }
    }
    let range: String
    let points: [Point]
    let enoughHistory: Bool
}

struct DMVActivityPage: Decodable, Sendable, Equatable {
    struct Baseline: Decodable, Sendable, Equatable { let date: String; let total: Int }
    let total: Int
    let baseline: Baseline?
    let events: [DMVEvent]
}

struct DMVUpdateDetail: Decodable, Sendable, Equatable {
    struct Vehicle: Decodable, Sendable, Equatable, Identifiable {
        let vin: String
        let modelClass: String?
        let modelYear: Int?
        var id: String { vin }
    }
    let event: DMVEvent
    let change: String
    let total: Int
    let vehicles: [Vehicle]
}

struct DMVDirectoryPage: Decodable, Sendable, Equatable {
    struct Vehicle: Decodable, Sendable, Equatable, Identifiable {
        let vin: String
        let model: String?
        let modelYear: Int?
        let modelClass: String?
        let decodeStatus: String?
        let firstDetected: String
        let lastConfirmed: String?
        let baseline: Bool?
        let isNew: Bool?
        let listed: Bool?
        var id: String { vin }
    }
    /// First page only (later pages leave it out: the server doesn't recount).
    let total: Int?
    let newDate: String?
    let years: [Int]?
    let vehicles: [Vehicle]
}

struct DMVVinDetail: Decodable, Sendable, Equatable {
    struct Source: Decodable, Sendable, Equatable { let make: String?; let model: String?; let modelYear: Int? }
    struct Decode: Decodable, Sendable, Equatable {
        let modelClass: String?
        let status: String?
        let manufacturer: String?
        let model: String?
        let modelYear: Int?
        let plant: String?
        let vehicleType: String?
        let checkDigitOk: Bool?
    }
    struct Change: Decodable, Sendable, Equatable, Identifiable { let date: String; let change: String; var id: String { date + change } }
    struct Tracking: Decodable, Sendable, Equatable {
        let firstDetected: String
        let lastConfirmed: String
        let inBaseline: Bool
        let listed: Bool
        let latestSnapshot: String?
        let history: [Change]?
    }
    struct Registry: Decodable, Sendable, Equatable {
        let id: String
        let plate: String?
        let approvedSightings: Int?
        enum CodingKeys: String, CodingKey { case id, plate, approvedSightings }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            // D1 ids arrive as numbers; the registry routes by string.
            if let n = try? c.decode(Int.self, forKey: .id) { id = String(n) } else { id = try c.decode(String.self, forKey: .id) }
            plate = try c.decodeIfPresent(String.self, forKey: .plate)
            approvedSightings = try c.decodeIfPresent(Int.self, forKey: .approvedSightings)
        }
    }
    let vin: String
    let source: Source
    let decode: Decode?
    let tracking: Tracking
    let registry: Registry?
}

enum DMVText {
    /// The site's freshness pill (js/dmv-tracker.js FRESH).
    static func freshness(_ status: String) -> (label: String, warn: Bool) {
        switch status {
        case "current": ("Current", false)
        case "update_pending": ("Update pending", false)
        case "import_failed": ("Import failed", true)
        case "source_unavailable": ("Source unavailable", true)
        case "stale": ("Stale", true)
        case "historical_incomplete": ("Historical data incomplete", false)
        default: (status.replacingOccurrences(of: "_", with: " ").capitalized, false)
        }
    }

    static func decodeStatus(_ s: String?) -> String {
        switch s {
        case "verified": "Verified (NHTSA vPIC and TxDMV agree)"
        case "vpic": "NHTSA vPIC only"
        case "source_label": "TxDMV label (not yet decoded)"
        case "conflict": "Sources disagree: shown as unknown"
        default: "Not decodable yet"
        }
    }

    static func change(_ c: String) -> String {
        switch c { case "added": "First detected"; case "missing": "Missing from the roster"; case "returned": "Back on the roster"; default: c }
    }

    /// "2 Cybercab · 53 Model Y": the non-zero classes only.
    static func breakdown(_ c: DMVClassCounts?) -> String {
        guard let c else { return "" }
        return DMVClass.allCases.filter { $0.count(c) > 0 }.map { "\(Format.int($0.count(c))) \($0.label)" }.joined(separator: " · ")
    }
}

/// DMV data changes once a day (the server caches 5 minutes), so responses are
/// reused for 5 minutes: reopening a sheet or coming back to the screen doesn't
/// refetch. Pull-to-refresh always does.
@MainActor
final class DMVResponseCache {
    static let shared = DMVResponseCache()
    init() {}
    static let ttl: TimeInterval = 300
    private var entries: [String: (at: Date, value: Any)] = [:]
    func get<T>(_ key: String, now: Date = .now) -> T? {
        guard let e = entries[key], now.timeIntervalSince(e.at) < Self.ttl else { return nil }
        return e.value as? T
    }
    func put(_ key: String, _ value: Any, now: Date = .now) {
        if entries.count > 200 { entries = entries.filter { now.timeIntervalSince($0.value.at) < Self.ttl } }
        entries[key] = (now, value)
    }
    func clear() { entries.removeAll() }

    /// A GET through the cache (`force` skips it and refreshes the entry).
    func fetch<T: Decodable & Sendable>(_ api: APIClient, _ path: String, query: [URLQueryItem] = [], force: Bool = false) async throws -> T {
        let key = path + "?" + query.map { "\($0.name)=\($0.value ?? "")" }.joined(separator: "&")
        if !force, let hit: T = get(key) { return hit }
        let value: T = try await api.get(path, query: query)
        put(key, value)
        return value
    }
}

/// The tracker screen: overview and chart, then the VIN directory below.
@MainActor
@Observable
final class DMVTrackerModel {
    enum State: Equatable { case loading, ready, failed }
    enum Range: String, CaseIterable, Identifiable, CustomStringConvertible {
        case d7 = "7d", d30 = "30d", d90 = "90d", all
        var id: String { rawValue }
        var description: String { self == .all ? "All" : rawValue.uppercased() }
    }

    private(set) var state: State = .loading
    private(set) var overview: DMVOverview?
    private(set) var growth: DMVGrowth?
    var range: Range = .all
    @ObservationIgnored var cache = DMVResponseCache.shared

    /// `force`: pull-to-refresh. Otherwise a response from the last 5 minutes is reused.
    func reload(api: APIClient, force: Bool = false) async {
        if overview == nil { state = .loading }
        let cache = self.cache
        do {
            async let o: DMVOverview = cache.fetch(api, "/api/dmv/overview", force: force)
            async let g: DMVGrowth? = try? cache.fetch(api, "/api/dmv/growth", query: [URLQueryItem(name: "range", value: range.rawValue)], force: force)
            overview = try await o
            growth = await g
            state = .ready
        } catch is CancellationError {
        } catch { if overview == nil { state = .failed } }
    }

    /// A range is fetched once; switching back to it reuses it.
    func loadGrowth(api: APIClient) async {
        growth = try? await cache.fetch(api, "/api/dmv/growth", query: [URLQueryItem(name: "range", value: range.rawValue)])
    }

    /// Snapshots after the baseline (the baseline's vehicles aren't "new").
    var additions: [DMVGrowth.Point] { (growth?.points ?? []).filter { !$0.baseline } }
}

/// The VIN directory: search, model, year, sort, latest update only; 50 at a time.
@MainActor
@Observable
final class DMVRosterModel {
    enum State: Equatable { case loading, ready, failed }
    enum Sort: String, CaseIterable, Identifiable {
        case firstSeen = "first_seen", lastSeen = "last_seen", vin
        var id: String { rawValue }
        var label: String { switch self { case .firstSeen: "Newest first detected"; case .lastSeen: "Last confirmed"; case .vin: "VIN A–Z" } }
    }
    static let page = 50
    @ObservationIgnored var cache = DMVResponseCache.shared

    var model = ""        // "", "cybercab", "model_y" or "recent" (the latest update)
    var query = ""
    var year: Int?
    var sort: Sort = .firstSeen
    private(set) var state: State = .loading
    private(set) var vehicles: [DMVDirectoryPage.Vehicle] = []
    private(set) var total = 0
    private(set) var years: [Int] = []
    private(set) var loadingMore = false
    private var generation = 0

    /// The site's VIN search: letters and digits only, upper case, up to 17.
    static func cleaned(_ q: String) -> String {
        String(q.uppercased().filter { $0.isASCII && ($0.isLetter || $0.isNumber) }.prefix(17))
    }

    func items(offset: Int) -> [URLQueryItem] {
        var items = [URLQueryItem(name: "limit", value: String(Self.page)), URLQueryItem(name: "offset", value: String(offset)), URLQueryItem(name: "sort", value: sort.rawValue)]
        if model == "recent" { items.append(URLQueryItem(name: "recent", value: "1")) } else if !model.isEmpty { items.append(URLQueryItem(name: "model", value: model)) }
        if let year { items.append(URLQueryItem(name: "year", value: String(year))) }
        let q = Self.cleaned(query)
        if !q.isEmpty { items.append(URLQueryItem(name: "q", value: q)) }
        return items
    }

    func reload(api: APIClient, force: Bool = false) async {
        generation += 1
        let gen = generation
        if vehicles.isEmpty || force == false { state = .loading }
        do {
            let r: DMVDirectoryPage = try await cache.fetch(api, "/api/dmv/vins", query: items(offset: 0), force: force)
            guard gen == generation else { return }
            vehicles = r.vehicles
            total = r.total ?? r.vehicles.count
            if years.isEmpty, let y = r.years { years = y }
            state = .ready
        } catch is CancellationError {
        } catch { if gen == generation { state = .failed } }
    }

    func loadMore(api: APIClient) async {
        guard state == .ready, vehicles.count < total, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        let gen = generation
        guard let r: DMVDirectoryPage = try? await api.get("/api/dmv/vins", query: items(offset: vehicles.count)), gen == generation else { return }
        vehicles += r.vehicles
        if let t = r.total { total = t }
    }

    var countLine: String {
        switch state {
        case .loading: return ""
        case .failed: return "Couldn't load the roster right now."
        case .ready:
            if total > 0 { return "\(Format.int(vehicles.count)) of \(Format.int(total)) VINs" }
            return Self.cleaned(query).isEmpty ? "No VINs match." : "No VIN matches that search."
        }
    }
}

/// Registration history: every update that changed the roster, newest first.
@MainActor
@Observable
final class DMVHistoryModel {
    enum State: Equatable { case loading, ready, failed }
    static let page = 20
    @ObservationIgnored var cache = DMVResponseCache.shared
    var kind = "all"      // "all", "additions" or "missing"
    var model = ""        // "", "cybercab" or "model_y"
    private(set) var state: State = .loading
    private(set) var events: [DMVEvent] = []
    private(set) var total = 0
    private(set) var baseline: DMVActivityPage.Baseline?
    private var generation = 0

    func items(offset: Int) -> [URLQueryItem] {
        var items = [URLQueryItem(name: "limit", value: String(Self.page)), URLQueryItem(name: "offset", value: String(offset))]
        if kind != "all" { items.append(URLQueryItem(name: "kind", value: kind)) }
        if !model.isEmpty { items.append(URLQueryItem(name: "model", value: model)) }
        return items
    }

    func reload(api: APIClient, force: Bool = false) async {
        generation += 1
        let gen = generation
        state = .loading
        do {
            let r: DMVActivityPage = try await cache.fetch(api, "/api/dmv/activity", query: items(offset: 0), force: force)
            guard gen == generation else { return }
            events = r.events; total = r.total; baseline = r.baseline; state = .ready
        } catch is CancellationError {
        } catch { if gen == generation { state = .failed } }
    }

    func loadMore(api: APIClient) async {
        guard state == .ready, events.count < total else { return }
        let gen = generation
        guard let r: DMVActivityPage = try? await api.get("/api/dmv/activity", query: items(offset: events.count)), gen == generation else { return }
        events += r.events; total = r.total
    }
}
