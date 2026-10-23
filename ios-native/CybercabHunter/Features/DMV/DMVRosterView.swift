import SwiftUI
import Charts

/// The Texas DMV tracker (public/dmv.html): freshness, the four numbers, new
/// VINs per update, the latest updates (all of them one tap away), insights,
/// the dataset, and every VIN. Data: DMVTracker.swift. Predictions live on
/// Home's DMV panel only; nothing here is projected.
struct DMVRosterView: View {
    @Environment(SessionStore.self) private var session
    @State private var tracker = DMVTrackerModel()
    @State private var model = DMVRosterModel()
    @State private var searchTask: Task<Void, Never>?
    @State private var sheet: DMVSheet?
    @FocusState private var searching: Bool

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                header
                switch tracker.state {
                case .loading: PanelSkeleton(height: 220)
                case .failed:
                    VStack(alignment: .leading, spacing: 8) {
                        InlineMessage(text: "Couldn't load the DMV tracker right now.", systemImage: "wifi.exclamationmark")
                        Button("Try again") { Task { await tracker.reload(api: session.api) } }.font(.inter(14, .semibold)).accessibilityIdentifier("dmvTrackerRetry")
                    }
                case .ready:
                    if let o = tracker.overview {
                        if o.latest == nil {
                            InlineMessage(text: "The first daily TxDMV snapshot hasn't been taken yet.")
                        } else {
                            stats(o)
                            additionsChart
                            activity(o)
                            if !(o.insights ?? []).isEmpty || !(o.milestones ?? []).isEmpty { insights(o) }
                            dataset(o)
                        }
                    }
                }
                directory
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 32)
        }
        .scrollDismissesKeyboard(.immediately)
        .appBackground()
        .navigationBarTitleDisplayMode(.inline)
        // Coming back to this screen reuses the last 5 minutes' responses
        // (DMVResponseCache); pull-to-refresh always fetches.
        .task {
            async let a: Void = tracker.reload(api: session.api)
            async let b: Void = model.reload(api: session.api)
            _ = await (a, b)
        }
        .refreshable {
            async let a: Void = tracker.reload(api: session.api, force: true)
            async let b: Void = model.reload(api: session.api, force: true)
            _ = await (a, b)
        }
        .sheet(item: $sheet) { s in
            NavigationStack {
                switch s {
                case .update(let date): DMVUpdateDetailView(date: date)
                case .vin(let vin): DMVVinDetailView(vin: vin)
                }
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        .navigationDestination(for: DMVHistoryRoute.self) { _ in DMVHistoryView() }
        // Siri / Apple Intelligence: this screen shows the latest Texas DMV snapshot,
        // and the rider checked DMV updates (a donation, once per launch).
        .modifier(OnscreenEntity(DMVSnapshotEntity.self, id: tracker.overview?.latest?.date))
        .onAppear { SiriDonations.donate("dmv", CheckDMVIntent()) }
    }

    // MARK: Header and the four numbers

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Eyebrow(text: "Vehicles · Texas DMV")
            Text("TEXAS DMV TRACKER").displayTitle(28).accessibilityIdentifier("dmvTitle")
            Text("Every vehicle Tesla Robotaxi, LLC lists with the Texas DMV under its SB 2807 automated-vehicle authorization, and when each first appeared in Cybercab Hunter's daily snapshots.")
                .font(.inter(13.5)).foregroundStyle(Color.chMist).fixedSize(horizontal: false, vertical: true)
            if let o = tracker.overview {
                let f = DMVText.freshness(o.freshness.status)
                HStack(spacing: 8) {
                    HStack(spacing: 5) {
                        Circle().frame(width: 6, height: 6)
                        Text(f.label).font(.inter(12, .semibold))
                    }
                    .foregroundStyle(f.warn ? Color(hex: 0xFCD34D) : Color.chOK)
                    .padding(.horizontal, 10).padding(.vertical, 4)
                    .overlay(Capsule().strokeBorder((f.warn ? Color(hex: 0xFCD34D) : Color.chOK).opacity(0.4)))
                    .accessibilityIdentifier("dmvFreshness")
                    if let d = o.latest?.date { Text("Snapshot \(Format.day(d))").font(.inter(12)).foregroundStyle(Color.chFog) }
                }
            }
        }
    }

    private func stats(_ o: DMVOverview) -> some View {
        let t = o.totals ?? DMVClassCounts()
        let total = t.total ?? t.sum
        let pct: (Int) -> String = { n in total > 0 ? "\(Int((Double(n) / Double(total) * 100).rounded()))% of the roster" : "" }
        return VStack(alignment: .leading, spacing: 8) {
            MetricGrid(columns: 2, rowSpacing: 10) {
                Metric(label: "Total tracked", value: Format.int(total), note: "on the roster · \(Format.day(o.latest?.date, year: false))", valueColor: .brandGold, size: 24)
                let pending = o.latestUpdate == nil && (o.processingPending ?? 0) > 0
                Metric(label: "New in latest update", value: pending ? "—" : "+\(Format.int(o.latestUpdate?.added ?? 0))",
                       note: o.latestUpdate.map { "first detected \(Format.day($0.date, year: false))" } ?? (pending ? "activity being processed" : "none since tracking began"), valueColor: .chOK, size: 24)
                Metric(label: "Cybercabs", value: Format.int(t.cybercab), note: pct(t.cybercab), size: 24)
                Metric(label: "Model Ys", value: Format.int(t.modelY), note: pct(t.modelY), size: 24)
            }
            .dataPanel(padding: 14)
            .accessibilityIdentifier("dmvStats")
            Text([
                "Other Tesla \(Format.int(t.otherTesla))", "Unknown \(Format.int(t.unknown))",
                o.previousSnapshot.map { "\(Format.signed($0.net)) since \(Format.day($0.date, year: false))" },
                o.freshness.lastSuccess.flatMap(Format.instant).map { "Imported \(Format.ago($0))" }
            ].compactMap { $0 }.joined(separator: " · "))
            .font(.inter(11.5)).foregroundStyle(Color.chFog).fixedSize(horizontal: false, vertical: true)
            breakdown(t, total: total)
        }
    }

    /// Cybercab vs Model Y (and anything else) as one bar.
    private func breakdown(_ t: DMVClassCounts, total: Int) -> some View {
        GeometryReader { g in
            HStack(spacing: 2) {
                ForEach(DMVClass.allCases, id: \.self) { c in
                    let n = c.count(t)
                    if n > 0, total > 0 { Rectangle().fill(c.color).frame(width: max(2, g.size.width * CGFloat(n) / CGFloat(total) - 2)) }
                }
            }
        }
        .frame(height: 6).clipShape(Capsule())
        .accessibilityElement().accessibilityLabel(DMVText.breakdown(t))
    }

    // MARK: New VINs per update (actual snapshots only)

    private var additionsChart: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("NEW VINS PER UPDATE").font(.inter(13, .bold)).tracking(0.5).foregroundStyle(Color.chInk)
                Spacer(minLength: 6)
                RangePicker(ranges: DMVTrackerModel.Range.allCases, selection: $tracker.range)
            }
            let pts = tracker.additions
            if tracker.growth == nil {
                PanelSkeleton(height: 120)
            } else if !(tracker.growth?.enoughHistory ?? false) || pts.isEmpty {
                Text("Not enough snapshots in this range yet.").font(.inter(12.5)).foregroundStyle(Color.chFog).frame(maxWidth: .infinity, minHeight: 80)
            } else {
                Chart {
                    ForEach(pts) { p in
                        ForEach(DMVClass.allCases, id: \.self) { c in
                            let n = p.added.map { c.count($0) } ?? 0
                            if n > 0 {
                                BarMark(x: .value("Date", Format.calendarDate(p.date) ?? .now, unit: .day), y: .value("New VINs", n))
                                    .foregroundStyle(by: .value("Model", c.label))
                            }
                        }
                    }
                }
                .chartForegroundStyleScale(domain: DMVClass.allCases.map(\.label), range: DMVClass.allCases.map(\.color))
                .chartLegend(position: .bottom, alignment: .leading)
                .chartXAxis { AxisMarks(values: .automatic(desiredCount: 4)) { _ in AxisValueLabel(format: .dateTime.month(.abbreviated).day()).foregroundStyle(Color.chCaption) } }
                .chartYAxis { AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) { _ in AxisGridLine().foregroundStyle(Color.chLine); AxisValueLabel().foregroundStyle(Color.chCaption) } }
                .frame(height: 140)
                .accessibilityIdentifier("dmvAdditionsChart")
                Footnote(text: "First detected in each daily snapshot. Days with no new VINs show no bar. Actual data only.")
            }
        }
        .dataPanel(padding: 14)
        .onChange(of: tracker.range) { Task { await tracker.loadGrowth(api: session.api) } }
    }

    // MARK: Registration activity

    private func activity(_ o: DMVOverview) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("REGISTRATION ACTIVITY").font(.inter(13, .bold)).tracking(0.5).foregroundStyle(Color.chInk)
                Spacer()
                NavigationLink(value: DMVHistoryRoute()) {
                    Text("View all").font(.inter(13, .semibold)).foregroundStyle(Color.brandGold)
                }
                .accessibilityIdentifier("dmvHistoryAll")
            }
            let list = Array((o.recentUpdates ?? []).prefix(3))
            if list.isEmpty, (o.processingPending ?? 0) > 0 {
                Text("Registration activity is being processed from the daily snapshots. It appears after the next daily import.")
                    .font(.inter(12.5)).foregroundStyle(Color.chFog).fixedSize(horizontal: false, vertical: true)
            } else if list.isEmpty {
                Text("No changes since tracking began\(o.trackingSince.map { " on \(Format.day($0))" } ?? ""). The first snapshot is the baseline: its vehicles aren't counted as new.")
                    .font(.inter(12.5)).foregroundStyle(Color.chFog).fixedSize(horizontal: false, vertical: true)
            }
            ForEach(list) { e in
                Button { sheet = .update(e.date) } label: { DMVEventRow(event: e) }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("dmvUpdate")
            }
        }
        .dataPanel(padding: 14)
    }

    private func insights(_ o: DMVOverview) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("INSIGHTS").font(.inter(13, .bold)).tracking(0.5).foregroundStyle(Color.chInk)
            ForEach(o.insights ?? []) { i in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("•").foregroundStyle(Color.brandGold)
                    Text(i.text).font(.inter(12.5)).foregroundStyle(Color.chMist).fixedSize(horizontal: false, vertical: true)
                }
            }
            ForEach(o.milestones ?? []) { m in
                HStack(spacing: 6) {
                    Image(systemName: "star.fill").font(.system(size: 10)).foregroundStyle(Color.brandGold)
                    Text("\(m.label) · \(Format.day(m.date, year: false))").font(.inter(12, .medium)).foregroundStyle(Color.chMist)
                }
                .padding(.horizontal, 10).padding(.vertical, 5)
                .overlay(Capsule().strokeBorder(Color.brandGold.opacity(0.35)))
            }
        }
        .dataPanel(padding: 14)
    }

    private func dataset(_ o: DMVOverview) -> some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 6) {
                DMVField("Provider", o.source.name)
                DMVField("Company", "\(o.source.company) · \(o.source.authorization) (\(o.source.law))")
                if let d = o.latest?.date { DMVField("Dataset date", "\(Format.day(d)) (the day Cybercab Hunter read it; TxDMV dates nothing)") }
                DMVField("Last import", o.freshness.lastSuccess.flatMap(Format.instant).map { Format.dateTime($0, zone: "America/Chicago") } ?? "—")
                DMVField("Status", DMVText.freshness(o.freshness.status).label)
                DMVField("Schedule", o.source.schedule)
                DMVField("Fields", o.source.fields.joined(separator: ", "))
                if let s = o.trackingSince { DMVField("Tracking since", "\(Format.day(s)) (baseline)") }
                DMVField("Decoding", "\(o.source.decoder.name), cross-checked with TxDMV's label")
                if let url = URL(string: o.source.url) { Link("Open the TxDMV roster", destination: url).font(.inter(12.5, .semibold)).foregroundStyle(Color.brandGold).padding(.top, 2) }
            }
            .padding(.top, 8)
        } label: {
            Text("LATEST DATASET").font(.inter(13, .bold)).tracking(0.5).foregroundStyle(Color.chInk)
        }
        .tint(Color.chFog)
        .dataPanel(padding: 14)
        .accessibilityIdentifier("dmvDataset")
    }

    // MARK: Every VIN

    private var directory: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("EVERY VIN").displayTitle(22).padding(.top, 6)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach([("", "All"), ("cybercab", "Cybercab"), ("model_y", "Model Y"), ("recent", "Latest update")], id: \.0) { key, label in
                        PillToggle(title: label, selected: model.model == key, compact: true) { model.model = key; Task { await model.reload(api: session.api) } }
                            .accessibilityIdentifier("dmvModel-\(key.isEmpty ? "all" : key)")
                    }
                }
            }
            HStack(spacing: 8) {
                Menu {
                    Picker("Model year", selection: $model.year) {
                        Text("Any year").tag(Int?.none)
                        ForEach(model.years, id: \.self) { Text(String($0)).tag(Int?.some($0)) }
                    }
                } label: { menuLabel(model.year.map(String.init) ?? "Any year") }
                .accessibilityIdentifier("dmvYear")
                Menu {
                    Picker("Sort", selection: $model.sort) { ForEach(DMVRosterModel.Sort.allCases) { Text($0.label).tag($0) } }
                } label: { menuLabel(model.sort.label) }
                .accessibilityIdentifier("dmvSort")
                Spacer(minLength: 0)
            }
            .onChange(of: model.year) { Task { await model.reload(api: session.api) } }
            .onChange(of: model.sort) { Task { await model.reload(api: session.api) } }
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(Color.chFog)
                TextField("Search VIN", text: $model.query)
                    .textInputAutocapitalization(.characters).autocorrectionDisabled()
                    .font(.system(size: 15, design: .monospaced))
                    .focused($searching)
                    .submitLabel(.search)
                    .accessibilityIdentifier("dmvSearch")
                if !model.query.isEmpty { Button { model.query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Color.chFog) }.accessibilityLabel("Clear search") }
            }
            .padding(.horizontal, 12).frame(minHeight: 42)
            .background(Color.chSurface, in: .rect(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.chHair2))
            .onChange(of: model.query) {
                searchTask?.cancel()
                searchTask = Task { try? await Task.sleep(for: .milliseconds(250)); if !Task.isCancelled { await model.reload(api: session.api) } }
            }
            Text(model.countLine).font(.inter(12.5)).foregroundStyle(Color.chFog).accessibilityIdentifier("dmvCount")
            switch model.state {
            case .loading: PanelSkeleton(height: 200)
            case .failed:
                Button("Try again") { Task { await model.reload(api: session.api) } }.font(.inter(14, .semibold)).accessibilityIdentifier("dmvRetry")
            case .ready:
                if !model.vehicles.isEmpty {
                    VStack(spacing: 0) {
                        HStack { Text("VIN"); Spacer(); Text("MODEL").frame(width: 92, alignment: .leading); Text("FIRST SEEN").frame(width: 70, alignment: .trailing) }
                            .font(.inter(10, .bold)).tracking(0.5).foregroundStyle(Color.chCaption)
                            .padding(.horizontal, 12).padding(.vertical, 8)
                        ForEach(model.vehicles) { v in
                            Divider().overlay(Color.chLine)
                            Button { searching = false; sheet = .vin(v.vin) } label: { vinRow(v) }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("dmvRow")
                        }
                    }
                    .background(Color.chSurface, in: .rect(cornerRadius: 14))
                    .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.chLine))
                }
                if model.vehicles.count < model.total {
                    Button(model.loadingMore ? "Loading…" : "Show more") { Task { await model.loadMore(api: session.api) } }
                        .font(.inter(14, .semibold)).frame(maxWidth: .infinity).padding(.vertical, 8)
                        .disabled(model.loadingMore)
                        .accessibilityIdentifier("dmvMore")
                }
            }
            Footnote(text: "Source: TxDMV Motor Carrier Credentialing System (TxMCCS), polled once a day. TxDMV publishes the VIN, make, model and model year only: no registration date, owner or location. Models are decoded with NHTSA vPIC. A listing is not proof a car is in service.")
        }
    }

    private func menuLabel(_ text: String) -> some View {
        HStack(spacing: 4) {
            Text(text).font(.inter(12.5, .semibold)).lineLimit(1)
            Image(systemName: "chevron.up.chevron.down").font(.system(size: 9, weight: .bold))
        }
        .foregroundStyle(Color.chMist)
        .padding(.horizontal, 11).frame(minHeight: 32)
        .overlay(Capsule().strokeBorder(Color.chHair2))
    }

    private func vinRow(_ v: DMVDirectoryPage.Vehicle) -> some View {
        let c = DMVClass(v.modelClass)
        return HStack(spacing: 6) {
            VStack(alignment: .leading, spacing: 3) {
                Text(v.vin).font(.system(size: 12.5, design: .monospaced)).foregroundStyle(Color.chInk).lineLimit(1).minimumScaleFactor(0.75)
                if v.isNew == true {
                    Text("NEW").font(.inter(9.5, .bold)).foregroundStyle(Color(hex: 0x1A1204))
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Color.brandGold, in: .rect(cornerRadius: 3))
                        .accessibilityIdentifier("dmvNewBadge")
                }
            }
            .layoutPriority(1)
            Spacer(minLength: 4)
            HStack(spacing: 5) {
                Circle().fill(c.color).frame(width: 7, height: 7)
                Text(c.label).font(.inter(12)).foregroundStyle(Color.chMist).lineLimit(1)
            }
            .frame(width: 92, alignment: .leading)
            Text(v.baseline == true ? "by \(Format.day(v.firstDetected, year: false))" : Format.day(v.firstDetected, year: false))
                .font(.inter(12)).monospacedDigit().foregroundStyle(Color.chFog).lineLimit(1).minimumScaleFactor(0.8)
                .frame(width: 70, alignment: .trailing)
        }
        .padding(.horizontal, 12).padding(.vertical, 9)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(c.label)\(v.modelYear.map { ", \($0)" } ?? ""), VIN \(v.vin)\(v.isNew == true ? ", new in the latest update" : ""), first detected \(Format.day(v.firstDetected))")
    }
}

