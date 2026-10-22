import SwiftUI
import Charts

/// Simulation (the website's /simulation): Fleet ROI and Fleet ETA, reached
/// from Home's Explore button. Every figure is an estimate or a simulation,
/// labelled as such; nothing is a live Tesla price or fleet availability.
struct SimulationView: View {
    @Environment(SessionStore.self) private var session
    @State private var model = SimulationModel()
    var initialView: SimulationModel.View = .roi

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(spacing: 8) {
                    PillToggle(title: "FLEET ROI", selected: model.view == .roi) { model.view = .roi }
                        .accessibilityIdentifier("simTab-roi")
                    PillToggle(title: "FLEET ETA", selected: model.view == .eta) { model.view = .eta }
                        .accessibilityIdentifier("simTab-eta")
                }
                switch model.view {
                case .roi: FleetROIView(model: model)
                case .eta: FleetEtaView(model: model)
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 32)
        }
        .appBackground()
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { model.view = initialView }
        .task { await model.loadRegistry(api: session.api) }
        .refreshable {
            if model.view == .eta { await model.loadEta(model.city, api: session.api, force: true) } else { await model.loadRegistry(api: session.api) }
        }
    }
}

// MARK: - Fleet ROI

struct FleetROIView: View {
    @Bindable var model: SimulationModel
    @State private var pdfURL: URL?

    var body: some View {
        let r = model.financials
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Eyebrow(text: "Investor tools")
                Text("FLEET ROI").displayTitle(30).accessibilityIdentifier("roiTitle")
                Text("Model monthly economics for a prospective Cybercab fleet: energy overhead, gross revenue, net operating income, and breakeven timeline.")
                    .font(.inter(14)).foregroundStyle(Color.chMist).fixedSize(horizontal: false, vertical: true)
            }

            VStack(alignment: .leading, spacing: 14) {
                Text("INPUTS").font(.inter(11, .bold)).tracking(1).foregroundStyle(Color.brandGold)
                Text(model.startNote).font(.inter(12)).foregroundStyle(Color.chFog).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("roiStartNote")
                MetricGrid(columns: 3) {
                    Metric(label: "Tesla network cut", value: "\(Int(SimulationCalc.ROI.networkCutPct))%", size: 17)
                    Metric(label: "Cost per unit", value: "$" + Format.int(Int(SimulationCalc.ROI.costPerCab)), size: 17)
                    Metric(label: "Passenger fare", value: String(format: "$%.2f + $%.2f/mi", SimulationCalc.ROI.baseFare, SimulationCalc.ROI.perMileRate), note: "~5 mi avg trip", size: 13)
                }
                Divider().overlay(Color.chLine)
                SliderRow(label: "Fleet size", value: Binding(get: { Double(model.fleetSize) }, set: { model.setFleetSize(Int($0)) }),
                          range: 0...Double(SimulationCalc.ROI.fleetMax), step: 1, format: { "\(Int($0))" }, unit: "Cybercabs", id: "roiFleet")
                SliderRow(label: "Electricity rate", value: $model.electricityRate, range: 0...SimulationCalc.ROI.electricityMax, step: 0.01,
                          format: { String(format: "$%.2f", $0) }, unit: "/kWh", id: "roiElectricity")
                SliderRow(label: "Daily miles / cab", value: Binding(get: { Double(model.dailyMiles) }, set: { model.dailyMiles = Int($0) }),
                          range: 0...Double(SimulationCalc.ROI.milesMax), step: 1, format: { "\(Int($0))" }, unit: "mi", id: "roiMiles")
                Toggle(isOn: $model.lossOn) {
                    Text("Inductive loss factor (\(model.lossOn ? "8" : "0")%)").font(.inter(14, .semibold)).foregroundStyle(Color.chInk)
                }
                .tint(.brandGold)
                .accessibilityIdentifier("roiLoss")
            }
            .glassCard()

