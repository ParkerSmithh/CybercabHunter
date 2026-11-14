import Foundation

/// Fleet ROI 2.0: the Cybercab ownership and fleet-investment model, a
/// line-for-line port of public/js/fleet-roi.js (the reference). Formulas and
/// every default: docs/fleet-roi-model.md. Both are tested against the same
/// fixtures, tests/fixtures/fleet-roi-cases.json (FleetROIModelTests), so the
/// app and the website always give the same numbers.
///
/// Three kinds of figure, kept apart: reported (Tesla's order interface, as
/// reported Nov 13, 2026; not verified on tesla.com), estimate (a citable
/// public figure), assumption (an editable guess). Commercial operation is
/// hypothetical: Tesla has published no terms for owners.
enum FleetROI {

    // MARK: Reported terms

    enum Pricing {
        static let price = 29_990.0
        static let deposit = 1_000.0
        static let depositRefundable = false
        static let depositCreditedToPrice = true      // assumption until Tesla's terms say otherwise
        static let subscriptionMonthly = 299.0
        static let subscriptionIncludedMonths = 1
        static let deliveryEstimate = "2026-12"
        static let deliveryLocation = "Austin, Texas"
        static let taxesIncluded = false
        static let maintenanceSubscriptionRequired = true
        static let maintenancePriceShown = false
        static let lastVerified = "2026-11-13"
        static let verifiedOnTeslaCom = false
        static let sources: [(label: String, url: String?)] = [
            ("Tesla Cybercab order interface (screenshot, as reported)", nil),
            ("InsideEVs, Nov 13, 2026", "https://insideevs.com/news/815473/tesla-cybercab-pricing-sales-announced/"),
            ("Teslarati, Nov 13, 2026", "https://www.teslarati.com/tesla-cybercab-29990-december-deliveries/"),
            ("Not a Tesla App, Nov 13, 2026", "https://www.notateslaapp.com/news/5012/tesla-opens-orders-for-the-cybercab-for-personal-use-costs-29990-and-requires-a-299-monthly-subscription"),
        ]
    }

    enum Kind: String, Codable { case reported, estimate, assumption
        var label: String { rawValue.capitalized }
    }
    enum Mode: String, Codable, CaseIterable { case personal, fleet }
    enum Purchase: String, Codable, CaseIterable { case cash, finance }

    // MARK: Inputs

    struct Field { let def: Double, min: Double, max: Double, step: Double, kind: Kind?, fleetOnly: Bool }
    /// Same table as FIELDS in fleet-roi.js.
    static let fields: [String: Field] = [
        "vehicles": .init(def: 1, min: 1, max: 1000, step: 1, kind: .assumption, fleetOnly: false),
        "price": .init(def: 29_990, min: 0, max: 200_000, step: 10, kind: .reported, fleetOnly: false),
        "deposit": .init(def: 1000, min: 0, max: 10_000, step: 50, kind: .reported, fleetOnly: false),
        "salesTaxPct": .init(def: 6.25, min: 0, max: 15, step: 0.05, kind: .estimate, fleetOnly: false),
        "feesPerVehicle": .init(def: 300, min: 0, max: 5000, step: 10, kind: .assumption, fleetOnly: false),
        "downPaymentPct": .init(def: 20, min: 0, max: 100, step: 1, kind: .assumption, fleetOnly: false),
        "aprPct": .init(def: 6.9, min: 0, max: 30, step: 0.1, kind: .assumption, fleetOnly: false),
        "loanMonths": .init(def: 60, min: 12, max: 96, step: 12, kind: .assumption, fleetOnly: false),
        "subscriptionMonthly": .init(def: 299, min: 0, max: 2000, step: 1, kind: .reported, fleetOnly: false),
        "subscriptionIncludedMonths": .init(def: 1, min: 0, max: 24, step: 1, kind: .reported, fleetOnly: false),
        "insuranceMonthly": .init(def: 250, min: 0, max: 3000, step: 5, kind: .assumption, fleetOnly: false),
        "maintenanceMonthly": .init(def: 60, min: 0, max: 1000, step: 5, kind: .assumption, fleetOnly: false),
        "electricityRate": .init(def: 0.12, min: 0, max: 0.6, step: 0.01, kind: .assumption, fleetOnly: false),
        "kwhPerMile": .init(def: 0.25, min: 0.1, max: 0.5, step: 0.01, kind: .assumption, fleetOnly: false),
        "personalMilesMonthly": .init(def: 1000, min: 0, max: 6000, step: 50, kind: .assumption, fleetOnly: false),
        "farePerRide": .init(def: 12, min: 0, max: 100, step: 0.5, kind: .assumption, fleetOnly: true),
        "ridesPerDay": .init(def: 16, min: 0, max: 60, step: 1, kind: .assumption, fleetOnly: true),
        "milesPerRide": .init(def: 5, min: 0.5, max: 40, step: 0.5, kind: .assumption, fleetOnly: true),
        "deadheadPct": .init(def: 30, min: 0, max: 150, step: 5, kind: .assumption, fleetOnly: true),
        "operatingDays": .init(def: 30, min: 0, max: 31, step: 1, kind: .assumption, fleetOnly: true),
        "downtimePct": .init(def: 10, min: 0, max: 100, step: 1, kind: .assumption, fleetOnly: true),
        "platformSharePct": .init(def: 30, min: 0, max: 100, step: 1, kind: .assumption, fleetOnly: true),
        "cleaningMonthly": .init(def: 150, min: 0, max: 2000, step: 5, kind: .assumption, fleetOnly: true),
        "activationDelayMonths": .init(def: 3, min: 0, max: 60, step: 1, kind: .assumption, fleetOnly: true),
        "horizonMonths": .init(def: 60, min: 12, max: 120, step: 12, kind: nil, fleetOnly: false),
    ]
    static let maxMonths = 120
    static let fleetPresets = [1, 2, 5, 10, 25, 50, 100]