struct DMVHistoryRoute: Hashable {}

enum DMVSheet: Identifiable, Hashable {
    case update(String), vin(String)
    var id: String { switch self { case .update(let d): "u" + d; case .vin(let v): "v" + v } }
}

/// One update: date, how many new / missing, by model, the roster after.
struct DMVEventRow: View {
    let event: DMVEvent
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(Format.day(event.date)).font(.inter(14, .semibold)).foregroundStyle(Color.chInk)
                Spacer(minLength: 6)
                Text(event.added > 0 ? "+\(Format.int(event.added)) new" : "\(Format.int(event.missing)) missing")
                    .font(.inter(13.5, .semibold)).monospacedDigit()
                    .foregroundStyle(event.added > 0 ? Color.chOK : Color(hex: 0xFCD34D))
            }
            HStack(spacing: 8) {
                ForEach(DMVClass.allCases, id: \.self) { c in
                    if let m = event.addedByModel, c.count(m) > 0 {
                        HStack(spacing: 4) { Circle().fill(c.color).frame(width: 6, height: 6); Text("\(Format.int(c.count(m))) \(c.label)") }
                    }
                }
                if event.added > 0, event.missing > 0 { Text("\(Format.int(event.missing)) missing").foregroundStyle(Color(hex: 0xFCD34D)) }
            }
            .font(.inter(11.5)).foregroundStyle(Color.chMist)
            Text("\(Format.int(event.total)) on the roster after (\(Format.signed(event.net)))").font(.inter(11)).foregroundStyle(Color.chFog)
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(.rect)
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.chLine))
        .accessibilityElement(children: .combine)
    }
}

