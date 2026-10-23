import AppIntents
import CoreSpotlight
import CoreTransferable
import SwiftUI

// Cybercab Hunter's public data as App Entities, for Siri, Apple Intelligence
// and Spotlight's semantic search: sightings, Texas DMV snapshots, service
// zones (with their recent activity) and the fleet as a whole, beside
// VehicleEntity (CybercabIntents.swift). Public fields only. Each one:
//   • resolves by id through SiriData (cached, public endpoints),
//   • is indexed in Spotlight from data a screen already loaded (SiriIndex:
//     no extra requests, bounded, stale items removed),
//   • exports a short factual text (Transferable), and
//   • opens its native screen (an OpenIntent).

// MARK: - Sighting

/// An approved public photo sighting (moderator-reviewed): city, street-level
/// place, plate when it belongs to a public registry vehicle, and when.
struct SightingEntity: AppEntity, IndexedEntity, Transferable {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Cybercab Sighting", numericFormat: "\(placeholder: .int) Cybercab sightings")
    static let defaultQuery = SightingQuery()

    let id: String
    @Property(title: "City") var city: String?
    @Property(title: "Place") var place: String?
    @Property(title: "Plate") var plate: String?
    @Property(title: "Spotted") var spotted: Date?
    @Property(title: "Plate of an approved Cybercab") var approvedCybercab: Bool
    @Property(title: "Summary") var summary: String

    init(_ s: PublicSighting, now: Date = .now) {
        id = s.id
        city = s.city; place = s.location; plate = s.plate; spotted = SiriSpeech.instant(s.spottedAt); approvedCybercab = s.cybercab
        summary = SiriSummaries.sighting(city: s.city, place: s.location, plate: s.plate, spotted: SiriSpeech.instant(s.spottedAt), now: now)
    }

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "Cybercab sighting\(city.map { " in \($0)" } ?? "")",
                              subtitle: "\([place, spotted.map { SiriSpeech.shortDay(SiriSpeech.iso($0)) }].compactMap { $0 }.joined(separator: " · "))",
                              image: .init(systemName: "camera.viewfinder"))
    }

    static var transferRepresentation: some TransferRepresentation { ProxyRepresentation(exporting: \.summary) }

    /// What Spotlight's semantic search reads (IndexedEntity, iOS 18.0+).
    var attributeSet: CSSearchableItemAttributeSet {
        let a = CSSearchableItemAttributeSet()
        a.contentDescription = summary; a.city = city; a.namedLocation = place; a.contentCreationDate = spotted
        a.keywords = ["Cybercab", "sighting", "spotted", "robotaxi", city, plate].compactMap { $0 }
        return a
    }
}

struct SightingQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [SightingEntity] {
        let page: PublicSightingsPage = try await SiriData.shared.get("/api/sightings", query: [URLQueryItem(name: "city", value: "all"), URLQueryItem(name: "limit", value: "48")])
        return page.sightings.filter { identifiers.contains($0.id) }.map { SightingEntity($0) }   // older than the newest 48: gone from Siri too
    }
    func suggestedEntities() async throws -> [SightingEntity] {
        let page: PublicSightingsPage = try await SiriData.shared.get("/api/sightings", query: [URLQueryItem(name: "city", value: "all"), URLQueryItem(name: "limit", value: "10")])
        return page.sightings.map { SightingEntity($0) }
    }
}

struct OpenSightingIntent: OpenIntent {
    static let title: LocalizedStringResource = "Open a Cybercab Sighting"
    static let description = IntentDescription("Opens Cybercab sightings for that sighting's city.")
    @Parameter(title: "Sighting") var target: SightingEntity
    @MainActor
    func perform() async throws -> some IntentResult {
        AppRouter.shared.openSightings(city: target.city?.lowercased())
        return .result()
    }
}

// MARK: - Texas DMV snapshot

/// One daily Texas DMV snapshot of Tesla Robotaxi's VINs, as Cybercab Hunter
/// recorded it, and what was first detected in it. Never a registration date.
struct DMVSnapshotEntity: AppEntity, IndexedEntity, Transferable {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Texas DMV Snapshot", numericFormat: "\(placeholder: .int) Texas DMV snapshots")
    static let defaultQuery = DMVSnapshotQuery()

    let id: String                                   // "2026-10-22"
    @Property(title: "Dataset date") var date: Date?
    @Property(title: "Total VINs") var totalVINs: Int
    @Property(title: "Cybercab VINs") var cybercabVINs: Int
    @Property(title: "Model Y VINs") var modelYVINs: Int
    @Property(title: "Newly detected VINs") var newlyDetected: Int?
    @Property(title: "Newly detected Cybercab VINs") var newlyDetectedCybercabs: Int?
    @Property(title: "Summary") var summary: String

