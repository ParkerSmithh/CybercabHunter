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
    @Parameter(title: "City", requestValueDialog: "Which city, Austin or Dallas?") var city: ServiceCity
    init() {}
    init(city: ServiceCity) { self.city = city }
    @MainActor
    func perform() async throws -> some IntentResult {
        guard $city.diagnosticPresence != .unset else {
            throw $city.needsValueError("Which city, Austin or Dallas?")
        }
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
    static func answer(city: ServiceCity?, metric: FleetMetric = .overview, diagnostics: SiriDiagnostics.Invocation? = nil) async throws -> SiriAnswer {
        let data = SiriData.shared
        do {
            if let city {
                let s: HomepageStats = try await data.get("/api/homepage-stats", query: [URLQueryItem(name: "city", value: city.rawValue)])
                try SiriCityResponse.validate(s, for: city)
                if metric == .overview { return SiriSpeech.cityFleet(s) }
                if metric == .lifetimeSightings { return SiriAnswer(spoken: "A permanent lifetime sighting count isn't available for individual cities. Ask for Austin or Dallas sightings across the available public records instead.") }
                return CityActivitySpeech.answer(s, metric: metric == .rides ? .rides : .registry, period: .allTime)
            }
            if metric != .overview {
                let s: RegistryStats = try await data.get("/api/registry/stats")
                let n = metric == .registry ? s.publicVehicles : metric == .rides ? s.recordedRides : s.sightingsAllTime
                let label = metric == .registry ? "public registry vehicles" : metric == .rides ? "recorded rides" : "approved sightings in its lifetime counter"
                return SiriAnswer(spoken: "Across the global public records, Cybercab Hunter has \(SiriSpeech.n(n)) \(label).", figures: [.init(value: SiriSpeech.n(n), label: metric == .registry ? "Registry" : metric == .rides ? "Rides" : "Lifetime sightings")])
            }
            async let stats: RegistryStats = data.get("/api/registry/stats")
            async let daily: DailyReport? = try? data.get("/api/daily")
            async let dmv: DMVOverview? = try? data.get("/api/dmv/overview")
            var answer = SiriSpeech.fleet(stats: try await stats, daily: await daily, dmv: await dmv)
            answer.spoken = "This is the global fleet overview. " + answer.spoken
            return answer
        } catch {
            diagnostics?.emit("data_failed", outcome: "error", error: error)
            throw IntentFailure.unavailable
        }
    }
}

/// No city/metric parameters for Siri to omit or substitute. The global Fleet
/// intent retains its legitimate nil-city overview behavior.
struct DallasFleetSummaryIntent: AppIntent {
    static let title: LocalizedStringResource = "Dallas Fleet Summary"
    static let description = IntentDescription("Dallas-specific public registry and recent activity overview. Always Dallas, including when its registry count is zero.")
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .background }

    func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView & ReturnsValue<String> {
        var p = SiriDiagnostics.Parameters()
        p.city = ServiceCity.dallas.rawValue; p.cityState = .derived
        p.metric = FleetMetric.overview.rawValue; p.metricState = .derived
        var trace = SiriDiagnostics.Invocation("DallasFleetSummaryIntent", parameters: p)
        do {
            let a = try await FleetStatsIntent.answer(city: .dallas, metric: .overview, diagnostics: trace)
            trace.complete(a.figures.isEmpty ? "no_count_available" : "answer_composed")
            return .result(value: a.spoken, dialog: IntentDialog(stringLiteral: a.spoken), view: SiriAnswerCard(answer: a, open: OpenScreenIntent(.cars), openTitle: "Open Cars"))
        } catch { trace.fail(error); throw error }
    }
}

/// Fail closed on misrouted/mislabeled city payloads; never relabel another
/// city's or global response as a Dallas answer.
enum SiriCityResponse {
    static func validate(_ stats: HomepageStats, for city: ServiceCity) throws {
        guard stats.city.lowercased() == city.rawValue,
              stats.name.lowercased() == city.rawValue else { throw IntentFailure.cityMismatch }
    }
}

