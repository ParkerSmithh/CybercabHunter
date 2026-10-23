import AppIntents
import CoreLocation
import SwiftUI

// Siri, Shortcuts and Apple Intelligence actions beyond Phase 6's. Each one
// answers in Siri (dialog + a small card) without opening the app, and offers
// to open the matching screen. Data: SiriData (public, cached, bounded);
// sentences: SiriSpeech. Nothing here signs in, writes, or runs on a schedule.

/// The app's main screens, for "Open … in Cybercab Hunter".
enum AppDestination: String, AppEnum, CaseIterable {
    case home, map, cars, sightings, community, dmvTracker, alertSettings, siriSettings
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Screen"
    static let caseDisplayRepresentations: [AppDestination: DisplayRepresentation] = [
        .home: DisplayRepresentation(title: "Home", synonyms: ["the home screen", "Cybercab Hunter"]),
        .map: DisplayRepresentation(title: "Map", synonyms: ["the map", "the Cybercab map", "Zones", "the zone map"]),
        .cars: DisplayRepresentation(title: "Cars", synonyms: ["the registry", "vehicles"]),
        .sightings: DisplayRepresentation(title: "Sightings", synonyms: ["Cybercab sightings", "the sightings map"]),
        .community: DisplayRepresentation(title: "Community", synonyms: ["the community"]),
        .dmvTracker: DisplayRepresentation(title: "DMV Tracker", synonyms: ["the Texas DMV tracker", "the DMV tracker", "DMV updates"]),
        .alertSettings: DisplayRepresentation(title: "Alert Settings", synonyms: ["Activity Alerts", "alerts", "notifications", "alert settings"]),
        .siriSettings: DisplayRepresentation(title: "Siri Settings", synonyms: ["Siri and Shortcuts", "Shortcuts settings"])
    ]
}

/// Opens one of the app's screens through AppRouter (as the tabs and links do).
struct OpenScreenIntent: AppIntent {
    static let title: LocalizedStringResource = "Open a Cybercab Hunter Screen"
    static let description = IntentDescription("Opens Home, the map, Cars, Sightings, Community, the Texas DMV tracker, or Activity Alert settings.")
    static let openAppWhenRun = true

    @Parameter(title: "Screen", default: .home) var destination: AppDestination

    init() {}
    init(_ destination: AppDestination) { self.destination = destination }

    static var parameterSummary: some ParameterSummary { Summary("Open \(\.$destination)") }

    @MainActor
    func perform() async throws -> some IntentResult {
        AppRouter.shared.open(destination)
        return .result()
    }
}

/// Opens Sightings for a city (the card's "Open" button in Siri).
struct OpenSightingsIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Cybercab Sightings"
    static let description = IntentDescription("Opens approved Cybercab sightings, for Austin or Dallas.")
    static let openAppWhenRun = true
    @Parameter(title: "City", default: .austin) var city: ServiceCity
    init() {}
    init(city: ServiceCity) { self.city = city }
    @MainActor
    func perform() async throws -> some IntentResult {
        AppRouter.shared.openSightings(city: city.rawValue)
        return .result()
    }
}

// MARK: - Fleet, DMV, sightings

/// "How many Cybercabs…?" — the public registry and the Texas DMV roster,
/// named apart. With a city: that city's registry and the last 24 hours.
/// Replaces Phase 6's FleetStatsIntent answer (same type, so existing
/// shortcuts keep working).
extension FleetStatsIntent {
    static func answer(city: ServiceCity?) async throws -> SiriAnswer {
        let data = SiriData.shared
        do {
            if let city {
                let s: HomepageStats = try await data.get("/api/homepage-stats", query: [URLQueryItem(name: "city", value: city.rawValue)])
                return SiriSpeech.cityFleet(s)
            }
            async let stats: RegistryStats = data.get("/api/registry/stats")
            async let daily: DailyReport? = try? data.get("/api/daily")
            async let dmv: DMVOverview? = try? data.get("/api/dmv/overview")
            return SiriSpeech.fleet(stats: try await stats, daily: await daily, dmv: await dmv)
        } catch { throw IntentFailure.unavailable }
    }
}

