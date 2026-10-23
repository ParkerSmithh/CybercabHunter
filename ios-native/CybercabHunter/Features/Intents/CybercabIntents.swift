import AppIntents
import CoreSpotlight
import CoreTransferable
import SwiftUI

// Phase 6: App Intents. Siri, Shortcuts, Spotlight and Apple Intelligence
// reach the app through these. They read the same public API as the app
// (FleetSnapshot, /api/robotaxi-vehicles) and open native screens through
// AppRouter.shared. Nothing here signs in, writes or needs an account.

/// The two service areas, for "Open the Zones map for Dallas".
enum ServiceCity: String, AppEnum {
    case austin, dallas
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "City"
    static let caseDisplayRepresentations: [ServiceCity: DisplayRepresentation] = [.austin: "Austin", .dallas: "Dallas"]
}

struct OpenZonesIntent: AppIntent {
    static let title: LocalizedStringResource = "Open the Zones Map"
    static let description = IntentDescription("Shows the Cybercab service zone map, with live camera sightings, for Austin or Dallas.")
    static let openAppWhenRun = true

    @Parameter(title: "City", default: .austin) var city: ServiceCity

    static var parameterSummary: some ParameterSummary { Summary("Open the Zones map for \(\.$city)") }

    @MainActor
    func perform() async throws -> some IntentResult {
        AppRouter.shared.openZones(city.rawValue)
        return .result()
    }
}

struct SubmitSightingIntent: AppIntent {
    static let title: LocalizedStringResource = "Submit a Cybercab Sighting"
    static let description = IntentDescription("Opens the form to submit a photo of a Cybercab you spotted. You need to be signed in.")
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        AppRouter.shared.requestSubmitSighting()
        return .result()
    }
}

struct FleetStatsIntent: AppIntent {
    static let title: LocalizedStringResource = "Check the Cybercab Fleet"
    static let description = IntentDescription("Tells you how many vehicles Cybercab Hunter's public registry documents and how many Tesla robotaxi VINs the Texas DMV roster lists (kept apart: neither is the number in service right now). With a city: that city's registry and the last 24 hours of sightings.")

    @Parameter(title: "City") var city: ServiceCity?
    static var parameterSummary: some ParameterSummary { Summary("Cybercab fleet in \(\.$city)") }

    func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView & ReturnsValue<String> {
        let a = try await Self.answer(city: city)
        return .result(value: a.spoken, dialog: IntentDialog(stringLiteral: a.spoken), view: SiriAnswerCard(answer: a, open: OpenScreenIntent(.cars), openTitle: "Open Cars"))
    }
}

/// What Siri says when the data can't be reached.
enum IntentFailure: Error, CustomLocalizedStringResourceConvertible {
    case unavailable, notFound
    case locationNotAllowedYet, locationDenied, locationUnavailable, outsideServiceAreas
    var localizedStringResource: LocalizedStringResource {
        switch self {
        case .unavailable: "Cybercab Hunter couldn't be reached. Check your connection and try again."
        case .notFound: "That Cybercab isn't in the public registry."
        case .locationNotAllowedYet: "To check near you, open Cybercab Hunter, then Account, Siri & Shortcuts, and allow location. Or ask for Austin or Dallas sightings."
        case .locationDenied: "Location is off for Cybercab Hunter. You can allow it in Settings, or ask for Austin or Dallas sightings instead."
        case .locationUnavailable: "Your location isn't available right now. Try again, or ask for Austin or Dallas sightings."
        case .outsideServiceAreas: "Cybercab Hunter tracks Austin and Dallas, and you're not near either. Ask for Austin or Dallas sightings instead."
        }
    }
}

/// The card shown with the Fleet Stats answer (Siri and Shortcuts).
struct FleetSnippetView: View {
    let snapshot: FleetSnapshot
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 18) {
                figure(snapshot.registered, "Cybercabs")
                figure(snapshot.rides, "Rides")
                figure(snapshot.sightings, "Sightings")
            }
            if let today = snapshot.todayLine {
                Text(today).font(.footnote).foregroundStyle(.secondary)
            }
        }
        .padding()
    }
    private func figure(_ n: Int, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(n.formatted()).font(.title2.bold()).foregroundStyle(Color.brandGold).monospacedDigit()
            Text(label.uppercased()).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
        }
    }
}