    init(date: String, total: Int, cybercab: Int, modelY: Int, added: DMVClassCounts?, processed: Bool, now: Date = .now) {
        id = date
        self.date = SiriSpeech.calendarDate(date)
        totalVINs = total; cybercabVINs = cybercab; modelYVINs = modelY
        newlyDetected = processed ? (added?.sum ?? 0) : nil
        newlyDetectedCybercabs = processed ? (added?.cybercab ?? 0) : nil
        summary = SiriSummaries.dmvSnapshot(date: date, total: total, cybercab: cybercab, modelY: modelY, newly: processed ? (added?.sum ?? 0) : nil, newlyCybercab: added?.cybercab, now: now)
    }

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "Texas DMV snapshot, \(SiriSpeech.shortDay(id))",
                              subtitle: "\(totalVINs) VINs\(newlyDetected.map { $0 > 0 ? " · +\($0) newly detected" : "" } ?? "")",
                              image: .init(systemName: "doc.text.magnifyingglass"))
    }

    static var transferRepresentation: some TransferRepresentation { ProxyRepresentation(exporting: \.summary) }

    var attributeSet: CSSearchableItemAttributeSet {
        let a = CSSearchableItemAttributeSet()
        a.contentDescription = summary; a.contentCreationDate = date
        a.keywords = ["Texas DMV", "DMV", "VIN", "Cybercab", "Model Y", "registration", "snapshot"]
        return a
    }

    /// The snapshots in the growth series (actual snapshots only).
    static func all(_ g: DMVGrowth, processed: Bool) -> [DMVSnapshotEntity] {
        g.points.map { DMVSnapshotEntity(date: $0.date, total: $0.total, cybercab: $0.cybercab, modelY: $0.modelY, added: $0.baseline ? nil : $0.added, processed: processed && !$0.baseline) }
    }
}

struct DMVSnapshotQuery: EntityQuery {
    private func load() async throws -> [DMVSnapshotEntity] {
        async let g: DMVGrowth = SiriData.shared.get("/api/dmv/growth", query: [URLQueryItem(name: "range", value: "all")])
        async let o: DMVOverview? = try? SiriData.shared.get("/api/dmv/overview")
        let processed = (await o).map { ($0.processingPending ?? 0) == 0 } ?? false
        return DMVSnapshotEntity.all(try await g, processed: processed)
    }
    func entities(for identifiers: [String]) async throws -> [DMVSnapshotEntity] {
        try await load().filter { identifiers.contains($0.id) }
    }
    /// The latest snapshot and the ones where something changed, newest first.
    func suggestedEntities() async throws -> [DMVSnapshotEntity] {
        let all = try await load().sorted { $0.id > $1.id }
        return Array((all.prefix(1) + all.dropFirst().filter { ($0.newlyDetected ?? 0) > 0 }).prefix(8))
    }
}

struct OpenDMVSnapshotIntent: OpenIntent {
    static let title: LocalizedStringResource = "Open a Texas DMV Snapshot"
    static let description = IntentDescription("Opens the Texas DMV tracker.")
    @Parameter(title: "Snapshot") var target: DMVSnapshotEntity
    @MainActor
    func perform() async throws -> some IntentResult {
        AppRouter.shared.openDMVTracker()
        return .result()
    }
}

// MARK: - Service zone

/// A service area: its coverage (and where that figure comes from) and its
/// recent public activity. The activity figures are as of `updated`.
struct ServiceZoneEntity: AppEntity, IndexedEntity, Transferable {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Cybercab Service Zone", numericFormat: "\(placeholder: .int) Cybercab service zones")
    static let defaultQuery = ServiceZoneQuery()

    let id: String                                   // "austin"
    @Property(title: "City") var name: String
    @Property(title: "Area (square miles)") var squareMiles: Double?
    @Property(title: "Area source") var areaSource: String
    @Property(title: "In service since") var inServiceSince: Date?
    @Property(title: "Public registry vehicles") var registryVehicles: Int?
    @Property(title: "Approved sightings, last 24 hours") var approvedSightings24h: Int?
    @Property(title: "Camera detections, last 24 hours") var cameraDetections24h: Int?
    @Property(title: "Updated") var updated: Date?
    @Property(title: "Summary") var summary: String