struct CheckDMVIntent: AppIntent {
    static let title: LocalizedStringResource = "Check Texas DMV Updates"
    static let description = IntentDescription("Tells you how many Tesla robotaxi VINs the Texas DMV roster lists, how many are Cybercabs, and what Cybercab Hunter newly detected in the latest dataset. VIN counts do not establish active service.", searchKeywords: ["DMV", "Texas", "VIN", "registration"])
    /// iOS 26+: answers in Siri / Shortcuts without opening the app (replaces openAppWhenRun = false).
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .background }

    @Parameter(title: "Statistic", default: .overview) var question: DMVQuestion
    static var parameterSummary: some ParameterSummary { Summary("Check \(\.$question)") }

    static func answer(question: DMVQuestion, traceID: String = UUID().uuidString) async throws -> SiriAnswer {
        SiriDiagnostics.record(intent: "CheckDMVIntent", phase: "entered", id: traceID, selection: question.rawValue)
        do {
            let o: DMVOverview = try await SiriData.shared.get("/api/dmv/overview")
            let a = SiriSpeech.dmv(o, question: question)
            SiriDiagnostics.record(intent: "CheckDMVIntent", phase: "answer_ready", id: traceID, selection: question.rawValue)
            return a
        } catch {
            SiriDiagnostics.record(intent: "CheckDMVIntent", phase: "data_failed", id: traceID, selection: question.rawValue, error: error)
            throw IntentFailure.unavailable
        }
    }

    func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView & ReturnsValue<String> {
        let a = try await Self.answer(question: question)
        return .result(value: a.spoken, dialog: IntentDialog(stringLiteral: a.spoken), view: SiriAnswerCard(answer: a, open: OpenScreenIntent(.dmvTracker), openTitle: "Open DMV Tracker"))
    }
}

struct RecentSightingsIntent: AppIntent {
    static let title: LocalizedStringResource = "Show Recent Cybercab Sightings"
    static let description = IntentDescription("Counts approved public Cybercab sightings in Austin or Dallas: today, yesterday, this week since Monday, the last seven days, the last 24 hours, or all available public records. City lifetime totals are unavailable.")
    /// iOS 26+: answers in Siri / Shortcuts without opening the app (replaces openAppWhenRun = false).
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .background }

    @Parameter(title: "City") var city: ServiceCity?
    @Parameter(title: "Period") var period: ActivityPeriod?
    @Parameter(title: "City and period") var question: CitySightingsQuestion?
    static var parameterSummary: some ParameterSummary { Summary("Approved sightings for \(\.$question)") { \.$city; \.$period } }

    init() {}
    init(city: ServiceCity) { self.city = city }

    static func answer(city: ServiceCity, period: ActivityPeriod, now: Date = .now, traceID: String = UUID().uuidString, selection: String = "legacy-city-period") async throws -> SiriAnswer {
        var p = SiriDiagnostics.Parameters()
        p.city = city.rawValue; p.metric = "sightings"; p.period = period.rawValue
        p.cityState = .derived; p.metricState = .derived; p.periodState = .derived
        var trace = SiriDiagnostics.Invocation("RecentSightingsIntent", parameters: p, id: traceID)
        trace.emit("parameters_resolved")
        do {
            let s: HomepageStats = try await SiriData.shared.get("/api/homepage-stats", query: [URLQueryItem(name: "city", value: city.rawValue)])
            try SiriCityResponse.validate(s, for: city)
            var answer = CityActivitySpeech.answer(s, metric: .sightings, period: period, now: now)
            if let latest = s.sightings?.latest?.first, let at = SiriSpeech.instant(latest.spottedAt) {
                answer.spoken += " The latest approved sighting in \(s.name) was on \(SiriSpeech.day(SiriSpeech.iso(at), now: now))\(latest.location.map { ", near \($0)" } ?? "")."
            }
            trace.complete(answer.figures.isEmpty ? "no_count_available" : "answer_composed")
            return answer
        } catch {
            trace.fail(error)
            throw IntentFailure.unavailable
        }
    }

    /// A missing Siri parameter must never silently become Austin.
    func resolvedSelection(traceID: String = UUID().uuidString) throws -> (city: ServiceCity, period: ActivityPeriod) {
        if let question {
            if let city, city != question.city {
                throw $question.needsValueError("The city selections disagree. Which city and period do you want?")
            }
            if let period, period != question.period {
                throw $question.needsValueError("The periods disagree. Which city and period do you want?")
            }
            return (question.city, question.period)
        }
        guard let city else { throw $city.needsValueError("Which city, Austin or Dallas?") }
        guard let period else {
            SiriDiagnostics.record(intent: "RecentSightingsIntent", phase: "clarification_requested", id: traceID, city: city.rawValue, selection: "missing_period")
            throw $period.needsValueError("Which period: today, yesterday, this week, last seven days, last 24 hours, or all time?")
        }
        return (city, period)
    }

    func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView & ReturnsValue<String> {
        let id = UUID().uuidString
        SiriDiagnostics.record(intent: "RecentSightingsIntent", phase: "parameters_received", id: id,
                               city: city?.rawValue ?? "missing", period: period?.rawValue ?? "missing",
                               selection: question?.rawValue ?? "missing")
        let selected: (city: ServiceCity, period: ActivityPeriod)
        do { selected = try resolvedSelection(traceID: id) }
        catch {
            SiriDiagnostics.record(intent: "RecentSightingsIntent", phase: "clarification_requested", id: id, selection: "missing_or_conflicting_parameters", outcome: "needs_value")
            throw error
        }
        let selectedCity = selected.city
        let a = try await Self.answer(city: selectedCity, period: selected.period, traceID: id, selection: question?.rawValue ?? "explicit-city-period")
        return .result(value: a.spoken, dialog: IntentDialog(stringLiteral: a.spoken), view: SiriAnswerCard(answer: a, open: OpenSightingsIntent(city: selectedCity), openTitle: "Open Sightings"))
    }
}