struct DMVField: View {
    let label: String
    let value: String
    init(_ label: String, _ value: String) { self.label = label; self.value = value }
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(label).font(.inter(12)).foregroundStyle(Color.chCaption).frame(width: 96, alignment: .leading)
            Text(value).font(.inter(12.5)).foregroundStyle(Color.chMist).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            Spacer(minLength: 0)
        }
    }
}

/// Every update that changed the roster, with the website's filters.
struct DMVHistoryView: View {
    @Environment(SessionStore.self) private var session
    @State private var model = DMVHistoryModel()
    @State private var sheet: DMVSheet?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                Eyebrow(text: "Texas DMV")
                Text("REGISTRATION HISTORY").displayTitle(26).accessibilityIdentifier("dmvHistoryTitle")
                Text("Each snapshot that changed the roster, compared VIN by VIN with the one before. Dates are when Cybercab Hunter first detected the change, not DMV registration dates.")
                    .font(.inter(13)).foregroundStyle(Color.chMist).fixedSize(horizontal: false, vertical: true)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach([("all", "All changes"), ("additions", "Additions"), ("missing", "Missing")], id: \.0) { key, label in
                            PillToggle(title: label, selected: model.kind == key, compact: true) { model.kind = key; Task { await model.reload(api: session.api) } }
                                .accessibilityIdentifier("dmvKind-\(key)")
                        }
                        Divider().frame(height: 20)
                        ForEach([("", "Any model"), ("cybercab", "Cybercab"), ("model_y", "Model Y")], id: \.0) { key, label in
                            PillToggle(title: label, selected: model.model == key, compact: true) { model.model = key; Task { await model.reload(api: session.api) } }
                        }
                    }
                }
                switch model.state {
                case .loading: PanelSkeleton(height: 220)
                case .failed:
                    InlineMessage(text: "Couldn't load the history right now.", systemImage: "wifi.exclamationmark")
                    Button("Try again") { Task { await model.reload(api: session.api) } }.font(.inter(14, .semibold))
                case .ready:
                    if model.events.isEmpty {
                        Text("No updates match.").font(.inter(13)).foregroundStyle(Color.chFog).accessibilityIdentifier("dmvHistoryEmpty")
                    }
                    ForEach(model.events) { e in
                        Button { sheet = .update(e.date) } label: { DMVEventRow(event: e) }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("dmvHistoryRow")
                    }
                    if model.events.count < model.total {
                        Button("Show more") { Task { await model.loadMore(api: session.api) } }
                            .font(.inter(14, .semibold)).frame(maxWidth: .infinity).padding(.vertical, 8)
                    }
                    if let b = model.baseline {
                        Footnote(text: "Tracking began \(Format.day(b.date)) with \(Format.int(b.total)) vehicles: the baseline. Their real registration dates are unknown, so none of them count as new.")
                    }
                }
            }
            .padding(.horizontal, 16).padding(.bottom, 32)
        }
        .appBackground()
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.reload(api: session.api) }
        .refreshable { await model.reload(api: session.api, force: true) }
        .sheet(item: $sheet) { s in
            NavigationStack {
                switch s {
                case .update(let date): DMVUpdateDetailView(date: date)
                case .vin(let vin): DMVVinDetailView(vin: vin)
                }
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
    }
}

