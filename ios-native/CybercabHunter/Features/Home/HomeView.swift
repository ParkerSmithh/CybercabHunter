import SwiftUI

/// The native homepage, in the website's order: hero, the live stats bar, the
/// service status, Cybercab Daily, Service Zones (city facts), Fleet Growth,
/// Texas DMV registrations, Ride Stats and Sightings Activity. Every number is
/// one the server sent.
struct HomeView: View {
    @Environment(SessionStore.self) private var session
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
                VStack(spacing: 14) {
                    ServiceStatusCard(hours: model.cityStats["austin"]?.area?.hours)
                    DailyCard(report: model.daily, error: model.errors["daily"])
                }
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

// MARK: - Service status

/// "LIVE NOW · Cybercabs are on the road now / Service ends in 5h 21m", or
/// parked, from the service hours (Central), with the 24-hour track.
struct ServiceStatusCard: View {
    let hours: HomepageStats.Hours?

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            let s = ServiceClock(hours: hours, now: context.date)
            VStack(alignment: .leading, spacing: 14) {
                // The car (and its road) centered on the headline and countdown,
                // not the top of the card.
                HStack(alignment: .liveCarRow) {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 6) {
                            Circle().fill(s.live ? Color.chOK : Color(hex: 0x7DD3FC)).frame(width: 7, height: 7)
                            Text(s.live ? "LIVE NOW" : "PARKED").font(.inter(10, .bold)).tracking(1.6).foregroundStyle(s.live ? Color.chOK : Color(hex: 0x7DD3FC))
                        }
                        VStack(alignment: .leading, spacing: 6) {
                            Text(s.live ? "CYBERCABS ARE ON THE ROAD NOW" : "THE FLEET IS PARKED FOR THE NIGHT")
                                .font(.inter(16, .bold)).foregroundStyle(Color.chInk).fixedSize(horizontal: false, vertical: true)
                            Text(s.live ? "Service ends in \(s.countdown)" : "Back on the road at \(Format.clock(hours?.open)) · in \(s.countdown)")
                                .font(.inter(13, .semibold)).foregroundStyle(s.live ? Color.brandGold : Color.chFog)
                                .contentTransition(.numericText())
                        }
                        .alignmentGuide(.liveCarRow) { $0[VerticalAlignment.center] }
                    }
                    Spacer(minLength: 0)
                    LiveCar(live: s.live).frame(width: 130).padding(.trailing, -10)
                }
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text("Service day · ").foregroundStyle(Color.chFog) + Text("\(Format.clock(hours?.open)) – \(Format.clock(hours?.close))").foregroundStyle(Color.chMist)
                        Spacer()
                        Text("Now ").foregroundStyle(Color.chFog) + Text(s.nowLabel).foregroundStyle(Color.chMist)
                    }
                    .font(.inter(11, .medium))
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Color.chSmoke).frame(height: 6)
                            Capsule().fill(Color.brandGold.opacity(0.35))
                                .frame(width: geo.size.width * s.windowWidth, height: 6)
                                .offset(x: geo.size.width * s.windowStart)
                            Capsule().fill(Color.brandGold)
                                .frame(width: geo.size.width * s.runWidth, height: 6)
                                .offset(x: geo.size.width * s.windowStart)
                            Circle().fill(Color.chInk).frame(width: 14, height: 14)
                                .overlay(Circle().strokeBorder(Color.brandGold, lineWidth: 2))
                                .offset(x: geo.size.width * s.nowPosition - 7)
                        }
                    }
                    .frame(height: 14)
                    HStack { ForEach(["12 AM", "6 AM", "12 PM", "6 PM", "12 AM"], id: \.self) { Text($0); if $0 != "12 AM" || true { Spacer(minLength: 0) } } }
                        .font(.inter(9, .medium)).foregroundStyle(Color.chCaption)
                    Text("All times central time (CT) · every day").font(.inter(10)).foregroundStyle(Color.chCaption)
                }
                LiveActivitySwitch(hours: hours, live: s.live)
            }
            .padding(16)
            .background {
                RoundedRectangle(cornerRadius: 16).fill(Color.chSurface)
                    .overlay(RoundedRectangle(cornerRadius: 16).fill(LinearGradient(colors: [(s.live ? Color.brandGold : Color(hex: 0x7DD3FC)).opacity(0.08), .clear], startPoint: .topLeading, endPoint: .bottomTrailing)))
            }
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder((s.live ? Color.brandGold : Color.chLine).opacity(0.45)))
            .accessibilityElement(children: .combine)
        }
        .opacity(hours == nil ? 0.6 : 1)
    }
}

/// The Live now card's switch for the Dynamic Island / Lock Screen Live
/// Activity (ServiceLiveActivityController): off until the rider turns it on.
struct LiveActivitySwitch: View {
    let hours: HomepageStats.Hours?
    let live: Bool
    @State private var controller = ServiceLiveActivityController.shared
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Divider().overlay(Color.chLine)
            Toggle(isOn: Binding(get: { controller.enabled }, set: { on in
                busy = true
                Task { await controller.setEnabled(on); busy = false }
            })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Dynamic Island Live Activity").font(.inter(13.5, .semibold)).foregroundStyle(Color.chInk)
                    Text("Show Cybercab service status in the Dynamic Island and on your Lock Screen.")
                        .font(.inter(11.5)).foregroundStyle(Color.chFog).fixedSize(horizontal: false, vertical: true)
                }
            }
            .tint(Color.brandGold)
            .disabled(!controller.isSupported || busy)
            .accessibilityIdentifier("liveActivityToggle")
            Text(statusLine).font(.inter(11)).foregroundStyle(controller.problem == nil ? Color.chCaption : Color(hex: 0xFCD34D))
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("liveActivityStatus")
            if controller.problem == .notAuthorized {
                Button("Open Settings") { if let u = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(u) } }
                    .font(.inter(12, .semibold)).tint(Color.brandGold)
            }
        }
        // The hours (when they load) and each change of service while the app is open.
        .task(id: "\(hours?.open ?? "")-\(hours?.close ?? "")-\(live)") {
            controller.schedule = ServiceSchedule(open: hours?.open, close: hours?.close)
            await controller.reconcile()
        }
    }

    private var statusLine: String {
        if let p = controller.problem { return p.message }
        if controller.enabled {
            return "On · in the Dynamic Island, or on the Lock Screen on iPhones without one. Follows the published service hours; iOS ends it after about 8 hours, and opening the app starts it again."
        }
        return "Off · on iPhones without a Dynamic Island it appears on the Lock Screen."
    }
}