/// A literal, parameter-free route: Siri cannot omit or substitute its city.
/// Reuses the same public endpoint, cache, period logic, and answer rendering.
struct DallasWeeklySightingsIntent: AppIntent {
    static let title: LocalizedStringResource = "Dallas Weekly Sightings"
    static let description = IntentDescription("Approved public Cybercab sightings in Dallas this week since Monday. Always Dallas; no city parameter.")
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .background }

    func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView & ReturnsValue<String> {
        let a = try await SiriDiagnostics.traceAnswer(intent: "DallasWeeklySightingsIntent", selection: "dallasThisWeek") {
            try await RecentSightingsIntent.answer(city: .dallas, period: .thisWeek, selection: "fixed-dallasThisWeek")
        }
        return .result(value: a.spoken, dialog: IntentDialog(stringLiteral: a.spoken), view: SiriAnswerCard(answer: a, open: OpenSightingsIntent(city: .dallas), openTitle: "Open Dallas Sightings"))
    }
}

// MARK: - Briefing and hands-free status

struct DailyBriefingIntent: AppIntent {
    static let title: LocalizedStringResource = "Cybercab Hunter Briefing"
    static let description = IntentDescription("A spoken rundown of Cybercab Hunter's data: the public registry, today's approved sightings and camera detections, and the latest Texas DMV snapshot. Answers in Siri without opening the app.", searchKeywords: ["briefing", "today", "rundown", "Cybercab news"])
    /// iOS 26+: answers in Siri / Shortcuts without opening the app (replaces openAppWhenRun = false).
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .background }

    @Parameter(title: "City") var city: ServiceCity?
    static var parameterSummary: some ParameterSummary { Summary("Cybercab briefing for \(\.$city)") }

    func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView {
        let a = try await SiriDiagnostics.traceAnswer(intent: "DailyBriefingIntent", selection: city?.rawValue ?? "all") {
            try await Self.compose(city: city, quick: false)
        }
        return .result(dialog: IntentDialog(stringLiteral: a.spoken), view: SiriAnswerCard(answer: a, open: OpenScreenIntent(.home), openTitle: "Open Cybercab Hunter"))
    }

    /// Shared with the hands-free status: the same (cached) requests.
    static func compose(city: ServiceCity?, quick: Bool) async throws -> SiriAnswer {
        let data = SiriData.shared
        async let daily: DailyReport? = try? data.get("/api/daily")
        async let dmv: DMVOverview? = try? data.get("/api/dmv/overview")
        async let registry: RegistryStats? = (quick || city != nil) ? nil : try? data.get("/api/registry/stats")
        async let stats: HomepageStats? = city == nil ? nil : try? data.get("/api/homepage-stats", query: [URLQueryItem(name: "city", value: city!.rawValue)])
        let (d, o, r, s) = await (daily, dmv, registry, stats)
        if let city {
            guard let s else { throw IntentFailure.unavailable }
            try SiriCityResponse.validate(s, for: city)
        }
        if d == nil && o == nil && r == nil && s == nil { throw IntentFailure.unavailable }
        return SiriSpeech.briefing(stats: r, daily: d, dmv: o, city: s, quick: quick)
    }
}

