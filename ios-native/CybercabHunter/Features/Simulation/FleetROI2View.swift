import SwiftUI
import Charts

/// Fleet ROI 2.0 in the app (the website's Fleet ROI tab, same model:
/// FleetROI in FleetROIModel.swift = public/js/fleet-roi.js). Native
/// controls, Swift Charts, saved configurations on the device. Every input
/// says what kind of figure it is (Reported / Estimate / Assumption) and
/// commercial operation is always labelled hypothetical.

/// The simulator's state, kept on SimulationModel so switching to Fleet ETA
/// and back doesn't lose it.
@MainActor
@Observable
final class FleetROISession {
    var input = FleetROI.Input()
    var showCumulative = true
    var showRevenue = true
    var showExpenses = true
    var scenarioEdits: [FleetROI.Scenario: [String: Double]] = [:]
    var editingScenario: FleetROI.Scenario = .expected
    var compareIDs: Set<String> = []

    var result: FleetROI.Result { FleetROI.simulate(input) }
    var horizon: Int { Int(input.sanitized.horizonMonths) }
    func scenarioInput(_ s: FleetROI.Scenario) -> FleetROI.Input { FleetROI.withScenario(input, s, edits: scenarioEdits[s] ?? [:]) }
    func reset() { let mode = input.mode; input = FleetROI.Input(); input.mode = mode }
}

// MARK: - Formatting

enum ROIFormat {
    static func money(_ v: Double, dp: Int = 0) -> String {
        let s = abs(v).formatted(.number.precision(.fractionLength(dp)).locale(Locale(identifier: "en_US")))
        return (v < 0 ? "−$" : "$") + s
    }
    /// Exact below $10M, compact above ("$374.8M").
    static func big(_ v: Double) -> String {
        abs(v) >= 10_000_000 ? (v < 0 ? "−$" : "$") + abs(v).formatted(.number.notation(.compactName).precision(.fractionLength(0...2)).locale(Locale(identifier: "en_US"))) : money(v)
    }
    static func compact(_ v: Double) -> String { (v < 0 ? "−$" : "$") + abs(v).formatted(.number.notation(.compactName).precision(.fractionLength(0...1)).locale(Locale(identifier: "en_US"))) }
    static func payback(_ r: FleetROI.Result, short: Bool = false) -> String {
        guard r.input.mode == .fleet else { return "n/a" }
        guard let m = r.paybackMonth else { return short ? "Not in 10 yrs" : "Not within 10 years" }
        return "\(m) mo"
    }
    static func years(_ months: Int) -> String { months == 12 ? "1 yr" : "\(months / 12) yrs" }
}

// MARK: - Building blocks

/// Reported / Estimate / Assumption.
struct KindBadge: View {
    let kind: FleetROI.Kind
    var body: some View {
        Text(kind.label.uppercased())
            .font(.inter(9, .semibold, relativeTo: .caption2)).tracking(0.6)
            .padding(.horizontal, 7).padding(.vertical, 3)
            .foregroundStyle(kind == .reported ? Color.brandGold : kind == .estimate ? Color.chMist : Color.chFog)
            .background(kind == .reported ? Color.brandGold.opacity(0.1) : .clear, in: .capsule)
            .overlay(Capsule().strokeBorder(kind == .reported ? Color.brandGold.opacity(0.45) : Color.chHair2, style: StrokeStyle(lineWidth: 1, dash: kind == .assumption ? [3, 2] : [])))
            .accessibilityLabel(kind.label)
    }
}

/// A rounded gold-edged panel (the website's .roi2-card).
struct ROICard<Content: View>: View {
    var gold = false
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 10) { content }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                ZStack {
                    Color.chSurface
                    if gold { LinearGradient(colors: [Color.brandGold.opacity(0.1), .clear], startPoint: .topLeading, endPoint: .center) }
                }
                .clipShape(.rect(cornerRadius: 16))
            }
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(gold ? Color.brandGold.opacity(0.35) : Color.chLine))
    }
}

/// An animated result tile.
struct ROIMetric: View {
    let label: String
    let value: Double?
    var text: String? = nil
    var sub: String
    var highlight = false
    var format: (Double) -> String = ROIFormat.big
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(label.uppercased()).font(.inter(10, .semibold, relativeTo: .caption2)).tracking(0.5).foregroundStyle(Color.chFog)
                .fixedSize(horizontal: false, vertical: true)
            Group {
                if let text { Text(text) } else { Text(format(value ?? 0)).contentTransition(.numericText(value: value ?? 0)) }
            }
            .font(.inter(20, .semibold, relativeTo: .title3)).monospacedDigit().lineLimit(1).minimumScaleFactor(0.55)
            .foregroundStyle((value ?? 0) < 0 ? Color(hex: 0xF87171) : highlight ? Color.brandGold : Color.chInk)
            Text(sub).font(.inter(11, relativeTo: .caption)).foregroundStyle(Color.chCaption).fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(maxWidth: .infinity, minHeight: 104, alignment: .topLeading)
        .background(highlight ? Color.brandGold.opacity(0.08) : Color.chSurface, in: .rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(highlight ? Color.brandGold.opacity(0.5) : Color.chLine))
        .animation(.snappy(duration: 0.35), value: value)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityValue("\(text ?? format(value ?? 0)). \(sub)")
    }
}

// MARK: - Purchase