/// One update's VINs: new, missing or returned. Tapping a VIN opens its detail.
struct DMVUpdateDetailView: View {
    let date: String
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var change = "added"
    @State private var detail: DMVUpdateDetail?
    @State private var failed = false

    var body: some View {
        List {
            Section {
                if let e = detail?.event {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("\(e.added > 0 ? "+\(Format.int(e.added)) newly detected" : "No new VINs")\(e.missing > 0 ? " · \(Format.int(e.missing)) missing" : "")\(e.returned > 0 ? " · \(Format.int(e.returned)) returned" : "")")
                            .font(.inter(14, .semibold)).foregroundStyle(Color.chInk)
                        if !DMVText.breakdown(e.addedByModel).isEmpty { Text(DMVText.breakdown(e.addedByModel)).font(.inter(12.5)).foregroundStyle(Color.chMist) }
                        Text("\(Format.int(e.total)) on the roster after (\(Format.signed(e.net))). Compared VIN by VIN with the snapshot of \(Format.day(e.previousDate)). \"New\" means first detected in this snapshot, not a DMV registration date.\(change == "missing" ? " A missing VIN is not necessarily deregistered." : "")")
                            .font(.inter(11.5)).foregroundStyle(Color.chFog).fixedSize(horizontal: false, vertical: true)
                        let tabs = [("added", "New", e.added), ("missing", "Missing", e.missing), ("returned", "Returned", e.returned)].filter { $0.2 > 0 }
                        if tabs.count > 1 {
                            Picker("Change", selection: $change) { ForEach(tabs, id: \.0) { Text("\($0.1) (\(Format.int($0.2)))").tag($0.0) } }
                                .pickerStyle(.segmented)
                        }
                    }
                    .listRowBackground(Color.chSurface)
                } else if failed {
                    Text("Couldn't load this update.").foregroundStyle(Color.chFog)
                } else {
                    ProgressView().frame(maxWidth: .infinity)
                }
            }
            if let d = detail {
                Section(d.total > d.vehicles.count ? "Showing \(d.vehicles.count) of \(Format.int(d.total))" : "\(Format.int(d.total)) VINs") {
                    ForEach(d.vehicles) { v in
                        NavigationLink { DMVVinDetailView(vin: v.vin, close: { dismiss() }) } label: {
                            HStack {
                                Text(v.vin).font(.system(size: 13, design: .monospaced)).foregroundStyle(Color.chInk).lineLimit(1).minimumScaleFactor(0.75)
                                Spacer(minLength: 6)
                                Circle().fill(DMVClass(v.modelClass).color).frame(width: 6, height: 6)
                                Text(DMVClass(v.modelClass).label).font(.inter(12)).foregroundStyle(Color.chMist)
                            }
                        }
                        .listRowBackground(Color.chSurface)
                        .accessibilityIdentifier("dmvUpdateVin")
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Color.chBackground)
        .navigationTitle(Format.day(date))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        .task(id: change) { await load() }
    }

    private func load() async {
        do {
            detail = try await DMVResponseCache.shared.fetch(session.api, "/api/dmv/activity/\(date)", query: [URLQueryItem(name: "change", value: change), URLQueryItem(name: "limit", value: "200")])
            failed = false
        } catch is CancellationError {
        } catch { failed = true }
    }
}

/// One VIN: what TxDMV lists, what the VIN decodes to, when Cybercab Hunter
/// saw it, and the public registry car with this VIN if there is one.
struct DMVVinDetailView: View {
    let vin: String
    /// Pushed inside another sheet: Done closes that whole sheet, not one level.
    var close: (() -> Void)? = nil
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var detail: DMVVinDetail?
    @State private var failed = false

    var body: some View {
        List {
            if let v = detail {
                Section("From TxDMV") {
                    DMVField("Make", v.source.make ?? "—")
                    DMVField("Model", v.source.model ?? "—")
                    DMVField("Model year", v.source.modelYear.map(String.init) ?? "—")
                    DMVField("Registration date", "Not published by TxDMV")
                }
                .listRowBackground(Color.chSurface)
                Section("Decoded VIN · NHTSA vPIC") {
                    if let d = v.decode {
                        DMVField("Class", "\(DMVClass(d.modelClass).label) · \(DMVText.decodeStatus(d.status))")
                        DMVField("Manufacturer", d.manufacturer ?? "—")
                        DMVField("Model", d.model ?? "—")
                        DMVField("Model year", d.modelYear.map(String.init) ?? "—")
                        DMVField("Built at", "\(d.plant ?? "—") (where it was built, not where it is)")
                        DMVField("Vehicle type", d.vehicleType ?? "—")
                        DMVField("Check digit", d.checkDigitOk.map { $0 ? "Valid" : "Invalid" } ?? "—")
                    } else {
                        DMVField("Status", "Not decoded yet")
                    }
                }
                .listRowBackground(Color.chSurface)
                Section("Tracking") {
                    let t = v.tracking
                    DMVField("First detected", t.inBaseline ? "On the roster when tracking began (\(Format.day(t.firstDetected))); its real date is unknown" : Format.day(t.firstDetected))
                    DMVField("Last confirmed", Format.day(t.lastConfirmed))
                    DMVField("Status", t.listed ? "Listed in the latest snapshot" : "Not in the latest snapshot (\(Format.day(t.latestSnapshot)))")
                    ForEach(t.history ?? []) { h in DMVField(Format.day(h.date), DMVText.change(h.change)) }
                }
                .listRowBackground(Color.chSurface)
                Section("Cybercab Hunter") {
                    if let r = v.registry {
                        NavigationLink(value: VehicleRoute(id: r.id, plate: r.plate)) {
                            DMVField("Registry", "\(r.plate ?? "View vehicle") · \(Format.plural(r.approvedSightings ?? 0, "sighting", "sightings"))")
                        }
                        .accessibilityIdentifier("dmvRegistryLink")
                    } else {
                        DMVField("Registry", "No public registry vehicle with this VIN yet")
                    }
                }
                .listRowBackground(Color.chSurface)
            } else if failed {
                Text("Couldn't load this VIN.").foregroundStyle(Color.chFog)
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Color.chBackground)
        .navigationTitle(vin)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { if let close { close() } else { dismiss() } } } }
        .navigationDestination(for: VehicleRoute.self) { VehicleDetailView(route: $0) }
        .accessibilityIdentifier("dmvVinDetail")
        .task {
            do { detail = try await DMVResponseCache.shared.fetch(session.api, "/api/dmv/vins/\(vin)"); failed = false }
            catch is CancellationError {}
            catch { failed = true }
        }
    }
}
