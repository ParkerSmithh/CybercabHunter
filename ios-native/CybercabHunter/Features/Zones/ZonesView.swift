import SwiftUI
import MapKit

/// Zones (the website's /infrastructure): the service-zone map for Austin and
/// Dallas with charging locations, camera-spotted Cybercabs, place search,
/// Normal Map / Heatmap, zone details with Fleet & Fares, and the Replay.
struct ZonesView: View {
    var initialHeat = false
    var initialCity: String? = nil
    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openSignIn) private var openSignIn
    /// Bumped when the rider comes back to the map (they may have just followed someone).
    @State private var followingRefresh = 0
    @State private var model = ZonesModel()
    @State private var location = LocationService.shared
    @State private var recenterID = 0
    @State private var locationTarget: CLLocationCoordinate2D?
    @State private var proximity: ZoneProximity.Result?
    @State private var statusOpen = false
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
        // navigation bar (the CybercabHunter brand and the Account button) and the
        // Liquid Glass tab bar. The controls stay inside the safe area.
        GeometryReader { geo in
            ZStack(alignment: .top) {
                ZoneMapView(cityKey: model.city, heatMode: model.mode == .heat, liveDetections: model.source == .following ? [] : (model.live[model.city] ?? []), followingSpots: model.followingSpots,
                            heatPoints: model.heatPoints, cameraDots: model.cameraDots, place: place, locationFix: location.location, recenterID: recenterID, locationTarget: locationTarget,
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
        .overlay { if model.source == .following && model.mode == .normal { followingOverlay } }
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
        .onChange(of: location.location?.timestamp) {
            guard let fix = location.location else { proximity = nil; return }
            locationTarget = fix.coordinate; recenterID += 1
            proximity = ZoneProximity.evaluate(fix, zones: WebData.zones.cities.map { .init(name: $0.name, polygons: [[$0.polygon]]) })
        }
        .background(Color.chBackground)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { BrandToolbarItem(identifier: "zonesBrand") }
        .navigationDestination(for: ReplayRoute.self) { ReplayView(route: $0) }
        .sheet(item: $selection) { sel in
            if case .following(let spot) = sel {
                FollowingSpotSheet(spot: spot) { selection = nil }.presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
            } else {
                MapSelectionSheet(selection: sel, model: model).presentationDetents([.medium]).presentationDragIndicator(.visible)
            }
        }
        .sheet(isPresented: $showingDetails) { ZoneDetailsSheet(model: model).presentationDetents([.medium, .large]).presentationDragIndicator(.visible) }
        // Live markers: now, then every 60 s while Zones is showing (as the site), per city.
        .task {
            if let initialCity, ["austin", "dallas"].contains(initialCity) { model.city = initialCity }
            if initialHeat { model.mode = .heat }
        }
        .task(id: model.city) {
            await model.loadPanel(using: session.api)
        }
        .task(id: "\(model.city)|\(scenePhase == .active)|\(model.source.rawValue)|\(session.user != nil)|\(followingRefresh)") {
            guard scenePhase == .active else { return }
            // Following asks once and never polls; All Sightings keeps its 60 s refresh.
            if model.source == .following {
                // The stored session, not `user`: offline, the account can't be loaded but
                // the rider is still signed in. The server's 401 is what says otherwise.
                await model.loadFollowing(using: session.api, signedIn: session.token != nil)
                return
            }
            while !Task.isCancelled {
                await model.loadLive(using: session.api)
                try? await Task.sleep(for: .seconds(60))
            }
        }
        .task(id: model.mode == .heat ? model.heatKey : "normal") {
            if model.mode == .heat { await model.loadHeat(using: session.api) }
        }
        .onChange(of: scenePhase) {
            if scenePhase == .background { location.cancel() }
            if scenePhase == .active { location.authorizationChanged() }
        }
        .onDisappear { location.cancel() }
        .onAppear { if let c = router.zonesCity { model.city = c; router.zonesCity = nil } }
        .onAppear { if model.source == .following { followingRefresh += 1 } }
        #if DEBUG
        .onAppear {
            let args = ProcessInfo.processInfo.arguments
            if let i = args.firstIndex(of: "-zoneStatusFixture"), i + 1 < args.count {
                let fixture = args[i + 1]
                if fixture == "unavailable" { proximity = .init(text: "Location unavailable", nearest: nil) }
                else if ["dallas", "austin", "outside"].contains(fixture) {
                    model.city = fixture == "austin" ? "austin" : "dallas"
                    let fix = fixture == "dallas" ? CLLocation(latitude: 32.80, longitude: -96.80)
                        : fixture == "austin" ? CLLocation(latitude: 30.27, longitude: -97.75)
                        : CLLocation(latitude: 31, longitude: -100)
                    proximity = ZoneProximity.evaluate(fix, zones: WebData.zones.cities.map { .init(name: $0.name, polygons: [[$0.polygon]]) })
                }
            }
        }
        #endif
        // Siri / Apple Intelligence: the map shows this city's service zone ("how big is this service area?").
        .modifier(OnscreenEntity(ServiceZoneEntity.self, id: model.city))
        .onChange(of: model.city, initial: true) {
            if let c = ServiceCity(rawValue: model.city) { SiriDonations.donate("zone-\(c.rawValue)", ServiceZoneIntent(city: c)) }
        }
        .onChange(of: router.zonesCity) { _, c in if let c { model.city = c; router.zonesCity = nil } }
        .onChange(of: model.city) { place = nil; selection = nil; model.clearFollowing() }
        #if DEBUG
        .onAppear { if ProcessInfo.processInfo.arguments.contains("-zonesFollowing") { model.source = .following } }
        #endif
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
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 0) {
                    if location.requesting || location.message != nil || proximity != nil {
                        zoneStatus
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
                VStack(spacing: 10) {
                    MapGlassButton(systemImage: "magnifyingglass", label: "Search places", active: place != nil) {
                        searchOpen = true
                    }.accessibilityIdentifier("zoneSearchButton")
                    MapGlassButton(systemImage: "location.fill", label: "My Location", active: location.location != nil) {
                        location.request()
                    }.accessibilityIdentifier("zoneMyLocationButton")
                }
            }
        }
        .padding(.horizontal, 12).padding(.top, 8)
    }

    private var zoneStatus: some View {
        Button { statusOpen = true } label: {
            Text(ZoneStatusText.headline(proximity, requesting: location.requesting))
                .font(.system(.caption2, design: .default, weight: .semibold))
                .tracking(0.3)
                .foregroundStyle(Color.brandGold)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 9).padding(.vertical, 7)
                .background(Color.chBackground.opacity(0.96), in: .rect(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.chHair2, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("zoneStatusBadge")
        .accessibilityHint("Shows zone details, distance and location options")
        .popover(isPresented: $statusOpen, attachmentAnchor: .rect(.bounds), arrowEdge: .top) {
            VStack(alignment: .leading, spacing: 12) {
                if let proximity {
                    Text(proximity.text.uppercased()).font(.caption).foregroundStyle(Color.brandGold)
                    if let point = proximity.nearest {
                        Button("View Nearest Zone") {
                            locationTarget = point; recenterID += 1; statusOpen = false
                        }.accessibilityIdentifier("viewNearestZone")
                    }
                    Text("Mapped coverage does not guarantee ride availability.").font(.caption).foregroundStyle(Color.chMist)
                }
                LocationFeedback(service: location)
            }
            .padding(16).frame(idealWidth: 290, maxWidth: 320)
            .presentationCompactAdaptation(.popover)
            .presentationBackground(Color.chBackground)
        }
    }

    /// What Following has to say when there is nothing, or something missing, to draw.
    @ViewBuilder private var followingOverlay: some View {
        switch model.following {
        case .idle, .loading:
            EmptyView()
        case .signedOut:
            followingCard(title: "Sign in to see Following", text: "Sign in to see sightings from people you follow. The public map stays open to everyone.") {
                Button("Sign in") { openSignIn() }.buttonStyle(ZoneCardButton(gold: true)).accessibilityIdentifier("followingSignIn")
            }
        case .failed:
            followingCard(title: "Couldn't load Following", text: "Check your connection and try again. All Sightings still works.") {
                Button("Try again") { followingRefresh += 1 }.buttonStyle(ZoneCardButton(gold: true)).accessibilityIdentifier("followingRetry")
            }
        case .loaded(let page):
            if page.followingCount == 0 {
                followingCard(title: "NO FOLLOWED SPOTTERS YET", text: "Follow other Cybercab spotters to see their sightings on this map.") {
                    Button("Find spotters") { router.openCommunity(.leaderboard) }.buttonStyle(ZoneCardButton(gold: true)).accessibilityIdentifier("followingFindSpotters")
                }
            } else if page.sightings.isEmpty {
                followingCard(title: "NO SIGHTINGS FROM FOLLOWED USERS IN THIS AREA",
                              text: page.unplaced.isEmpty ? "The people you follow have no recent approved sightings here."
                                : "\(Format.plural(page.unplaced.count, "recent sighting has", "recent sightings have")) no map position, so nothing is shown here.") { EmptyView() }
            } else if !page.unplaced.isEmpty {
                VStack {
                    Spacer()
                    Text("\(Format.plural(page.unplaced.count, "more sighting has", "more sightings have")) no map position")
                        .font(.inter(12, .medium)).foregroundStyle(Color.chMist)
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .background(Color.chBackground.opacity(0.92), in: .capsule)
                        .padding(.bottom, 130)
                }
                .allowsHitTesting(false)
                .accessibilityIdentifier("followingUnplacedNote")
            }
        }
    }

    private func followingCard<Actions: View>(title: String, text: String, @ViewBuilder actions: () -> Actions) -> some View {
        VStack(spacing: 8) {
            Text(title).font(.inter(16, .bold)).foregroundStyle(Color.chInk).multilineTextAlignment(.center)
                .accessibilityIdentifier("followingEmptyTitle")
            Text(text).font(.inter(13.5)).foregroundStyle(Color.chMist).multilineTextAlignment(.center)
            HStack(spacing: 8) {
                actions()
                Button("All Sightings") { withAnimation(.snappy) { model.source = .all } }.buttonStyle(ZoneCardButton(gold: false))
                    .accessibilityIdentifier("followingBackToAll")
            }
            .padding(.top, 4)
        }
        .padding(16)
        .frame(maxWidth: 320)
        .background(Color.chBackground.opacity(0.94), in: .rect(cornerRadius: MapControl.radius))
        .overlay(RoundedRectangle(cornerRadius: MapControl.radius).strokeBorder(Color.brandGold.opacity(0.3)))
        .padding(.horizontal, 24)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("followingEmptyCard")
    }

    /// One choice, on one row with Replay: All Sightings (the normal map), Following
    /// (the normal map, from followed accounts) or Heatmap (camera history).
    private enum MapView: CaseIterable, Identifiable {
        case all, following, heat
        var id: Self { self }
        var identifier: String {
            switch self {
            case .all: "mapSourceAll"
            case .following: "mapSourceFollowing"
            case .heat: "heatmapButton"
            }
        }
        func title(short: Bool) -> String {
            switch self {
            case .all: short ? "All" : "All Sightings"
            case .following: "Following"
            case .heat: "Heatmap"
            }
        }
    }

    private var mapView: MapView { model.mode == .heat ? .heat : model.source == .following ? .following : .all }

    private func choose(_ view: MapView) {
        withAnimation(.snappy) {
            model.mode = view == .heat ? .heat : .normal
            model.source = view == .following ? .following : .all
        }
    }

    private func mapViewPicker(short: Bool) -> some View {
        HStack(spacing: 0) {
            ForEach(MapView.allCases) { option in
                let on = mapView == option
                Button { choose(option) } label: {
                    Text(option.title(short: short)).font(.inter(13.5, .semibold)).lineLimit(1).fixedSize()
                        .padding(.horizontal, 12).frame(height: MapControl.height - 8)
                        .foregroundStyle(on ? Color(hex: 0x1A1204) : Color.chMist)
                        .background(on ? Color.brandGold : Color.clear, in: .rect(cornerRadius: MapControl.radius - 4))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(option.title(short: false))
                .accessibilityAddTraits(on ? .isSelected : [])
                .accessibilityIdentifier(option.identifier)
            }
        }
        .padding(4)
        .modifier(GlassBackground(shape: RoundedRectangle(cornerRadius: MapControl.radius)))
        .sensoryFeedback(.selection, trigger: mapView)
    }

    private var bottomControls: some View {
        VStack(alignment: .trailing, spacing: 10) {
            if model.mode == .heat { heatPanel }
            HStack(spacing: 8) {
                // The map key lives in Zone details only (as on the website).
                ViewThatFits(in: .horizontal) {
                    mapViewPicker(short: false)
                    mapViewPicker(short: true)
                }
                Spacer(minLength: 0)
                NavigationLink(value: ReplayRoute(city: model.city)) {
                    Image(systemName: "play.fill").font(.system(size: 16, weight: .bold))
                        .frame(width: MapControl.height, height: MapControl.height)
                        .background(Color.brandGold, in: .rect(cornerRadius: MapControl.radius))
                        .shadow(color: .black.opacity(0.35), radius: 6, y: 2)
                        .foregroundStyle(Color(hex: 0x1A1204))
                }
                .accessibilityLabel("Replay")
                .accessibilityIdentifier("replayButton")
            }
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

private struct ZoneCardButton: ButtonStyle {
    let gold: Bool
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.inter(13.5, .semibold))
            .padding(.horizontal, 14).frame(minHeight: 40)
            .foregroundStyle(gold ? Color(hex: 0x1A1204) : Color.chInk)
            .background(gold ? Color.brandGold : Color.clear, in: .rect(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(gold ? Color.clear : Color.chHair2))
            .opacity(configuration.isPressed ? 0.8 : 1)
    }
}

/// A tapped Following marker: the sighting's permitted facts, the links to the
/// vehicle and the spotter, and any other sightings the marker stands for.
struct FollowingSpotSheet: View {
    let spot: FollowingMapSpot
    let close: () -> Void
    @Environment(AppRouter.self) private var router

    var body: some View {
        ScrollView {
            if let s = spot.sightings.first {
                VStack(alignment: .leading, spacing: 10) {
                    Eyebrow(text: "Spotted by someone you follow")
                    AsyncImage(url: s.gallery.imageURL) { phase in
                        if let image = phase.image {
                            image.resizable().aspectRatio(contentMode: .fit).frame(maxWidth: .infinity, maxHeight: 300)
                        } else if phase.error != nil {
                            Text("Photo unavailable").font(.inter(12)).foregroundStyle(Color.chFog).frame(maxWidth: .infinity, minHeight: 160)
                        } else {
                            ProgressView().tint(Color.chFog).frame(maxWidth: .infinity, minHeight: 160)
                        }
                    }
                    .background(Color(hex: 0x0C1119)).clipShape(.rect(cornerRadius: 10))
                    .accessibilityElement().accessibilityAddTraits(.isImage)
                    .accessibilityLabel("Photo of a Cybercab\(s.location.map { " at \($0)" } ?? "")")
                    .accessibilityIdentifier("followingSightingPhoto")
                    Text(s.plate ?? "Cybercab sighting").font(.inter(20, .bold)).foregroundStyle(Color.chInk)
                        .accessibilityIdentifier("followingSightingTitle")
                    Text(s.gallery.spottedText).font(.inter(13)).foregroundStyle(Color.chMist)
                    if let location = s.location { Text(location).font(.inter(14)).foregroundStyle(Color.chMist) }
                    links(s)
                    if spot.sightings.count > 1 { others }
                    Footnote(text: "A past sighting at about this spot: not a live position.")
                }
                .padding(20)
            }
        }
        .appBackground()
    }

    @ViewBuilder private func links(_ s: FollowingMapPage.Sighting) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let handle = s.spotter.handle {
                Button { close(); router.open(.rider(RiderRoute(handle: handle))) } label: {
                    Label("Spotted by \(s.spotter.name)", systemImage: "person.crop.circle").font(.inter(14, .semibold)).foregroundStyle(Color.brandGold)
                }
                .frame(minHeight: 36)
                .accessibilityIdentifier("followingSpotterLink")
            } else {
                Text("Spotted by \(s.spotter.name)").font(.inter(14, .semibold)).foregroundStyle(Color.chInk)
            }
            if let id = s.vehicleId {
                Button { close(); router.openVehicle(id: id, plate: s.plate) } label: {
                    Label("View this Cybercab", systemImage: "car.fill").font(.inter(14, .semibold)).foregroundStyle(Color.brandGold)
                }
                .frame(minHeight: 36)
                .accessibilityIdentifier("followingVehicleLink")
            }
        }
    }

    private var others: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("ALSO SPOTTED").font(.inter(11, .semibold)).tracking(1.4).foregroundStyle(Color.chFog)
            ForEach(spot.sightings.dropFirst()) { m in
                Text("\(m.spotter.name): \(m.gallery.spottedText)\(m.location.map { ", \($0)" } ?? "")")
                    .font(.inter(13)).foregroundStyle(Color.chMist)
            }
        }
        .padding(.top, 6)
        .accessibilityIdentifier("followingOtherSightings")
    }
}

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
                case .following:
                    EmptyView()   // FollowingSpotSheet shows these
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