// MARK: - Vehicles as entities (Siri, Spotlight, Apple Intelligence)

/// A Cybercab in the public registry. Indexed in Spotlight, so searching a
/// plate (or asking Siri) finds it and opens its page in the app.
///
/// Public fields only (what the vehicle's public page shows): never a
/// submitter, a moderation note or an exact place. Shared with other apps
/// and Apple Intelligence as a short text and the public page's link.
struct VehicleEntity: AppEntity, IndexedEntity, Transferable {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = TypeDisplayRepresentation(name: "Cybercab", numericFormat: "\(placeholder: .int) Cybercabs")
    static let defaultQuery = VehicleQuery()

    let id: String
    @Property(title: "Plate") var plate: String?
    @Property(title: "City") var city: String?
    @Property(title: "Recorded rides") var rides: Int?
    @Property(title: "Model") var model: String?
    @Property(title: "VIN") var vin: String?
    @Property(title: "First reported") var firstReported: Date?
    @Property(title: "Last reported") var lastReported: Date?

    var displayRepresentation: DisplayRepresentation {
        let subtitle = [model, city, rides.map { "\($0) \($0 == 1 ? "ride" : "rides") recorded" }].compactMap { $0 }.joined(separator: " · ")
        return DisplayRepresentation(title: "\(plate ?? "Cybercab")", subtitle: subtitle.isEmpty ? "Cybercab" : "\(subtitle)", image: .init(systemName: "car.fill"))
    }

    init(id: String, plate: String?, city: String?, rides: Int?, model: String? = nil, vin: String? = nil, firstReported: Date? = nil, lastReported: Date? = nil) {
        self.id = id
        self.plate = plate; self.city = city; self.rides = rides
        self.model = model; self.vin = vin; self.firstReported = firstReported; self.lastReported = lastReported
    }
    init(_ v: RegistryVehicle) {
        self.init(id: v.id, plate: v.licensePlate, city: v.city, rides: v.tripCount, model: v.model, vin: v.vin,
                  firstReported: SiriSpeech.instant(v.firstSeenAt), lastReported: SiriSpeech.instant(v.lastSeenAt))
    }
    init(_ d: VehicleDetail) {
        self.init(id: d.vehicle.id, plate: d.vehicle.licensePlate, city: d.vehicle.serviceArea ?? d.history.cities.first, rides: d.history.tripCount,
                  model: d.vehicle.model, vin: d.vehicle.vin, firstReported: SiriSpeech.instant(d.vehicle.firstSeenAt), lastReported: SiriSpeech.instant(d.vehicle.lastSeenAt))
    }

    /// What it becomes in another app or an Apple Intelligence request.
    var shareText: String {
        ["Cybercab \(plate ?? id)", model, city, vin.map { "VIN \($0)" }, AppConfig.webURL("/vehicle/\(id)").absoluteString].compactMap { $0 }.joined(separator: " · ")
    }
    static var transferRepresentation: some TransferRepresentation {
        ProxyRepresentation(exporting: \.shareText)
    }

    /// Extra words Spotlight matches on.
    var attributeSet: CSSearchableItemAttributeSet {
        let set = CSSearchableItemAttributeSet()
        set.keywords = ["Cybercab", "Tesla", "robotaxi", plate, plate?.replacingOccurrences(of: "-", with: ""), city].compactMap { $0 }
        return set
    }
}

struct VehicleQuery: EntityStringQuery {
    func entities(for identifiers: [String]) async throws -> [VehicleEntity] {
        var out: [VehicleEntity] = []
        for id in identifiers.prefix(20) {
            guard let d: VehicleDetail = try? await VehicleDirectory.api.get("/api/robotaxi-vehicles/\(id)") else { continue }
            out.append(VehicleEntity(d))
        }
        return out
    }
    /// A plate (or part of one), as the Cars search.
    func entities(matching string: String) async throws -> [VehicleEntity] {
        try await VehicleDirectory.search(string).map(VehicleEntity.init)
    }
    /// The vehicles you looked at recently first, then the registry's most recent (10 at most).
    func suggestedEntities() async throws -> [VehicleEntity] {
        let recent = await SpotlightRecents.entities()
        if recent.count >= 5 { return Array(recent.prefix(10)) }
        let more = (try? await VehicleDirectory.search("").map(VehicleEntity.init)) ?? []
        return Array((recent + more.filter { m in !recent.contains { $0.id == m.id } }).prefix(10))
    }
}

