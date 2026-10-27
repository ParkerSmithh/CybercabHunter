import Foundation

/// The Simulation page's math, ported line for line from public/js/calc.js
/// (CCC_CALC). The website and its node tests are the reference; the unit
/// tests check these against the same values. Nothing here is a live price.
enum SimulationCalc {

    // MARK: Fleet ROI (calc.js fleetFinancials + the page's locked assumptions)

    /// The page's locked assumptions (simulation.html): not user-editable.
    enum ROI {
        static let networkCutPct = 25.0
        static let costPerCab = 30_000.0
        static let baseFare = 3.00
        static let perMileRate = 1.40
        static let avgTripMiles = 5.0
        static let kwhPerMile = 0.25
        static let inductiveLoss = 0.08
        /// Slider ranges and the example starting values.
        static let fleetMax = 100, electricityMax = 0.40, milesMax = 400
        static let electricityStart = 0.12, milesStart = 150
    }

    struct Financials: Equatable {
        let grossRevenue: Double
        let teslaCut: Double
        let monthlyEnergyOverhead: Double
        let netOperatingIncome: Double
        /// One decimal; nil = never (the site's Infinity).
        let breakevenMonths: Double?
    }

    static func fleetFinancials(fleetSize: Int, electricityRate: Double, dailyMiles: Int, lossOn: Bool) -> Financials {
        let miles = Double(dailyMiles), fleet = Double(fleetSize)
        let tripsPerDay = ROI.avgTripMiles > 0 ? miles / ROI.avgTripMiles : 0
        let dailyRevenuePerCab = tripsPerDay * (ROI.baseFare + ROI.perMileRate * ROI.avgTripMiles)
        let gross = dailyRevenuePerCab * fleet * 30
        let cut = gross * (ROI.networkCutPct / 100)
        let energy = miles * ROI.kwhPerMile * electricityRate * fleet * 30 * (1 + (lossOn ? ROI.inductiveLoss : 0))
        let noi = gross - cut - energy
        let capital = fleet * ROI.costPerCab
        let breakeven = noi > 0 ? (capital / noi * 10).rounded() / 10 : nil
        return Financials(grossRevenue: gross, teslaCut: cut, monthlyEnergyOverhead: energy, netOperatingIncome: noi, breakevenMonths: breakeven)
    }

    /// The cash-flow chart's window (simulation.html renderCashFlowChart):
    /// 1.3 × breakeven, 6 to 60 months; 24 without a breakeven.
    static func chartMonths(breakeven: Double?) -> Int {
        guard let b = breakeven, b > 0 else { return 24 }
        return min(60, max(6, Int((b * 1.3).rounded(.up))))
    }

    // MARK: Fleet ETA (calc.js)

    static let tiers = ["quiet", "typical", "busy"]
    static let tierLabel = ["quiet": "Quiet", "typical": "Typical", "busy": "Busy"]
    static let confidenceLabel = ["high": "High confidence", "medium": "Medium confidence", "low": "Low confidence", "insufficient": "Insufficient data"]
    static let vehicleLabel = ["cybercab": "Cybercab", "model_y": "Model Y", "unknown": "Robotaxi"]
    static let cityName = ["austin": "Austin", "dallas": "Dallas"]
    /// Static figures with no live source (js/fleet-compare.js, calc.js).
    static let modelYFleet = ["austin": 114, "dallas": 65]
    static let staleHours = 36.0
    /// Both cities: 6 AM to 1 AM, Central (owner-confirmed). closeMinute is past
    /// 1440: the service day runs past midnight (1500 = 1:00 AM the next day).
    static let openMinute = 6 * 60, closeMinute = 25 * 60
    /// The window on a 24-hour track, in minutes: 6 AM–12 AM, then 12 AM–1 AM.
    static var hourPieces: [(start: Int, end: Int)] {
        closeMinute > 1440 ? [(openMinute, 1440), (0, closeMinute - 1440)] : [(openMinute, closeMinute)]
    }
    static let central = TimeZone(identifier: "America/Chicago")!

    struct Range: Equatable { let center: Double; let lo: Double; let hi: Double }

    static func fareRange(_ model: FleetEta.FareModel?, miles: Double, tier: String, area: String?) -> Range? {
        guard let model, miles > 0, !model.tiers.isEmpty else { return nil }
        let t = model.tiers[tier] ?? model.tiers["typical"]!
        let mult = FleetEta.lookup(model.areaMult, area) ?? 1
        let at = max(0.5, (model.a + model.b * miles) * mult)
        return Range(center: at * t.center, lo: at * t.lo, hi: at * t.hi)
    }

    static func waitRange(_ model: FleetEta.Waits.Model?, tier: String, area: String?) -> Range? {
        guard let model, !model.tiers.isEmpty else { return nil }
        let t = model.tiers[tier] ?? model.tiers["typical"]!
        let m = FleetEta.lookup(model.areaMult, area) ?? 1
        return Range(center: t.center * m, lo: t.lo * m, hi: t.hi * m)
    }

    /// "$7–$11": whole dollars, rounded outward, at least a dollar wide.
    static func dollarRange(_ r: Range?) -> String? {
        guard let r else { return nil }
        let lo = max(1, Int(r.lo.rounded(.down))), hi = max(lo + 1, Int(r.hi.rounded(.up)))
        return "$\(lo)–$\(hi)"
    }

