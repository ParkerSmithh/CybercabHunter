import SwiftUI

/// Simulation (the website's /simulation): Fleet ROI and Fleet ETA, reached
/// from Home's Explore button. Every figure is an estimate or a simulation,
/// labelled as such; nothing is a live Tesla price or fleet availability.
struct SimulationView: View {
    @Environment(SessionStore.self) private var session
    @State private var model = SimulationModel()
    var initialView: SimulationModel.View = .roi

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                // Lazy only for the pinned segment bar (a section header): each
                // view is a compact header, then one segment's content.
                LazyVStack(alignment: .leading, spacing: 16, pinnedViews: [.sectionHeaders]) {
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
            // A new segment opens at its top when the bar is pinned (scrolled
            // down); at the top of the page nothing moves.
            .onChange(of: model.roi2.tab) { if model.segmentPinned { withAnimation(.snappy) { proxy.scrollTo(SegmentAnchor.id, anchor: .top) } } }
            .onChange(of: model.etaTab) { if model.segmentPinned { withAnimation(.snappy) { proxy.scrollTo(SegmentAnchor.id, anchor: .top) } } }
        }
        .appBackground()
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { model.view = initialView }
        .refreshable {
            if model.view == .eta { await model.loadEta(model.city, api: session.api, force: true) }
        }
    }
}

// MARK: - Fleet ROI

/// The Fleet ROI tab: the hero, then the simulator (FleetROI2View.swift), the
/// only Fleet ROI calculator.
struct FleetROIView: View {
    @Bindable var model: SimulationModel

    var body: some View {
        SimHero(eyebrow: "Investor tools", title: "FLEET ROI", titleID: "roiTitle",
                text: "What a $29,990 Cybercab costs to own, and what a fleet might earn if owners are ever allowed to run one.")
        SegmentAnchor(pinned: $model.segmentPinned)
        FleetROI2Sections(session: model.roi2, store: model.roi2Store)
    }
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