/// Opens a Cybercab's page in the Cars tab.
struct OpenVehicleIntent: OpenIntent {
    static let title: LocalizedStringResource = "Open a Cybercab"
    static let description = IntentDescription("Opens a Cybercab's page (rides, sightings, VIN) by its plate.")
    @Parameter(title: "Cybercab") var target: VehicleEntity

    @MainActor
    func perform() async throws -> some IntentResult {
        AppRouter.shared.openVehicle(id: target.id, plate: target.plate)
        return .result()
    }
}

/// The public registry, for the intents and the Spotlight index.
enum VehicleDirectory {
    /// Public endpoints only: no session is ever attached. (Unit tests point it at a stub.)
    static var api: APIClient { testAPI ?? APIClient(tokens: NoToken()) }
    nonisolated(unsafe) static var testAPI: APIClient?
    private struct NoToken: TokenProvider { func currentToken() -> String? { nil } }

    static func search(_ query: String, limit: Int = 10) async throws -> [RegistryVehicle] {
        var items = [URLQueryItem(name: "limit", value: String(limit))]
        let q = query.trimmingCharacters(in: .whitespaces)
        if !q.isEmpty { items.append(URLQueryItem(name: "q", value: String(q.prefix(40)))) }
        let list: VehicleList = try await api.get("/api/robotaxi-vehicles", query: items)
        return list.vehicles
    }

    /// Earlier versions indexed the whole public registry in Spotlight once a
    /// day; now only the vehicles you open are (SpotlightRecents). This removes
    /// that old index once, on the first launch after the update.
    static func retireFullRegistryIndex(defaults: UserDefaults = .standard) async {
        let key = "spotlightFullIndexRetired"
        guard !defaults.bool(forKey: key) else { return }
        do {
            try await CSSearchableIndex.default().deleteAppEntities(ofType: VehicleEntity.self)
            defaults.removeObject(forKey: "spotlightIndexedAt")
            defaults.set(true, forKey: key)
            await SpotlightRecents.reindex()
        } catch { /* tried again next launch */ }
    }
}

/// Spotlight and Siri suggestions: the vehicles you opened recently (at most
/// 30, newest first), on this iPhone only. Public records only; clearing them
/// (Siri & Shortcuts settings) removes them from Spotlight too.
enum SpotlightRecents {
    static let limit = 30
    static let key = "spotlightRecentVehicles"
    nonisolated(unsafe) static var defaults: UserDefaults = .standard
    nonisolated(unsafe) static var indexing = true   // tests turn the system index off

    struct Item: Codable, Equatable, Sendable { let id: String; let plate: String?; let city: String?; let model: String? }

    static func items() -> [Item] {
        (defaults.data(forKey: key)).flatMap { try? JSONDecoder().decode([Item].self, from: $0) } ?? []
    }

    static func entities() async -> [VehicleEntity] {
        items().map { VehicleEntity(id: $0.id, plate: $0.plate, city: $0.city, rides: nil, model: $0.model) }
    }

    /// Remembers a vehicle you opened and adds it to Spotlight (dropping the oldest past `limit`).
    static func record(_ e: VehicleEntity) async {
        var list = items().filter { $0.id != e.id }
        list.insert(Item(id: e.id, plate: e.plate, city: e.city, model: e.model), at: 0)
        let dropped = list.count > limit ? Array(list[limit...]) : []
        list = Array(list.prefix(limit))
        defaults.set(try? JSONEncoder().encode(list), forKey: key)
        guard indexing else { return }
        try? await CSSearchableIndex.default().indexAppEntities([e])
        if !dropped.isEmpty { try? await CSSearchableIndex.default().deleteAppEntities(identifiedBy: dropped.map(\.id), ofType: VehicleEntity.self) }
    }

    static func reindex() async {
        guard indexing else { return }
        try? await CSSearchableIndex.default().indexAppEntities(await entities())
    }