            MetricGrid(columns: 3) {
                Metric(label: "Monthly energy overhead", value: "$" + Format.int(Int(r.monthlyEnergyOverhead.rounded())), size: 18)
                Metric(label: "Gross fleet revenue", value: "$" + Format.int(Int(r.grossRevenue.rounded())), size: 18)
                Metric(label: "Net operating income", value: signedDollars(r.netOperatingIncome), valueColor: .brandGold, size: 18)
            }
            .dataPanel()
            .accessibilityIdentifier("roiResults")

            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("BREAKEVEN").font(.inter(11, .bold)).tracking(1).foregroundStyle(Color.brandGold)
                        Text("Cumulative cash flow").font(.inter(12)).foregroundStyle(Color.chFog)
                    }
                    Spacer()
                    Text(r.breakevenMonths.map { "\(Format.one($0)) mo" } ?? "—").statNumber(24, color: .chInk)
                        .accessibilityIdentifier("roiBreakeven")
                }
                CashFlowChart(capital: Double(model.fleetSize) * SimulationCalc.ROI.costPerCab, noi: r.netOperatingIncome, breakeven: r.breakevenMonths)
                    .frame(height: 190)
                Footnote(text: "Projected net cash position from initial fleet capital outlay through recovery.")
            }
            .glassCard()

            HStack {
                Text("Not affiliated with Tesla, Inc. Figures are simulated estimates for planning purposes only, not real prices or earnings.")
                    .font(.inter(11.5)).foregroundStyle(Color.chCaption).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                if let pdfURL {
                    ShareLink(item: pdfURL) { Label("Export", systemImage: "square.and.arrow.up").font(.inter(13, .semibold)) }
                        .accessibilityIdentifier("roiExport")
                }
            }
        }
        .task(id: "\(model.fleetSize)|\(model.electricityRate)|\(model.dailyMiles)|\(model.lossOn)") {
            // Rewritten once the inputs settle (a slider drag changes them many times).
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            pdfURL = ProspectusPDF.write(model: model)
        }
    }

    private func signedDollars(_ v: Double) -> String { (v < 0 ? "-$" : "$") + Format.int(Int(abs(v).rounded())) }
}

/// A slider with its exact value, typed or dragged (the website's linked number field).
struct SliderRow: View {
    let label: String
    @Binding var value: Double
    let range: ClosedRange<Double>
    let step: Double
    let format: (Double) -> String
    let unit: String
    let id: String
    @State private var editing = false
    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(label).font(.inter(14, .semibold)).foregroundStyle(Color.chInk)
                Spacer()
                TextField("", text: $text)
                    .keyboardType(.decimalPad)
                    .multilineTextAlignment(.trailing)
                    .font(.inter(15, .bold)).monospacedDigit().foregroundStyle(Color.brandGold)
                    .frame(width: 80)
                    .focused($focused)
                    .onSubmit(commit)
                    .onChange(of: focused) { _, f in if !f { commit() } }
                    .accessibilityLabel("\(label), exact value")
                    .accessibilityIdentifier("\(id)Field")
                Text(unit).font(.inter(12)).foregroundStyle(Color.chFog)
            }
            Slider(value: $value, in: range, step: step)
                .tint(.brandGold)
                .accessibilityLabel(label)
                .accessibilityValue("\(format(value)) \(unit)")
                .accessibilityIdentifier(id)
        }
        .onAppear { text = format(value).replacingOccurrences(of: "$", with: "") }
        .onChange(of: value) { if !focused { text = format(value).replacingOccurrences(of: "$", with: "") } }
        .toolbar { if focused { ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("Done") { focused = false } } } }
    }

    private func commit() {
        if let v = Double(text.replacingOccurrences(of: "$", with: "").trimmingCharacters(in: .whitespaces)) {
            value = min(range.upperBound, max(range.lowerBound, (v / step).rounded() * step))
        }
        text = format(value).replacingOccurrences(of: "$", with: "")
    }
}

/// The cumulative net cash position: −capital at month 0, + NOI each month;
/// red below zero, gold after breakeven (simulation.html renderCashFlowChart).
struct CashFlowChart: View {
    let capital: Double
    let noi: Double
    let breakeven: Double?

