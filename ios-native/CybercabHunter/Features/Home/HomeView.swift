import SwiftUI

/// The native homepage, in the website's order: hero, the live stats bar,
/// Cybercab Daily (with the Live Activity switch), Service Zones (city facts), Fleet Growth,
/// Texas DMV registrations, Ride Stats and Sightings Activity. Every number is
/// one the server sent.
struct HomeView: View {
    @Environment(SessionStore.self) private var session
    @Environment(\.scenePhase) private var scenePhase
    @State private var model = HomeModel()
    @State private var scroll: CGFloat = 0
    /// Debug builds: the page's measured heights, for layout tests.
    @State private var contentHeight: CGFloat = 0
    @State private var belowMinimapHeight: CGFloat = 0

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 28) {
                // No pin and no reserved space: the doors open as the hero scrolls out
                // (the site's flow mode, js/hero-video.js), so the stats follow the hero.
                HomeHero(scroll: scroll)
                HeadlineStats(stats: model.registry, error: model.errors["registry"])
                CybercabDailyCard(report: model.daily, error: model.errors["daily"])
                ServiceZonesSection(model: model)
                // Everything below the Austin minimap: compact dashboard cards.
                VStack(alignment: .leading, spacing: 20) {
                    FleetGrowthSection(model: model)
                    DMVSection(dmv: model.dmv, error: model.errors["dmv"])
                    USSightingsSection()
                    CityRowsSection(model: model)
                }
                .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { belowMinimapHeight = $0 }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 32)
        }
        // The hero's door frames follow the scroll position (js/hero-video.js).
        .onScrollGeometryChange(for: CGFloat.self) { $0.contentOffset.y + $0.contentInsets.top } action: { _, y in let c = min(max(y, 0), HomeHeroMedia.openDistance); if c != scroll { scroll = c } }
        .onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.height } action: { _, h in contentHeight = h }
        #if DEBUG
        .overlay(alignment: .topLeading) {
            Color.clear.frame(width: 1, height: 1)
                .accessibilityElement()
                .accessibilityLabel("\(Int(contentHeight)) \(Int(belowMinimapHeight))")
                .accessibilityIdentifier("homeHeights")
        }
        #endif
        .appBackground()
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { BrandToolbarItem() }
        .navigationDestination(for: ExploreRoute.self) { ExploreDestination(route: $0) }
        .onAppear { SiriDonations.donate("fleet", FleetStatsIntent()) }   // the rider checked the fleet
        .task { await model.loadAll(using: session.api) }
        .refreshable { await model.loadAll(using: session.api) }
        // Back in the app: Cybercab Daily (and the Live Activity) catch up, at most every five minutes.
        .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await model.refreshDailyIfStale(using: session.api) } } }
        .onChange(of: model.city) { _, city in
            Task { await model.loadCity(city, using: session.api) }
        }
    }
}

// MARK: - Hero