/// Hands-free: two sentences, spoken, no app. (Not a CarPlay app; Siri decides
/// how to present it, including while driving.)
struct QuickStatusIntent: AppIntent {
    static let title: LocalizedStringResource = "Quick Cybercab Status"
    static let description = IntentDescription("A two-sentence Cybercab update for hands-free use: recent sightings and the latest Texas DMV change.")
    /// iOS 26+: answers in Siri / Shortcuts without opening the app (replaces openAppWhenRun = false).
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .background }

    @Parameter(title: "City") var city: ServiceCity?

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let a = try await SiriDiagnostics.traceAnswer(intent: "QuickStatusIntent", selection: city?.rawValue ?? "all") {
            try await DailyBriefingIntent.compose(city: city, quick: true)
        }
        return .result(dialog: IntentDialog(stringLiteral: a.spoken))
    }
}

// MARK: - Near me

struct NearbySightingsIntent: AppIntent {
    static let title: LocalizedStringResource = "Find Cybercab Sightings Near Me"
    static let description = IntentDescription("Uses your location, once, to tell you about Cybercab traffic-camera detections near you in the last 24 hours. Your location isn't stored or sent anywhere else.")
    /// iOS 26+: answers in Siri / Shortcuts without opening the app (replaces openAppWhenRun = false).
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .background }

    static let radiusMiles = 3.0
    static let window: TimeInterval = 24 * 3600

    func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView {
        var p = SiriDiagnostics.Parameters()
        p.city = "not_resolved"; p.cityState = .derived
        p.metric = "cameras"; p.metricState = .derived
        p.period = "last24Hours"; p.periodState = .derived
        switch await OneShotLocation.status {
        case .notDetermined: p.locationAuthorization = "not_configured"
        case .denied: p.locationAuthorization = "denied"
        case .restricted: p.locationAuthorization = "restricted"
        case .authorizedWhenInUse: p.locationAuthorization = "when_in_use"
        case .authorizedAlways: p.locationAuthorization = "always"
        @unknown default: p.locationAuthorization = "unknown"
        }
        var trace = SiriDiagnostics.Invocation("NearbySightingsIntent", parameters: p)
        do {
            let location: CLLocation
            do { location = try await OneShotLocation.current() }
            catch LocationFailure.notDetermined { throw IntentFailure.locationNotAllowedYet }
            catch LocationFailure.denied { throw IntentFailure.locationDenied }
            catch { throw IntentFailure.locationUnavailable }
            let precise = await OneShotLocation.isPrecise
            let city = Self.nearestCity(to: location)
            guard let city else { throw IntentFailure.outsideServiceAreas }
            trace.parameters.city = city.rawValue
            trace.emit("parameters_resolved")
            let list: [CameraDetection]
            do { list = try await SiriData.shared.get("/api/camera-sightings", query: city == .austin ? [] : [URLQueryItem(name: "city", value: city.rawValue)]) }
            catch { trace.fail(error); throw IntentFailure.unavailable }
            // Approximate location: a wider circle, and no exact distance.
            let radius = precise ? Self.radiusMiles : max(Self.radiusMiles, location.horizontalAccuracy / 1609.344)
            let hits = SiriSpeech.nearby(list, from: location, radiusMiles: radius, window: Self.window)
            let latest = list.compactMap { d in SiriSpeech.instant(d.observedAt).map { SiriSpeech.NearbyHit(camera: SiriSpeech.titleCase(d.cameraName), miles: 0, at: $0) } }.max { $0.at < $1.at }
            let a = SiriSpeech.nearbyAnswer(hits: hits, radiusMiles: radius, precise: precise, cityName: city.title, latestInCity: latest)
            trace.complete(hits.isEmpty ? "no_nearby_detections" : "answer_composed")
            return .result(dialog: IntentDialog(stringLiteral: a.spoken), view: SiriAnswerCard(answer: a, open: OpenZonesIntent(city: city), openTitle: "Open Map"))
        } catch { trace.fail(error); throw error }
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
        .day: DisplayRepresentation(title: "Latest snapshots", synonyms: ["latest day", "daily"]),
        .week: DisplayRepresentation(title: "Last seven days", synonyms: ["week", "weekly"]),
        .month: DisplayRepresentation(title: "Last thirty days", synonyms: ["month", "monthly"]),
        .all: DisplayRepresentation(title: "Since tracking began", synonyms: ["all time", "since the start"])
    ]
    var days: Int? { switch self { case .day: 1; case .week: 7; case .month: 30; case .all: nil } }
}