struct CheckDMVIntent: AppIntent {
    static let title: LocalizedStringResource = "Check Texas DMV Updates"
    static let description = IntentDescription("Tells you how many Tesla robotaxi VINs the Texas DMV roster lists, how many are Cybercabs, and what Cybercab Hunter newly detected in the latest dataset.")

    func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView {
        let o: DMVOverview
        do { o = try await SiriData.shared.get("/api/dmv/overview") } catch { throw IntentFailure.unavailable }
        let a = SiriSpeech.dmv(o)
        return .result(dialog: IntentDialog(stringLiteral: a.spoken), view: SiriAnswerCard(answer: a, open: OpenScreenIntent(.dmvTracker), openTitle: "Open DMV Tracker"))
    }
}

struct RecentSightingsIntent: AppIntent {
    static let title: LocalizedStringResource = "Show Recent Cybercab Sightings"
    static let description = IntentDescription("Tells you about the latest approved Cybercab sightings and the last 24 hours, for Austin or Dallas.")

    @Parameter(title: "City", default: .austin) var city: ServiceCity
    static var parameterSummary: some ParameterSummary { Summary("Recent sightings in \(\.$city)") }

    init() {}
    init(city: ServiceCity) { self.city = city }

    func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView {
        let data = SiriData.shared
        let a: SiriAnswer
        do {
            async let page: PublicSightingsPage = data.get("/api/sightings", query: [URLQueryItem(name: "city", value: city.rawValue), URLQueryItem(name: "limit", value: "3")])
            async let stats: HomepageStats? = try? data.get("/api/homepage-stats", query: [URLQueryItem(name: "city", value: city.rawValue)])
            a = SiriSpeech.sightings(city: await stats, latest: try await page.sightings, cityName: city.title)
        } catch { throw IntentFailure.unavailable }
        return .result(dialog: IntentDialog(stringLiteral: a.spoken), view: SiriAnswerCard(answer: a, open: OpenSightingsIntent(city: city), openTitle: "Open Sightings"))
    }
}

// MARK: - Briefing and hands-free status

struct DailyBriefingIntent: AppIntent {
    static let title: LocalizedStringResource = "Cybercab Daily Briefing"
    static let description = IntentDescription("A short summary of today's Cybercab activity: sightings, newly detected Texas DMV VINs, and registry growth. Only what today's data supports.")

    @Parameter(title: "City") var city: ServiceCity?
    static var parameterSummary: some ParameterSummary { Summary("Cybercab briefing for \(\.$city)") }

    func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView {
        let a = try await Self.compose(city: city, quick: false)
        return .result(dialog: IntentDialog(stringLiteral: a.spoken), view: SiriAnswerCard(answer: a, open: OpenScreenIntent(.home), openTitle: "Open Cybercab Hunter"))
    }

    /// Shared with the hands-free status: the same (cached) requests.
    static func compose(city: ServiceCity?, quick: Bool) async throws -> SiriAnswer {
        let data = SiriData.shared
        async let daily: DailyReport? = try? data.get("/api/daily")
        async let dmv: DMVOverview? = try? data.get("/api/dmv/overview")
        async let stats: HomepageStats? = city == nil ? nil : try? data.get("/api/homepage-stats", query: [URLQueryItem(name: "city", value: city!.rawValue)])
        let (d, o, s) = await (daily, dmv, stats)
        if d == nil && o == nil && s == nil { throw IntentFailure.unavailable }
        return SiriSpeech.briefing(daily: d, dmv: o, city: s, quick: quick)
    }
}

/// Hands-free: two sentences, spoken, no app. (Not a CarPlay app; Siri decides
/// how to present it, including while driving.)
struct QuickStatusIntent: AppIntent {
    static let title: LocalizedStringResource = "Quick Cybercab Status"
    static let description = IntentDescription("A two-sentence Cybercab update for hands-free use: recent sightings and the latest Texas DMV change.")

    @Parameter(title: "City") var city: ServiceCity?

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let a = try await DailyBriefingIntent.compose(city: city, quick: true)
        return .result(dialog: IntentDialog(stringLiteral: a.spoken))
    }
}

// MARK: - Near me