/// The website's hero: the Cybercab render, "TRACK THE FUTURE OF AUTONOMY"
/// with FUTURE OF in gold, and the two calls to action.
private struct HomeHero: View {
    let scroll: CGFloat
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HomeHeroMedia(scroll: scroll)
                .frame(height: 220)
                .frame(maxWidth: .infinity)
                .clipped()
                .overlay(LinearGradient(colors: [.clear, Color.chBackground], startPoint: .center, endPoint: .bottom))
                .padding(.horizontal, -16)
                .accessibilityHidden(true)
            (Text("TRACK THE\n") + Text("FUTURE").foregroundStyle(Color.brandGold) + Text(" OF").foregroundStyle(Color.brandGold) + Text("\nAUTONOMY"))
                .font(.inter(38, .bold, relativeTo: .largeTitle))
                .tracking(-1.3)
                .lineSpacing(-2)
                .foregroundStyle(Color.chInk)
                .padding(.top, -40)
            Text("Crowdsourced sightings and live stats for Tesla's autonomous Cybercab fleet in Austin and Dallas.")
                .font(.inter(15, relativeTo: .body)).foregroundStyle(Color.chMist)
            // Each button is as wide as its label and arrow (plus padding), arrows 10 pt from the text.
            HStack(spacing: 18) {
                NavigationLink(value: ExploreRoute.news) {
                    HStack(spacing: 10) { Text("View News"); Image(systemName: "arrow.right") }
                        .font(.inter(15, .semibold))
                        .fixedSize()
                        .padding(.horizontal, 16).frame(minHeight: 46)
                        .background(Color.brandGold, in: .rect(cornerRadius: 10))
                        .foregroundStyle(Color(hex: 0x1A1204))
                }
                .accessibilityLabel("View News")
                .accessibilityIdentifier("homeViewNews")
                NavigationLink(value: ExploreRoute.simulation(.roi)) {
                    HStack(spacing: 10) { Text("Explore"); Image(systemName: "arrow.right") }
                        .font(.inter(13, .semibold)).foregroundStyle(Color.brandGold)
                        .fixedSize()
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("Explore")
                .accessibilityIdentifier("homeExplore")
            }
            .buttonStyle(.plain)
        }
    }
}

// MARK: - Stats bar

/// "ALL CITIES · LIVE": the three lifetime counters, divided by hairlines.
private struct HeadlineStats: View {
    let stats: RegistryStats?
    let error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            (Text("ALL CITIES").foregroundStyle(Color.brandGold) + Text(" · LIVE").foregroundStyle(Color.chCaption))
                .font(.inter(11, .semibold)).tracking(1.9)
            HStack(alignment: .top, spacing: 0) {
                cell("Cybercabs Registered", stats?.publicVehicles)
                Rectangle().fill(Color.chLine).frame(width: 1)
                cell("Total Rides", stats?.recordedRides).padding(.leading, 14)
                Rectangle().fill(Color.chLine).frame(width: 1)
                cell("Sightings", stats?.sightingsAllTime).padding(.leading, 14)
            }
            .fixedSize(horizontal: false, vertical: true)
            if let error { InlineMessage(text: error, systemImage: "wifi.exclamationmark") }
        }
        .padding(.vertical, 14)
        .overlay(alignment: .top) { Rectangle().fill(Color.chLine).frame(height: 1) }
        .overlay(alignment: .bottom) { Rectangle().fill(Color.chLine).frame(height: 1) }
    }

    private func cell(_ label: String, _ value: Int?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label).font(.inter(12)).foregroundStyle(Color.chFog).lineLimit(2).frame(minHeight: 30, alignment: .topLeading)
            Text(Format.int(value)).statNumber(26).contentTransition(.numericText())
                .accessibilityIdentifier("headline-\(label)")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Cybercab Daily