struct FleetGrowthIntent: AppIntent {
    static let title: LocalizedStringResource = "Check Cybercab Fleet Growth"
    static let description = IntentDescription("Compares the Texas DMV roster between two actual daily snapshots: start and end VIN counts, net change, percentage, and newly detected VINs. Optional custom dates.", searchKeywords: ["growth", "Cybercab", "VIN", "DMV"])
    static let isDiscoverable = true
    /// iOS 26+: answers in Siri / Shortcuts without opening the app (replaces openAppWhenRun = false).
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .background }

    @Parameter(title: "Period", default: .week) var period: GrowthPeriod
    @Parameter(title: "Model", default: .all) var model: GrowthModel
    @Parameter(title: "From", description: "Overrides the period: the first date to compare (an actual snapshot on or after it).") var from: Date?
    @Parameter(title: "To", description: "The last date to compare (an actual snapshot on or before it).") var to: Date?

    static var parameterSummary: some ParameterSummary { Summary("Fleet growth for \(\.$period)") { \.$model; \.$from; \.$to } }

    var diagnosticParameters: SiriDiagnostics.Parameters {
        var p = SiriDiagnostics.Parameters()
        p.modelState = $model.diagnosticPresence; p.periodState = $period.diagnosticPresence
        p.fromState = $from.diagnosticPresence; p.toState = $to.diagnosticPresence
        p.model = model.rawValue; p.period = period.rawValue
        p.customFrom = from != nil; p.customTo = to != nil
        return p
    }

    func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView {
        var trace = SiriDiagnostics.Invocation("FleetGrowthIntent", parameters: diagnosticParameters)
        let data = SiriData.shared
        let g: DMVGrowth, o: DMVOverview?
        do {
            async let growth: DMVGrowth = data.get("/api/dmv/growth", query: [URLQueryItem(name: "range", value: "all")])
            async let overview: DMVOverview? = try? data.get("/api/dmv/overview")
            (g, o) = (try await growth, await overview)
        } catch { trace.fail(error); throw IntentFailure.unavailable }
        var (start, end) = Self.window(period: period, from: from, to: to, latest: g.points.map(\.date).max())
        if period == .day && from == nil && to == nil {
            let dates = Array(Set(g.points.map(\.date))).sorted()
            start = dates.dropLast().last; end = dates.last
        }
        let processed = o.map { $0.processingPending == 0 } ?? false
        let comparison = SiriSpeech.growth(g, start: start, end: end, processed: processed, model: model)
        let a = SiriSpeech.growthAnswer(comparison, model: model)
        trace.complete(comparison == nil ? "insufficient_history" : "answer_composed")
        return .result(dialog: IntentDialog(stringLiteral: a.spoken), view: SiriAnswerCard(answer: a, open: OpenScreenIntent(.dmvTracker), openTitle: "Open Growth Chart"))
    }

    /// The compared dates ("yyyy-MM-dd", Central): custom dates win; else the
    /// period back from the latest snapshot ("day" = the two latest snapshots).
    static func window(period: GrowthPeriod, from: Date?, to: Date?, latest: String?) -> (String?, String?) {
        let iso = { (d: Date) in SiriSpeech.iso(d) }
        if from != nil || to != nil { return (from.map(iso), to.map(iso)) }
        guard let latest, let end = SiriSpeech.calendarDate(latest), let days = period.days else { return (nil, latest) }
        return (iso(CityActivitySpeech.calendar.date(byAdding: .day, value: -days, to: end)!), latest)
    }
}

