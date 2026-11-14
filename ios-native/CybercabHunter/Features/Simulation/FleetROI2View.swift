import SwiftUI
import Charts

/// Fleet ROI in the app (the website's Fleet ROI tab, same model: FleetROI in
/// FleetROIModel.swift = public/js/fleet-roi.js). Native controls, Swift
/// Charts, saved configurations on the device. The five fixed values are
/// shown locked; every other input says what kind of figure it is (Estimate /
/// Assumption), and commercial operation is always labelled hypothetical.

/// The simulator's state, kept on SimulationModel so switching to Fleet ETA
/// and back doesn't lose it.
@MainActor
@Observable
final class FleetROISession {
    var input = FleetROI.Input()
    enum Tab: String, CaseIterable, Identifiable { case overview, settings, timeline; var id: String { rawValue }
        var title: String { switch self { case .overview: "Overview"; case .settings: "Settings"; case .timeline: "Timeline" } }
    }
    var tab: Tab = .overview
    /// Settings groups that are open (Fleet & Financing and Revenue & Operations by default).
    var openGroups: Set<String> = ["fin", "ops"]
    var showCumulative = true
    var showRevenue = true
    var showExpenses = true
    var compareIDs: Set<String> = []

    var result: FleetROI.Result { FleetROI.simulate(input) }
    var horizon: Int { Int(input.sanitized.horizonMonths) }
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

/// Estimate / Assumption (fixed values are LockedRow, not a badge).
struct KindBadge: View {
    let kind: FleetROI.Kind
    var body: some View {
        Text(kind.label.uppercased())
            .font(.inter(9, .semibold, relativeTo: .caption2)).tracking(0.6)
            .padding(.horizontal, 7).padding(.vertical, 3)
            .foregroundStyle(kind == .estimate ? Color.chMist : Color.chFog)
            .overlay(Capsule().strokeBorder(Color.chHair2, style: StrokeStyle(lineWidth: 1, dash: kind == .assumption ? [3, 2] : [])))
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

/// A fixed value: shown, never edited (a lock and a quiet capsule, not a
/// disabled control).
struct LockedRow: View {
    let label: String
    let value: String
    var hint: String? = nil
    let id: String
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .center) {
                Text(label).font(.inter(14, .medium)).foregroundStyle(Color.chMist)
                Spacer(minLength: 8)
                HStack(spacing: 6) {
                    Image(systemName: "lock.fill").font(.system(size: 10, weight: .semibold)).foregroundStyle(Color.brandGold)
                    Text(value).font(.inter(15, .semibold)).monospacedDigit().foregroundStyle(Color.chInk)
                }
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(Color.white.opacity(0.03), in: .capsule)
                .overlay(Capsule().strokeBorder(Color.chLine))
            }
            if let hint { Text(hint).font(.inter(11, relativeTo: .caption)).foregroundStyle(Color.chCaption).fixedSize(horizontal: false, vertical: true) }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityValue("\(value), fixed")
        .accessibilityIdentifier(id)
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
        Section {
            VStack(alignment: .leading, spacing: 14) {
                switch session.tab {
                case .overview: overview(r)
                case .settings: inputs
                case .timeline: timelineTab(r)
                }
            }
            .padding(.top, 2)
            .sensoryFeedback(.success, trigger: savedFlash)
            .alert("Rename configuration", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
                TextField("Name", text: $newName)
                Button("Save") { if let it = renaming { store.rename(it.id, to: newName) }; renaming = nil }
                Button("Cancel", role: .cancel) { renaming = nil }
            }
            .confirmationDialog("Delete this configuration?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible, presenting: deleting) { it in
                Button("Delete \u{201C}\(it.name)\u{201D}", role: .destructive) { store.delete(it.id); session.compareIDs.remove(it.id) }
            } message: { _ in Text("This can't be undone.") }
            .sheet(isPresented: $showCompare) { compareSheet }
        } header: {
            SegmentBar(label: "Fleet ROI section", tabs: FleetROISession.Tab.allCases, title: { $0.title }, selection: $session.tab, id: "roi2Segments") {
                // Editing settings: the two key figures stay in view.
                if session.tab == .settings { keyFigures(r) }
            }
        }
    }

