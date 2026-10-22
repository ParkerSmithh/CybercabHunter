import Foundation
import Observation

/// The Simulation screen's state (public/simulation.html, js/fleet-compare.js).
/// Fleet ROI is computed on the device (SimulationCalc, from calc.js); Fleet
/// ETA reads GET /api/fleet-eta per city, once, and again only when an hour
/// old (the estimates change once a day). A failed refresh keeps an earlier
/// good copy; with none, no number is shown.
@MainActor
@Observable
final class SimulationModel {
    enum View: String, CaseIterable, Identifiable { case roi, eta; var id: String { rawValue } }
    enum CityState: Equatable { case idle, loading, loaded(FleetEta), failed }

    var view: View = .roi

    // MARK: Fleet ROI
    var fleetSize = 0
    var electricityRate = SimulationCalc.ROI.electricityStart
    var dailyMiles = SimulationCalc.ROI.milesStart
    var lossOn = true
    /// The lifetime registry count the fleet size starts at (nil until loaded, or if it couldn't be).
    private(set) var registryCount: Int?
    private(set) var registryFailed = false
    private var fleetTouched = false

    var financials: SimulationCalc.Financials {
        SimulationCalc.fleetFinancials(fleetSize: fleetSize, electricityRate: electricityRate, dailyMiles: dailyMiles, lossOn: lossOn)
    }
    var startNote: String {
        if let n = registryCount { return "Fleet size starts at the lifetime registry count (\(Format.int(n)) Cybercabs spotted). Electricity rate and daily miles start at example values. Change any of them." }
        if registryFailed { return "Couldn't load the lifetime registry count, so fleet size starts at 0. Electricity rate and daily miles start at example values." }
        return "Fleet size starts at the live registry count. Electricity rate and daily miles start at example values. Change any of them."
    }

    func setFleetSize(_ n: Int) { fleetTouched = true; fleetSize = min(SimulationCalc.ROI.fleetMax, max(0, n)) }

    /// GET /api/registry/stats: fleet size starts at the lifetime count (capped at the slider's 100).
    func loadRegistry(api: APIClient) async {
        guard registryCount == nil else { return }
        do {
            let s: RegistryStats = try await api.get("/api/registry/stats")
            registryCount = s.publicVehicles
            registryFailed = false
            if !fleetTouched { fleetSize = min(SimulationCalc.ROI.fleetMax, s.publicVehicles) }
        } catch is CancellationError {
        } catch { registryFailed = true }
    }

    // MARK: Fleet ETA
    var city = "austin"
    private(set) var states: [String: CityState] = ["austin": .idle, "dallas": .idle]
    private var loadedAt: [String: Date] = [:]
    /// The rider's pick (shared by both cities, as on the site); nil = the assumed scenario.
    var userScenario: String?
    var miles: [String: Double] = ["austin": 5, "dallas": 3]
    var area: [String: String] = ["austin": "", "dallas": ""]

    func eta(_ city: String) -> FleetEta? { if case .loaded(let e) = states[city] { return e } else { return nil } }
    func failed(_ city: String) -> Bool { states[city] == .failed }

    func scenario(for city: String, at date: Date) -> String {
        userScenario ?? SimulationCalc.assumedTier(eta(city), at: date).tier
    }

    func loadEta(_ city: String, api: APIClient, now: Date = .now, force: Bool = false) async {
        if !force, eta(city) != nil, let at = loadedAt[city], now.timeIntervalSince(at) < 3600 { return }
        if states[city] == .loading { return }
        let previous = states[city]
        if eta(city) == nil { states[city] = .loading }
        do {
            let e: FleetEta = try await api.get("/api/fleet-eta", query: [URLQueryItem(name: "city", value: city)])
            states[city] = .loaded(e)
            loadedAt[city] = now
        } catch is CancellationError {
            states[city] = previous ?? .idle
        } catch {
            // Keep an earlier good copy; with none, say so (no number is shown).
            if case .loaded = previous { states[city] = previous! } else { states[city] = .failed }
        }
    }