    init(_ s: HomepageStats, now: Date = .now) {
        id = s.city
        name = s.name
        squareMiles = s.area?.squareMiles
        areaSource = SiriSpeech.zoneSource(s.city)
        inServiceSince = s.area?.inServiceSince.flatMap(SiriSpeech.calendarDate)
        registryVehicles = s.area?.vehicles
        approvedSightings24h = s.sightings?.last24h
        cameraDetections24h = s.cameras?.detections24h
        updated = SiriSpeech.instant(s.generatedAt) ?? now
        summary = SiriSummaries.zone(s)
    }

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name) service zone",
                              subtitle: "\(squareMiles.map { "About \(Int($0.rounded())) sq mi" } ?? "Cybercab service area")",
                              image: .init(systemName: "map"))
    }

    static var transferRepresentation: some TransferRepresentation { ProxyRepresentation(exporting: \.summary) }

    var attributeSet: CSSearchableItemAttributeSet {
        let a = CSSearchableItemAttributeSet()
        a.contentDescription = summary; a.city = name; a.contentModificationDate = updated
        a.keywords = ["Cybercab", "service zone", "service area", "geofence", "coverage", "square miles", name]
        return a
    }
}

struct ServiceZoneQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [ServiceZoneEntity] {
        var out: [ServiceZoneEntity] = []
        for id in identifiers.prefix(4) where ServiceCity(rawValue: id) != nil {
            if let s: HomepageStats = try? await SiriData.shared.get("/api/homepage-stats", query: [URLQueryItem(name: "city", value: id)]) { out.append(ServiceZoneEntity(s)) }
        }
        return out
    }
    func suggestedEntities() async throws -> [ServiceZoneEntity] {
        try await entities(for: ServiceCity.allCases.map(\.rawValue))
    }
}

struct OpenServiceZoneIntent: OpenIntent {
    static let title: LocalizedStringResource = "Open a Cybercab Service Zone"
    static let description = IntentDescription("Opens that city's service zone on the map.")
    @Parameter(title: "Service zone") var target: ServiceZoneEntity
    @MainActor
    func perform() async throws -> some IntentResult {
        AppRouter.shared.openZones(target.id)
        return .result()
    }
}

// MARK: - The fleet

/// The whole of Cybercab Hunter's public tracking, as one entity: the public
/// registry, the Texas DMV roster and today's counts — kept apart, as of `updated`.
struct FleetSummaryEntity: UniqueAppEntity, IndexedEntity, Transferable {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Cybercab Fleet"
    static let defaultQuery = FleetSummaryQuery()

    let id = "fleet"
    @Property(title: "Public registry vehicles") var registryVehicles: Int
    @Property(title: "Recorded rides") var recordedRides: Int?
    @Property(title: "Approved sightings, all time") var approvedSightingsAllTime: Int?
    @Property(title: "Approved sightings today") var approvedSightingsToday: Int?
    @Property(title: "Camera detections today") var cameraDetectionsToday: Int?
    @Property(title: "New registry vehicles today") var newRegistryVehiclesToday: Int?
    @Property(title: "Texas DMV VINs") var dmvVINs: Int?
    @Property(title: "Texas DMV Cybercab VINs") var dmvCybercabVINs: Int?
    @Property(title: "Updated") var updated: Date
    @Property(title: "Summary") var summary: String

    init(registry: Int, rides: Int?, sightingsAllTime: Int?, today: DailyReport.Day?, dmvTotal: Int?, dmvCybercab: Int?, updated: Date = .now) {
        registryVehicles = registry; recordedRides = rides; approvedSightingsAllTime = sightingsAllTime
        approvedSightingsToday = today?.sightings; cameraDetectionsToday = today?.cameras; newRegistryVehiclesToday = today?.registry
        dmvVINs = dmvTotal; dmvCybercabVINs = dmvCybercab
        self.updated = updated
        summary = SiriSummaries.fleet(registry: registry, today: today, dmvTotal: dmvTotal, dmvCybercab: dmvCybercab)
    }

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "Cybercab fleet", subtitle: "\(registryVehicles) registry vehicles\(dmvVINs.map { " · \($0) DMV VINs" } ?? "")", image: .init(systemName: "chart.bar.fill"))
    }

    static var transferRepresentation: some TransferRepresentation { ProxyRepresentation(exporting: \.summary) }

    var attributeSet: CSSearchableItemAttributeSet {
        let a = CSSearchableItemAttributeSet()
        a.contentDescription = summary; a.contentModificationDate = updated
        a.keywords = ["Cybercab", "fleet", "how many", "registry", "sightings", "Texas DMV", "VINs"]
        return a
    }
}

