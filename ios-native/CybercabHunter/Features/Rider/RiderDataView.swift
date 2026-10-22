import SwiftUI
import Charts

/// Rider data (the website's /rider-data): the signed-in rider's own rides
/// from their Tesla receipts. Everything here is theirs, fetched with their
/// session; nothing is public. Missing values show as "—", never as 0.
struct RiderDataView: View {
    @Environment(SessionStore.self) private var session
    @State private var model = RiderDataModel()
    @State private var tesla = TeslaLinkModel()
    @State private var teslaPage: URL?
    @State private var confirmUnlink = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Eyebrow(text: "Your rides · private")
                Text("RIDER DATA").displayTitle(30).accessibilityIdentifier("riderTitle")
                switch model.state {
                case .loading: PanelSkeleton(height: 160); PanelSkeleton(height: 220)
                case .signedOut:
                    InlineMessage(text: "Sign in to see your rides.", systemImage: "person.crop.circle.badge.exclamationmark").accessibilityIdentifier("riderSignedOut")
                case .failed(let text):
                    VStack(alignment: .leading, spacing: 8) {
                        InlineMessage(text: text, systemImage: "wifi.exclamationmark")
                        Button("Try again") { Task { await model.load(api: session.api) } }.font(.inter(14, .semibold))
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("riderError")
                case .ready:
                    if let d = model.data { content(d) }
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 32)
        }
        .appBackground()
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load(api: session.api) }
        .refreshable { await model.load(api: session.api, skeleton: false) }
        .fullScreenCover(item: Binding(get: { teslaPage.map(RiderURL.init) }, set: { teslaPage = $0?.url })) {
            SafariView(url: $0.url).ignoresSafeArea()
                .onDisappear { Task { await model.load(api: session.api, skeleton: false) } }
        }
    }

    @ViewBuilder private func content(_ d: RiderData) -> some View {
        let s = d.rideSummary
        MetricGrid(columns: 3) {
            Metric(label: "Rides", value: RiderDataModel.count(s?.tripCount), size: 22)
            Metric(label: "Miles", value: RiderDataModel.miles(s?.totalDistance), size: 22)
            Metric(label: "Time", value: RiderDataModel.duration(s?.totalDurationMinutes), size: 22)
            Metric(label: "Vehicles ridden", value: RiderDataModel.count(s?.uniqueVehicles), size: 22)
            Metric(label: "Cities", value: Format.int(d.cities.count), size: 22)
            Metric(label: "Contributions", value: RiderDataModel.count(d.contributions), size: 22)
        }
        .dataPanel()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("riderStats")
        let hero = RiderDataModel.heroNote(d)
        if !hero.isEmpty { Footnote(text: hero) }

        receiptSync

        section("Ride summary", id: "riderSummary") {
            if (s?.tripCount ?? 0) == 0 {
                Text("No counted rides yet. Forward your Tesla ride receipts and they'll appear here.").font(.inter(13.5)).foregroundStyle(Color.chMist)
            } else if let s {
                MetricGrid(columns: 2) {
                    Metric(label: "Average distance", value: RiderDataModel.miles(s.avgDistance), size: 18)
                    Metric(label: "Longest ride", value: RiderDataModel.miles(s.longestRideDistance), size: 18)
                    Metric(label: "Average time", value: RiderDataModel.duration(s.avgDurationMinutes), size: 18)
                    Metric(label: "Time on board", value: RiderDataModel.duration(s.totalDurationMinutes), size: 18)
                    Metric(label: "First ride", value: RiderDataModel.date(s.firstRideDate), size: 18)
                    Metric(label: "Latest ride", value: RiderDataModel.date(s.lastRideDate), size: 18)
                }
                let note = RiderDataModel.summaryNote(d)
                if !note.isEmpty { Footnote(text: note) }
            }
        }

        section("Spending", id: "riderSpending") {
            if d.spending.isEmpty {
                Text("No fares recorded yet.").font(.inter(13.5)).foregroundStyle(Color.chMist)
            } else {
                ForEach(d.spending, id: \.currency) { sp in
                    VStack(alignment: .leading, spacing: 8) {
                        Text("TOTAL · \(sp.currency)").font(.inter(11, .bold)).tracking(0.8).foregroundStyle(Color.chCaption)
                        Text(RiderDataModel.money(sp.totalCents, sp.currency)).statNumber(30)
                        MetricGrid(columns: 3) {
                            Metric(label: "Median fare", value: RiderDataModel.money(sp.medianCents, sp.currency), size: 16)
                            Metric(label: "Average fare", value: RiderDataModel.money(sp.avgCents, sp.currency), size: 16)
                            Metric(label: "Free rides", value: Format.int(sp.freeCount), size: 16)
                        }
                    }
                }
                Footnote(text: RiderDataModel.spendingNote(d))
            }
        }

        section("Monthly activity", id: "riderMonthly") {
            let months = RiderDataModel.months(d)
            let total = months.reduce(0) { $0 + $1.rides }
            if d.monthlyActivity.isEmpty {
                Text("No dated rides yet.").font(.inter(13.5)).foregroundStyle(Color.chMist)
            } else {
                let busiest = months.max { $0.rides < $1.rides }
                Text(total > 0 && busiest != nil ? "\(Format.plural(total, "ride", "rides")) in the last 12 months · busiest: \(busiest!.label) (\(busiest!.rides))" : "Rides per month, last 12 months")
                    .font(.inter(12.5)).foregroundStyle(Color.chFog)
                Chart(Array(months.enumerated()), id: \.offset) { _, m in
                    BarMark(x: .value("Month", m.key), y: .value("Rides", m.rides))
                        .foregroundStyle(Color.brandGold.gradient)
                        .cornerRadius(3)
                }
                .chartXAxis { AxisMarks(values: months.map(\.key)) { v in AxisValueLabel { Text(months.first { $0.key == v.as(String.self) }.map { String($0.label.prefix(1)) } ?? "") } } }
                .chartYAxis { AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) }
                .frame(height: 140)
                .accessibilityLabel("Rides per month")
            }
            let note = RiderDataModel.monthlyNote(d)
            if !note.isEmpty { Footnote(text: note) }
        }

        section("Cities", id: "riderCities") {
            if d.cities.isEmpty {
                Text("No city recorded yet.").font(.inter(13.5)).foregroundStyle(Color.chMist)
            } else {
                let rides = max(d.rideSummary?.tripCount ?? 0, 1)
                ForEach(d.cities, id: \.serviceArea) { c in
                    let pct = Int((Double(c.rideCount) / Double(rides) * 100).rounded())
                    VStack(alignment: .leading, spacing: 6) {
                        HStack { Text(c.serviceArea).font(.inter(14, .semibold)); Spacer(); Text(Format.plural(c.rideCount, "ride", "rides")).font(.inter(13, .bold)).foregroundStyle(Color.chMist) }
                        ProgressView(value: Double(pct), total: 100).tint(.brandGold)
                        Text("\(pct)% of rides · \(c.ridesWithDistance > 0 ? RiderDataModel.miles(c.totalDistance) + (c.ridesWithDistance < c.rideCount ? " (\(c.ridesWithDistance) of \(c.rideCount) rides)" : "") : "distance unknown") · first ride \(RiderDataModel.date(c.firstRideDate))")
                            .font(.inter(11.5)).foregroundStyle(Color.chFog)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }

        ridesSection

        if model.isModerator { teslaSection }
    }

    // MARK: Receipt sync (Gmail forwarding)

    private var receiptSync: some View {
        NavigationLink(value: RiderDataRoute.gmail) {
            HStack(spacing: 12) {
                Image(systemName: "envelope.arrow.triangle.branch").font(.system(size: 18, weight: .semibold)).foregroundStyle(Color.brandGold)
                    .frame(width: 38, height: 38).background(Color.brandGold.opacity(0.12), in: .rect(cornerRadius: 10))
                VStack(alignment: .leading, spacing: 2) {
                    Text("Receipt sync (Gmail)").font(.inter(15, .bold)).foregroundStyle(Color.chInk)
                    Text("Forward Tesla's ride receipts to your private address. No Gmail sign-in or password.").font(.inter(12)).foregroundStyle(Color.chFog).multilineTextAlignment(.leading)
                }
                Spacer(minLength: 4)
                Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Color.chCaption)
            }
            .padding(12)
            .background(Color.chSurface, in: .rect(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.chLine))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("riderGmail")
    }

    // MARK: Rides

    private var ridesSection: some View {
        section("Your rides", id: "riderRides", trailing: model.rides.map { $0.pagination.total > 0 ? Format.plural($0.pagination.total, "ride", "rides") : "" }) {
            if model.ridesFailed {
                InlineMessage(text: "Couldn't load this page of rides. Pull to refresh.")
            }
            if let e = model.actionError {
                Text(e).font(.inter(12.5, .semibold)).foregroundStyle(Color.chDanger).accessibilityIdentifier("riderActionError")
            }
            if let r = model.rides {
                if r.pagination.total == 0 {
                    Text("No rides yet. Rides appear here when your forwarded receipts arrive.").font(.inter(13.5)).foregroundStyle(Color.chMist).accessibilityIdentifier("riderRidesEmpty")
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(r.trips.enumerated()), id: \.element.id) { i, t in
                            if i > 0 { Divider().overlay(Color.chLine) }
                            rideRow(t)
                        }
                    }
                    if r.pagination.totalPages > 1 {
                        HStack {
                            Button("Previous") { Task { await model.loadPage(model.page - 1, api: session.api) } }.disabled(r.pagination.page <= 1)
                            Spacer()
                            Text("Page \(r.pagination.page) of \(r.pagination.totalPages)").font(.inter(12.5)).foregroundStyle(Color.chFog)
                            Spacer()
                            Button("Next") { Task { await model.loadPage(model.page + 1, api: session.api) } }.disabled(r.pagination.page >= r.pagination.totalPages)
                                .accessibilityIdentifier("riderNext")
                        }
                        .font(.inter(14, .semibold)).padding(.top, 8)
                    }
                }
            }
        }
    }

    private func rideRow(_ t: TripsPage.Trip) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(RiderDataModel.date(t.rideDate)).font(.inter(14, .semibold)).foregroundStyle(Color.chInk)
                if t.status == "under_review" { badge("UNDER REVIEW", Color(hex: 0xF5B83D)) }
                if t.status == "rejected" { badge("REJECTED", .chDanger) }
                if t.corrected == true { badge("CORRECTED", .chFog) }
                Spacer()
                Text(RiderDataModel.fare(t)).font(.inter(14, .bold)).monospacedDigit()
            }
            HStack(spacing: 6) {
                Text(t.city ?? "—"); Text("·"); Text(RiderDataModel.miles(t.distance)); Text("·")
                Text(t.vehiclePlate ?? "—").font(.inter(12.5, .bold)).foregroundStyle(Color.chMist)
                Spacer()
                Text(RiderDataModel.sourceLabels[t.source ?? ""] ?? (t.source ?? "")).foregroundStyle(Color.chCaption)
            }
            .font(.inter(12.5)).foregroundStyle(Color.chFog)
            if model.pendingDelete == t.id {
                HStack(spacing: 10) {
                    Text("Remove this ride?").font(.inter(12.5)).foregroundStyle(Color.chMist)
                    Spacer()
                    Button("Cancel") { model.pendingDelete = nil }.font(.inter(13, .semibold)).tint(.chFog)
                    Button(model.removing == t.id ? "Removing…" : "Remove", role: .destructive) { Task { await model.remove(t.id, api: session.api) } }
                        .font(.inter(13, .bold)).disabled(model.removing != nil)
                        .accessibilityIdentifier("riderConfirmRemove")
                }
            } else {
                Button("Remove") { model.pendingDelete = t.id; model.actionError = nil }
                    .font(.inter(12.5)).tint(.chFog)
                    .accessibilityLabel("Remove this ride from your history")
                    .accessibilityIdentifier("riderRemove")
            }
        }
        .padding(.vertical, 10)
        .opacity(t.status == nil || t.status == "counted" ? 1 : 0.75)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("riderRide")
    }

    private func badge(_ text: String, _ color: Color) -> some View {
        Text(text).font(.inter(9.5, .heavy)).tracking(0.5).foregroundStyle(color)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .overlay(Capsule().strokeBorder(color.opacity(0.5)))
    }

    // MARK: Tesla (moderators, as on the website)

    private var teslaSection: some View {
        section("Tesla account", id: "riderTesla") {
            Text(model.teslaLinked ? "Linked. Cybercab Hunter can see the eligible vehicle information on your Tesla account. This does not import Robotaxi ride history; rides come from receipts."
                 : "Not linked. Linking lets Cybercab Hunter see the eligible vehicle information on your Tesla account. It does not import Robotaxi ride history. You sign in on Tesla's own page; the app never sees your Tesla password.")
                .font(.inter(13)).foregroundStyle(Color.chMist).fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("teslaStatus")
            if let m = tesla.message { Text(m).font(.inter(12.5, .semibold)).foregroundStyle(Color.chDanger) }
            if model.teslaLinked {
                Button(tesla.working ? "Unlinking…" : "Unlink Tesla", role: .destructive) { confirmUnlink = true }
                    .disabled(tesla.working)
                    .accessibilityIdentifier("teslaUnlink")
                    .confirmationDialog("Unlink your Tesla account from Cybercab Hunter?", isPresented: $confirmUnlink, titleVisibility: .visible) {
                        Button("Unlink Tesla", role: .destructive) {
                            Task { if await tesla.unlink(api: session.api) { await model.load(api: session.api, skeleton: false) } }
                        }
                    } message: { Text("Your rides and receipts stay. You can link again later.") }
            } else {
                Button(tesla.working ? "Connecting…" : "Link Tesla account") {
                    Task { if let url = await tesla.startURL(api: session.api) { teslaPage = url } }
                }
                .modifier(OutlineButton(color: .brandGold))
                .disabled(tesla.working)
                .accessibilityIdentifier("teslaLink")
            }
        }
    }

    // MARK: Layout

    private func section<C: View>(_ title: String, id: String, trailing: String? = nil, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(title.uppercased()).font(.inter(12, .heavy)).tracking(1).foregroundStyle(Color.brandGold)
                Spacer()
                if let trailing { Text(trailing).font(.inter(12)).foregroundStyle(Color.chFog) }
            }
            content()
        }
        .padding(14)
        .background(Color.chSurface, in: .rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.chLine))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(id)
    }
}

enum RiderDataRoute: Hashable { case data, gmail }

private struct RiderURL: Identifiable { let url: URL; var id: String { url.absoluteString } }
