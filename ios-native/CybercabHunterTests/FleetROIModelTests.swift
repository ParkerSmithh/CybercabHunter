import Testing
import Foundation
@testable import CybercabHunter

/// Fleet ROI 2.0 (FleetROIModel.swift, a port of public/js/fleet-roi.js):
/// the same fixtures the website's node test uses
/// (tests/fixtures/fleet-roi-cases.json), so both give the same numbers;
/// plus the formulas, invalid inputs and saved configurations on the device.
struct FleetROIModelTests {

    /// The repository's fixture file, found from this source file (the
    /// simulator reads the Mac's file system).
    private static func fixtures() throws -> [[String: Any]] {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("tests/fixtures/fleet-roi-cases.json")
        let data = try Data(contentsOf: url)
        let root = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        return try #require(root["cases"] as? [[String: Any]])
    }

    private static func near(_ a: Double, _ b: Double) -> Bool { abs(a - b) <= 1e-6 * max(1, abs(b)) }

    /// Every numeric field of `expected` against the same-named property of `actual`.
    private static func compare(_ path: String, _ actual: [String: Any], _ expected: [String: Any], _ bad: inout [String]) {
        for (k, e) in expected {
            let a = actual[k]
            if let ed = e as? [String: Any] { compare("\(path).\(k)", (a as? [String: Any]) ?? [:], ed, &bad); continue }
            if e is NSNull { if !(a == nil || a is NSNull) { bad.append("\(path).\(k): \(String(describing: a)) vs null") }; continue }
            if let en = e as? NSNumber, CFGetTypeID(en) != CFBooleanGetTypeID() {
                guard let an = a as? Double, near(an, en.doubleValue) else { bad.append("\(path).\(k): \(String(describing: a)) vs \(en)"); continue }
                continue
            }
            if let eb = e as? Bool { if (a as? Bool) != eb { bad.append("\(path).\(k): \(String(describing: a)) vs \(eb)") }; continue }
            if let es = e as? String { if (a as? String) != es { bad.append("\(path).\(k): \(String(describing: a)) vs \(es)") }; continue }
        }
    }

    private static func dict(_ r: FleetROI.Result) -> [String: Any] {
        func m(_ x: FleetROI.Month) -> [String: Any] {
            ["m": Double(x.m), "active": x.active, "gross": x.gross, "platformFee": x.platformFee, "charging": x.charging, "subscription": x.subscription,
             "insurance": x.insurance, "maintenance": x.maintenance, "cleaning": x.cleaning, "opex": x.opex, "operatingProfit": x.operatingProfit,
             "loan": x.loan, "net": x.net, "cumulative": x.cumulative, "loanBalance": x.loanBalance]
        }
        var input: [String: Any] = ["mode": r.input.mode.rawValue, "purchase": r.input.purchase.rawValue]
        for k in FleetROI.Input.numericKeys { input[k] = r.input[k] }
        let p = r.purchase, s = r.steady, h = r.horizon, v = r.perVehicle
        return [
            "input": input,
            "purchase": ["price": p.price, "deposit": p.deposit, "depositCredited": true, "balanceAtDelivery": p.balanceAtDelivery, "tax": p.tax, "fees": p.fees,
                         "down": p.down, "principal": p.principal, "payment": p.payment, "loanMonths": Double(p.loanMonths), "interestTotal": p.interestTotal,
                         "upfrontPerVehicle": p.upfrontPerVehicle, "totalPrice": p.totalPrice, "totalDeposits": p.totalDeposits, "totalTaxFees": p.totalTaxFees,
                         "upfront": p.upfront, "financedTotal": p.financedTotal, "allInPerVehicle": p.allInPerVehicle],
            "perVehicle": ["ridesMonthly": v.ridesMonthly, "grossMonthly": v.grossMonthly, "platformFeeMonthly": v.platformFeeMonthly, "milesMonthly": v.milesMonthly, "chargingMonthly": v.chargingMonthly],
            "steady": ["gross": s.gross, "platformFee": s.platformFee, "charging": s.charging, "subscription": s.subscription, "insurance": s.insurance,
                       "maintenance": s.maintenance, "cleaning": s.cleaning, "opex": s.opex, "operatingProfit": s.operatingProfit, "loan": s.loan, "netWithLoan": s.netWithLoan],
            "horizon": ["months": Double(h.months), "gross": h.gross, "platformFee": h.platformFee, "charging": h.charging, "subscription": h.subscription,
                        "insurance": h.insurance, "maintenance": h.maintenance, "cleaning": h.cleaning, "loan": h.loan, "operatingProfit": h.operatingProfit,
                        "ownershipCost": h.ownershipCost, "ownershipPerMonth": h.ownershipPerMonth, "cumulative": h.cumulative],
            "paybackMonth": r.paybackMonth.map { Double($0) as Any } ?? NSNull(),
            "loanBalanceAtPayback": r.loanBalanceAtPayback.map { $0 as Any } ?? NSNull(),
            "cumulativeEnd": r.cumulativeEnd,
            "month1": m(r.months[0]), "month12": m(r.months[11]), "month60": m(r.months[59]),
        ]
    }