struct FleetROIPurchaseCard: View {
    var body: some View {
        ROICard(gold: true) {
            HStack {
                CardHeading(dotLabel: "Order terms", title: nil)
                Spacer()
                KindBadge(kind: .reported)
            }
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("$29,990").font(.inter(38, .semibold, relativeTo: .largeTitle)).monospacedDigit().foregroundStyle(Color.brandGold)
                Text("before taxes").font(.inter(13)).foregroundStyle(Color.chFog)
            }
            .accessibilityElement(children: .combine)
            VStack(spacing: 0) {
                term("Order deposit", "$1,000 · nonrefundable")
                term("Autonomy Subscription", "$299/mo · first month included")
                term("Maintenance subscription", "Required · price not shown")
                term("Estimated delivery", "December 2026 · Austin, Texas")
                term("Availability", "Invitation only, personal use")
            }
            Text("We treat the deposit as part of the $29,990 (credited at delivery), not an extra charge, until Tesla's terms say otherwise. Tesla hasn't said owners may run a Cybercab on its Robotaxi network; any revenue here is hypothetical.")
                .font(.inter(11.5, relativeTo: .footnote)).foregroundStyle(Color.chCaption).fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 4) {
                Text("Sources (last verified Nov 13, 2026; not yet confirmed on tesla.com):").font(.inter(11.5, relativeTo: .footnote)).foregroundStyle(Color.chCaption)
                ForEach(FleetROI.Pricing.sources, id: \.label) { s in
                    if let u = s.url, let url = URL(string: u) {
                        Link(destination: url) { Text(s.label).font(.inter(12, .medium, relativeTo: .footnote)).underline() }.tint(.brandGold)
                    } else {
                        Text(s.label).font(.inter(12, relativeTo: .footnote)).foregroundStyle(Color.chFog)
                    }
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("roi2Sources")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("roi2Purchase")
    }

    private func term(_ k: String, _ v: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(k).font(.inter(13)).foregroundStyle(Color.chFog)
            Spacer(minLength: 10)
            Text(v).font(.inter(13, .medium)).foregroundStyle(Color.chInk).multilineTextAlignment(.trailing)
        }
        .padding(.vertical, 8)
        .overlay(alignment: .top) { Rectangle().fill(Color.chLine).frame(height: 1) }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Simulator

struct FleetROI2Sections: View {
    @Bindable var session: FleetROISession
    let store: FleetROIStore
    @State private var selectedMonth: Int?
    @State private var renaming: FleetROIStore.Item?
    @State private var newName = ""
    @State private var deleting: FleetROIStore.Item?
    @State private var showCompare = false
    @State private var savedFlash = 0

    var body: some View {
        let r = session.result
        let fleet = session.input.mode == .fleet
        VStack(alignment: .leading, spacing: 18) {
            SimSectionHead(eyebrow: "Price · Subscription · Delivery", title: "Cybercab purchase").padding(.top, 8)
            FleetROIPurchaseCard()
            breakdown(r)

            SimSectionHead(eyebrow: "Simulator · Fleet builder", title: "Own or operate").padding(.top, 8)
            modePicker
            Text(fleet
                 ? "Fleet investment is a hypothetical: Tesla has not published terms for owners to run a Cybercab on its Robotaxi network (eligibility, revenue split, insurance, start date), and local rules and approval apply. Revenue, costs and the start date are your assumptions."
                 : "Personal ownership: what owning and driving a Cybercab costs, with the required Autonomy Subscription. No revenue: owning one doesn't mean you may run it as a commercial Robotaxi.")
                .font(.inter(13, relativeTo: .callout)).foregroundStyle(Color.chMist).fixedSize(horizontal: false, vertical: true)
                .padding(.leading, 12)
                .overlay(alignment: .leading) { Rectangle().fill(Color.brandGold).frame(width: 2) }
                .accessibilityIdentifier("roi2ModeNote")

            fleetBuilder
            metrics(r)
            timeline(r)
            inputs

            if fleet {
                SimSectionHead(eyebrow: "Conservative · Expected · Optimistic", title: "Scenario comparison").padding(.top, 8)
                scenarios
            }

            SimSectionHead(eyebrow: "On this device only", title: "Saved configurations").padding(.top, 8)
            saved

            Text("Not affiliated with Tesla, Inc. A simulation for planning and curiosity, not financial advice, a quote or a promise of returns. Personal ownership does not mean permission to operate a commercial Robotaxi: that depends on Tesla's fleet terms, local regulation, commercial insurance and approval.")
                .font(.inter(11.5, relativeTo: .footnote)).foregroundStyle(Color.chCaption).fixedSize(horizontal: false, vertical: true)
        }
        .sensoryFeedback(.success, trigger: savedFlash)
        .alert("Rename configuration", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Name", text: $newName)
            Button("Save") { if let it = renaming { store.rename(it.id, to: newName) }; renaming = nil }
            Button("Cancel", role: .cancel) { renaming = nil }
        }
        .confirmationDialog("Delete this configuration?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible, presenting: deleting) { it in
            Button("Delete “\(it.name)”", role: .destructive) { store.delete(it.id); session.compareIDs.remove(it.id) }
        } message: { _ in Text("This can't be undone.") }
        .sheet(isPresented: $showCompare) { compareSheet }
    }

    // MARK: Mode and fleet size

    private var modePicker: some View {
        Picker("Simulation mode", selection: Binding(get: { session.input.mode }, set: { session.input.mode = $0 })) {
            Text("Personal ownership").tag(FleetROI.Mode.personal)
            Text("Fleet investment").tag(FleetROI.Mode.fleet)
        }
        .pickerStyle(.segmented)
        .sensoryFeedback(.selection, trigger: session.input.mode)
        .accessibilityIdentifier("roi2Mode")
    }

    private var fleetBuilder: some View {
        ROICard(gold: true) {
            HStack {
                IconLabel(icon: "car.2.fill", text: "Cybercabs")
                Spacer()
                Stepper(value: Binding(get: { session.input.vehicles }, set: { session.input.vehicles = min(1000, max(1, $0)) }), in: 1...1000) {
                    Text(Format.int(Int(session.input.vehicles))).font(.inter(20, .semibold)).monospacedDigit().foregroundStyle(Color.chInk)
                        .contentTransition(.numericText(value: session.input.vehicles))
                }
                .fixedSize()
                .accessibilityLabel("Cybercabs")
                .accessibilityValue("\(Int(session.input.vehicles))")
                .accessibilityIdentifier("roi2Vehicles")
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(FleetROI.fleetPresets, id: \.self) { n in
                        PillToggle(title: "\(n)", selected: Int(session.input.vehicles) == n, compact: true) {
                            withAnimation(.snappy) { session.input.vehicles = Double(n) }
                        }
                        .accessibilityLabel("\(n) Cybercab\(n == 1 ? "" : "s")")
                        .accessibilityIdentifier("roi2Preset-\(n)")
                    }
                }
            }
            .sensoryFeedback(.selection, trigger: session.input.vehicles)
        }
    }

    // MARK: Results

    private func metrics(_ r: FleetROI.Result) -> some View {
        let s = r.steady, n = Int(session.input.vehicles), fin = session.input.purchase == .finance
        let cols = [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)]
        return LazyVGrid(columns: cols, spacing: 8) {
            ROIMetric(label: "Upfront cash", value: r.purchase.upfront, sub: (fin ? "Down payment, tax & fees" : "Price, tax & fees") + " · \(n) vehicle\(n == 1 ? "" : "s")")
            if session.input.mode == .fleet {
                ROIMetric(label: "Gross revenue / mo", value: s.gross, sub: "\(Format.int(Int(r.perVehicle.ridesMonthly.rounded()))) rides per vehicle")
                ROIMetric(label: "Operating expenses / mo", value: s.opex, sub: "Platform share, charging, subscription, insurance, upkeep")
                ROIMetric(label: "Operating profit / mo", value: s.operatingProfit, sub: "Before loan payments", highlight: true)
                ROIMetric(label: "Net cash flow / mo", value: s.netWithLoan, sub: fin ? "After \(ROIFormat.money(s.loan)) loan payments" : "Cash purchase: no loan")
                ROIMetric(label: "Hypothetical break-even", value: nil, text: ROIFormat.payback(r),
                          sub: r.paybackMonth.map { FleetROI.monthName($0) + ((r.loanBalanceAtPayback ?? 0) > 0 ? " · \(ROIFormat.big(r.loanBalanceAtPayback ?? 0)) still owed on loans" : "") } ?? "Cumulative cash never turns positive in 10 years")
            } else {
                ROIMetric(label: "Monthly cost", value: s.opex + s.loan, sub: fin ? "Incl. \(ROIFormat.money(s.loan)) loan payment" : "Subscription, insurance, upkeep, charging", highlight: true)
                ROIMetric(label: "Running cost per mile", value: session.input.personalMilesMonthly > 0 ? s.opex / Double(n) / session.input.personalMilesMonthly : 0, sub: "Excludes the purchase", format: { ROIFormat.money($0, dp: 2) })
                ROIMetric(label: "Cost over \(ROIFormat.years(session.horizon))", value: r.horizon.ownershipCost, sub: "Everything paid, incl. the purchase")
                ROIMetric(label: "Average per month", value: r.horizon.ownershipPerMonth, sub: "Over \(session.horizon) months")
                ROIMetric(label: "Loan interest", value: r.purchase.interestTotal * Double(n), sub: fin ? "\(Int(session.input.loanMonths)) months at \(Format.one(session.input.aprPct))% APR" : "Cash purchase")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("roi2Metrics")
    }

    private struct Point: Identifiable { let m: Int; let cumulative, revenue, expenses: Double; var id: Int { m } }

    private func timeline(_ r: FleetROI.Result) -> some View {
        let h = session.horizon, fleet = session.input.mode == .fleet
        let pts = [Point(m: 0, cumulative: -r.purchase.upfront, revenue: 0, expenses: 0)] + r.months.prefix(h).map { Point(m: $0.m, cumulative: $0.cumulative, revenue: $0.gross, expenses: $0.opex + $0.loan) }
        let pb = fleet ? r.paybackMonth.flatMap { $0 <= h ? $0 : nil } : nil
        let delay = Int(session.input.activationDelayMonths)
        let sel = selectedMonth.flatMap { m in pts.first { $0.m == m } }
        return ROICard {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    IconLabel(icon: "chart.line.uptrend.xyaxis", text: "Profit timeline")
                    Text(fleet ? "Cumulative cash · \(ROIFormat.big(pts.last?.cumulative ?? 0)) after \(ROIFormat.years(h))" : "Cost of owning · \(ROIFormat.big(-(pts.last?.cumulative ?? 0))) after \(ROIFormat.years(h))")
                        .font(.inter(12.5, relativeTo: .footnote)).foregroundStyle(Color.chFog).contentTransition(.numericText())
                }
                Spacer()
            }
            Picker("Timeline length", selection: Binding(get: { h }, set: { session.input.horizonMonths = Double($0) })) {
                Text("1Y").tag(12); Text("3Y").tag(36); Text("5Y").tag(60); Text("10Y").tag(120)
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("roi2Horizon")
            HStack(spacing: 6) {
                seriesToggle("Cumulative", color: .brandGold, on: $session.showCumulative)
                if fleet { seriesToggle("Revenue", color: Color(hex: 0x34D399), on: $session.showRevenue) }
                seriesToggle("Expenses", color: Color(hex: 0xF87171), on: $session.showExpenses)
            }
            if session.showCumulative {
                Chart {
                    RuleMark(y: .value("Zero", 0)).foregroundStyle(Color.chSmoke).lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 4]))
                    ForEach(pts) { p in
                        LineMark(x: .value("Month", p.m), y: .value("Cumulative", p.cumulative))
                            .foregroundStyle(Color.brandGold).lineStyle(StrokeStyle(lineWidth: 2.4))
                    }
                    if fleet, delay > 0, delay < h {
                        RuleMark(x: .value("Commercial start", delay)).foregroundStyle(Color.chFog.opacity(0.6)).lineStyle(StrokeStyle(lineWidth: 1, dash: [2, 4]))
                            .annotation(position: .top, alignment: .leading) { Text("Commercial start").font(.inter(9.5)).foregroundStyle(Color.chFog) }
                    }
                    if let pb {
                        RuleMark(x: .value("Break-even", pb)).foregroundStyle(Color.brandGold.opacity(0.7)).lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 3]))
                        PointMark(x: .value("Break-even", pb), y: .value("Cash", 0)).foregroundStyle(Color.brandGold).symbolSize(70)
                            .annotation(position: .top, alignment: pb > h * 2 / 3 ? .trailing : .leading) {
                                Text("Break-even · \(FleetROI.monthName(pb))").font(.inter(10, .bold)).foregroundStyle(Color.brandGold)
                            }
                    }
                    if let sel {
                        RuleMark(x: .value("Selected", sel.m)).foregroundStyle(Color.chMist.opacity(0.5))
                            .annotation(position: .top, overflowResolution: .init(x: .fit(to: .chart), y: .disabled)) { tip(sel, fleet: fleet) }
                    }
                }
                .chartXScale(domain: 0...h)
                .chartXAxis { AxisMarks(values: .stride(by: h <= 12 ? 3 : h <= 36 ? 6 : 12)) { v in AxisGridLine().foregroundStyle(Color.chLine); AxisValueLabel { if let m = v.as(Int.self) { Text(m == 0 ? "Now" : m % 12 == 0 ? "\(m / 12)y" : "\(m)mo").font(.inter(9.5)) } } } }
                .chartYAxis { AxisMarks(position: .leading) { v in AxisGridLine().foregroundStyle(Color.chLine); AxisValueLabel { if let d = v.as(Double.self) { Text(ROIFormat.compact(d)).font(.inter(9.5)) } } } }
                .chartXSelection(value: $selectedMonth)
                .sensoryFeedback(.selection, trigger: selectedMonth)
                .frame(height: 210)
                .animation(.snappy(duration: 0.4), value: pts.map(\.cumulative))
                .accessibilityLabel("Cumulative cash over \(h) months")
                .accessibilityValue("Starts at \(ROIFormat.money(pts.first?.cumulative ?? 0)), ends at \(ROIFormat.money(pts.last?.cumulative ?? 0)). \(pb.map { "Hypothetical break-even in month \($0)." } ?? (fleet ? "No break-even in this period." : ""))")
                .accessibilityIdentifier("roi2Chart")
            }
            if (session.showRevenue && fleet) || session.showExpenses {
                Text("PER MONTH").font(.inter(10, .semibold)).tracking(0.6).foregroundStyle(Color.chFog).padding(.top, 4)
                Chart {
                    ForEach(pts.dropFirst()) { p in
                        if session.showRevenue && fleet {
                            LineMark(x: .value("Month", p.m), y: .value("Amount", p.revenue), series: .value("Series", "Revenue")).foregroundStyle(Color(hex: 0x34D399))
                        }
                        if session.showExpenses {
                            LineMark(x: .value("Month", p.m), y: .value("Amount", p.expenses), series: .value("Series", "Expenses")).foregroundStyle(Color(hex: 0xF87171))
                        }
                    }
                }
                .chartXScale(domain: 0...h)
                .chartXAxis(.hidden)
                .chartYAxis { AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) { v in AxisGridLine().foregroundStyle(Color.chLine); AxisValueLabel { if let d = v.as(Double.self) { Text(ROIFormat.compact(d)).font(.inter(9.5)) } } } }
                .frame(height: 90)
                .accessibilityLabel(fleet ? "Monthly revenue and expenses" : "Monthly expenses")
                .accessibilityValue(fleet ? "Revenue \(ROIFormat.money(r.steady.gross)) a month once operating; expenses \(ROIFormat.money(r.steady.opex + r.steady.loan))." : "Expenses \(ROIFormat.money(r.steady.opex + r.steady.loan)) a month.")
            }
            Footnote(text: fleet
                     ? "Expenses include loan payments. Nothing earns before the commercial start (\(FleetROI.monthName(delay + 1))), and \(Int(session.input.downtimePct))% downtime applies every operating month. Hypothetical, not a forecast."
                     : "Expenses include loan payments. Personal ownership earns no revenue.")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("roi2Timeline")
    }

    private func tip(_ p: Point, fleet: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(p.m == 0 ? "At delivery" : "Month \(p.m) · \(FleetROI.monthName(p.m))").font(.inter(11, .bold))
            Text("Cumulative \(ROIFormat.money(p.cumulative))").font(.inter(11)).monospacedDigit()
            if p.m > 0 && fleet { Text("Revenue \(ROIFormat.money(p.revenue))").font(.inter(11)).monospacedDigit() }
            if p.m > 0 { Text("Expenses \(ROIFormat.money(p.expenses))").font(.inter(11)).monospacedDigit() }
        }
        .foregroundStyle(Color.chInk)
        .padding(8)
        .background(Color.chSurface2, in: .rect(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.chLine))
    }

    private func seriesToggle(_ title: String, color: Color, on: Binding<Bool>) -> some View {
        Button { on.wrappedValue.toggle() } label: {
            HStack(spacing: 5) {
                RoundedRectangle(cornerRadius: 2).fill(color).frame(width: 9, height: 9)
                Text(title).font(.inter(12, .medium))
            }
            .padding(.horizontal, 10).frame(minHeight: 32)
            .foregroundStyle(Color.chMist)
            .overlay(Capsule().strokeBorder(Color.chHair2))
            .opacity(on.wrappedValue ? 1 : 0.45)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Show \(title.lowercased())")
        .accessibilityAddTraits(on.wrappedValue ? .isSelected : [])
    }

    // MARK: Breakdown

    private func breakdown(_ r: FleetROI.Result) -> some View {
        let x = session.input.sanitized, p = r.purchase, n = x.vehicles, multi = n > 1, fleet = x.mode == .fleet
        return ROICard {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    CardHeading(dotLabel: "Purchase & ownership", title: nil)
                    Text(multi ? "Per vehicle and for \(Int(n)) vehicles" : "Per vehicle, from your inputs").font(.inter(12, relativeTo: .footnote)).foregroundStyle(Color.chFog)
                }
                Spacer()
            }
            VStack(spacing: 0) {
                line("Vehicle price", .reported, p.price, n, note: "Before taxes")
                line("Order deposit", .reported, p.deposit, n, note: "Part of the price")
                line("Sales tax", .estimate, p.tax, n, note: "\(Format.one(x.salesTaxPct))% of the price")
                line("Title, registration & fees", .assumption, p.fees, n)
                if x.purchase == .finance {
                    line("Financed", .assumption, p.principal, n, note: "\(Int(x.loanMonths)) months at \(Format.one(x.aprPct))% APR")
                    line("Loan payment / mo", .assumption, p.payment, n, note: "\(ROIFormat.money(p.interestTotal)) interest in all", dp: 2)
                }
                line("Upfront cash", nil, p.upfrontPerVehicle, n, total: true)
                line("Autonomy Subscription / mo", .reported, x.subscriptionMonthly, n, note: "First month included")
                line("Insurance / mo", .assumption, x.insuranceMonthly, n)
                line("Maintenance subscription / mo", .assumption, x.maintenanceMonthly, n, note: "Required; price not shown by Tesla")
                line("Charging / mo", .assumption, r.perVehicle.chargingMonthly, n)
                if fleet {
                    line("Platform share / mo", .assumption, r.perVehicle.platformFeeMonthly, n, note: "\(Int(x.platformSharePct))% of fares")
                    line("Gross revenue / mo", .assumption, r.steady.gross / n, n, note: "Hypothetical")
                    line("Net operating cash / mo", nil, r.steady.netWithLoan / n, n, total: true)
                }
                line("Cost of ownership, \(ROIFormat.years(session.horizon))", nil, r.horizon.ownershipCost / n, n, total: true)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("roi2Breakdown")
    }

    private func line(_ label: String, _ kind: FleetROI.Kind?, _ per: Double, _ n: Double, note: String? = nil, total: Bool = false, dp: Int = 0) -> some View {
        HStack(alignment: .center, spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                Text(label).font(.inter(13, total ? .semibold : .regular)).foregroundStyle(total ? Color.chInk : Color.chMist)
                if let note { Text(note).font(.inter(10.5, relativeTo: .caption2)).foregroundStyle(Color.chCaption) }
            }
            Spacer(minLength: 6)
            if let kind { KindBadge(kind: kind) }
            VStack(alignment: .trailing, spacing: 1) {
                Text(ROIFormat.money(per, dp: dp)).font(.inter(total ? 15 : 13.5, .semibold)).monospacedDigit().foregroundStyle(total ? Color.brandGold : Color.chInk)
                    .contentTransition(.numericText(value: per))
                if n > 1 { Text(ROIFormat.big(per * n)).font(.inter(10.5)).monospacedDigit().foregroundStyle(Color.chFog) }
            }
        }
        .padding(.vertical, 8)
        .overlay(alignment: .top) { Rectangle().fill(total ? Color.brandGold.opacity(0.35) : Color.chLine).frame(height: 1) }
        .accessibilityElement(children: .combine)
    }

    // MARK: Inputs

    private struct Row { let key: String; let label: String; let range: ClosedRange<Double>; let step: Double; let unit: String; var money = false; var dp = 0; var hint: String? = nil }

    private var inputs: some View {
        let x = session.input
        let fleet = x.mode == .fleet
        return ROICard(gold: true) {
            IconLabel(icon: "slider.horizontal.3", text: "Assumptions")
            group("Purchase", rows: [
                Row(key: "price", label: "Price per Cybercab", range: 15_000...60_000, step: 10, unit: "", money: true, hint: "Reported price, before taxes"),
                Row(key: "deposit", label: "Order deposit", range: 0...5000, step: 50, unit: "", money: true, hint: "Nonrefundable; part of the price, not extra"),
                Row(key: "salesTaxPct", label: "Sales tax", range: 0...12, step: 0.05, unit: "%", dp: 2, hint: "Texas motor vehicle sales tax is 6.25%"),
                Row(key: "feesPerVehicle", label: "Title, registration & fees", range: 0...2000, step: 10, unit: "", money: true),
            ]) {
                Picker("Pay", selection: Binding(get: { session.input.purchase }, set: { session.input.purchase = $0 })) {
                    Text("Cash").tag(FleetROI.Purchase.cash); Text("Finance").tag(FleetROI.Purchase.finance)
                }
                .pickerStyle(.segmented).padding(.top, 4)
                .accessibilityIdentifier("roi2Purchase-pay")
                if x.purchase == .finance {
                    slider(Row(key: "downPaymentPct", label: "Down payment", range: 0...100, step: 1, unit: "%"))
                    slider(Row(key: "aprPct", label: "Interest rate (APR)", range: 0...15, step: 0.1, unit: "%", dp: 1))
                    slider(Row(key: "loanMonths", label: "Loan term", range: 12...96, step: 12, unit: "mo"))
                }
            }
            group("Ownership costs (per vehicle, monthly)", rows: [
                Row(key: "subscriptionMonthly", label: "Autonomy Subscription", range: 0...600, step: 1, unit: "", money: true, hint: "Required; first month included"),
                Row(key: "insuranceMonthly", label: "Insurance", range: 0...1500, step: 5, unit: "", money: true, hint: "Commercial cover would likely cost more"),
                Row(key: "maintenanceMonthly", label: "Maintenance subscription", range: 0...400, step: 5, unit: "", money: true, hint: "Required; Tesla hasn't shown the price"),
                Row(key: "electricityRate", label: "Electricity", range: 0...0.5, step: 0.01, unit: "/kWh", money: true, dp: 2),
            ] + (fleet ? [] : [Row(key: "personalMilesMonthly", label: "Miles per month", range: 0...4000, step: 50, unit: "mi")])) { EmptyView() }
            if fleet {
                group("Commercial operation (hypothetical)", rows: [
                    Row(key: "activationDelayMonths", label: "Commercial start", range: 0...36, step: 1, unit: "mo", hint: "Hypothetical start: \(FleetROI.monthName(Int(x.activationDelayMonths) + 1)) (delivery estimate: December 2026)"),
                    Row(key: "farePerRide", label: "Average fare per ride", range: 0...40, step: 0.5, unit: "", money: true, dp: 2),
                    Row(key: "ridesPerDay", label: "Rides per vehicle per day", range: 0...40, step: 1, unit: ""),
                    Row(key: "operatingDays", label: "Operating days per month", range: 0...31, step: 1, unit: ""),
                    Row(key: "downtimePct", label: "Downtime", range: 0...100, step: 1, unit: "%", hint: "Charging, cleaning, repairs, no demand"),
                    Row(key: "platformSharePct", label: "Platform revenue share", range: 0...60, step: 1, unit: "%", hint: "Tesla has published no split; estimates run 25–30%"),
                    Row(key: "cleaningMonthly", label: "Cleaning", range: 0...800, step: 5, unit: "", money: true),
                ]) { EmptyView() }
            }
            HStack(spacing: 10) {
                Button { withAnimation(.snappy) { session.reset() } } label: {
                    Text("Reset").font(.inter(14, .semibold)).frame(maxWidth: .infinity, minHeight: 44)
                        .foregroundStyle(Color.chMist).overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.chHair2))
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("roi2Reset")
                Button {
                    let n = Int(session.input.vehicles)
                    store.save(name: "\(n) Cybercab\(n == 1 ? "" : "s") · \(session.input.mode == .fleet ? "fleet" : "personal") · \(session.input.purchase == .finance ? "financed" : "cash")", input: session.input)
                    savedFlash += 1
                } label: {
                    Label("Save", systemImage: "square.and.arrow.down").font(.inter(14, .semibold)).frame(maxWidth: .infinity, minHeight: 44)
                        .background(Color.brandGold, in: .rect(cornerRadius: 12)).foregroundStyle(Color(hex: 0x1A1204))
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("roi2Save")
            }
            .padding(.top, 8)
        }
    }

    private func group<Extra: View>(_ title: String, rows: [Row], @ViewBuilder extra: () -> Extra) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title.uppercased()).font(.inter(10.5, .semibold, relativeTo: .caption)).tracking(1.2).foregroundStyle(Color.chFog).padding(.top, 12)
            ForEach(rows, id: \.key) { slider($0) }
            extra()
        }
        .overlay(alignment: .top) { Rectangle().fill(Color.chLine).frame(height: 1) }
    }

    private func slider(_ row: Row) -> some View {
        let kind = FleetROI.fields[row.key]?.kind
        return VStack(alignment: .leading, spacing: 3) {
            if let kind { KindBadge(kind: kind) }
            SliderRow(label: row.label,
                      value: Binding(get: { session.input[row.key] }, set: { var x = session.input; x[row.key] = $0; session.input = x.sanitized }),
                      range: row.range, step: row.step,
                      format: { v in row.money ? "$" + v.formatted(.number.precision(.fractionLength(row.dp)).grouping(.never)) : v.formatted(.number.precision(.fractionLength(row.dp)).grouping(.never)) },
                      unit: row.unit, id: "roi2-\(row.key)")
            if let hint = row.hint { Text(hint).font(.inter(11, relativeTo: .caption)).foregroundStyle(Color.chCaption).fixedSize(horizontal: false, vertical: true) }
        }
    }

    // MARK: Scenarios

    private var scenarios: some View {
        let runs = FleetROI.Scenario.allCases.map { ($0, FleetROI.simulate(session.scenarioInput($0))) }
        return ROICard {
            Text("Three editable sets of operating assumptions, each run with your fleet, purchase and ownership costs. Hypotheticals, not forecasts or promised returns.")
                .font(.inter(12.5, relativeTo: .footnote)).foregroundStyle(Color.chFog).fixedSize(horizontal: false, vertical: true)
            Grid(alignment: .trailing, horizontalSpacing: 10, verticalSpacing: 8) {
                GridRow {
                    Text("").gridColumnAlignment(.leading)
                    ForEach(runs, id: \.0) { s, _ in Text(s.label.uppercased()).font(.inter(10, .semibold)).tracking(0.5).lineLimit(1).minimumScaleFactor(0.5).foregroundStyle(s == session.editingScenario ? Color.brandGold : Color.chFog) }
                }
                Divider().overlay(Color.chLine)
                cmp("Fare", runs) { ROIFormat.money($0.input.farePerRide, dp: 2) }
                cmp("Rides / day", runs) { Format.int(Int($0.input.ridesPerDay)) }
                cmp("Downtime", runs) { "\(Int($0.input.downtimePct))%" }
                cmp("Platform share", runs) { "\(Int($0.input.platformSharePct))%" }
                cmp("Start", runs) { "+\(Int($0.input.activationDelayMonths)) mo" }
                Divider().overlay(Color.brandGold.opacity(0.35))
                cmp("Revenue / mo", runs) { ROIFormat.big($0.steady.gross) }
                cmp("Expenses / mo", runs) { ROIFormat.big($0.steady.opex) }
                cmp("Profit / mo", runs, gold: true) { ROIFormat.big($0.steady.operatingProfit) }
                cmp("Net / mo", runs) { ROIFormat.big($0.steady.netWithLoan) }
                cmp("Break-even", runs, gold: true) { ROIFormat.payback($0, short: true) }
                cmp("After \(ROIFormat.years(session.horizon))", runs) { ROIFormat.big($0.horizon.cumulative) }
            }
            .font(.inter(12.5)).monospacedDigit()
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("roi2Scenarios")

            Picker("Edit scenario", selection: $session.editingScenario) {
                ForEach(FleetROI.Scenario.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented).padding(.top, 6)
            let s = session.editingScenario
            ForEach(Self.scenarioRows, id: \.key) { row in
                SliderRow(label: row.label,
                          value: Binding(get: { session.scenarioInput(s)[row.key] }, set: { session.scenarioEdits[s, default: [:]][row.key] = $0 }),
                          range: row.range, step: row.step,
                          format: { v in (row.money ? "$" : "") + v.formatted(.number.precision(.fractionLength(row.dp)).grouping(.never)) },
                          unit: row.unit, id: "roi2Scen-\(s.rawValue)-\(row.key)")
            }
            HStack(spacing: 10) {
                Button("Reset scenarios") { session.scenarioEdits = [:] }.font(.inter(13, .semibold)).foregroundStyle(Color.chMist)
                Spacer()
                Button("Use \(s.label) in simulator") {
                    withAnimation(.snappy) { session.input = session.scenarioInput(s).sanitized }
                    Haptics.tap()
                }
                .font(.inter(13, .semibold)).foregroundStyle(Color.brandGold)
                .accessibilityIdentifier("roi2UseScenario")
            }
            .padding(.top, 4)
        }
    }

    private static let scenarioRows: [Row] = [
        Row(key: "farePerRide", label: "Fare per ride", range: 0...40, step: 0.5, unit: "", money: true, dp: 2),
        Row(key: "ridesPerDay", label: "Rides per vehicle per day", range: 0...40, step: 1, unit: ""),
        Row(key: "downtimePct", label: "Downtime", range: 0...100, step: 1, unit: "%"),
        Row(key: "platformSharePct", label: "Platform share", range: 0...60, step: 1, unit: "%"),
        Row(key: "activationDelayMonths", label: "Commercial start", range: 0...36, step: 1, unit: "mo"),
        Row(key: "insuranceMonthly", label: "Insurance / mo", range: 0...1500, step: 5, unit: "", money: true),
        Row(key: "cleaningMonthly", label: "Cleaning / mo", range: 0...800, step: 5, unit: "", money: true),
    ]

    private func cmp(_ label: String, _ runs: [(FleetROI.Scenario, FleetROI.Result)], gold: Bool = false, _ f: @escaping (FleetROI.Result) -> String) -> some View {
        GridRow {
            Text(label).foregroundStyle(Color.chMist).gridColumnAlignment(.leading).lineLimit(1).minimumScaleFactor(0.8)
            ForEach(runs, id: \.0) { _, r in Text(f(r)).foregroundStyle(gold ? Color.brandGold : Color.chInk).lineLimit(1).minimumScaleFactor(0.7) }
        }
    }

    // MARK: Saved

    private var saved: some View {
        ROICard {
            if store.items.isEmpty {
                Text("Nothing saved yet. Set up a configuration and tap Save. Saved configurations stay on this iPhone; nothing is uploaded.")
                    .font(.inter(13, relativeTo: .callout)).foregroundStyle(Color.chFog).fixedSize(horizontal: false, vertical: true)
            }
            ForEach(store.items) { it in
                HStack(spacing: 10) {
                    Button {
                        if session.compareIDs.contains(it.id) { session.compareIDs.remove(it.id) } else if session.compareIDs.count < 3 { session.compareIDs.insert(it.id) }
                    } label: {
                        Image(systemName: session.compareIDs.contains(it.id) ? "checkmark.circle.fill" : "circle")
                            .font(.system(size: 20)).foregroundStyle(session.compareIDs.contains(it.id) ? Color.brandGold : Color.chFog)
                            .frame(minWidth: 44, minHeight: 44)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Compare \(it.name)")
                    .accessibilityAddTraits(session.compareIDs.contains(it.id) ? .isSelected : [])
                    VStack(alignment: .leading, spacing: 2) {
                        Text(it.name).font(.inter(14, .semibold)).foregroundStyle(Color.chInk).lineLimit(1)
                        Text(summary(it)).font(.inter(11.5, relativeTo: .caption)).foregroundStyle(Color.chCaption).lineLimit(2)
                    }
                    Spacer(minLength: 4)
                    Menu {
                        Button { withAnimation(.snappy) { session.input = it.input } ; Haptics.tap() } label: { Label("Load", systemImage: "arrow.down.doc") }
                        Button { newName = it.name; renaming = it } label: { Label("Rename", systemImage: "pencil") }
                        Button { store.duplicate(it.id) } label: { Label("Duplicate", systemImage: "plus.square.on.square") }
                        Button(role: .destructive) { deleting = it } label: { Label("Delete", systemImage: "trash") }
                    } label: {
                        Image(systemName: "ellipsis.circle").font(.system(size: 20)).foregroundStyle(Color.chMist).frame(minWidth: 44, minHeight: 44)
                    }
                    .accessibilityLabel("Actions for \(it.name)")
                    .accessibilityIdentifier("roi2SavedMenu")
                }
                .overlay(alignment: .top) { Rectangle().fill(Color.chLine).frame(height: 1) }
                .accessibilityElement(children: .contain)   // keeps the menu's own identifier
                .accessibilityIdentifier("roi2SavedRow")
            }
            if store.items.count >= 2 {
                Button { showCompare = true } label: {
                    Text(session.compareIDs.count >= 2 ? "Compare \(session.compareIDs.count) selected" : "Select 2–3 to compare")
                        .font(.inter(14, .semibold)).frame(maxWidth: .infinity, minHeight: 44)
                        .foregroundStyle(session.compareIDs.count >= 2 ? Color(hex: 0x1A1204) : Color.chFog)
                        .background(session.compareIDs.count >= 2 ? Color.brandGold : Color.clear, in: .rect(cornerRadius: 12))
                        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.chHair2))
                }
                .buttonStyle(.plain)
                .disabled(session.compareIDs.count < 2)
                .accessibilityIdentifier("roi2Compare")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("roi2Saved")
    }

    private func summary(_ it: FleetROIStore.Item) -> String {
        let i = it.input, n = Int(i.vehicles)
        var s = "\(i.mode == .fleet ? "Fleet" : "Personal") · \(n) vehicle\(n == 1 ? "" : "s") · \(i.purchase == .finance ? "financed \(Format.one(i.aprPct))%" : "cash")"
        if i.mode == .fleet { s += " · \(ROIFormat.money(i.farePerRide, dp: 0))/ride, \(Int(i.ridesPerDay))/day" }
        let d = FleetROIStore.savedLabel(it.savedAt)
        return d.isEmpty ? s : s + " · saved \(d)"
    }

    private var compareSheet: some View {
        let items = store.items.filter { session.compareIDs.contains($0.id) }
        let runs = items.map { ($0, FleetROI.simulate($0.input)) }
        return NavigationStack {
            ScrollView {
                Grid(alignment: .trailing, horizontalSpacing: 12, verticalSpacing: 10) {
                    GridRow {
                        Text("").gridColumnAlignment(.leading)
                        ForEach(runs, id: \.0.id) { it, _ in Text(it.name).font(.inter(12, .semibold)).foregroundStyle(Color.brandGold).lineLimit(2).multilineTextAlignment(.trailing) }
                    }
                    Divider().overlay(Color.chLine)
                    crow("Mode", runs) { $0.input.mode == .fleet ? "Fleet" : "Personal" }
                    crow("Vehicles", runs) { Format.int(Int($0.input.vehicles)) }
                    crow("Purchase", runs) { $0.input.purchase == .finance ? "\(Int($0.input.downPaymentPct))% down, \(Format.one($0.input.aprPct))%" : "Cash" }
                    crow("Upfront cash", runs) { ROIFormat.big($0.purchase.upfront) }
                    crow("Revenue / mo", runs) { $0.input.mode == .fleet ? ROIFormat.big($0.steady.gross) : "—" }
                    crow("Expenses / mo", runs) { ROIFormat.big($0.steady.opex) }
                    crow("Profit / mo", runs) { $0.input.mode == .fleet ? ROIFormat.big($0.steady.operatingProfit) : "—" }
                    crow("Net / mo", runs) { ROIFormat.big($0.steady.netWithLoan) }
                    crow("Break-even", runs) { ROIFormat.payback($0, short: true) }
                    crow("Cumulative", runs) { ROIFormat.big($0.horizon.cumulative) }
                }
                .font(.inter(13)).monospacedDigit()
                .padding(16)
                Text("Each configuration over its own saved horizon. Hypothetical.").font(.inter(11.5)).foregroundStyle(Color.chCaption).padding(.horizontal, 16)
            }
            .appBackground()
            .navigationTitle("Compare")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showCompare = false } } }
        }
        .presentationDetents([.medium, .large])
        .accessibilityIdentifier("roi2CompareSheet")
    }

    private func crow(_ label: String, _ runs: [(FleetROIStore.Item, FleetROI.Result)], _ f: @escaping (FleetROI.Result) -> String) -> some View {
        GridRow {
            Text(label).foregroundStyle(Color.chMist).gridColumnAlignment(.leading)
            ForEach(runs, id: \.0.id) { _, r in Text(f(r)).foregroundStyle(Color.chInk) }
        }
    }
}
