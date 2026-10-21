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
    @State private var query = ""
    @State private var suggestions: [PlaceResults.Place] = []
    @State private var place: PlaceResults.Place?
    @FocusState private var searching: Bool

    private let areas = [ServiceArea(key: "austin", name: "Austin"), ServiceArea(key: "dallas", name: "Dallas")]

    var body: some View {
        ZStack(alignment: .top) {
            ZoneMapView(cityKey: model.city, heatMode: model.mode == .heat, liveDetections: model.live[model.city] ?? [],
                        heatPoints: model.heatPoints, cameraDots: model.cameraDots, place: place, bottomInset: model.mode == .heat ? 170 : 90) { selection = $0 }
                .ignoresSafeArea(edges: .bottom)
                .accessibilityIdentifier("zonesMap")
            topControls
        }
        .overlay(alignment: .bottom) { bottomControls }
        .background(Color.chBackground)
        .navigationTitle("Zones")
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
        .onChange(of: router.zonesCity) { _, c in if let c { model.city = c; router.zonesCity = nil } }
        .onChange(of: model.city) { query = ""; suggestions = []; place = nil; selection = nil }
        .task(id: query) { await search() }
    }

    // MARK: controls

    private var topControls: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                CityPicker(cities: areas, selection: $model.city)
                Spacer(minLength: 0)
                Button { showingDetails = true } label: {
                    Label("Zone details", systemImage: "line.3.horizontal.decrease")
                        .font(.inter(13, .semibold)).foregroundStyle(Color.chInk)
                        .padding(.horizontal, 12).frame(minHeight: 40)
                        .background(.ultraThinMaterial, in: .capsule)
                        .overlay(Capsule().strokeBorder(Color.chHair2))
                }
                .accessibilityIdentifier("zoneDetailsButton")
            }
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(Color.chFog)
                TextField("Search \(model.cityData.name) places", text: $query)
                    .focused($searching).submitLabel(.search).autocorrectionDisabled()
                    .font(.inter(15)).foregroundStyle(Color.chInk)
                    .onSubmit { if let first = suggestions.first { pick(first) } }
                if !query.isEmpty || place != nil {
                    Button { query = ""; suggestions = []; place = nil } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Color.chFog) }
                        .accessibilityLabel("Clear search")
                }
            }
            .padding(.horizontal, 12).frame(minHeight: 42)
            .background(.ultraThinMaterial, in: .rect(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.chHair2))
            if searching && !suggestions.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(suggestions) { p in
                        Button { pick(p) } label: {
                            Text(p.label).font(.inter(14)).foregroundStyle(Color.chInk).lineLimit(1)
                                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).padding(.vertical, 10)
                        }
                        .buttonStyle(.plain)
                        if p != suggestions.last { Divider().overlay(Color.chLine) }
                    }
                }
                .background(Color.chSurface.opacity(0.96), in: .rect(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.chHair2))
            }
        }
        .padding(.horizontal, 12).padding(.top, 8)
    }

    private var bottomControls: some View {
        VStack(alignment: .trailing, spacing: 8) {
            if model.mode == .heat { heatPanel }
            HStack(spacing: 8) {
                if model.mode == .normal {
                    HStack(spacing: 10) {
                        Label { Text("Charging").font(.inter(11, .medium)) } icon: { Circle().fill(Color.brandGold).frame(width: 9, height: 9) }
                        Label { Text("Cybercabs").font(.inter(11, .medium)) } icon: { Image("CybercabOverhead").resizable().frame(width: 15, height: 15) }
                    }
                    .labelStyle(.titleAndIcon).foregroundStyle(Color.chMist)
                    .padding(.horizontal, 10).frame(minHeight: 34)
                    .background(.ultraThinMaterial, in: .capsule)
                    .accessibilityElement(children: .combine).accessibilityLabel("Map key: gold dots are charging locations, Cybercab icons are camera sightings in the last 24 hours")
                }
                Spacer(minLength: 0)
                NavigationLink(value: ReplayRoute(city: model.city)) {
                    Label("Replay", systemImage: "play.fill").font(.inter(13, .bold))
                        .padding(.horizontal, 14).frame(minHeight: 40)
                        .background(Color.brandGold, in: .rect(cornerRadius: 12))
                        .foregroundStyle(Color(hex: 0x1A1204))
                }
                .accessibilityIdentifier("replayButton")
            }
            HStack(spacing: 0) {
                ForEach(ZonesModel.Mode.allCases) { m in
                    let on = model.mode == m
                    Button { withAnimation(.snappy) { model.mode = m } } label: {
                        Text(m == .normal ? "Normal Map" : "Heatmap").font(.inter(13, .semibold))
                            .padding(.horizontal, 14).frame(minHeight: 38)
                            .foregroundStyle(on ? Color(hex: 0x1A1204) : Color.chMist)
                            .background(on ? Color.brandGold : Color.clear, in: .rect(cornerRadius: 10))
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(on ? .isSelected : [])
                    .accessibilityIdentifier(m == .normal ? "normalMapButton" : "heatmapButton")
                }
            }
            .padding(4)
            .background(.ultraThinMaterial, in: .rect(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.chHair2))
            .sensoryFeedback(.selection, trigger: model.mode)
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 64)   // above the Liquid Glass tab bar
    }

    private var heatPanel: some View {
        VStack(alignment: .leading, spacing: 8) {
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
        .background(.ultraThinMaterial, in: .rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.chHair2))
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    // MARK: search (GET /api/places/map, 3+ letters, debounced)

    private func search() async {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard q.count >= 3, place?.label != query else { suggestions = []; return }
        try? await Task.sleep(for: .milliseconds(250))
        guard !Task.isCancelled else { return }
        var items = [URLQueryItem(name: "v", value: "2"), URLQueryItem(name: "q", value: q)]
        if model.city != "austin" { items.append(URLQueryItem(name: "area", value: model.city)) }
        if let r: PlaceResults = try? await session.api.get("/api/places/map", query: items) { suggestions = Array(r.places.prefix(6)) }
    }

    private func pick(_ p: PlaceResults.Place) {
        place = p
        query = p.label
        suggestions = []
        searching = false
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
                    AsyncImage(url: d.imageURL) { phase in
                        if let image = phase.image { image.resizable().scaledToFill() }
                        else if phase.error != nil || d.imageURL == nil { Text("Capture image pending").font(.inter(12)).foregroundStyle(Color.chFog) }
                        else { ProgressView().tint(Color.chFog) }
                    }
                    .frame(maxWidth: .infinity).aspectRatio(16 / 9, contentMode: .fit)
                    .background(Color(hex: 0x0C1119)).clipShape(.rect(cornerRadius: 10))
                    .accessibilityLabel("Traffic camera capture of a Cybercab at \(d.cameraName)")
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