    @Test func matchesTheWebsiteOnEverySharedFixture() throws {
        let cases = try Self.fixtures()
        #expect(cases.count >= 17)
        for c in cases {
            let name = c["name"] as? String ?? "?"
            let inputData = try JSONSerialization.data(withJSONObject: c["input"] ?? [:])
            let input = try JSONDecoder().decode(FleetROI.Input.self, from: inputData)
            var bad: [String] = []
            Self.compare(name, Self.dict(FleetROI.simulate(input)), try #require(c["expected"] as? [String: Any]), &bad)
            #expect(bad.isEmpty, "\(name): \(bad.prefix(4).joined(separator: "; "))")
        }
    }

    @Test func purchaseFormulas() {
        var x = FleetROI.Input()
        let cash = FleetROI.simulate(x)
        #expect(Self.near(cash.purchase.upfront, 29_990 + 29_990 * 0.0625 + 300), "price + 6.25% tax + fees")
        #expect(cash.purchase.deposit == 1000 && cash.purchase.balanceAtDelivery == 28_990, "the deposit is part of the price, never added")
        x.purchase = .finance
        let fin = FleetROI.simulate(x)
        #expect(abs(fin.purchase.payment - 473.94) < 0.005, "$23,992 at 6.9% for 60 months")
        #expect(Self.near(fin.purchase.down + fin.purchase.principal, 29_990), "the price is counted once")
        #expect(Self.near(cash.months[59].cumulative - fin.months[59].cumulative, fin.purchase.interestTotal), "after the loan, they differ by the interest")
        #expect(fin.months[59].loanBalance == 0 && fin.months[58].loanBalance > 0)
        #expect(fin.loanBalanceAtPayback.map { $0 > 0 } == true, "payback while the loan is still owed says so")
    }

    @Test func personalOwnershipNeverEarns() {
        var x = FleetROI.Input()
        x.mode = .personal
        let r = FleetROI.simulate(x)
        #expect(r.months.allSatisfy { $0.gross == 0 && $0.platformFee == 0 && $0.cleaning == 0 })
        #expect(r.paybackMonth == nil)
        #expect(Self.near(r.months[0].charging, 1000 * 0.25 * 0.12))
    }

    @Test func edgeCases() {
        var x = FleetROI.Input()
        x.farePerRide = 0
        #expect(FleetROI.simulate(x).paybackMonth == nil, "zero revenue: no payback")
        x = FleetROI.Input(); x.downtimePct = 100
        #expect(FleetROI.simulate(x).steady.gross == 0)
        x = FleetROI.Input(); x.activationDelayMonths = 24
        let late = FleetROI.simulate(x), now = FleetROI.simulate(FleetROI.Input())
        #expect((late.paybackMonth ?? 0) > (now.paybackMonth ?? 0) + 18)
        x = FleetROI.Input(); x.vehicles = 100
        #expect(Self.near(FleetROI.simulate(x).steady.operatingProfit, 100 * now.steady.operatingProfit) && FleetROI.simulate(x).paybackMonth == now.paybackMonth)
        x = FleetROI.Input(); x.vehicles = -3; x.price = .nan; x.horizonMonths = 7; x.loanMonths = 61.5
        let s = x.sanitized
        #expect(s.vehicles == 1 && s.price == 29_990 && s.horizonMonths == 12 && s.loanMonths == 62, "clamped like the site (Math.round)")
        #expect(FleetROI.startMonthLabel(3) == "2027-03" && FleetROI.monthName(16) == "Mar 2028")
    }

    @Test func theFiveFixedValuesCantBeChanged() {
        #expect(FleetROI.Fixed.price == 29_990 && FleetROI.Fixed.deposit == 1000 && FleetROI.Fixed.subscriptionMonthly == 300
                && FleetROI.Fixed.subscriptionIncludedMonths == 1 && FleetROI.Fixed.platformSharePct == 25)
        var x = FleetROI.Input()
        x.price = 35_000; x.deposit = 2500; x.subscriptionMonthly = 299; x.subscriptionIncludedMonths = 6; x.platformSharePct = 30; x.farePerRide = 14
        let s = x.sanitized
        #expect(s.price == 29_990 && s.deposit == 1000 && s.subscriptionMonthly == 300 && s.subscriptionIncludedMonths == 1 && s.platformSharePct == 25, "an input can't change them")
        #expect(s.farePerRide == 14, "other inputs are kept")
        let r = FleetROI.simulate(x)
        #expect(Self.near(r.steady.platformFee, r.steady.gross * 0.25), "Tesla Revenue Share is always 25%")
        #expect(r.months[0].subscription == 0 && r.months[1].subscription == 300, "month 1 free, then $300")
        var long = FleetROI.Input(); long.horizonMonths = 120
        let ten = FleetROI.simulate(long)
        #expect([12, 13, 24, 25, 60, 119].allSatisfy { ten.months[$0].subscription == 300 }, "the free month applies once, not every year")
        let costs: Double = 1296 + 84.24 + 300 + 250 + 60 + 150   // 25% share, charging, subscription, insurance, maintenance, cleaning
        let expected: Double = 5184 - costs
        #expect(Self.near(FleetROI.simulate(.init()).steady.operatingProfit, expected), "$3,043.76 a month by default")
        #expect(FleetROI.fields.filter { $0.value.kind == .fixed }.keys.sorted() == ["deposit", "platformSharePct", "price", "subscriptionIncludedMonths", "subscriptionMonthly"])
    }

