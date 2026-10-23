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
        VStack(alignment: .leading, spacing: 18) {
            SimHero(eyebrow: "Investor tools", title: "FLEET ROI", titleID: "roiTitle",
                    text: "Model monthly economics for a prospective Cybercab fleet: energy overhead, gross revenue, net operating income, and breakeven timeline.")

            SimSectionHead(eyebrow: "Inputs · Results · Breakeven", title: "Fleet economics").padding(.top, 8)

            // Inputs: one gold card with the Cybercab.
            TintCard(car: "CybercabRender") {
                CardHeading(dotLabel: "Cybercab fleet", title: "Inputs")
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.trailing, TintCard<EmptyView>.headingInset).frame(minHeight: 66, alignment: .topLeading)
                Text(model.startNote).font(.inter(12)).foregroundStyle(Color.chFog).fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 6)
                    .accessibilityIdentifier("roiStartNote")
                inputGroup("Network & fare", icon: "dollarsign") {
                    ValueRow(label: "Tesla Network Cut", value: "\(Int(SimulationCalc.ROI.networkCutPct))%")
                    Divider().overlay(Color.white.opacity(0.07))
                    ValueRow(label: "Cost per Unit", value: "$" + Format.int(Int(SimulationCalc.ROI.costPerCab)))
                    Divider().overlay(Color.white.opacity(0.07))
                    ValueRow(label: "Passenger Fare", value: String(format: "$%.2f + $%.2f/mi", SimulationCalc.ROI.baseFare, SimulationCalc.ROI.perMileRate),
                             note: "Base fare per trip, plus per-mile rate (~5 mi avg trip)")
                }
                inputGroup("Fleet", icon: "car.fill") {
                    SliderRow(label: "Fleet Size", value: Binding(get: { Double(model.fleetSize) }, set: { model.setFleetSize(Int($0)) }),
                              range: 0...Double(SimulationCalc.ROI.fleetMax), step: 1, format: { "\(Int($0))" }, unit: "", id: "roiFleet")
                }
                inputGroup("Energy", icon: "bolt") {
                    SliderRow(label: "Electricity Rate", value: $model.electricityRate, range: 0...SimulationCalc.ROI.electricityMax, step: 0.01,
                              format: { String(format: "$%.2f", $0) }, unit: "/kWh", id: "roiElectricity")
                    SliderRow(label: "Daily Miles / Cab", value: Binding(get: { Double(model.dailyMiles) }, set: { model.dailyMiles = Int($0) }),
                              range: 0...Double(SimulationCalc.ROI.milesMax), step: 1, format: { "\(Int($0))" }, unit: "mi", id: "roiMiles")
                        .padding(.top, 10)
                    Toggle(isOn: $model.lossOn) {
                        Text("Inductive Loss Factor (\(model.lossOn ? "8" : "0")%)").font(.inter(14, .medium)).foregroundStyle(Color.chMist)
                    }
                    .tint(.brandGold)
                    .padding(.top, 12)
                    .accessibilityIdentifier("roiLoss")
                }
                exportButton.padding(.top, 16)
            }

            // Results: three glowing tiles, net operating income the bright one.
            HStack(spacing: 8) {
                ResultTile(icon: "bolt.fill", label: "Monthly energy overhead", value: "$" + Format.int(Int(r.monthlyEnergyOverhead.rounded())))
                ResultTile(icon: "chart.bar.fill", label: "Gross fleet revenue", value: "$" + Format.int(Int(r.grossRevenue.rounded())))
                ResultTile(icon: "chart.line.uptrend.xyaxis", label: "Net operating income", value: signedDollars(r.netOperatingIncome), highlight: true)
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("roiResults")

            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .center) {
                    VStack(alignment: .leading, spacing: 4) {
                        IconLabel(icon: "waveform.path.ecg", text: "Breakeven")
                        Text("CUMULATIVE CASH FLOW").font(.inter(17, .bold)).tracking(0.3).foregroundStyle(Color.chInk)
                    }
                    Spacer()
                    Text(r.breakevenMonths.map { "\(Format.one($0)) mo" } ?? "— mo").statNumber(24, color: .brandGold)
                        .shadow(color: Color.brandGold.opacity(0.4), radius: 8)
                        .accessibilityIdentifier("roiBreakeven")
                }
                CashFlowChart(capital: Double(model.fleetSize) * SimulationCalc.ROI.costPerCab, noi: r.netOperatingIncome, breakeven: r.breakevenMonths)
                    .frame(height: 190)
                Footnote(text: "Projected net cash position from initial fleet capital outlay through recovery.")
            }
            .padding(16)
            .background(Color.chSurface, in: .rect(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.brandGold.opacity(0.25)))

            Text("Not affiliated with Tesla, Inc. Figures are simulated estimates for planning purposes only, not real prices or earnings.")
                .font(.inter(11.5)).foregroundStyle(Color.chCaption).fixedSize(horizontal: false, vertical: true)
        }
        .task(id: "\(model.fleetSize)|\(model.electricityRate)|\(model.dailyMiles)|\(model.lossOn)") {
            // Rewritten once the inputs settle (a slider drag changes them many times).
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            pdfURL = ProspectusPDF.write(model: model)
        }
    }

    /// A group of inputs under an icon label, separated from the previous one by a hairline.
    private func inputGroup<C: View>(_ title: String, icon: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            IconLabel(icon: icon, text: title).padding(.top, 14)
            content()
        }
        .padding(.bottom, 4)
        .overlay(alignment: .top) { Rectangle().fill(Color.white.opacity(0.07)).frame(height: 1) }
        .padding(.top, 12)
    }

    /// The website's full-width gold Export button (the prospectus PDF, via the share sheet).
    @ViewBuilder private var exportButton: some View {
        if let pdfURL {
            ShareLink(item: pdfURL) {
                Label("Export", systemImage: "square.and.arrow.down").font(.inter(16, .semibold))
                    .frame(maxWidth: .infinity, minHeight: 48)
                    .background(Color.brandGold, in: .rect(cornerRadius: 12))
                    .foregroundStyle(Color(hex: 0x1A1204))
            }
            .accessibilityIdentifier("roiExport")
        } else {
            Label("Export", systemImage: "square.and.arrow.down").font(.inter(16, .semibold))
                .frame(maxWidth: .infinity, minHeight: 48)
                .background(Color.brandGold.opacity(0.5), in: .rect(cornerRadius: 12))
                .foregroundStyle(Color(hex: 0x1A1204))
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
                Text(label).font(.inter(14, .medium)).foregroundStyle(Color.chMist)
                Spacer()
                // A currency value shows its "$" in grey before the number, as on the site.
                if format(value).hasPrefix("$") { Text("$").font(.inter(14)).foregroundStyle(Color.chFog) }
                TextField("", text: $text)
                    .keyboardType(.decimalPad)
                    .multilineTextAlignment(.trailing)
                    .font(.inter(18, .semibold)).monospacedDigit().foregroundStyle(Color.chInk)
                    .fixedSize()
                    .focused($focused)
                    .onSubmit(commit)
                    .onChange(of: focused) { _, f in if !f { commit() } }
                    .accessibilityLabel("\(label), exact value")
                    .accessibilityIdentifier("\(id)Field")
                if !unit.isEmpty { Text(unit).font(.inter(14)).foregroundStyle(Color.chFog) }
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