// MARK: - One vehicle

struct VehicleHistoryIntent: AppIntent {
    static let title: LocalizedStringResource = "Get Cybercab History"
    static let description = IntentDescription("Tells you when a Cybercab was first and last reported, its approved public sightings and recorded rides, and when its VIN first appeared on the Texas DMV roster.")
    /// iOS 26+: answers in Siri / Shortcuts without opening the app (replaces openAppWhenRun = false).
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .background }

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
        let a = SiriSpeech.vehicleHistory(detail, sightings: (await s)?.sightings, dmvFirst: dmvFirst.map { (date: $0.0, baseline: $0.1) })
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
    /// iOS 26+: answers in Siri / Shortcuts without opening the app (replaces openAppWhenRun = false).
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .background }

    @Parameter(title: "City") var city: ServiceCity
    @Parameter(title: "Compare Austin and Dallas", default: false) var compare: Bool

    static var parameterSummary: some ParameterSummary { Summary("Service zone for \(\.$city)") { \.$compare } }

    init() {}
    init(city: ServiceCity) { self.city = city }

    var diagnosticParameters: SiriDiagnostics.Parameters {
        var p = SiriDiagnostics.Parameters()
        p.cityState = $city.diagnosticPresence; p.compareState = $compare.diagnosticPresence
        p.city = p.cityState == .unset ? "missing" : city.rawValue; p.compare = compare ? "true" : "false"
        p.metric = "zone"; p.metricState = .derived
        return p
    }

    /// Required in metadata, with an explicit restart/clarification error as
    /// a safety net. Never read an unset, nonoptional parameter's wrapped value.
    func resolvedCity() throws -> ServiceCity {
        guard $city.diagnosticPresence != .unset else {
            throw $city.needsValueError("Which city, Austin or Dallas?")
        }
        return city
    }

    func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView {
        var trace = SiriDiagnostics.Invocation("ServiceZoneIntent", parameters: diagnosticParameters)
        let selectedCity: ServiceCity
        do { selectedCity = try resolvedCity() }
        catch {
            trace.emit("clarification_requested", outcome: "city_required")
            throw error
        }
        let data = SiriData.shared
        let a: SiriAnswer
        do {
            let areas: ServiceAreasResponse = try await data.get("/api/service-areas")
            guard areas.areas.contains(where: { $0.key == selectedCity.rawValue }) else {
                trace.complete("city_not_tracked")
                return .result(dialog: "Cybercab Hunter isn't tracking \(selectedCity.title) right now.", view: SiriAnswerCard(answer: SiriAnswer(spoken: ""), open: OpenScreenIntent(.map), openTitle: "Open Map"))
            }
            if compare {
                async let austin: HomepageStats = data.get("/api/homepage-stats", query: [URLQueryItem(name: "city", value: "austin")])
                async let dallas: HomepageStats = data.get("/api/homepage-stats", query: [URLQueryItem(name: "city", value: "dallas")])
                let (austinStats, dallasStats) = try await (austin, dallas)
                try SiriCityResponse.validate(austinStats, for: .austin)
                try SiriCityResponse.validate(dallasStats, for: .dallas)
                a = SiriSpeech.compareZones(austinStats, dallasStats)
            } else {
                let stats: HomepageStats = try await data.get("/api/homepage-stats", query: [URLQueryItem(name: "city", value: selectedCity.rawValue)])
                try SiriCityResponse.validate(stats, for: selectedCity)
                a = SiriSpeech.zone(stats)
            }
        } catch { trace.fail(error); throw IntentFailure.unavailable }
        trace.complete(a.figures.isEmpty ? "no_count_available" : "answer_composed")
        return .result(dialog: IntentDialog(stringLiteral: a.spoken), view: SiriAnswerCard(answer: a, open: OpenZonesIntent(city: selectedCity), openTitle: "Open \(selectedCity.title) Zone"))
    }
}