/// Cybercab Daily, built on the former "Live now" card (the surface, the gold
/// wash and edge, the green eyebrow, the bold headline, the car on its road):
/// Robotaxi service runs 24/7 in Austin and Dallas, so where the countdown and
/// the service-day track were it shows today's four figures (Central), each
/// against yesterday, and the Live Activity switch below them. A figure that
/// changes rolls to its new value (none with Reduce Motion).
struct CybercabDailyCard: View {
    let report: DailyReport?
    let error: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // The car (and its road) centered on the heading block, as before.
            HStack(alignment: .liveCarRow, spacing: 8) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Circle().fill(Color.chOK).frame(width: 7, height: 7)
                        Text("LIVE · 24/7").font(.inter(10, .bold)).tracking(1.6).foregroundStyle(Color.chOK)
                    }
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 7) {
                            Image(systemName: "calendar").font(.system(size: 14, weight: .semibold)).foregroundStyle(Color.brandGold)
                            Text("CYBERCAB DAILY").font(.inter(16, .bold)).foregroundStyle(Color.chInk)
                        }
                        .accessibilityAddTraits(.isHeader)
                        Text("Robotaxi 24/7 in Austin and Dallas")
                            .font(.inter(12.5, .semibold)).foregroundStyle(Color.brandGold).lineLimit(1).minimumScaleFactor(0.85)
                    }
                    .alignmentGuide(.liveCarRow) { $0[VerticalAlignment.center] }
                    Text(dateLine).font(.inter(11)).foregroundStyle(Color.chFog).lineLimit(1).minimumScaleFactor(0.85)
                        .accessibilityIdentifier("dailyUpdated")
                }
                Spacer(minLength: 0)
                LiveCar(live: true).frame(width: 112).padding(.trailing, -10)
            }
            HStack(alignment: .top, spacing: 0) {
                metric("New Cybercabs", "car.fill", \.registry, plus: true)
                divider
                metric("DMV additions", "doc.text.fill", \.dmv, plus: true)
                divider
                metric("Sightings", "eye.fill", \.sightings)
                divider
                metric("Detections", "video.fill", \.cameras)
            }
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("dailyFigures")
            if let error { InlineMessage(text: error, systemImage: "wifi.exclamationmark") }
            LiveActivitySwitch(report: report)
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .background {
            RoundedRectangle(cornerRadius: 16).fill(Color.chSurface)
                .overlay(RoundedRectangle(cornerRadius: 16).fill(LinearGradient(colors: [Color.brandGold.opacity(0.08), .clear], startPoint: .topLeading, endPoint: .bottomTrailing)))
        }
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.brandGold.opacity(0.45)))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("cybercabDaily")
    }

    private var divider: some View { Rectangle().fill(Color.brandGold.opacity(0.16)).frame(width: 1).padding(.horizontal, 6) }

    /// "Thu, Nov 12 · Updated 1:51 PM CT" (Central).
    private var dateLine: String {
        let day = report.flatMap { Format.calendarDate($0.today)?.formatted(Date.FormatStyle(timeZone: TimeZone(identifier: "UTC")!).weekday(.abbreviated).month(.abbreviated).day()) } ?? "Today"
        guard let at = Format.instant(report?.generatedAt) else { return "\(day) · \(report == nil && error == nil ? "Updating…" : "Refresh pending")" }
        return "\(day) · Updated \(at.formatted(Date.FormatStyle(timeZone: Format.central).hour().minute())) CT"
    }

    /// A value not in yet shows 0 until it updates (as the website does).
    private func metric(_ label: String, _ icon: String, _ key: KeyPath<DailyReport.Day, Int?>, plus: Bool = false) -> some View {
        let n = report?.day[keyPath: key] ?? 0
        let before = report?.previous?[keyPath: key]
        return VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 3) {
                Image(systemName: icon).font(.system(size: 8.5, weight: .semibold)).foregroundStyle(Color.brandGold)
                Text(label).font(.inter(10, .medium)).foregroundStyle(Color.chFog).lineLimit(1).minimumScaleFactor(0.75)
            }
            Text(plus ? "+\(Format.int(n))" : Format.int(n)).statNumber(20, color: .brandGold)
                .lineLimit(1).minimumScaleFactor(0.7)
                .contentTransition(.numericText(value: Double(n)))
                .animation(reduceMotion ? nil : .snappy, value: n)
            if let before, report?.day[keyPath: key] != nil {
                Text("\(Format.signed(n - before)) vs yesterday").font(.inter(9)).foregroundStyle(Color.chCaption).lineLimit(1).minimumScaleFactor(0.75)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// The Cybercab Daily card's switch for the Dynamic Island / Lock Screen Live
/// Activity (ServiceLiveActivityController): off until the rider turns it on.
/// It hands the controller each fresh Daily report, so the activity shows
/// today's detections and sightings. One compact row: the name with On/Off,
/// one line of explanation, the switch; a problem (not allowed, couldn't
/// start) still shows its message, and Open Settings when that helps.
struct LiveActivitySwitch: View {
    let report: DailyReport?
    @State private var controller = ServiceLiveActivityController.shared
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Divider().overlay(Color.chLine)
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 6) {
                        Text("Live Activity").font(.inter(13.5, .semibold)).foregroundStyle(Color.chInk)
                        Text(statusLine).font(.inter(10.5, .semibold))
                            .foregroundStyle(controller.problem == nil ? (controller.enabled ? Color.chOK : Color.chCaption) : Color(hex: 0xFCD34D))
                            .lineLimit(1)
                            .accessibilityIdentifier("liveActivityStatus")
                    }
                    Text("Show detections and sightings on your Lock Screen and Dynamic Island.")
                        .font(.inter(11)).foregroundStyle(Color.chFog).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                Toggle("Live Activity", isOn: Binding(get: { controller.enabled }, set: { on in
                    busy = true
                    Task { await controller.setEnabled(on); busy = false }
                }))
                .labelsHidden()
                .tint(Color.brandGold)
                .disabled(!controller.isSupported || busy)
                .accessibilityHint("Shows today's detections and sightings on your Lock Screen and Dynamic Island.")
                .accessibilityIdentifier("liveActivityToggle")
            }
            if let p = controller.problem {
                Text(p.message).font(.inter(11)).foregroundStyle(Color(hex: 0xFCD34D)).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("liveActivityProblem")
                if p == .notAuthorized {
                    Button("Open Settings") { if let u = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(u) } }
                        .font(.inter(12, .semibold)).tint(Color.brandGold)
                }
            }
        }
        // Each fresh report (and the first) updates the activity.
        .task(id: report?.generatedAt ?? report?.today ?? "") {
            if let report { controller.latest = ServiceActivityAttributes.ContentState(report) }
            await controller.reconcile()
        }
    }

    /// "On" / "Off", or "Needs attention" when there's a problem (its message below).
    private var statusLine: String {
        if controller.problem != nil { return "Needs attention" }
        return controller.enabled ? "On" : "Off"
    }
}

