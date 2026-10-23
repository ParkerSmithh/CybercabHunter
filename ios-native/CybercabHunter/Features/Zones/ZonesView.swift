import SwiftUI
import MapKit

/// Zones (the website's /infrastructure): the service-zone map for Austin and
/// Dallas with charging locations, camera-spotted Cybercabs, place search,
/// Normal Map / Heatmap, zone details with Fleet & Fares, and the Replay.
struct ZonesView: View {
    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router
    @Environment(\.scenePhase) private var scenePhase
    @State private var model = ZonesModel()
    @State private var selection: MapSelection?
    @State private var showingDetails = false
    @State private var place: PlaceResults.Place?
    /// The place search, opened from its circular button (closed by default).
    @State private var searchOpen = false
    @State private var searchDetent: PresentationDetent = .medium
    @State private var heatExpanded = false

    private let areas = [ServiceArea(key: "austin", name: "Austin"), ServiceArea(key: "dallas", name: "Dallas")]

    var body: some View {
        // Full screen: the map runs under the status bar, the see-through
        // navigation bar (only the Account button, no title; RootView) and the
        // Liquid Glass tab bar. The controls stay inside the safe area.
        GeometryReader { geo in
            ZStack(alignment: .top) {
                ZoneMapView(cityKey: model.city, heatMode: model.mode == .heat, liveDetections: model.live[model.city] ?? [],
                            heatPoints: model.heatPoints, cameraDots: model.cameraDots, place: place,
                            bottomInset: model.mode == .heat ? (heatExpanded ? 230 : 140) : 90,
                            topInset: geo.safeAreaInsets.top + 52, selectionActive: selection != nil) { selection = $0 }   // under the status bar, header and the Search button
                    .ignoresSafeArea()
                    .accessibilityIdentifier("zonesMap")
                // A soft scrim so the status bar and the Account button stay readable over a bright map.
                LinearGradient(colors: [Color.black.opacity(0.55), Color.black.opacity(0)], startPoint: .top, endPoint: .bottom)
                    .frame(height: geo.safeAreaInsets.top + 16)
                    .ignoresSafeArea(edges: .top)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                topControls
            }
        }
        .overlay(alignment: .bottom) { bottomControls }
        // The place search: an Apple Maps-style sheet over the live map (medium, drag up for more).
        .sheet(isPresented: $searchOpen) {
            ZoneSearchSheet(city: model.cityData, api: session.api,
                            onPick: { p in place = p },
                            onCity: { c in place = nil; model.city = c },
                            pinned: place?.id.hasPrefix("spot:") == true ? nil : place,
                            onClearPin: { place = nil },
                            detent: $searchDetent)
                .presentationDetents([.medium, .large], selection: $searchDetent)
                .presentationDragIndicator(.visible)
                .presentationBackgroundInteraction(.enabled(upThrough: .medium))
                .modifier(SearchSheetBackground())
                .onAppear { searchDetent = .medium }
        }
        .background(Color.chBackground)
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(for: ReplayRoute.self) { ReplayView(route: $0) }
        .sheet(item: $selection) { sel in MapSelectionSheet(selection: sel, model: model).presentationDetents([.medium]).presentationDragIndicator(.visible) }
        .sheet(isPresented: $showingDetails) { ZoneDetailsSheet(model: model).presentationDetents([.medium, .large]).presentationDragIndicator(.visible) }
        // Live markers: now, then every 60 s while Zones is showing (as the site), per city.
        .task(id: model.city) {
            await model.loadPanel(using: session.api)
        }
        .task(id: "\(model.city)|\(scenePhase == .active)") {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                await model.loadLive(using: session.api)
                try? await Task.sleep(for: .seconds(60))
            }
        }
        .task(id: model.mode == .heat ? model.heatKey : "normal") {
            if model.mode == .heat { await model.loadHeat(using: session.api) }
        }
        .onAppear { if let c = router.zonesCity { model.city = c; router.zonesCity = nil } }
        // Siri / Apple Intelligence: the map shows this city's service zone ("how big is this service area?").
        .modifier(OnscreenEntity(ServiceZoneEntity.self, id: model.city))
        .onChange(of: model.city, initial: true) {
            if let c = ServiceCity(rawValue: model.city) { SiriDonations.donate("zone-\(c.rawValue)", ServiceZoneIntent(city: c)) }
        }
        .onChange(of: router.zonesCity) { _, c in if let c { model.city = c; router.zonesCity = nil } }
        .onChange(of: model.city) { place = nil; selection = nil }
    }

    // MARK: controls

    /// Top left: the Austin / Dallas selector. Top right: two circular Liquid
    /// Glass buttons, Zone details (its bottom edge level with the selector's)
    /// and Search right below it. Search opens a field beside its button.
    private var topControls: some View {
        VStack(alignment: .trailing, spacing: 10) {
            HStack(alignment: .bottom, spacing: 8) {
                CityPicker(cities: areas, selection: $model.city, bordered: false)
                    .padding(4)
                    .modifier(GlassBackground(shape: Capsule()))
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("zonesCityPicker")
                Spacer(minLength: 8)
                MapGlassButton(systemImage: "line.3.horizontal.decrease", label: "Zone details") { showingDetails = true }
                    .accessibilityIdentifier("zoneDetailsButton")
            }
            HStack(alignment: .top, spacing: 8) {
                MapGlassButton(systemImage: "magnifyingglass", label: "Search places", active: place != nil) {
                    searchOpen = true
                }
                .accessibilityIdentifier("zoneSearchButton")
            }
        }
        .padding(.horizontal, 12).padding(.top, 8)
    }

    private var bottomControls: some View {
        VStack(alignment: .trailing, spacing: 10) {
            if model.mode == .heat { heatPanel }
            HStack(spacing: 8) {
                // The map key lives in Zone details only (as on the website).
                Spacer(minLength: 0)
                NavigationLink(value: ReplayRoute(city: model.city)) {
                    Label("Replay", systemImage: "play.fill").font(.inter(14, .bold))
                        .padding(.horizontal, 16).frame(height: MapControl.height)
                        .background(Color.brandGold, in: .rect(cornerRadius: MapControl.radius))
                        .shadow(color: .black.opacity(0.35), radius: 6, y: 2)
                        .foregroundStyle(Color(hex: 0x1A1204))
                }
                .accessibilityIdentifier("replayButton")
            }
            HStack(spacing: 0) {
                ForEach(ZonesModel.Mode.allCases) { m in
                    let on = model.mode == m
                    Button { withAnimation(.snappy) { model.mode = m } } label: {
                        Text(m == .normal ? "Normal Map" : "Heatmap").font(.inter(13.5, .semibold))
                            .padding(.horizontal, 14).frame(height: MapControl.height - 8)
                            .foregroundStyle(on ? Color(hex: 0x1A1204) : Color.chMist)
                            .background(on ? Color.brandGold : Color.clear, in: .rect(cornerRadius: MapControl.radius - 4))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(on ? .isSelected : [])
                    .accessibilityIdentifier(m == .normal ? "normalMapButton" : "heatmapButton")
                }
            }
            .padding(4)
            .modifier(GlassBackground(shape: RoundedRectangle(cornerRadius: MapControl.radius)))
            .sensoryFeedback(.selection, trigger: model.mode)
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 64)   // above the Liquid Glass tab bar
    }

    /// Heatmap details, like Zone details: a compact bar by default (what the map
    /// shows), expanding to the filters, hour, key and explanation. Collapsing
    /// only hides the panel; the heatmap and its filters stay as they are.
    @ViewBuilder private var heatPanel: some View {
        if heatExpanded { heatPanelFull } else { heatPanelCompact }
    }

    private var heatPanelCompact: some View {
        Button { withAnimation(.snappy) { heatExpanded = true } } label: {
            HStack(spacing: 10) {
                Image(systemName: "flame.fill").font(.system(size: 14)).foregroundStyle(Color(hex: 0xF97316))
                Text(model.heatStatus).font(.inter(12.5, .medium)).foregroundStyle(Color.chInk)
                    .lineLimit(2).multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.up").font(.system(size: 12, weight: .bold)).foregroundStyle(Color.chMist)
                    .frame(width: 30, height: 30).background(Color.chSurface2, in: .circle)
            }
            .padding(.leading, 14).padding(.trailing, 9).frame(minHeight: MapControl.height)
            .modifier(GlassBackground(shape: RoundedRectangle(cornerRadius: MapControl.radius)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Heatmap details. \(model.heatStatus)")
        .accessibilityHint("Shows the time range, hour and key")
        .accessibilityIdentifier("heatPanelExpand")
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    private var heatPanelFull: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("HEATMAP").font(.inter(11, .bold)).tracking(1.4).foregroundStyle(Color.chFog)
                Spacer()
                Button { withAnimation(.snappy) { heatExpanded = false } } label: {
                    Image(systemName: "chevron.down").font(.system(size: 12, weight: .bold)).foregroundStyle(Color.chMist)
                        .frame(width: 30, height: 30).background(Color.chSurface2, in: .circle)
                        .frame(width: 44, height: 36).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Hide heatmap details")
                .accessibilityIdentifier("heatPanelCollapse")
            }
            HStack(spacing: 6) {
                ForEach(HeatRange.allCases) { r in
                    let on = model.heatRange == r
                    Button { model.heatRange = r } label: {
                        Text(r.description).font(.inter(12, .semibold))
                            .frame(minWidth: 40, minHeight: 32)
                            .foregroundStyle(on ? Color(hex: 0x1A1204) : Color.chMist)
                            .background(on ? Color.brandGold : Color.chSurface2, in: .rect(cornerRadius: 8))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(r.phrase.prefix(1).uppercased() + r.phrase.dropFirst())
                    .accessibilityIdentifier("heatRange-\(r.rawValue)")
                    .accessibilityAddTraits(on ? .isSelected : [])
                }
                Spacer(minLength: 4)
                Menu {
                    Picker("Hour of day (Austin time)", selection: $model.heatHour) {
                        Text("All hours").tag(Int?.none)
                        ForEach(0..<24, id: \.self) { h in Text(ZonesModel.hourSpan(h)).tag(Int?.some(h)) }
                    }
                } label: {
                    HStack(spacing: 4) { Text(model.heatHour.map(ZonesModel.hourSpan) ?? "All hours"); Image(systemName: "chevron.up.chevron.down").font(.caption2) }
                        .font(.inter(12, .semibold)).foregroundStyle(Color.chMist)
                        .padding(.horizontal, 10).frame(minHeight: 32)
                        .background(Color.chSurface2, in: .rect(cornerRadius: 8))
                }
                .accessibilityLabel("Hour of day, Austin time")
            }
            HStack(spacing: 6) {
                Text("Fewer").font(.inter(10)).foregroundStyle(Color.chFog)
                LinearGradient(colors: [Color.brandGold.opacity(0.16), Color.brandGold.opacity(0.82), Color(hex: 0xF97316), Color(hex: 0xFF4500)], startPoint: .leading, endPoint: .trailing)
                    .frame(height: 6).clipShape(.capsule)
                Text("More detections").font(.inter(10)).foregroundStyle(Color.chFog)
            }
            .accessibilityHidden(true)
            Text(model.heatStatus).font(.inter(12, .medium)).foregroundStyle(Color.chInk).accessibilityIdentifier("heatStatus")
            Text("Where traffic cameras recorded Cybercabs. History, not live positions.").font(.inter(10)).foregroundStyle(Color.chFog)
        }
        .padding(12)
        .modifier(GlassBackground(shape: RoundedRectangle(cornerRadius: MapControl.radius)))
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

}

struct ReplayRoute: Hashable { let city: String }

// MARK: - Sheets

/// A tapped marker: a charging location, a camera's Cybercab capture, or (in
/// Heatmap mode) a camera's detections for the selection.
struct MapSelectionSheet: View {
    let selection: MapSelection
    let model: ZonesModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                switch selection {
                case .charging(let c):
                    Eyebrow(text: "Charging location")
                    Text(c.name).font(.inter(20, .bold)).foregroundStyle(Color.chInk)
                    Text(c.note).font(.inter(14)).foregroundStyle(Color.chMist)
                case .liveCamera(let d):
                    Eyebrow(text: "Cybercab spotted")
                    // The whole capture, aspect-fit and centred on a dark panel (never
                    // filled-and-cropped: in a scroll view that zoomed into its middle).
                    AsyncImage(url: d.imageURL) { phase in
                        if let image = phase.image {
                            image.resizable().aspectRatio(contentMode: .fit)
                                .frame(maxWidth: .infinity, maxHeight: 420)
                        } else if phase.error != nil || d.imageURL == nil {
                            Text("Capture image pending").font(.inter(12)).foregroundStyle(Color.chFog)
                                .frame(maxWidth: .infinity, minHeight: 180)
                        } else {
                            ProgressView().tint(Color.chFog).frame(maxWidth: .infinity, minHeight: 180)
                        }
                    }
                    .background(Color(hex: 0x0C1119)).clipShape(.rect(cornerRadius: 10))
                    .accessibilityElement()
                    .accessibilityAddTraits(.isImage)
                    .accessibilityLabel("Traffic camera capture of a Cybercab at \(d.cameraName)")
                    .accessibilityIdentifier("cameraCaptureImage")
                    Text(d.cameraName).font(.inter(17, .bold)).foregroundStyle(Color.chInk)
                    Text(Format.instant(d.observedAt).map { $0.formatted(Date.FormatStyle(timeZone: Format.central).month(.abbreviated).day().hour().minute().timeZone()) } ?? "")
                        .font(.inter(13)).foregroundStyle(Color.chMist)
                    Footnote(text: "Seen by the traffic camera at this spot in the last 24 hours: a camera sighting, not a live position. Camera captures don't identify which Cybercab it was.")
                case .heatCamera(let id, let name):
                    let cam = model.heatCamera(id)
                    let s = cam.map { CameraHeat.stats(for: $0, hour: model.heatHour) } ?? CameraHeat.Stats(count: 0, last: nil, busiestHour: nil, busiestDay: nil)
                    Eyebrow(text: "Traffic camera")
                    Text(cam?.cameraName ?? name).font(.inter(18, .bold)).foregroundStyle(Color.chInk)
                    if s.count > 0 {
                        row("Detections", Format.int(s.count))
                        if let last = s.last { row("Most recent", Format.dateTime(Format.instant(last)) + " CT") }
                        if let h = s.busiestHour, model.heatHour == nil { row("Busiest hour", ZonesModel.hourSpan(h)) }
                        if let d = s.busiestDay { row("Busiest day", ZonesModel.days[d]) }
                    } else {
                        Text("No Cybercab detections here in \(model.heatSpan).").font(.inter(13)).foregroundStyle(Color.chFog)
                    }
                    Footnote(text: "\(model.heatSpan.prefix(1).uppercased() + model.heatSpan.dropFirst()) · Austin time")
                }
            }
            .padding(20)
        }
        .appBackground()
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack { Text(label).font(.inter(13)).foregroundStyle(Color.chFog); Spacer(); Text(value).font(.inter(14, .semibold)).foregroundStyle(Color.chInk) }
            .padding(.vertical, 2)
    }
}

/// The website's zone panel: zone name, Operating, map key, coverage,
/// description, in service since, and Fleet & Fares.
struct ZoneDetailsSheet: View {
    let model: ZonesModel

    var body: some View {
        let city = model.cityData
        let facts = model.facts[city.key]?.area
        let fleet = model.fleet[city.key]
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 4) {
                        Eyebrow(text: "Service zone", color: .chFog)
                        Text("\(city.name.uppercased()), \(city.state)").displayTitle(24)
                    }
                    Spacer()
                    HStack(spacing: 6) { Circle().fill(Color.brandGold).frame(width: 7, height: 7); Text("OPERATING").font(.inter(11, .bold)).tracking(1) }
                        .foregroundStyle(Color.brandGold).padding(.horizontal, 10).padding(.vertical, 6)
                        .overlay(Capsule().strokeBorder(Color.brandGold.opacity(0.4)))
                }
                HStack(spacing: 14) {
                    Label { Text("Charging Locations") } icon: { Circle().fill(Color.brandGold).frame(width: 10, height: 10) }
                    Label { Text("Cybercabs") } icon: { Image("CybercabOverhead").resizable().frame(width: 18, height: 18) }
                }
                .font(.inter(13)).foregroundStyle(Color.chMist)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("zoneDetailsLegend")
                Rectangle().fill(Color.chLine).frame(height: 1)
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("COVERAGE").font(.inter(11, .semibold)).tracking(1.6).foregroundStyle(Color.chFog)
                        HStack(alignment: .firstTextBaseline, spacing: 4) {
                            Text(facts?.squareMiles.map { Format.int(Int($0)) } ?? "—").statNumber(38, color: .brandGold)
                            Text("mi²").font(.inter(16)).foregroundStyle(Color.brandGold)
                        }
                    }
                    Spacer()
                    Text("\(city.name.uppercased()) • LIVE FLEET").font(.inter(11, .semibold)).tracking(1.4).foregroundStyle(Color.chFog)
                }
                if let d = facts?.description { Text(d).font(.inter(14)).foregroundStyle(Color.chMist) }
                if let since = facts?.inServiceSince { Text("In service since \(Format.day(since))").font(.inter(13)).foregroundStyle(Color.chFog) }
                Rectangle().fill(Color.chLine).frame(height: 1)
                Text("FLEET & FARES").font(.inter(11, .semibold)).tracking(1.6).foregroundStyle(Color.chFog)
                MetricGrid(columns: 2) {
                    Metric(label: "Cybercabs", value: Format.int(fleet?.cybercabs))
                    Metric(label: "Median fare", value: Format.money(fleet?.fares?.medianFare))
                    Metric(label: "Avg fare", value: Format.money(fleet?.fares?.averageFare))
                    Metric(label: "Per mile", value: Format.money(fleet?.fares?.perMile))
                }
                Text(basis(fleet)).font(.inter(12)).foregroundStyle(Color.chFog)
            }
            .padding(20)
        }
        .appBackground()
    }

    /// "Based on 9 rides · updated Oct 16, 2026" (the site's fareBasis).
    private func basis(_ f: FleetStats?) -> String {
        guard let fares = f?.fares, let rides = fares.rides else { return "" }
        let updated = Format.instant(fares.computedAt).map { " · updated " + $0.formatted(Date.FormatStyle(timeZone: Format.central).month(.abbreviated).day().year()) } ?? ""
        return fares.medianFare == nil ? "No logged rides yet\(updated)" : "Based on \(Format.plural(rides, "ride", "rides"))\(updated)"
    }
}

// MARK: - Floating map controls

/// A circular Liquid Glass button for the map (iOS 26 glass; frosted material before).
/// One size for every floating map control: 48 pt tall (the city selector's
/// height), 14 pt corners on the rounded ones.
enum MapControl {
    static let height: CGFloat = 48
    static let radius: CGFloat = 14
}

struct MapGlassButton: View {
    let systemImage: String
    let label: String
    var active = false
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(active ? Color.brandGold : Color.chInk)
                .frame(width: MapControl.height, height: MapControl.height)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .modifier(GlassBackground(shape: Circle(), interactive: true))
        .accessibilityLabel(label)
    }
}

/// Liquid Glass behind a control on iOS 26 and later; frosted material with a hairline before.
struct GlassBackground<S: Shape>: ViewModifier {
    let shape: S
    var interactive = false
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
        } else {
            content.background(.ultraThinMaterial, in: shape).overlay(shape.stroke(Color.chHair2, lineWidth: 1))
        }
    }
}

/// The search sheet's glass: iOS 26 gives partial sheets Liquid Glass on its own;
/// earlier systems get a dark translucent material.
private struct SearchSheetBackground: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) { content } else { content.presentationBackground(.ultraThinMaterial) }
    }
}