struct FleetSummaryQuery: UniqueAppEntityQuery {
    func uniqueEntity() async throws -> FleetSummaryEntity {
        async let stats: RegistryStats = SiriData.shared.get("/api/registry/stats")
        async let daily: DailyReport? = try? SiriData.shared.get("/api/daily")
        async let dmv: DMVOverview? = try? SiriData.shared.get("/api/dmv/overview")
        let s = try await stats, d = await daily, o = await dmv
        return FleetSummaryEntity(registry: s.publicVehicles, rides: s.recordedRides, sightingsAllTime: s.sightingsAllTime, today: d?.day,
                                  dmvTotal: o?.totals.map { $0.total ?? $0.sum }, dmvCybercab: o?.totals?.cybercab)
    }
}

// MARK: - The entities' own sentences (what Apple Intelligence reads)

enum SiriSummaries {
    static func sighting(city: String?, place: String?, plate: String?, spotted: Date?, now: Date = .now) -> String {
        var s = "Approved Cybercab sighting (moderator-reviewed photo)"
        if let city { s += " in \(city)" }
        if let place, !place.isEmpty { s += ", near \(place)" }
        if let spotted { s += ", \(SiriSpeech.day(SiriSpeech.iso(spotted), now: now))" }
        if let plate { s += ", plate \(plate)" }
        return s + ". A sighting is one moment, not where the car is now."
    }

    static func dmvSnapshot(date: String, total: Int, cybercab: Int, modelY: Int, newly: Int?, newlyCybercab: Int?, now: Date = .now) -> String {
        var s = "Texas DMV dataset of \(SiriSpeech.day(date, now: now)): \(SiriSpeech.n(total)) Tesla Robotaxi VINs, \(SiriSpeech.n(cybercab)) Cybercab and \(SiriSpeech.n(modelY)) Model Y."
        if let newly {
            s += newly > 0 ? " Cybercab Hunter first detected \(SiriSpeech.plural(newly, "VIN", "VINs")) in it\(newlyCybercab.map { $0 > 0 ? ", \(SiriSpeech.n($0)) of them Cybercabs" : "" } ?? "")." : " No VINs were first detected in it."
        }
        return s + " TxDMV publishes no registration dates."
    }

    static func zone(_ s: HomepageStats) -> String {
        var parts: [String] = []
        if let sq = s.area?.squareMiles { parts.append("\(s.name) Cybercab service zone: about \(SiriSpeech.n(Int(sq.rounded()))) square miles (\(SiriSpeech.zoneSource(s.city))).") }
        else { parts.append("\(s.name) Cybercab service zone.") }
        if let since = s.area?.inServiceSince { parts.append("In service since \(SiriSpeech.day(since)).") }
        if let v = s.area?.vehicles { parts.append("\(SiriSpeech.plural(v, "public registry vehicle", "public registry vehicles")).") }
        if let line = SiriSpeech.recentSightingsSentence(s) { parts.append(line) }
        return parts.joined(separator: " ")
    }

    static func fleet(registry: Int, today: DailyReport.Day?, dmvTotal: Int?, dmvCybercab: Int?) -> String {
        var parts = ["Cybercab Hunter's public registry: \(SiriSpeech.plural(registry, "vehicle", "vehicles")) documented by riders and spotters."]
        if let t = dmvTotal { parts.append("Texas DMV roster: \(SiriSpeech.plural(t, "Tesla robotaxi VIN", "Tesla robotaxi VINs"))\(dmvCybercab.map { ", \(SiriSpeech.n($0)) Cybercabs" } ?? "").") }
        if let today, let line = SiriSpeech.todaySentence(today) { parts.append(line) }
        parts.append("Neither figure is the number of cars in service right now.")
        return parts.joined(separator: " ")
    }
}

// MARK: - Spotlight: what's indexed, from data the app already has

/// Indexes entities from responses a screen has just loaded (never fetches on
/// its own): the fleet and each city's zone (Home), DMV snapshots (the DMV
/// tracker), each city's newest sightings (Sightings). Bounded, and anything
/// that dropped out (an older sighting, a snapshot that's no longer recent)
/// is removed. Identical content isn't re-indexed.
@MainActor
enum SiriIndex {
    static var enabled = true                       // tests turn the system index off
    static var defaults: UserDefaults = .standard
    private static var lastSignature: [String: Int] = [:]
    static let sightingsPerCity = 12

    /// Indexing never holds up a screen: it runs after, at low priority.
    static func later(_ work: @escaping @MainActor () async -> Void) {
        guard enabled else { return }
        Task(priority: .utility) { await work() }
    }

    private static func changed(_ key: String, _ value: some Hashable) -> Bool {
        let h = value.hashValue
        if lastSignature[key] == h { return false }
        lastSignature[key] = h
        return true
    }

