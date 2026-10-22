import AppIntents
import CoreSpotlight
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
    static let title: LocalizedStringResource = "Cybercab Fleet Stats"
    static let description = IntentDescription("Tells you how many Cybercabs are registered, how many rides and sightings are recorded, and today's Cybercab Daily.")

    func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView & ReturnsValue<String> {
        let snapshot: FleetSnapshot
        do { snapshot = try await FleetSnapshot.load(base: AppConfig.siteURL) } catch {
            throw IntentFailure.unavailable
        }
        return .result(value: snapshot.spokenSummary, dialog: IntentDialog(stringLiteral: snapshot.spokenSummary), view: FleetSnippetView(snapshot: snapshot))
    }
}

/// What Siri says when the data can't be reached.
enum IntentFailure: Error, CustomLocalizedStringResourceConvertible {
    case unavailable, notFound
    var localizedStringResource: LocalizedStringResource {
        switch self {
        case .unavailable: "Cybercab Hunter couldn't be reached. Check your connection and try again."
        case .notFound: "That Cybercab isn't in the public registry."
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
struct VehicleEntity: AppEntity, IndexedEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = TypeDisplayRepresentation(name: "Cybercab", numericFormat: "\(placeholder: .int) Cybercabs")
    static let defaultQuery = VehicleQuery()

    let id: String
    let plate: String?
    let city: String?
    let rides: Int?

    var displayRepresentation: DisplayRepresentation {
        let subtitle = [city, rides.map { "\($0) \($0 == 1 ? "ride" : "rides") recorded" }].compactMap { $0 }.joined(separator: " · ")
        return DisplayRepresentation(title: "\(plate ?? "Cybercab")", subtitle: subtitle.isEmpty ? "Cybercab" : "\(subtitle)", image: .init(systemName: "car.fill"))
    }

    init(id: String, plate: String?, city: String?, rides: Int?) {
        self.id = id; self.plate = plate; self.city = city; self.rides = rides
    }
    init(_ v: RegistryVehicle) { self.init(id: v.id, plate: v.licensePlate, city: v.city, rides: v.tripCount) }

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
            out.append(VehicleEntity(id: d.vehicle.id, plate: d.vehicle.licensePlate, city: d.vehicle.serviceArea ?? d.history.cities.first, rides: d.history.tripCount))
        }
        return out
    }
    /// A plate (or part of one), as the Cars search.
    func entities(matching string: String) async throws -> [VehicleEntity] {
        try await VehicleDirectory.search(string).map(VehicleEntity.init)
    }
    func suggestedEntities() async throws -> [VehicleEntity] {
        try await VehicleDirectory.search("").map(VehicleEntity.init)
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

    /// Indexes the whole public registry in Spotlight, at most once a day (and
    /// replaces the previous index, so a vehicle that left the registry goes).
    static func indexInSpotlight(api: APIClient = VehicleDirectory.api, now: Date = .now, defaults: UserDefaults = .standard) async {
        let key = "spotlightIndexedAt"
        if let last = defaults.object(forKey: key) as? Date, now.timeIntervalSince(last) < 24 * 3600 { return }
        var all: [RegistryVehicle] = []
        var offset = 0
        while offset < 2000 {
            guard let page: VehicleList = try? await api.get("/api/robotaxi-vehicles", query: [URLQueryItem(name: "limit", value: "100"), URLQueryItem(name: "offset", value: String(offset))]) else { return }
            all += page.vehicles
            offset += page.vehicles.count
            if page.vehicles.isEmpty || offset >= page.total { break }
        }
        do {
            try await CSSearchableIndex.default().deleteAppEntities(ofType: VehicleEntity.self)
            try await CSSearchableIndex.default().indexAppEntities(all.map(VehicleEntity.init))
            defaults.set(now, forKey: key)
        } catch { /* tried again next launch */ }
    }
}

// MARK: - Siri phrases and the Shortcuts app

struct CybercabShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: FleetStatsIntent(), phrases: [
            "How many Cybercabs are on \(.applicationName)",
            "\(.applicationName) fleet stats",
            "Cybercab stats in \(.applicationName)"
        ], shortTitle: "Fleet Stats", systemImageName: "chart.bar.fill")
        AppShortcut(intent: OpenZonesIntent(), phrases: [
            "Open the zone map in \(.applicationName)",
            "Show the \(\.$city) zone in \(.applicationName)",
            "Where are the Cybercabs in \(.applicationName)"
        ], shortTitle: "Zones Map", systemImageName: "map.fill")
        AppShortcut(intent: SubmitSightingIntent(), phrases: [
            "Submit a sighting in \(.applicationName)",
            "I spotted a Cybercab in \(.applicationName)",
            "Report a Cybercab sighting in \(.applicationName)"
        ], shortTitle: "Submit Sighting", systemImageName: "camera.fill")
        AppShortcut(intent: OpenVehicleIntent(), phrases: [
            "Open a Cybercab in \(.applicationName)",
            "Look up \(\.$target) in \(.applicationName)"
        ], shortTitle: "Find a Cybercab", systemImageName: "car.fill")
    }
}