struct NearbySightingsIntent: AppIntent {
    static let title: LocalizedStringResource = "Find Cybercab Sightings Near Me"
    static let description = IntentDescription("Uses your location, once, to tell you about Cybercab traffic-camera detections near you in the last 24 hours. Your location isn't stored or sent anywhere else.")

    static let radiusMiles = 3.0
    static let window: TimeInterval = 24 * 3600

    func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView {
        let location: CLLocation
        do { location = try await OneShotLocation.current() }
        catch LocationFailure.notDetermined { throw IntentFailure.locationNotAllowedYet }
        catch LocationFailure.denied { throw IntentFailure.locationDenied }
        catch { throw IntentFailure.locationUnavailable }
        let precise = await OneShotLocation.isPrecise
        let city = Self.nearestCity(to: location)
        guard let city else { throw IntentFailure.outsideServiceAreas }
        let list: [CameraDetection]
        do { list = try await SiriData.shared.get("/api/camera-sightings", query: city == .austin ? [] : [URLQueryItem(name: "city", value: city.rawValue)]) }
        catch { throw IntentFailure.unavailable }
        // Approximate location: a wider circle, and no exact distance.
        let radius = precise ? Self.radiusMiles : max(Self.radiusMiles, location.horizontalAccuracy / 1609.344)
        let hits = SiriSpeech.nearby(list, from: location, radiusMiles: radius, window: Self.window)
        let latest = list.compactMap { d in SiriSpeech.instant(d.observedAt).map { SiriSpeech.NearbyHit(camera: SiriSpeech.titleCase(d.cameraName), miles: 0, at: $0) } }.max { $0.at < $1.at }
        let a = SiriSpeech.nearbyAnswer(hits: hits, radiusMiles: radius, precise: precise, cityName: city.title, latestInCity: latest)
        return .result(dialog: IntentDialog(stringLiteral: a.spoken), view: SiriAnswerCard(answer: a, open: OpenZonesIntent(city: city), openTitle: "Open Map"))
    }

    /// The service area whose zone centre is within 60 miles, nearest first.
    static func nearestCity(to location: CLLocation) -> ServiceCity? {
        ServiceCity.allCases.compactMap { c -> (ServiceCity, Double)? in
            let poly = WebData.city(c.rawValue).polygon
            guard !poly.isEmpty else { return nil }
            let lat = poly.map(\.latitude).reduce(0, +) / Double(poly.count), lng = poly.map(\.longitude).reduce(0, +) / Double(poly.count)
            let miles = location.distance(from: CLLocation(latitude: lat, longitude: lng)) / 1609.344
            return miles <= 60 ? (c, miles) : nil
        }.min { $0.1 < $1.1 }?.0
    }
}

// MARK: - Fleet growth

enum GrowthPeriod: String, AppEnum {
    case day, week, month, all
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Period"
    static let caseDisplayRepresentations: [GrowthPeriod: DisplayRepresentation] = [
        .day: DisplayRepresentation(title: "Latest day", synonyms: ["today", "daily", "yesterday"]),
        .week: DisplayRepresentation(title: "This week", synonyms: ["week", "weekly", "last week"]),
        .month: DisplayRepresentation(title: "This month", synonyms: ["month", "monthly", "last month"]),
        .all: DisplayRepresentation(title: "Since tracking began", synonyms: ["all time", "since the start"])
    ]
    var days: Int? { switch self { case .day: 1; case .week: 7; case .month: 30; case .all: nil } }
}

struct FleetGrowthIntent: AppIntent {
    static let title: LocalizedStringResource = "Check Cybercab Fleet Growth"
    static let description = IntentDescription("Compares the Texas DMV roster between two actual daily snapshots: start and end VIN counts, net change, percentage, and newly detected VINs. Optional custom dates.")

    @Parameter(title: "Period", default: .week) var period: GrowthPeriod
    @Parameter(title: "From", description: "Overrides the period: the first date to compare (an actual snapshot on or after it).") var from: Date?
    @Parameter(title: "To", description: "The last date to compare (an actual snapshot on or before it).") var to: Date?

    static var parameterSummary: some ParameterSummary { Summary("Fleet growth for \(\.$period)") { \.$from; \.$to } }