    static func fleet(registry: RegistryStats?, daily: DailyReport?, dmv: DMVRegistrations?) async {
        guard enabled, let r = registry else { return }
        let e = FleetSummaryEntity(registry: r.publicVehicles, rides: r.recordedRides, sightingsAllTime: r.sightingsAllTime, today: daily?.day,
                                   dmvTotal: dmv?.snapshot?.total, dmvCybercab: dmv?.snapshot?.cybercab)
        guard changed("fleet", e.summary) else { return }
        try? await CSSearchableIndex.default().indexAppEntities([e])
    }

    static func zone(_ s: HomepageStats) async {
        guard enabled, ServiceCity(rawValue: s.city) != nil else { return }
        let e = ServiceZoneEntity(s)
        guard changed("zone-\(s.city)", e.summary) else { return }
        try? await CSSearchableIndex.default().indexAppEntities([e])
    }

    /// From the DMV tracker's full growth series (actual snapshots, real
    /// totals): the latest snapshot and the recent ones that changed the roster,
    /// at most 6. Newly detected counts only once every snapshot is processed.
    static func dmv(_ g: DMVGrowth, processed: Bool) async {
        guard enabled, g.range == "all" else { return }
        let list = indexableDMV(g, processed: processed)
        guard !list.isEmpty, changed("dmv", list.map(\.summary)) else { return }
        await replace(DMVSnapshotEntity.self, key: "siriIndexedDMV", with: list)
    }

    /// The latest snapshot, then the recent ones that changed the roster (6 at most).
    nonisolated static func indexableDMV(_ g: DMVGrowth, processed: Bool) -> [DMVSnapshotEntity] {
        let all = DMVSnapshotEntity.all(g, processed: processed).sorted { $0.id > $1.id }
        return Array((all.prefix(1) + all.dropFirst().filter { ($0.newlyDetected ?? 0) > 0 }).prefix(6))
    }

    /// One city's newest sightings (the Sightings tab's first page).
    static func sightings(_ items: [PublicSighting], city: String) async {
        guard enabled else { return }
        let list = items.prefix(sightingsPerCity).map { SightingEntity($0) }
        guard changed("sightings-\(city)", list.map(\.id)) else { return }
        await replace(SightingEntity.self, key: "siriIndexedSightings-\(city)", with: Array(list))
    }

    /// Indexes `list` and removes what this key indexed before and no longer lists.
    private static func replace<E: IndexedEntity>(_ type: E.Type, key: String, with list: [E]) async where E.ID == String {
        let old = Set(defaults.stringArray(forKey: key) ?? [])
        let new = Set(list.map(\.id))
        let gone = Array(old.subtracting(new))
        if !gone.isEmpty { try? await CSSearchableIndex.default().deleteAppEntities(identifiedBy: gone, ofType: E.self) }
        try? await CSSearchableIndex.default().indexAppEntities(list)
        defaults.set(Array(new), forKey: key)
    }

    /// Settings › Siri & Shortcuts › Clear: everything this app put in Spotlight.
    static func clearAll() async {
        lastSignature = [:]
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix("siriIndexed") { defaults.removeObject(forKey: key) }
        await SpotlightRecents.clear()
        guard enabled else { return }
        let index = CSSearchableIndex.default()
        try? await index.deleteAppEntities(ofType: SightingEntity.self)
        try? await index.deleteAppEntities(ofType: DMVSnapshotEntity.self)
        try? await index.deleteAppEntities(ofType: ServiceZoneEntity.self)
        try? await index.deleteAppEntities(ofType: FleetSummaryEntity.self)
    }
}

// MARK: - Donations: what the rider does in the app

/// Tells the system about actions the rider takes in the app (Apple's
/// IntentDonationManager), once per action per launch. Donations shape Siri
/// Suggestions and predictions; they don't teach Siri new phrases.
@MainActor
enum SiriDonations {
    static var enabled = true
    private(set) static var done: Set<String> = []
    static func donate(_ key: String, _ intent: some AppIntent) {
        guard enabled, done.insert(key).inserted else { return }
        Task { _ = try? await intent.donate() }
    }
}

// MARK: - Onscreen entities

/// Tells the system which entity a screen shows (Apple's onscreen-entity API,
/// iOS 18.4+), so Siri with Apple Intelligence can resolve "this …".
struct OnscreenEntity<E: AppEntity>: ViewModifier where E.ID == String {
    let id: String?
    init(_ type: E.Type, id: String?) { self.id = id }
    func body(content: Content) -> some View {
        if #available(iOS 18.4, *), let id {
            content.appEntityIdentifier(EntityIdentifier(for: E.self, identifier: id))
        } else {
            content
        }
    }
}