    var body: some View {
        let months = SimulationCalc.chartMonths(breakeven: breakeven)
        let points = (0...months).map { (m: $0, v: -capital + noi * Double($0)) }
        Chart {
            RuleMark(y: .value("Zero", 0)).foregroundStyle(Color.chSmoke).lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 4]))
            ForEach(points, id: \.m) { p in
                AreaMark(x: .value("Month", p.m), yStart: .value("Zero", 0), yEnd: .value("Cash", p.v))
                    .foregroundStyle(p.v < 0 ? Color.chDanger.opacity(0.18) : Color.brandGold.opacity(0.18))
                LineMark(x: .value("Month", p.m), y: .value("Cash", p.v))
                    .foregroundStyle(capital <= 0 ? Color.chFog : Color.brandGold)
                    .lineStyle(StrokeStyle(lineWidth: 2.5))
            }
            if let b = breakeven, b <= Double(months), capital > 0 {
                PointMark(x: .value("Breakeven", b), y: .value("Cash", 0))
                    .foregroundStyle(Color.brandGold).symbolSize(80)
                    .annotation(position: .top) { Text("\(Format.one(b)) mo").font(.inter(11, .bold)).foregroundStyle(Color.brandGold) }
            }
        }
        .chartXAxis { AxisMarks(values: [0, months]) { v in AxisValueLabel { Text("\(v.as(Int.self) ?? 0) mo").font(.inter(10)) } } }
        .chartYAxis { AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) { v in
            AxisGridLine().foregroundStyle(Color.chLine)
            AxisValueLabel { Text(compact(v.as(Double.self) ?? 0)).font(.inter(10)) }
        } }
        .accessibilityLabel(breakeven.map { "Cumulative cash flow: breakeven after \(Format.one($0)) months" } ?? "Cumulative cash flow: no breakeven at these inputs")
        .accessibilityIdentifier("roiChart")
    }

    private func compact(_ v: Double) -> String {
        (v < 0 ? "-$" : "$") + abs(v).formatted(.number.notation(.compactName).precision(.fractionLength(0...2)).locale(Locale(identifier: "en_US")))
    }
}

/// The website's "Export" prospectus (jsPDF there), drawn natively and shared.
enum ProspectusPDF {
    @MainActor
    static func write(model: SimulationModel, now: Date = .now) -> URL? {
        let r = model.financials
        let money = { (v: Double) in (v < 0 ? "-$" : "$") + Format.int(Int(abs(v).rounded())) }
        let rows: [(String, String)] = [
            ("Fleet Size", "\(model.fleetSize) Cybercabs"),
            ("Electricity Rate", String(format: "$%.2f/kWh", model.electricityRate)),
            ("Daily Miles per Cab", "\(model.dailyMiles) mi"),
            ("Passenger Fare", String(format: "$%.2f + $%.2f/mi", SimulationCalc.ROI.baseFare, SimulationCalc.ROI.perMileRate)),
            ("Tesla Network Cut", "\(Int(SimulationCalc.ROI.networkCutPct))%"),
            ("Cost per Cybercab", "$" + Format.int(Int(SimulationCalc.ROI.costPerCab))),
            ("Inductive Loss Factor", model.lossOn ? "8%" : "0%")
        ]
        let outputs: [(String, String)] = [
            ("Monthly Energy Overhead", money(r.monthlyEnergyOverhead)),
            ("Gross Fleet Revenue", money(r.grossRevenue)),
            ("Net Operating Income", money(r.netOperatingIncome)),
            ("Breakeven Timeline", r.breakevenMonths.map { "\(Format.one($0)) mo" } ?? "—")
        ]
        let page = CGRect(x: 0, y: 0, width: 612, height: 792)
        let data = UIGraphicsPDFRenderer(bounds: page).pdfData { ctx in
            ctx.beginPage()
            var y: CGFloat = 72
            func draw(_ s: String, x: CGFloat = 56, size: CGFloat, bold: Bool = false, color: UIColor = .black) {
                (s as NSString).draw(at: CGPoint(x: x, y: y), withAttributes: [.font: bold ? UIFont.boldSystemFont(ofSize: size) : UIFont.systemFont(ofSize: size), .foregroundColor: color])
            }
            draw("CYBERCAB HUNTER", size: 20, bold: true); y += 26
            draw("Investment Prospectus", size: 14, bold: true, color: UIColor(red: 0.85, green: 0.73, blue: 0.05, alpha: 1)); y += 22
            draw("Generated: \(now.formatted(date: .abbreviated, time: .shortened))", size: 10); y += 30
            for (k, v) in rows { draw(k, size: 11, bold: true); draw(v, x: 256, size: 11); y += 20 }
            y += 16
            draw("Financial Outlook", size: 13, bold: true); y += 24
            for (k, v) in outputs { draw(k, size: 11, bold: true); draw(v, x: 256, size: 11); y += 20 }
            y += 24
            draw("Not affiliated with Tesla, Inc. Figures are simulated estimates for planning purposes only.", size: 9, color: .gray)
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("cybercab-hunter-prospectus.pdf")
        do { try data.write(to: url, options: .atomic); return url } catch { return nil }
    }
}