    func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView {
        let data = SiriData.shared
        let g: DMVGrowth, o: DMVOverview?
        do {
            async let growth: DMVGrowth = data.get("/api/dmv/growth", query: [URLQueryItem(name: "range", value: "all")])
            async let overview: DMVOverview? = try? data.get("/api/dmv/overview")
            (g, o) = (try await growth, await overview)
        } catch { throw IntentFailure.unavailable }
        let (start, end) = Self.window(period: period, from: from, to: to, latest: g.points.map(\.date).max())
        let processed = o.map { ($0.processingPending ?? 0) == 0 } ?? false
        let a = SiriSpeech.growthAnswer(SiriSpeech.growth(g, start: start, end: end, processed: processed))
        return .result(dialog: IntentDialog(stringLiteral: a.spoken), view: SiriAnswerCard(answer: a, open: OpenScreenIntent(.dmvTracker), openTitle: "Open Growth Chart"))
    }

    /// The compared dates ("yyyy-MM-dd", Central): custom dates win; else the
    /// period back from the latest snapshot ("day" = the two latest snapshots).
    static func window(period: GrowthPeriod, from: Date?, to: Date?, latest: String?) -> (String?, String?) {
        let iso = { (d: Date) in SiriSpeech.iso(d) }
        if from != nil || to != nil { return (from.map(iso), to.map(iso)) }
        guard let latest, let end = SiriSpeech.calendarDate(latest), let days = period.days else { return (nil, latest) }
        return (iso(end.addingTimeInterval(-Double(days) * 86400)), latest)
    }
}

// MARK: - One vehicle

struct VehicleHistoryIntent: AppIntent {
    static let title: LocalizedStringResource = "Get Cybercab History"
    static let description = IntentDescription("Tells you when a Cybercab was first and last reported, its approved public sightings and recorded rides, and when its VIN first appeared on the Texas DMV roster.")

    @Parameter(title: "Cybercab", requestValueDialog: "Which Cybercab? Say its plate.") var vehicle: VehicleEntity

    init() {}
    init(vehicle: VehicleEntity) { self.vehicle = vehicle }

    static var parameterSummary: some ParameterSummary { Summary("History of \(\.$vehicle)") }

    func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView {
        let data = SiriData.shared
        let detail: VehicleDetail
        do { detail = try await data.get("/api/robotaxi-vehicles/\(vehicle.id)") }
        catch APIError.http(let status, _) where status == 404 { throw IntentFailure.notFound }
        catch { throw IntentFailure.unavailable }
        async let s: VehicleSightings? = try? data.get("/api/robotaxi-vehicles/\(vehicle.id)/sightings", query: [URLQueryItem(name: "limit", value: "50")])
        var dmvFirst: (String, Bool)?
        if let vin = detail.vehicle.vin, VehicleSearchText.isVIN(VehicleSearchText.normalized(vin)),
           let d: DMVVinDetail = try? await data.get("/api/dmv/vins/\(VehicleSearchText.normalized(vin))") {
            dmvFirst = (d.tracking.firstDetected, d.tracking.inBaseline)
        }
        let a = SiriSpeech.vehicleHistory(detail, sightings: (await s)?.sightings ?? [], dmvFirst: dmvFirst.map { (date: $0.0, baseline: $0.1) })
        await SpotlightRecents.record(vehicle)
        let open = OpenVehicleIntent()
        open.target = vehicle
        return .result(dialog: IntentDialog(stringLiteral: a.spoken), view: SiriAnswerCard(answer: a, open: open, openTitle: "Open Vehicle"))
    }
}

/// "Find Cybercab 1234": searches plates and VINs (bounded, never the whole
/// registry). One match answers; several ask which; none says so.
struct FindVehicleIntent: AppIntent {
    static let title: LocalizedStringResource = "Find a Cybercab"
    static let description = IntentDescription("Finds a Cybercab in the public registry by plate or VIN (or part of one) and opens its page.")
    static let openAppWhenRun = false

    @Parameter(title: "Plate or VIN", requestValueDialog: "What's the plate or VIN?") var text: String

    static var parameterSummary: some ParameterSummary { Summary("Find Cybercab \(\.$text)") }