    static func clear() async {
        defaults.removeObject(forKey: key)
        guard indexing else { return }
        try? await CSSearchableIndex.default().deleteAppEntities(ofType: VehicleEntity.self)
    }
}

// MARK: - Siri phrases and the Shortcuts app

/// Ten App Shortcuts (Apple's limit per app). Every other action
/// (Quick Status, Open Sightings for a city, Submit a Sighting, Open a Cybercab)
/// is still in the Shortcuts app and Siri can run it by name. Siri matches
/// these phrases loosely, not word for word.
struct CybercabShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: FleetStatsIntent(), phrases: [
            "Check the Cybercab fleet in \(.applicationName)",
            "How many Cybercabs are tracked in \(.applicationName)",
            "\(.applicationName) fleet stats",
            "How many Cybercabs are in \(\.$city) in \(.applicationName)",
            "Cybercab activity in \(\.$city) in \(.applicationName)"
        ], shortTitle: "Check Fleet", systemImageName: "chart.bar.fill")
        AppShortcut(intent: CheckDMVIntent(), phrases: [
            "Check Cybercab DMV updates in \(.applicationName)",
            "What's new in the \(.applicationName) DMV tracker",
            "How many Cybercabs are in the Texas DMV dataset in \(.applicationName)"
        ], shortTitle: "DMV Updates", systemImageName: "doc.text.magnifyingglass")
        AppShortcut(intent: OpenVehicleIntent(), phrases: [
            "Find a Cybercab in \(.applicationName)",
            "Find \(\.$target) in \(.applicationName)",
            "Look up \(\.$target) in \(.applicationName)"
        ], shortTitle: "Find a Cybercab", systemImageName: "magnifyingglass")
        AppShortcut(intent: RecentSightingsIntent(), phrases: [
            "Show the latest Cybercab sightings in \(.applicationName)",
            "Check Cybercab sightings in \(\.$city) in \(.applicationName)",
            "\(.applicationName) sightings in \(\.$city)"
        ], shortTitle: "Recent Sightings", systemImageName: "camera.viewfinder")
        AppShortcut(intent: OpenScreenIntent(), phrases: [
            "Open \(\.$destination) in \(.applicationName)",
            "Show \(\.$destination) in \(.applicationName)",
            "Show the Cybercab map in \(.applicationName)",
            "Open \(.applicationName) alert settings"
        ], shortTitle: "Open a Screen", systemImageName: "rectangle.stack")
        AppShortcut(intent: DailyBriefingIntent(), phrases: [
            "Give me my Cybercab briefing in \(.applicationName)",
            "\(.applicationName) daily report",
            "What's new with Cybercabs today in \(.applicationName)",
            "Give me a quick Cybercab status in \(.applicationName)",
            "What's happening with Cybercabs in \(\.$city) in \(.applicationName)"
        ], shortTitle: "Daily Briefing", systemImageName: "newspaper")
        AppShortcut(intent: NearbySightingsIntent(), phrases: [
            "Find Cybercab sightings near me in \(.applicationName)",
            "Have any Cybercabs been spotted near me in \(.applicationName)",
            "\(.applicationName) sightings nearby"
        ], shortTitle: "Nearby Sightings", systemImageName: "location.circle")
        AppShortcut(intent: FleetGrowthIntent(), phrases: [
            "How much has the Cybercab fleet grown in \(.applicationName)",
            "Check Cybercab fleet growth in \(.applicationName)",
            "Cybercab growth \(\.$period) in \(.applicationName)"
        ], shortTitle: "Fleet Growth", systemImageName: "chart.line.uptrend.xyaxis")
        AppShortcut(intent: VehicleHistoryIntent(), phrases: [
            "Show the history of \(\.$vehicle) in \(.applicationName)",
            "When was \(\.$vehicle) last spotted in \(.applicationName)",
            "Get Cybercab history in \(.applicationName)"
        ], shortTitle: "Vehicle History", systemImageName: "clock.arrow.circlepath")
        AppShortcut(intent: ServiceZoneIntent(), phrases: [
            "How big is the \(\.$city) Cybercab service area in \(.applicationName)",
            "Check the \(\.$city) service zone in \(.applicationName)",
            "Is \(.applicationName) tracking \(\.$city)"
        ], shortTitle: "Service Zone", systemImageName: "map")
    }
}