/// The service day in Central time (the website's js/service-banner.js).
struct ServiceClock {
    let live: Bool
    let countdown: String
    let nowLabel: String
    let windowStart: CGFloat
    let windowWidth: CGFloat
    let runWidth: CGFloat
    let nowPosition: CGFloat

    init(hours: HomepageStats.Hours?, now: Date) {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = Format.central
        let parts = cal.dateComponents([.hour, .minute, .second], from: now)
        let sec = (parts.hour ?? 0) * 3600 + (parts.minute ?? 0) * 60 + (parts.second ?? 0)
        // Live / parked and the next change: Shared/ServiceSchedule.swift, the same
        // logic the Dynamic Island Live Activity uses (wall-clock Central, DST-safe).
        let schedule = ServiceSchedule(open: hours?.open, close: hours?.close)
        let status = schedule.status(at: now)
        let open = schedule.openMinute * 60
        let close = schedule.closeMinute * 60
        live = status.live
        countdown = ServiceSchedule.countdown(from: now, to: status.until)
        nowLabel = now.formatted(Date.FormatStyle(timeZone: Format.central).hour().minute())
        windowStart = CGFloat(open) / 86400
        windowWidth = CGFloat(close - open) / 86400
        runWidth = live ? CGFloat(sec - open) / 86400 : 0
        nowPosition = CGFloat(sec) / 86400
    }

    static func minutes(_ hhmm: String) -> Int { ServiceSchedule.minutes(hhmm) }
}

// MARK: - Cybercab Daily

private struct DailyCard: View {
    let report: DailyReport?
    let error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "calendar").foregroundStyle(Color.brandGold)
                Text("CYBERCAB DAILY").font(.inter(12, .bold)).tracking(1.2).foregroundStyle(Color.chInk)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(report.map { Format.calendarDate($0.today)?.formatted(Date.FormatStyle(timeZone: TimeZone(identifier: "UTC")!).weekday(.wide).month(.wide).day().year()) ?? $0.today } ?? "Today")
                    .font(.inter(12)).foregroundStyle(Color.chFog)
                if let at = Format.instant(report?.generatedAt) {
                    Text("Updated \(at.formatted(Date.FormatStyle(timeZone: Format.central).hour().minute())) CT").font(.inter(11)).foregroundStyle(Color.chCaption)
                }
            }
            MetricGrid(columns: 4) {
                metric("New Cybercabs", "car.fill", \.registry, plus: true)
                metric("DMV additions", "doc.text.fill", \.dmv, plus: true)
                metric("Sightings", "eye.fill", \.sightings)
                metric("Detections", "video.fill", \.cameras)
            }
            if let error { InlineMessage(text: error, systemImage: "wifi.exclamationmark") }
        }
        .glassCard()
    }

    /// A value not in yet shows 0 until it updates (as the website does).
    private func metric(_ label: String, _ icon: String, _ key: KeyPath<DailyReport.Day, Int?>, plus: Bool = false) -> some View {
        let n = report?.day[keyPath: key] ?? 0
        let before = report?.previous?[keyPath: key]
        return VStack(alignment: .leading, spacing: 5) {
            Image(systemName: icon).font(.caption2).foregroundStyle(Color.brandGold)
            Text(label).font(.inter(10, .medium)).foregroundStyle(Color.chFog).lineLimit(2).frame(minHeight: 26, alignment: .topLeading)
            Text(plus ? "+\(Format.int(n))" : Format.int(n)).statNumber(20, color: .brandGold)
            if let before, report?.day[keyPath: key] != nil {
                Text("\(Format.signed(n - before)) vs yesterday").font(.inter(9)).foregroundStyle(Color.chCaption)
            }
        }
    }
}

/// The website header's brand: the logo with CYBERCAB / HUNTER beside it. On
/// iOS 26+ it sits on the bar itself, not in a glass capsule (which clipped it).
struct BrandToolbarItem: ToolbarContent {
    var body: some ToolbarContent {
        if #available(iOS 26.0, *) {
            item.sharedBackgroundVisibility(.hidden)
        } else {
            item
        }
    }

    private var item: some ToolbarContent {
        // Centred on the screen (the bar's principal place), a little larger than before.
        ToolbarItem(placement: .principal) {
            HStack(spacing: 10) {
                Image("BrandMark").resizable().frame(width: 36, height: 36)
                VStack(alignment: .leading, spacing: -1) {
                    Text("CYBERCAB").font(.inter(17, .bold)).tracking(0.9).foregroundStyle(Color.chInk)
                    Text("HUNTER").font(.inter(10.5, .semibold)).tracking(2.8).foregroundStyle(Color.chFog)
                }
            }
            .fixedSize()
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Cybercab Hunter")
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("homeBrand")
        }
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
