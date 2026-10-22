import Foundation

/// GET /api/fleet-eta?city=austin|dallas (worker/fleet-eta.js): the Simulation
/// page's Fleet ETA view. Precomputed once a day per city (fitted by
/// worker/fleet-eta-model.js), edge-cached for an hour. Every estimate is a
/// range with its basis and confidence; nothing is a live Tesla quote, and
/// Austin and Dallas never borrow each other's numbers.
struct FleetEta: Decodable, Sendable, Equatable {
    let city: String
    let computedAt: String?
    let pendingFirstRun: Bool?
    let service: Service
    let fleet: Fleet?
    let fares: Fares
    let waits: Waits
    let slotTiers: [String: SlotTier]?
    let areas: [Area]?
    let recentReports: [Report]?

    struct Service: Decodable, Sendable, Equatable {
        let publicService: Bool?
        let since: String?
        let cybercabService: Bool
        let cybercabEvidence: String?
    }

    struct Fleet: Decodable, Sendable, Equatable {
        struct Counts: Decodable, Sendable, Equatable { let cybercab: Int; let modelY: Int?; let unknown: Int?; let total: Int? }
        struct Unidentified: Decodable, Sendable, Equatable { let sightings: Int; let cameraDetections: Int }
        struct DMV: Decodable, Sendable, Equatable { let snapshotDate: String; let total: Int; let cybercab: Int; let modelY: Int; let scope: String? }
        struct External: Decodable, Sendable, Equatable { let total: Int; let cybercab: Int?; let asOf: String; let source: String }
        let documented: Counts
        let registry: Counts?
        let observed7d: Int
        let observed30d: Int
        let unidentified30d: Unidentified?
        let dmv: DMV?
        let external: External?
    }

    /// center / lo / hi multipliers (fares) or minutes (waits) for one demand scenario.
    struct Band: Decodable, Sendable, Equatable { let center: Double; let lo: Double; let hi: Double }

    /// A fitted fare model: fare at `miles` = max(0.5, a + b·miles) × area × tier.
    struct FareModel: Decodable, Sendable, Equatable {
        struct Stats: Decodable, Sendable, Equatable { let medianFare: Double?; let perMile: Double?; let medianMiles: Double? }
        let basis: String          // "observed" or "external"
        let n: Int
        let a: Double
        let b: Double
        let tiers: [String: Band]
        let areaMult: [String: Double]?
        let stats: Stats?
        let widenedBy: Double?
    }

    struct Confidence: Decodable, Sendable, Equatable { let level: String; let reasons: [String]? }

    struct ByVehicle: Decodable, Sendable, Equatable {
        let use: String            // "cybercab", "model_y", "all", "external" or "none"
        let note: String?
        let confidence: Confidence
    }

    struct Check: Decodable, Sendable, Equatable {
        struct Baseline: Decodable, Sendable, Equatable { let mae: Double }
        let nTest: Int
        let withinRange: Double
        let medianAe: Double
        let mape: Double?
        let mae: Double?
        let baselines: [String: Baseline]?
    }

    struct Fares: Decodable, Sendable, Equatable {
        struct External: Decodable, Sendable, Equatable {
            struct History: Decodable, Sendable, Equatable { let asOf: String; let text: String }
            struct Tracker: Decodable, Sendable, Equatable { let medianFare: Double; let perMile: Double; let avgMiles: Double; let rides: Int; let window: String; let asOf: String; let source: String }
            struct Obi: Decodable, Sendable, Equatable { let low: Double; let high: Double; let source: String }
            let rateHistory: [History]?
            let tracker: Tracker?
            let obi: Obi?
        }
        let models: [String: FareModel?]
        let byVehicle: [String: ByVehicle]
        let checks: [String: Check?]?
        let external: External?
    }

    struct Waits: Decodable, Sendable, Equatable {
        struct Model: Decodable, Sendable, Equatable {
            let basis: String
            let n: Int
            let tiers: [String: Band]
            let areaMult: [String: Double]?
            let sources: [String]?
        }
        struct ActualVsQuoted: Decodable, Sendable, Equatable { let n: Int; let medianDelay: Double? }
        struct Unavailability: Decodable, Sendable, Equatable { let n: Int; let share: Double? }
        let use: String            // "observed", "external" or "none"
        let model: Model?
        let confidence: Confidence
        let check: Check?
        let note: String?
        let actualVsQuoted: ActualVsQuoted?
        let unavailability: Unavailability?
    }

    struct SlotTier: Decodable, Sendable, Equatable { let tier: String; let reasons: [String]; let fareN: Int?; let waitN: Int? }

    struct Area: Decodable, Sendable, Equatable, Identifiable, Hashable { let key: String; let label: String; var id: String { key } }

    struct Report: Decodable, Sendable, Equatable {
        let day: String?
        let area: String?
        let vehicle: String?
        let kind: String?
        let fare: Double?
        let miles: Double?
        let quotedWait: Int?
        let actualWait: Int?
        let noCars: Bool?
    }

    /// The decoder camel-cases dictionary keys too ("model_y" -> "modelY",
    /// "park_cities" -> "parkCities") while the same names arrive unchanged as
    /// values (use: "model_y", area key "park_cities"): look up both spellings.
    static func lookup<T>(_ dict: [String: T]?, _ key: String?) -> T? {
        guard let dict, let key else { return nil }
        return dict[key] ?? dict[APIClient.camelCase(key)]
    }

    func byVehicle(_ vehicle: String) -> ByVehicle? { Self.lookup(fares.byVehicle, vehicle) }
    func fareModel(for vehicle: String) -> FareModel? {
        guard let use = byVehicle(vehicle)?.use, use != "none" else { return nil }
        return Self.lookup(fares.models, use) ?? nil
    }
    func fareCheck(_ key: String) -> Check? { Self.lookup(fares.checks, key) ?? nil }
    func areaLabel(_ key: String?) -> String? { key.flatMap { k in areas?.first { $0.key == k }?.label } }
}

/// POST /api/fare-reports (worker/fleet-eta.js): a rider's fare / wait report.
struct FareReportSaved: Decodable, Sendable, Equatable { let success: Bool }