    /// Every input. Saved as JSON (keys match the website's), always passed
    /// through `sanitized` before use.
    struct Input: Codable, Equatable, Hashable {
        var mode: Mode = .fleet
        var vehicles: Double = 1
        var price: Double = 29_990
        var deposit: Double = 1000
        var salesTaxPct: Double = 6.25
        var feesPerVehicle: Double = 300
        var purchase: Purchase = .cash
        var downPaymentPct: Double = 20
        var aprPct: Double = 6.9
        var loanMonths: Double = 60
        var subscriptionMonthly: Double = 299
        var subscriptionIncludedMonths: Double = 1
        var insuranceMonthly: Double = 250
        var maintenanceMonthly: Double = 60
        var electricityRate: Double = 0.12
        var kwhPerMile: Double = 0.25
        var personalMilesMonthly: Double = 1000
        var farePerRide: Double = 12
        var ridesPerDay: Double = 16
        var milesPerRide: Double = 5
        var deadheadPct: Double = 30
        var operatingDays: Double = 30
        var downtimePct: Double = 10
        var platformSharePct: Double = 30
        var cleaningMonthly: Double = 150
        var activationDelayMonths: Double = 3
        var horizonMonths: Double = 60

        init() {}

        /// Lenient decoding, like sanitize() on the site: a missing, mistyped
        /// or unknown value becomes the default (a numeric string is read).
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: AnyKey.self)
            func num(_ k: String) -> Double? {
                let key = AnyKey(k)
                if let d = try? c.decode(Double.self, forKey: key) { return d }
                if let s = try? c.decode(String.self, forKey: key), let d = Double(s.trimmingCharacters(in: .whitespaces)), !s.trimmingCharacters(in: .whitespaces).isEmpty { return d }
                return nil
            }
            var x = Input()
            if let m = try? c.decode(String.self, forKey: AnyKey("mode")), let v = Mode(rawValue: m) { x.mode = v }
            if let p = try? c.decode(String.self, forKey: AnyKey("purchase")), let v = Purchase(rawValue: p) { x.purchase = v }
            for k in Input.numericKeys { if let v = num(k) { x[k] = v } }
            self = x
        }

        static let numericKeys = ["vehicles", "price", "deposit", "salesTaxPct", "feesPerVehicle", "downPaymentPct", "aprPct", "loanMonths",
                                  "subscriptionMonthly", "subscriptionIncludedMonths", "insuranceMonthly", "maintenanceMonthly", "electricityRate",
                                  "kwhPerMile", "personalMilesMonthly", "farePerRide", "ridesPerDay", "milesPerRide", "deadheadPct", "operatingDays",
                                  "downtimePct", "platformSharePct", "cleaningMonthly", "activationDelayMonths", "horizonMonths"]

        subscript(key: String) -> Double {
            get {
                switch key {
                case "vehicles": vehicles; case "price": price; case "deposit": deposit; case "salesTaxPct": salesTaxPct
                case "feesPerVehicle": feesPerVehicle; case "downPaymentPct": downPaymentPct; case "aprPct": aprPct; case "loanMonths": loanMonths
                case "subscriptionMonthly": subscriptionMonthly; case "subscriptionIncludedMonths": subscriptionIncludedMonths
                case "insuranceMonthly": insuranceMonthly; case "maintenanceMonthly": maintenanceMonthly; case "electricityRate": electricityRate
                case "kwhPerMile": kwhPerMile; case "personalMilesMonthly": personalMilesMonthly; case "farePerRide": farePerRide
                case "ridesPerDay": ridesPerDay; case "milesPerRide": milesPerRide; case "deadheadPct": deadheadPct; case "operatingDays": operatingDays
                case "downtimePct": downtimePct; case "platformSharePct": platformSharePct; case "cleaningMonthly": cleaningMonthly
                case "activationDelayMonths": activationDelayMonths; case "horizonMonths": horizonMonths
                default: .nan
                }
            }
            set {
                switch key {
                case "vehicles": vehicles = newValue; case "price": price = newValue; case "deposit": deposit = newValue; case "salesTaxPct": salesTaxPct = newValue
                case "feesPerVehicle": feesPerVehicle = newValue; case "downPaymentPct": downPaymentPct = newValue; case "aprPct": aprPct = newValue; case "loanMonths": loanMonths = newValue
                case "subscriptionMonthly": subscriptionMonthly = newValue; case "subscriptionIncludedMonths": subscriptionIncludedMonths = newValue
                case "insuranceMonthly": insuranceMonthly = newValue; case "maintenanceMonthly": maintenanceMonthly = newValue; case "electricityRate": electricityRate = newValue
                case "kwhPerMile": kwhPerMile = newValue; case "personalMilesMonthly": personalMilesMonthly = newValue; case "farePerRide": farePerRide = newValue
                case "ridesPerDay": ridesPerDay = newValue; case "milesPerRide": milesPerRide = newValue; case "deadheadPct": deadheadPct = newValue; case "operatingDays": operatingDays = newValue
                case "downtimePct": downtimePct = newValue; case "platformSharePct": platformSharePct = newValue; case "cleaningMonthly": cleaningMonthly = newValue
                case "activationDelayMonths": activationDelayMonths = newValue; case "horizonMonths": horizonMonths = newValue
                default: break
                }
            }
        }

        /// sanitize(): non-finite values become the default, numbers are
        /// clamped to their range, whole-number fields are rounded.
        var sanitized: Input {
            var x = self
            for k in Input.numericKeys {
                guard let f = FleetROI.fields[k] else { continue }
                var n = x[k]
                if !n.isFinite { n = f.def }
                n = Swift.min(f.max, Swift.max(f.min, n))
                if f.step >= 1, f.step.rounded() == f.step { n = FleetROI.jsRound(n) }
                x[k] = n
            }
            return x
        }
    }

    // MARK: Results

    struct Month: Equatable {
        let m: Int
        let active: Bool
        let gross, platformFee, charging, subscription, insurance, maintenance, cleaning, opex, operatingProfit, loan, net, cumulative, loanBalance: Double
    }
    struct PurchaseResult: Equatable {
        let price, deposit, balanceAtDelivery, tax, fees, down, principal, payment: Double
        let loanMonths: Int
        let interestTotal, upfrontPerVehicle, totalPrice, totalDeposits, totalTaxFees, upfront, financedTotal, allInPerVehicle: Double
    }
    struct PerVehicle: Equatable { let ridesMonthly, grossMonthly, platformFeeMonthly, milesMonthly, chargingMonthly: Double }
    struct Steady: Equatable { let gross, platformFee, charging, subscription, insurance, maintenance, cleaning, opex, operatingProfit, loan, netWithLoan: Double }
    struct Horizon: Equatable { let months: Int; let gross, platformFee, charging, subscription, insurance, maintenance, cleaning, loan, operatingProfit, ownershipCost, ownershipPerMonth, cumulative: Double }
    struct Result: Equatable {
        let input: Input
        let purchase: PurchaseResult
        let perVehicle: PerVehicle
        let steady: Steady
        let months: [Month]
        let horizon: Horizon
        /// Fleet only; nil = not within 10 years.
        let paybackMonth: Int?
        /// Financed: what's still owed at payback (cash back is not the loan paid off).
        let loanBalanceAtPayback: Double?
        let cumulativeEnd: Double
    }

    // MARK: Model

    /// Monthly payment on a fixed-rate loan (0% APR: straight-line).
    static func loanPayment(principal: Double, aprPct: Double, months: Double) -> Double {
        if principal <= 0 || months <= 0 { return 0 }
        let r = aprPct / 100 / 12
        if r == 0 { return principal / months }
        return principal * r / (1 - pow(1 + r, -months))
    }

    static func simulate(_ raw: Input) -> Result {
        let x = raw.sanitized
        let n = x.vehicles
        let fleet = x.mode == .fleet
        let finance = x.purchase == .finance

        let tax = x.price * x.salesTaxPct / 100
        let deposit = min(x.deposit, x.price)
        let down = finance ? x.price * x.downPaymentPct / 100 : x.price
        let principal = finance ? x.price - down : 0
        let payment = finance ? loanPayment(principal: principal, aprPct: x.aprPct, months: x.loanMonths) : 0
        let loanMonths = finance && principal > 0 ? Int(x.loanMonths) : 0
        let interestTotal = payment * Double(loanMonths) - principal
        let upfrontPerVehicle = down + tax + x.feesPerVehicle

        let activeShare = 1 - x.downtimePct / 100
        let ridesMonthly = fleet ? x.ridesPerDay * x.operatingDays * activeShare : 0
        let grossMonthly = ridesMonthly * x.farePerRide
        let platformFeeMonthly = grossMonthly * x.platformSharePct / 100
        let milesMonthly = fleet ? ridesMonthly * x.milesPerRide * (1 + x.deadheadPct / 100) : x.personalMilesMonthly
        let chargingActive = milesMonthly * x.kwhPerMile * x.electricityRate
        let chargingIdle = fleet ? 0 : chargingActive
        let cleaningMonthly = fleet ? x.cleaningMonthly : 0

        var months: [Month] = []
        months.reserveCapacity(maxMonths)
        var cumulative = -upfrontPerVehicle * n
        var paybackMonth: Int?
        var balance = principal * n
        let rate = x.aprPct / 100 / 12
        let h = Int(x.horizonMonths)
        var tGross = 0.0, tFee = 0.0, tCharging = 0.0, tSub = 0.0, tIns = 0.0, tMaint = 0.0, tClean = 0.0, tLoan = 0.0, tOP = 0.0
        for m in 1...maxMonths {
            let md = Double(m)
            let active = fleet && md > x.activationDelayMonths
            let gross = active ? grossMonthly * n : 0
            let platformFee = active ? platformFeeMonthly * n : 0
            let charging = (active ? chargingActive : chargingIdle) * n
            let subscription = md > x.subscriptionIncludedMonths ? x.subscriptionMonthly * n : 0
            let insurance = x.insuranceMonthly * n
            let maintenance = x.maintenanceMonthly * n
            let cleaning = active ? cleaningMonthly * n : 0
            let opex = platformFee + charging + subscription + insurance + maintenance + cleaning
            let operatingProfit = gross - opex
            let loan = m <= loanMonths ? payment * n : 0
            if loan > 0 { balance = m == loanMonths ? 0 : max(0, balance * (1 + rate) - loan) }
            let net = operatingProfit - loan
            cumulative += net
            if paybackMonth == nil && fleet && cumulative >= 0 { paybackMonth = m }
            if m <= h {
                tGross += gross; tFee += platformFee; tCharging += charging; tSub += subscription; tIns += insurance
                tMaint += maintenance; tClean += cleaning; tLoan += loan; tOP += operatingProfit
            }
            months.append(Month(m: m, active: active, gross: gross, platformFee: platformFee, charging: charging, subscription: subscription,
                                insurance: insurance, maintenance: maintenance, cleaning: cleaning, opex: opex, operatingProfit: operatingProfit,
                                loan: loan, net: net, cumulative: cumulative, loanBalance: balance))
        }

        let sGross = grossMonthly * n, sFee = platformFeeMonthly * n, sCharging = chargingActive * n
        let sSub = x.subscriptionMonthly * n, sIns = x.insuranceMonthly * n, sMaint = x.maintenanceMonthly * n, sClean = cleaningMonthly * n
        let sOpex = sFee + sCharging + sSub + sIns + sMaint + sClean
        let sOP = sGross - sOpex
        let sLoan = payment * n
        let steady = Steady(gross: sGross, platformFee: sFee, charging: sCharging, subscription: sSub, insurance: sIns, maintenance: sMaint,
                            cleaning: sClean, opex: sOpex, operatingProfit: sOP, loan: sLoan, netWithLoan: sOP - sLoan)

        let upfront = upfrontPerVehicle * n
        let ownership = upfront + tLoan + tCharging + tSub + tIns + tMaint + tClean
        let purchase = PurchaseResult(price: x.price, deposit: deposit, balanceAtDelivery: x.price - deposit, tax: tax, fees: x.feesPerVehicle,
                                      down: down, principal: principal, payment: payment, loanMonths: loanMonths, interestTotal: interestTotal,
                                      upfrontPerVehicle: upfrontPerVehicle, totalPrice: x.price * n, totalDeposits: deposit * n,
                                      totalTaxFees: (tax + x.feesPerVehicle) * n, upfront: upfront, financedTotal: principal * n,
                                      allInPerVehicle: x.price + tax + x.feesPerVehicle + interestTotal)
        return Result(
            input: x, purchase: purchase,
            perVehicle: PerVehicle(ridesMonthly: ridesMonthly, grossMonthly: grossMonthly, platformFeeMonthly: platformFeeMonthly, milesMonthly: milesMonthly, chargingMonthly: chargingActive),
            steady: steady, months: months,
            horizon: Horizon(months: h, gross: tGross, platformFee: tFee, charging: tCharging, subscription: tSub, insurance: tIns, maintenance: tMaint,
                             cleaning: tClean, loan: tLoan, operatingProfit: tOP, ownershipCost: ownership, ownershipPerMonth: ownership / Double(h),
                             cumulative: months[h - 1].cumulative),
            paybackMonth: paybackMonth,
            loanBalanceAtPayback: paybackMonth.map { months[$0 - 1].loanBalance },
            cumulativeEnd: months[maxMonths - 1].cumulative)
    }

    // MARK: Scenarios (Fleet mode)

    enum Scenario: String, CaseIterable, Identifiable, Codable {
        case conservative, expected, optimistic
        var id: String { rawValue }
        var label: String { rawValue.capitalized }
        /// Same values as SCENARIOS in fleet-roi.js.
        var values: [String: Double] {
            switch self {
            case .conservative: ["farePerRide": 9, "ridesPerDay": 10, "downtimePct": 20, "platformSharePct": 35, "activationDelayMonths": 6, "insuranceMonthly": 400, "cleaningMonthly": 200]
            case .expected: ["farePerRide": 12, "ridesPerDay": 16, "downtimePct": 10, "platformSharePct": 30, "activationDelayMonths": 3, "insuranceMonthly": 250, "cleaningMonthly": 150]
            case .optimistic: ["farePerRide": 15, "ridesPerDay": 24, "downtimePct": 5, "platformSharePct": 25, "activationDelayMonths": 1, "insuranceMonthly": 200, "cleaningMonthly": 100]
            }
        }
    }
    static let scenarioKeys = ["farePerRide", "ridesPerDay", "downtimePct", "platformSharePct", "activationDelayMonths", "insuranceMonthly", "cleaningMonthly"]

    static func withScenario(_ input: Input, _ s: Scenario, edits: [String: Double] = [:]) -> Input {
        var out = input
        out.mode = .fleet
        let vals = s.values.merging(edits) { _, e in e }
        for k in scenarioKeys { if let v = vals[k] { out[k] = v } }
        return out
    }

    /// "2027-03": the month a delay of `delayMonths` lands in, from the delivery estimate.
    static func startMonthLabel(_ delayMonths: Int, delivery: String = Pricing.deliveryEstimate) -> String {
        let parts = delivery.split(separator: "-").compactMap { Int($0) }
        let t = parts[0] * 12 + (parts[1] - 1) + delayMonths
        return String(format: "%d-%02d", t / 12, t % 12 + 1)
    }
    /// "Mar 2028" for month m after delivery (month 1 = December 2026).
    static func monthName(_ m: Int) -> String {
        let label = startMonthLabel(max(0, m - 1)).split(separator: "-").compactMap { Int($0) }
        let names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        return "\(names[label[1] - 1]) \(label[0])"
    }

    /// JavaScript's Math.round (halves round up, toward +∞), so whole-number
    /// inputs clamp the same way on both platforms.
    static func jsRound(_ v: Double) -> Double { (v + 0.5).rounded(.down) }
}

/// A coding key for any string (lenient input decoding).
struct AnyKey: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init(_ s: String) { stringValue = s }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { nil }
}