    /// The Cybercab count for a city's fleet mix (js/fleet-compare.js countOf):
    /// Austin, every vehicle on the public registry; Dallas, only those documented in Dallas.
    func cybercabCount(_ city: String) -> Int? {
        guard let f = eta(city)?.fleet else { return nil }
        return city == "austin" ? (f.registry?.total ?? f.documented.cybercab) : f.documented.cybercab
    }

    // MARK: Fare / wait report (POST /api/fare-reports; signed in; reviewed before it counts)

    struct Report {
        var city = "austin"
        var kind = "quote"            // quote | completed
        var vehicle = "unknown"       // unknown | cybercab | model_y
        var pickup = ""               // "" = not sure, an area key, or "other"
        var dropoff = ""
        var observedAt = Date.now
        var fare = ""
        var miles = ""
        var duration = ""
        var quotedWait = ""
        var actualWait = ""
        var noCars = false
    }
    var report = Report()
    private(set) var reportStatus = ""
    private(set) var reportNeedsSignIn = false
    private(set) var sendingReport = false

    static let reportErrors = [
        "rate_limited": "That is the daily limit of 10 reports. Thank you!",
        "duplicate_report": "You already sent this report.",
        "distance_required_with_fare": "Add the trip distance with the price.",
        "implausible_fare_for_distance": "That price and distance don't look right together. Please check them.",
        "implausible_speed": "That distance and trip time don't look right together.",
        "no_cars_with_values": "If no cars were available, leave the price and waits empty.",
        "nothing_reported": "Add a price, a wait, or tick \"no cars available\".",
        "actual_wait_needs_completed_ride": "The actual wait only applies to a ride you took.",
        "observed_at_out_of_range": "Reports must be from the last 30 days.",
        "invalid_fare": "The price must be between $1 and $250.",
        "invalid_distance": "The distance must be between 0.2 and 60 miles.",
        "invalid_quoted_wait": "The quoted wait must be a whole number of minutes, 0 to 90.",
        "invalid_actual_wait": "The actual wait must be a whole number of minutes, 0 to 120."
    ]

    /// The JSON body the website sends (empty fields as null).
    func reportBody() -> [String: Any] {
        let r = report
        func num(_ s: String) -> Any { let t = s.trimmingCharacters(in: .whitespaces); return t.isEmpty ? NSNull() : t }
        func int(_ s: String) -> Any { Int(s.trimmingCharacters(in: .whitespaces)).map { $0 as Any } ?? NSNull() }
        return [
            "city": r.city, "kind": r.kind, "vehicle_type": r.vehicle,
            "pickup_area": r.pickup.isEmpty ? NSNull() : r.pickup, "dropoff_area": r.dropoff.isEmpty ? NSNull() : r.dropoff,
            "quoted_fare": num(r.fare), "distance_miles": num(r.miles),
            "duration_minutes": int(r.duration), "quoted_wait_minutes": int(r.quotedWait), "actual_wait_minutes": int(r.actualWait),
            "no_cars_available": r.noCars,
            "observed_at": ISO8601DateFormatter().string(from: r.observedAt)
        ]
    }

    func sendReport(api: APIClient, signedIn: Bool) async {
        guard !sendingReport else { return }
        guard signedIn else { reportNeedsSignIn = true; reportStatus = "Sign in to send a report."; return }
        sendingReport = true
        defer { sendingReport = false }
        reportStatus = "Sending..."
        do {
            let _: FareReportSaved = try await api.send("/api/fare-reports", method: "POST", body: JSONBody.make(reportBody()))
            reportStatus = "Thanks! Your report is waiting for review. Reviewed reports feed the next daily update."
            report.fare = ""; report.miles = ""; report.duration = ""; report.quotedWait = ""; report.actualWait = ""; report.noCars = false
        } catch APIError.unauthorized {
            reportNeedsSignIn = true
            reportStatus = "Sign in to send a report."
        } catch APIError.http(_, let code) {
            reportStatus = code.flatMap { Self.reportErrors[$0] } ?? "That report couldn't be saved. Please check the values."
        } catch is CancellationError {
        } catch {
            reportStatus = "Couldn't reach the server. Please try again."
        }
    }
}