/// Fixed Dallas route: Siri has no city or comparison parameter to replace.
/// The original action remains available for manually configured city queries.
struct DallasServiceZoneIntent: AppIntent {
    static let title: LocalizedStringResource = "Dallas Service Area"
    static let description = IntentDescription("Reads Dallas's current service-area figure from Cybercab Hunter. Always Dallas; never Austin.")
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .background }

    func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView {
        var p = SiriDiagnostics.Parameters()
        p.city = "dallas"; p.cityState = .derived
        p.metric = "zone"; p.metricState = .derived
        p.compare = "false"; p.compareState = .derived
        var trace = SiriDiagnostics.Invocation("DallasServiceZoneIntent", parameters: p)
        do {
            let result = try await ServiceZoneIntent(city: .dallas).perform()
            trace.complete("delegated_answer")
            return result
        } catch { trace.fail(error); throw error }
    }
}

extension ServiceCity {
    var title: String { self == .austin ? "Austin" : "Dallas" }
}

extension OpenZonesIntent {
    init(city: ServiceCity) { self.init(); self.city = city }
}

// MARK: - The card

/// The small card Siri and Shortcuts show under a spoken answer: the figures,
/// a footnote and one button that opens the matching screen. It draws its own
/// near-black surface with white / light-gray text and gold figures, so it reads
/// the same whatever background Siri or Shortcuts puts behind it (light or dark);
/// hierarchical styles (.secondary) came out nearly invisible there.
struct SiriAnswerCard<Open: AppIntent>: View {
    let answer: SiriAnswer
    let open: Open
    let openTitle: LocalizedStringResource

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if !answer.figures.isEmpty {
                HStack(alignment: .top, spacing: 16) {
                    ForEach(answer.figures, id: \.self) { f in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(f.value).font(.title3.bold()).monospacedDigit().foregroundStyle(SiriCardPalette.figure).lineLimit(1).minimumScaleFactor(0.7)
                            Text(f.label.uppercased()).font(.caption2.weight(.semibold)).foregroundStyle(SiriCardPalette.label).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
            if let note = answer.footnote {
                Text(note).font(.footnote).foregroundStyle(SiriCardPalette.note).fixedSize(horizontal: false, vertical: true)
            }
            Button(intent: open) { Label(openTitle, systemImage: "arrow.up.right").font(.subheadline.weight(.semibold)) }
                .buttonStyle(.bordered)
                .tint(SiriCardPalette.figure)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(SiriCardPalette.surface, in: .rect(cornerRadius: 16))
        .environment(\.colorScheme, .dark)
    }
}

/// The card's colours (WCAG contrast against `surface`: gold 14.4:1, labels 13.2:1, notes 10.0:1).
enum SiriCardPalette {
    static let surface = Color(red: 0x0E / 255, green: 0x0F / 255, blue: 0x11 / 255)
    static let figure = Color.brandGold                               // #FAE030
    static let label = Color(red: 0xD4 / 255, green: 0xD6 / 255, blue: 0xDA / 255)
    static let note = Color(red: 0xB8 / 255, green: 0xBB / 255, blue: 0xC1 / 255)
}