/// The "Live now" card's car (css/style.css .sb-car): while the fleet runs it
/// bobs 1.5 pt every 2.6 s over a gold dashed road scrolling at 26 pt per
/// 0.8 s; parked, it is greyed out with no road. Reduce Motion: still.
private extension VerticalAlignment {
    /// The middle of the Live now card's headline and countdown, which the car lines up with.
    enum LiveCarRow: AlignmentID {
        static func defaultValue(in d: ViewDimensions) -> CGFloat { d[VerticalAlignment.center] }
    }
    static let liveCarRow = VerticalAlignment(LiveCarRow.self)
}

private struct LiveCar: View {
    let live: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(paused: !live || reduceMotion)) { tl in
            let t = tl.date.timeIntervalSinceReferenceDate
            let bob = (live && !reduceMotion) ? -1.5 * (1 - cos(t / 2.6 * 2 * .pi)) / 2 : 0
            let shift = (live && !reduceMotion) ? (t / 0.8).truncatingRemainder(dividingBy: 1) * 26 : 0
            ZStack(alignment: .bottom) {
                if live {
                    Canvas { ctx, size in
                        var x = -26 + shift
                        while x < size.width {
                            ctx.fill(Path(CGRect(x: x, y: 0, width: 12, height: 2)), with: .color(Color.brandGold.opacity(0.55)))
                            x += 26
                        }
                    }
                    .frame(height: 2)
                    .mask(LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.35), .init(color: .black, location: 0.85), .init(color: .clear, location: 1)], startPoint: .leading, endPoint: .trailing))
                    .padding(.horizontal, -20)
                    .offset(y: -4)
                }
                Image("CybercabLive").resizable().scaledToFit()
                    .mask(LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.22)], startPoint: .leading, endPoint: .trailing))
                    .shadow(color: .black.opacity(0.5), radius: 7, y: 10)
                    .grayscale(live ? 0 : 1).brightness(live ? 0 : -0.45).opacity(live ? 1 : 0.65)
                    .offset(y: bob)
            }
        }
        .accessibilityHidden(true)
    }
}