    @MainActor
    @Test func savedConfigurationsStayOnTheDevice() throws {
        let suite = "FleetROIModelTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = FleetROIStore(defaults: defaults)
        var x = FleetROI.Input(); x.vehicles = 10
        let a = try #require(store.save(name: "  Ten   cabs ", input: x))
        #expect(a.name == "Ten cabs" && store.items.count == 1)
        store.rename(a.id, to: "Ten-cab plan")
        #expect(store.items.first?.name == "Ten-cab plan")
        let b = try #require(store.duplicate(a.id))
        #expect(b.name == "Ten-cab plan copy" && store.items[1].id == b.id && store.items[1].input.vehicles == 10)
        store.delete(a.id)
        #expect(store.items.count == 1 && store.items[0].id == b.id)
        #expect(store.save(name: "   ", input: .init())?.name == "Untitled configuration")
        // Survives a relaunch, and reads the website's JSON shape.
        #expect(FleetROIStore(defaults: defaults).items.count == 2)
        defaults.set(Data(#"[{"id":"cfg-web","name":"From the web","savedAt":"2026-11-13T20:00:00.000Z","input":{"mode":"personal","vehicles":"3","price":"abc"}}]"#.utf8), forKey: FleetROIStore.key)
        let web = FleetROIStore(defaults: defaults).items
        #expect(web.count == 1 && web[0].input.mode == .personal && web[0].input.vehicles == 3 && web[0].input.price == 29_990)
        // A save from before the values were fixed ($299, 30%, its own price): fixed on load, everything else kept, nothing deleted.
        defaults.set(Data(#"[{"id":"cfg-old","name":"Old plan","savedAt":"2026-11-13T20:00:00.000Z","input":{"mode":"fleet","vehicles":7,"price":31000,"deposit":1500,"subscriptionMonthly":299,"subscriptionIncludedMonths":2,"platformSharePct":30,"farePerRide":13,"ridesPerDay":18}}]"#.utf8), forKey: FleetROIStore.key)
        let oldStore = FleetROIStore(defaults: defaults)
        let old = try #require(oldStore.items.first)
        #expect(old.input.price == 29_990 && old.input.deposit == 1000 && old.input.subscriptionMonthly == 300 && old.input.subscriptionIncludedMonths == 1 && old.input.platformSharePct == 25)
        #expect(old.name == "Old plan" && old.input.vehicles == 7 && old.input.farePerRide == 13 && old.input.ridesPerDay == 18)
        let copy = try #require(oldStore.duplicate("cfg-old"))
        #expect(copy.input.subscriptionMonthly == 300 && copy.input.platformSharePct == 25 && oldStore.items.count == 2, "a duplicate carries the fixed values")
        defaults.set(Data("{broken".utf8), forKey: FleetROIStore.key)
        #expect(FleetROIStore(defaults: defaults).items.isEmpty, "a corrupt store reads as empty")
    }
}