    /// "6–12 min": whole minutes, outward, at least 2 minutes wide; 45+ caps.
    static func minuteRange(_ r: Range?) -> String? {
        guard let r else { return nil }
        let lo = max(1, Int(r.lo.rounded(.down))), hi = max(lo + 2, Int(r.hi.rounded(.up)))
        return hi > 45 ? "\(lo)–45+ min" : "\(lo)–\(hi) min"
    }

    struct Slot: Equatable { let key: String; let day: String; let part: String }

    /// The demand slot of a moment in Central time (weekend = Friday evening through Sunday).
    static func slot(_ date: Date) -> Slot {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = central
        let hour = cal.component(.hour, from: date)
        // Fixed English names: the device's locale must not change the slot (weekdaySymbols can be "Sat").
        let day = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][cal.component(.weekday, from: date) - 1]
        let weekend = day == "Saturday" || day == "Sunday" || (day == "Friday" && hour >= 19)
        let part = hour < 6 ? "overnight" : hour < 10 ? "morning" : hour < 15 ? "midday" : hour < 19 ? "afternoon" : "evening"
        return Slot(key: "\(weekend ? "weekend" : "weekday"):\(part)", day: day, part: part)
    }

    /// The scenario assumed now for a city's estimates (calc.js assumedTier).
    static func assumedTier(_ eta: FleetEta?, at date: Date) -> (tier: String, reasons: [String], slot: Slot) {
        let s = slot(date)
        let t = eta?.slotTiers?[s.key]
        let tier = t.map(\.tier).flatMap { tiers.contains($0) ? $0 : nil } ?? "typical"
        return (tier, t?.reasons ?? [], s)
    }

    /// "6:00 AM" from minutes after midnight.
    static func clockLabel(_ minuteOfDay: Int) -> String {
        let h = (minuteOfDay / 60) % 24, m = minuteOfDay % 60
        return "\((h + 11) % 12 + 1):\(String(format: "%02d", m)) \(h < 12 ? "AM" : "PM")"
    }

    /// Open now by the Central clock (never the device's): (open, minuteOfDay, label).
    static func serviceStatus(_ date: Date) -> (open: Bool, minuteOfDay: Int, label: String) {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = central
        let minute = cal.component(.hour, from: date) * 60 + cal.component(.minute, from: date)
        // Past midnight, before the close, it is still the day before's service.
        let open = (minute >= openMinute && minute < closeMinute) || minute + 1440 < closeMinute
        return (open, minute, open ? "Operating now" : "Opens \(clockLabel(openMinute))")
    }

    static func ageHours(_ iso: String?, now: Date) -> Double? {
        Format.instant(iso).map { now.timeIntervalSince($0) / 3600 }
    }
    static func isStale(_ iso: String?, now: Date) -> Bool { (ageHours(iso, now: now) ?? .infinity) > staleHours }

    /// "3 min ago", "2 h ago", "just now" (js/fleet-compare.js ago).
    static func ago(_ iso: String?, now: Date) -> String? {
        guard let t = Format.instant(iso) else { return nil }
        let min = max(0, Int((now.timeIntervalSince(t) / 60).rounded()))
        if min < 1 { return "just now" }
        if min < 90 { return "\(min) min ago" }
        let h = Int((Double(min) / 60).rounded())
        return h < 36 ? "\(h) h ago" : "\(Int((Double(h) / 24).rounded())) days ago"
    }

    // MARK: The fleet-geometry check (calc.js etaRange; "How are these estimates calculated?")

    static let deployedShare = [0.4, 0.6, 0.8], speedMph = [18.0, 22, 28]
    static let idleShare: [String: [Double]] = ["quiet": [0.5, 0.65, 0.8], "typical": [0.3, 0.5, 0.6], "busy": [0.05, 0.15, 0.3]]
    static let areaSqMi = ["austin": 272.4, "dallas": 81.0]

    enum Geometry: Equatable { case ok(low: Int, likely: Int, high: Int, highCapped: Bool), fewCars, noData }

    static func geometry(fleetSize: Int?, tier: String, city: String) -> Geometry {
        guard let fleet = fleetSize, fleet > 0 else { return .noData }
        let s = idleShare[tier] ?? idleShare["typical"]!
        let area = areaSqMi[city] ?? 272.4
        func minutes(_ deployed: Double, _ idle: Double, _ speed: Double) -> (Double, Double) {
            let cars = Double(fleet) * deployed * idle
            guard cars > 0 else { return (.infinity, 0) }
            return (1 + (1.35 * 0.5 / (cars / area).squareRoot()) / speed * 60, cars)
        }
        let likely = minutes(deployedShare[1], s[1], speedMph[1])
        if likely.1 < 2 { return .fewCars }
        let best = minutes(deployedShare[2], s[2], speedMph[2]), worst = minutes(deployedShare[0], s[0], speedMph[0])
        let cap = { (m: Double) in min(Int(m.rounded()), 20) }
        return .ok(low: cap(best.0), likely: cap(likely.0), high: cap(worst.0), highCapped: !(worst.0 <= 20))
    }
}