    func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<VehicleEntity> & OpensIntent {
        let q = VehicleSearchText.normalized(text)
        guard q.count >= 2 else { throw IntentFailure.notFound }
        let found: [VehicleEntity]
        do { found = try await VehicleDirectory.search(q, limit: 10).map(VehicleEntity.init) } catch { throw IntentFailure.unavailable }
        guard !found.isEmpty else { throw IntentFailure.notFound }
        let pick: VehicleEntity
        if found.count == 1 { pick = found[0] }
        else {
            // Never a guess: Siri asks which one.
            let labels = found.map { $0.plate ?? $0.id }
            let chosen = try await $text.requestDisambiguation(among: labels, dialog: "Several Cybercabs match. Which one?")
            guard let match = found.first(where: { ($0.plate ?? $0.id) == chosen }) else { throw IntentFailure.notFound }
            pick = match
        }
        await SpotlightRecents.record(pick)
        let open = OpenVehicleIntent()
        open.target = pick
        return .result(value: pick, opensIntent: open, dialog: "Opening \(pick.plate.map(SiriSpeech.spell) ?? "that Cybercab").")
    }
}

// MARK: - Service zones

struct ServiceZoneIntent: AppIntent {
    static let title: LocalizedStringResource = "Check a Cybercab Service Zone"
    static let description = IntentDescription("Tells you how big a city's Cybercab service area is (and where that figure comes from), or compares Austin and Dallas.")

    @Parameter(title: "City", default: .austin) var city: ServiceCity
    @Parameter(title: "Compare Austin and Dallas", default: false) var compare: Bool

    static var parameterSummary: some ParameterSummary { Summary("Service zone for \(\.$city)") { \.$compare } }

    init() {}
    init(city: ServiceCity) { self.city = city }

    func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView {
        let data = SiriData.shared
        let a: SiriAnswer
        do {
            let areas: ServiceAreasResponse = try await data.get("/api/service-areas")
            guard areas.areas.contains(where: { $0.key == city.rawValue }) else {
                return .result(dialog: "Cybercab Hunter isn't tracking \(city.title) right now.", view: SiriAnswerCard(answer: SiriAnswer(spoken: ""), open: OpenScreenIntent(.map), openTitle: "Open Map"))
            }
            if compare {
                async let austin: HomepageStats = data.get("/api/homepage-stats", query: [URLQueryItem(name: "city", value: "austin")])
                async let dallas: HomepageStats = data.get("/api/homepage-stats", query: [URLQueryItem(name: "city", value: "dallas")])
                a = SiriSpeech.compareZones(try await austin, try await dallas)
            } else {
                a = SiriSpeech.zone(try await data.get("/api/homepage-stats", query: [URLQueryItem(name: "city", value: city.rawValue)]))
            }
        } catch { throw IntentFailure.unavailable }
        return .result(dialog: IntentDialog(stringLiteral: a.spoken), view: SiriAnswerCard(answer: a, open: OpenZonesIntent(city: city), openTitle: "Open \(city.title) Zone"))
    }
}

extension ServiceCity {
    var title: String { self == .austin ? "Austin" : "Dallas" }
}

extension OpenZonesIntent {
    init(city: ServiceCity) { self.init(); self.city = city }
}

// MARK: - The card

/// The small card Siri shows under a spoken answer: the figures, a footnote
/// and one button that opens the matching screen. Plain SwiftUI in the app's
/// colours; Siri draws its own chrome around it.
struct SiriAnswerCard<Open: AppIntent>: View {
    let answer: SiriAnswer
    let open: Open
    let openTitle: LocalizedStringResource

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !answer.figures.isEmpty {
                HStack(alignment: .top, spacing: 16) {
                    ForEach(answer.figures, id: \.self) { f in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(f.value).font(.title3.bold()).monospacedDigit().foregroundStyle(Color.brandGold).lineLimit(1).minimumScaleFactor(0.7)
                            Text(f.label.uppercased()).font(.caption2.weight(.semibold)).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                }
            }
            if let note = answer.footnote { Text(note).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
            Button(intent: open) { Label(openTitle, systemImage: "arrow.up.right") }
                .buttonStyle(.bordered)
                .tint(Color.brandGold)
        }
        .padding()
    }
}