    /// "Operating profit $3,044/mo · Break-even 15 mo" (or the personal-mode cost).
    private func keyFigures(_ r: FleetROI.Result) -> some View {
        let fleet = session.input.mode == .fleet
        return HStack {
            VStack(alignment: .leading, spacing: 1) {
                Text(fleet ? "Operating profit / mo" : "Monthly cost").font(.inter(11, relativeTo: .caption)).foregroundStyle(Color.chFog)
                Text(ROIFormat.big(fleet ? r.steady.operatingProfit : r.steady.opex + r.steady.loan)).font(.inter(16, .semibold)).monospacedDigit().foregroundStyle(Color.brandGold)
                    .contentTransition(.numericText())
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 1) {
                Text(fleet ? "Hypothetical break-even" : "Cost over \(ROIFormat.years(session.horizon))").font(.inter(11, relativeTo: .caption)).foregroundStyle(Color.chFog)
                Text(fleet ? ROIFormat.payback(r, short: true) : ROIFormat.big(r.horizon.ownershipCost)).font(.inter(16, .semibold)).monospacedDigit().foregroundStyle(Color.brandGold)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("roi2KeyFigures")
    }

    // MARK: Segments

    @ViewBuilder private func overview(_ r: FleetROI.Result) -> some View {
        let fleet = session.input.mode == .fleet
        modePicker
        Text(fleet
             ? "Hypothetical: Tesla hasn't published terms for owners to run a Cybercab on its network, and local rules apply. The 25% Tesla Revenue Share is a fixed modeling assumption, not a confirmed agreement."
             : "Personal ownership: what owning and driving a Cybercab costs. No revenue: owning one doesn't mean you may run it as a commercial Robotaxi.")
            .font(.inter(12, relativeTo: .footnote)).foregroundStyle(Color.chFog).fixedSize(horizontal: false, vertical: true)
            .padding(.leading, 10)
            .overlay(alignment: .leading) { Rectangle().fill(Color.brandGold).frame(width: 2) }
            .accessibilityIdentifier("roi2ModeNote")
        fleetBuilder
        metrics(r)
        HStack(spacing: 10) {
            jump("Adjust settings", icon: "slider.horizontal.3", to: .settings, id: "roi2GoSettings")
            jump("See the timeline", icon: "chart.line.uptrend.xyaxis", to: .timeline, id: "roi2GoTimeline")
        }
    }

    @ViewBuilder private func timelineTab(_ r: FleetROI.Result) -> some View {
        timeline(r)
        SimSectionHead(eyebrow: "On this device only", title: "Saved configurations").padding(.top, 4)
        saved
        Text("Not affiliated with Tesla, Inc. A simulation for planning and curiosity, not financial advice, a quote or a promise of returns. Personal ownership does not mean permission to operate a commercial Robotaxi: that depends on Tesla's fleet terms, local regulation, commercial insurance and approval.")
            .font(.inter(11.5, relativeTo: .footnote)).foregroundStyle(Color.chCaption).fixedSize(horizontal: false, vertical: true)
    }

    private func jump(_ title: String, icon: String, to tab: FleetROISession.Tab, id: String) -> some View {
        Button { session.tab = tab } label: {
            Label(title, systemImage: icon).font(.inter(13, .semibold)).frame(maxWidth: .infinity, minHeight: 44)
                .foregroundStyle(Color.chMist).overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.chHair2))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(id)
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
                ROIMetric(label: "Gross revenue / mo", value: s.gross, sub: "Hypothetical · \(Format.int(Int(r.perVehicle.ridesMonthly.rounded()))) rides per vehicle")
                ROIMetric(label: "Operating expenses / mo", value: s.opex, sub: "Tesla share, charging, subscription, insurance, upkeep")
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
                     ? "Expenses include loan payments and the 25% Tesla share. Nothing earns before the commercial start (\(FleetROI.monthName(delay + 1))), and \(Int(session.input.downtimePct))% downtime applies every operating month. Hypothetical, not a forecast: Tesla's actual commercial terms are unconfirmed."
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

    // MARK: Inputs

    private struct Row { let key: String; let label: String; let range: ClosedRange<Double>; let step: Double; let unit: String; var money = false; var dp = 0; var hint: String? = nil }

    private var inputs: some View {
        let x = session.input
        let fleet = x.mode == .fleet
        return VStack(alignment: .leading, spacing: 10) {
            group("fin", "Fleet & Financing", summary: "\(x.purchase == .finance ? "Financed \(Int(x.downPaymentPct))% down · \(Format.one(x.aprPct))%" : "Cash") · tax \(Format.one(x.salesTaxPct))%", rows: []) {
                Picker("Pay", selection: Binding(get: { session.input.purchase }, set: { session.input.purchase = $0 })) {
                    Text("Cash").tag(FleetROI.Purchase.cash); Text("Finance").tag(FleetROI.Purchase.finance)
                }
                .pickerStyle(.segmented).padding(.top, 2)
                .accessibilityIdentifier("roi2Purchase-pay")
                if x.purchase == .finance {
                    slider(Row(key: "downPaymentPct", label: "Down payment", range: 0...100, step: 1, unit: "%"))
                    slider(Row(key: "aprPct", label: "Interest rate (APR)", range: 0...15, step: 0.1, unit: "%", dp: 1))
                    slider(Row(key: "loanMonths", label: "Loan term", range: 12...96, step: 12, unit: "mo"))
                }
                slider(Row(key: "salesTaxPct", label: "Sales tax", range: 0...12, step: 0.05, unit: "%", dp: 2, hint: "Texas motor vehicle sales tax is 6.25%"))
                slider(Row(key: "feesPerVehicle", label: "Registration & fees", range: 0...2000, step: 10, unit: "", money: true))
            }
            if fleet {
                group("ops", "Revenue & Operations", summary: "\(ROIFormat.money(x.farePerRide, dp: 0)) × \(Int(x.ridesPerDay)) rides/day · \(Int(x.downtimePct))% down · start +\(Int(x.activationDelayMonths)) mo", rows: [
                    Row(key: "ridesPerDay", label: "Rides per day", range: 0...40, step: 1, unit: ""),
                    Row(key: "farePerRide", label: "Average fare", range: 0...40, step: 0.5, unit: "", money: true, dp: 2),
                    Row(key: "operatingDays", label: "Operating days / month", range: 0...31, step: 1, unit: ""),
                    Row(key: "downtimePct", label: "Downtime", range: 0...100, step: 1, unit: "%", hint: "Charging, cleaning, repairs, no demand"),
                    Row(key: "activationDelayMonths", label: "Commercial start", range: 0...36, step: 1, unit: "mo", hint: "Hypothetical start: \(FleetROI.monthName(Int(x.activationDelayMonths) + 1)) (delivery estimate: December 2026)"),
                    Row(key: "milesPerRide", label: "Miles per ride", range: 0.5...20, step: 0.5, unit: "mi", dp: 1),
                    Row(key: "deadheadPct", label: "Empty miles between rides", range: 0...100, step: 5, unit: "%"),
                ]) { EmptyView() }
            }
            group("exp", "Monthly Expenses", summary: "Insurance \(ROIFormat.money(x.insuranceMonthly)) · maintenance \(ROIFormat.money(x.maintenanceMonthly)) · \(String(format: "$%.2f", x.electricityRate))/kWh", rows: [
                Row(key: "insuranceMonthly", label: "Insurance", range: 0...1500, step: 5, unit: "", money: true, hint: "Commercial cover would likely cost more"),
                Row(key: "maintenanceMonthly", label: "Maintenance subscription", range: 0...400, step: 5, unit: "", money: true, hint: "Required; Tesla hasn't shown the price"),
                Row(key: "electricityRate", label: "Electricity", range: 0...0.5, step: 0.01, unit: "/kWh", money: true, dp: 2),
                Row(key: "kwhPerMile", label: "Efficiency", range: 0.1...0.5, step: 0.01, unit: "kWh/mi", dp: 2),
            ] + (fleet ? [Row(key: "cleaningMonthly", label: "Cleaning", range: 0...800, step: 5, unit: "", money: true)]
                       : [Row(key: "personalMilesMonthly", label: "Miles per month", range: 0...4000, step: 50, unit: "mi")])) { EmptyView() }
            group("fixed", "Fixed Tesla values", summary: "$29,990 · $1,000 deposit · $300/mo · 1 month free\(fleet ? " · 25% Tesla share" : "")", locked: true, rows: []) {
                LockedRow(label: "Price per Cybercab", value: "$29,990", hint: "Before taxes", id: "roi2-price")
                LockedRow(label: "Order deposit", value: "$1,000", hint: "Per Cybercab; included in the $29,990, not extra", id: "roi2-deposit")
                LockedRow(label: "Autonomy Subscription", value: "$300/mo", hint: "Per Cybercab; a fixed calculator assumption", id: "roi2-subscriptionMonthly")
                LockedRow(label: "Free Autonomy", value: "1 month", hint: "The first month after delivery is free", id: "roi2-subscriptionIncludedMonths")
                if fleet {
                    LockedRow(label: "Tesla Revenue Share", value: "25%", hint: "Of fares. A fixed modeling assumption: Tesla hasn't published revenue-sharing terms", id: "roi2-platformSharePct")
                }
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
            .padding(.top, 6)
        }
    }

    /// A collapsible settings group: its title, and when closed a one-line
    /// summary of what it holds (nothing hidden blind).
    private func group<Extra: View>(_ id: String, _ title: String, summary: String, locked: Bool = false, rows: [Row], @ViewBuilder extra: () -> Extra) -> some View {
        let open = Binding(get: { session.openGroups.contains(id) }, set: { if $0 { session.openGroups.insert(id) } else { session.openGroups.remove(id) } })
        let extraContent = extra()
        return DisclosureGroup(isExpanded: open) {
            VStack(alignment: .leading, spacing: 10) {
                extraContent
                ForEach(rows, id: \.key) { slider($0) }
            }
            .padding(.top, 8)
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    if locked { Image(systemName: "lock.fill").font(.system(size: 10, weight: .semibold)).foregroundStyle(Color.brandGold) }
                    Text(title.uppercased()).font(.inter(11.5, .semibold, relativeTo: .caption)).tracking(1.1).foregroundStyle(Color.chMist)
                }
                if !open.wrappedValue {
                    Text(summary).font(.inter(11.5, relativeTo: .caption)).foregroundStyle(Color.chCaption).lineLimit(1)
                }
            }
            .frame(minHeight: 36, alignment: .leading)
        }
        .tint(.brandGold)
        .padding(.horizontal, 14).padding(.vertical, 8)
        .background(locked ? Color.brandGold.opacity(0.05) : Color.chSurface, in: .rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(locked ? Color.brandGold.opacity(0.3) : Color.chLine))
        // A container keeps its own identifier without overriding its rows'.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("roi2Group-\(id)")
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
