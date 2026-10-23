import SwiftUI
import MapKit
import Charts

/// The Replay screen: map, the clock and count, the activity ribbon (drag to
/// scrub), play / speed / window controls. Pushed from Zones.
struct ReplayView: View {
    let route: ReplayRoute
    @Environment(SessionStore.self) private var session
    @State private var model: ReplayModel
    @State private var projection = MapProjection()
    @State private var pickingDate = false
    @AppStorage("replayAppearance") private var appearanceRaw = ReplayAppearance.auto.rawValue
    private var appearance: ReplayAppearance { ReplayAppearance(rawValue: appearanceRaw) ?? .auto }

    init(route: ReplayRoute) {
        self.route = route
        _model = State(initialValue: ReplayModel(city: route.city))
    }

    var body: some View {
        let city = WebData.city(route.city)
        TimelineView(.animation(paused: !model.playing)) { context in
            let t = model.time(at: context.date)
            let shown = model.count(upTo: t)
            VStack(spacing: 0) {
                header(city: city, t: t, shown: shown)
                ZStack {
                    ReplayMapView(cityKey: city.key, dark: appearance.darkMap, projection: $projection)
                    // The sky over the map (under every mark), by the replay's time or the chosen look.
                    ReplaySky.gradient(appearance.fixedHour ?? ReplayModel.hour(t))
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                    ReplayLayer(model: model, t: t, shown: shown, projection: projection)
                        .allowsHitTesting(false)
                    overlayMessage
                }
                .clipShape(.rect(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.chLine))
                .padding(.horizontal, 12)
                ribbon(t: t)
                controls
            }
            .onChange(of: context.date) { _, now in model.tick(now: now) }
        }
        .background(Color.chBackground.ignoresSafeArea())
        .navigationTitle("Replay")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: "\(model.range.rawValue)|\(model.date?.timeIntervalSince1970 ?? 0)") { await model.load(using: session.api) }
        .sheet(isPresented: $pickingDate) { datePicker.presentationDetents([.medium]) }
    }

    private func header(city: WebData.City, t: Date, shown: Int) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Eyebrow(text: "Sightings replay", accent: city.name)
                    Text(model.range.description.uppercased()).displayTitle(20)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text(Format.int(shown)).statNumber(28, color: .brandGold).contentTransition(.numericText(value: Double(shown)))
                        .accessibilityIdentifier("replayCount")
                    Text(shown == 1 ? "sighting" : "sightings").font(.inter(11)).foregroundStyle(Color.chFog)
                }
            }
            HStack(spacing: 8) {
                Text(t.formatted(Date.FormatStyle(timeZone: Format.central).month(.abbreviated).day().hour().minute()))
                    .font(.geistMono(13)).foregroundStyle(Color.chInk)
                let phase = ReplayModel.dayPart(t)
                Text(phase.uppercased()).font(.inter(9, .bold)).tracking(1)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .foregroundStyle(ReplaySky.chip(phase).text)
                    .background(ReplaySky.chip(phase).fill, in: .capsule)
                    .accessibilityIdentifier("replayPhase")
                Spacer()
                Text("CT").font(.inter(11)).foregroundStyle(Color.chFog)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
    }

    @ViewBuilder private var overlayMessage: some View {
        switch model.phase {
        case .idle, .loading: ProgressView("Loading sightings…").tint(Color.chFog).foregroundStyle(Color.chFog).padding().background(.ultraThinMaterial, in: .rect(cornerRadius: 12))
        case .failed(let m):
            VStack(spacing: 8) {
                InlineMessage(text: m, systemImage: "wifi.exclamationmark")
                Button("Try again") { Task { await model.load(using: session.api) } }.foregroundStyle(Color.brandGold)
            }
            .padding().background(.ultraThinMaterial, in: .rect(cornerRadius: 12))
        case .loaded where model.sightings.isEmpty:
            Text("No camera sightings in this window.").font(.inter(13)).foregroundStyle(Color.chMist).padding().background(.ultraThinMaterial, in: .rect(cornerRadius: 12))
        default: EmptyView()
        }
    }

    /// The activity ribbon: a histogram of the window, gold behind the playhead.
    private func ribbon(t: Date) -> some View {
        let bins = model.histogram()
        let span = model.window.end.timeIntervalSince(model.window.start)
        let progress = span > 0 ? t.timeIntervalSince(model.window.start) / span : 0
        return VStack(alignment: .leading, spacing: 4) {
            Chart(Array(bins.enumerated()), id: \.offset) { i, n in
                BarMark(x: .value("Bin", i), y: .value("Sightings", n))
                    .foregroundStyle(Double(i + 1) / Double(max(1, bins.count)) <= progress + 0.0001 ? Color.brandGold : Color.chSmoke)
            }
            .chartXAxis(.hidden).chartYAxis(.hidden)
            .chartXScale(domain: -0.5...(Double(bins.count) - 0.5))
            .chartOverlay { proxy in
                GeometryReader { geo in
                    Rectangle().fill(.clear).contentShape(.rect)
                        .gesture(DragGesture(minimumDistance: 0).onChanged { g in
                            let x = min(max(0, g.location.x), geo.size.width) / max(1, geo.size.width)
                            model.seek(to: model.window.start.addingTimeInterval(span * x))
                        })
                    Rectangle().fill(Color.chInk).frame(width: 2).offset(x: geo.size.width * progress - 1)
                }
            }
            .frame(height: 56)
            .accessibilityElement()
            .accessibilityLabel("Activity over the window")
            .accessibilityValue("\(Int(progress * 100)) percent through")
            .accessibilityAdjustableAction { dir in
                let step = span / 20
                let now = model.time(at: .now)
                model.seek(to: now.addingTimeInterval(dir == .increment ? step : -step))
            }
            HStack {
                Text(model.window.start.formatted(Date.FormatStyle(timeZone: Format.central).month(.abbreviated).day()))
                Spacer()
                Text(model.window.end.formatted(Date.FormatStyle(timeZone: Format.central).month(.abbreviated).day().hour()))
            }
            .font(.inter(10)).foregroundStyle(Color.chCaption)
        }
        .padding(.horizontal, 16).padding(.top, 10)
    }

    private var controls: some View {
        VStack(spacing: 10) {
            HStack(spacing: 12) {
                Button { model.togglePlay() } label: {
                    Image(systemName: model.playing ? "pause.fill" : "play.fill").font(.title3)
                        .frame(width: 52, height: 44).background(Color.brandGold, in: .rect(cornerRadius: 12)).foregroundStyle(Color(hex: 0x1A1204))
                }
                .accessibilityLabel(model.playing ? "Pause" : "Play")
                .accessibilityIdentifier("replayPlay")
                .disabled(model.sightings.isEmpty)
                Button { model.seek(to: model.window.start) } label: {
                    Image(systemName: "backward.end.fill").frame(width: 44, height: 44).background(Color.chSurface2, in: .rect(cornerRadius: 12)).foregroundStyle(Color.chMist)
                }
                .accessibilityLabel("Back to the start")
                HStack(spacing: 4) {
                    ForEach(Array(ReplayModel.speeds.enumerated()), id: \.offset) { i, s in
                        let on = model.speedIndex == i
                        Button { model.setSpeed(i) } label: {
                            Text("\(Int(s))×").font(.inter(12, .semibold)).frame(minWidth: 38, minHeight: 34)
                                .foregroundStyle(on ? Color(hex: 0x1A1204) : Color.chMist)
                                .background(on ? Color.brandGold : Color.chSurface2, in: .rect(cornerRadius: 8))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Speed \(Int(s)) times")
                        .accessibilityAddTraits(on ? .isSelected : [])
                    }
                }
            }
            // The map's look: Auto follows the replay's clock (the website's sky).
            HStack(spacing: 6) {
                Text("Map").font(.inter(12, .semibold)).foregroundStyle(Color.chFog)
                ForEach(ReplayAppearance.allCases) { a in
                    let on = appearance == a
                    Button { withAnimation(.easeInOut(duration: 0.25)) { appearanceRaw = a.rawValue } } label: {
                        Text(a.title).font(.inter(12, .semibold)).lineLimit(1)
                            .frame(maxWidth: .infinity, minHeight: 32)
                            .foregroundStyle(on ? Color(hex: 0x1A1204) : Color.chMist)
                            .background(on ? Color.brandGold : Color.chSurface2, in: .rect(cornerRadius: 8))
                            .frame(minHeight: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(a == .auto ? "Map look: automatic, follows the replay's time" : "Map look: \(a.title)")
                    .accessibilityAddTraits(on ? .isSelected : [])
                    .accessibilityIdentifier("replayLook-\(a.rawValue)")
                }
            }
            HStack(spacing: 8) {
                Picker("Window", selection: $model.range) { ForEach(ReplayModel.Range.allCases) { Text($0.description).tag($0) } }
                    .pickerStyle(.segmented)
                Button { pickingDate = true } label: {
                    Image(systemName: model.date == nil ? "calendar" : "calendar.badge.clock").frame(width: 40, height: 32)
                }
                .accessibilityLabel(model.date == nil ? "Choose a date" : "Date chosen")
            }
            Text("Each mark is a recorded sighting at the camera that saw it; nothing is drawn moving between sightings.")
                .font(.inter(10)).foregroundStyle(Color.chCaption).frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 16).padding(.top, 10).padding(.bottom, 12)
    }

    private var datePicker: some View {
        NavigationStack {
            DatePicker(model.range == .month ? "Month of" : "Ending", selection: Binding(get: { model.date ?? .now }, set: { model.date = $0 }), in: ...Date.now, displayedComponents: .date)
                .datePickerStyle(.graphical).tint(Color.brandGold).padding()
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Now") { model.date = nil; pickingDate = false } }
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { pickingDate = false } }
                }
                .appBackground()
        }
    }
}

/// Map points → view points for the Canvas layer (no rotation on these maps).
struct MapProjection: Equatable {
    var rect = MKMapRect.null
    var size = CGSize.zero
    static func == (a: MapProjection, b: MapProjection) -> Bool {
        a.size == b.size && a.rect.origin.x == b.rect.origin.x && a.rect.origin.y == b.rect.origin.y && a.rect.size.width == b.rect.size.width && a.rect.size.height == b.rect.size.height
    }
    func point(_ c: CLLocationCoordinate2D) -> CGPoint? {
        guard !rect.isNull, rect.width > 0, rect.height > 0 else { return nil }
        let p = MKMapPoint(c)
        return CGPoint(x: (p.x - rect.minX) / rect.width * size.width, y: (p.y - rect.minY) / rect.height * size.height)
    }
}

/// The Replay's map: the quiet zone, no markers (the Canvas draws them).
struct ReplayMapView: UIViewRepresentable {
    let cityKey: String
    /// The dark map (with the Dark Matter dimming) or the light one.
    var dark = true
    @Binding var projection: MapProjection

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> MKMapView {
        let map = MKMapView()
        map.delegate = context.coordinator
        map.overrideUserInterfaceStyle = dark ? .dark : .light
        let config = MKStandardMapConfiguration(elevationStyle: .flat, emphasisStyle: .muted)
        config.pointOfInterestFilter = .excludingAll
        map.preferredConfiguration = config
        map.isRotateEnabled = false; map.isPitchEnabled = false; map.showsCompass = false
        if dark { map.addOverlay(DarkMatterOverlay(), level: .aboveRoads) }
        var coords = WebData.city(cityKey).polygon
        let zone = ZonePolygon(coordinates: &coords, count: coords.count)
        zone.cityKey = cityKey; zone.dimmed = true
        map.addOverlay(zone, level: .aboveRoads)
        map.setVisibleMapRect(WebData.city(cityKey).zoneRect, edgePadding: UIEdgeInsets(top: 20, left: 20, bottom: 20, right: 20), animated: false)
        return map
    }
    func updateUIView(_ map: MKMapView, context: Context) {
        context.coordinator.parent = self
        // Day / Dusk / Night: switch the map's look in place (the zone and the view stay).
        let style: UIUserInterfaceStyle = dark ? .dark : .light
        if map.overrideUserInterfaceStyle != style { map.overrideUserInterfaceStyle = style }
        let dimming = map.overlays.filter { $0 is DarkMatterOverlay }
        if dark && dimming.isEmpty { map.insertOverlay(DarkMatterOverlay(), at: 0, level: .aboveRoads) }
        if !dark && !dimming.isEmpty { map.removeOverlays(dimming) }
    }

    final class Coordinator: NSObject, MKMapViewDelegate {
        var parent: ReplayMapView
        init(_ parent: ReplayMapView) { self.parent = parent }
        func mapView(_ mapView: MKMapView, rendererFor overlay: MKOverlay) -> MKOverlayRenderer {
            if let z = overlay as? ZonePolygon { let r = ZoneRenderer(zone: z); r.alpha = 0.6; return r }
            if overlay is DarkMatterOverlay { return DarkMatterRenderer(overlay: overlay) }
            return MKOverlayRenderer(overlay: overlay)
        }
        func mapViewDidChangeVisibleRegion(_ mapView: MKMapView) { publish(mapView) }
        func mapView(_ mapView: MKMapView, regionDidChangeAnimated animated: Bool) { publish(mapView) }
        private func publish(_ map: MKMapView) {
            let p = MapProjection(rect: map.visibleMapRect, size: map.bounds.size)
            if p != parent.projection { parent.projection = p }
        }
    }
}

/// Everything that moves in the Replay, on one Canvas: every camera as a dim
/// dot, lit gold once a sighting lands there (bigger with more), a landing
/// ping for recent sightings, and the mark of the latest sighting at each
/// camera (the Cybercab icon for the camera watch, a gold diamond for a spotter).
struct ReplayLayer: View {
    let model: ReplayModel
    let t: Date
    let shown: Int
    let projection: MapProjection

    var body: some View {
        Canvas { ctx, _ in
            let gold = Color.brandGold
            for cam in model.cameras {
                guard let p = projection.point(.init(latitude: cam.lat, longitude: cam.lng)) else { continue }
                ctx.fill(Path(ellipseIn: CGRect(x: p.x - 2, y: p.y - 2, width: 4, height: 4)), with: .color(Color.chFog.opacity(0.45)))
            }
            var perCamera: [String: (count: Int, last: ReplayModel.Sighting)] = [:]
            for s in model.sightings.prefix(shown) { perCamera[s.cameraKey] = ((perCamera[s.cameraKey]?.count ?? 0) + 1, s) }
            let icon = ctx.resolve(Image("CybercabOverhead"))
            for (_, v) in perCamera {
                guard let p = projection.point(v.last.coordinate) else { continue }
                let glow = 8 + CGFloat(v.count).squareRoot() * 5
                ctx.fill(Path(ellipseIn: CGRect(x: p.x - glow, y: p.y - glow, width: glow * 2, height: glow * 2)), with: .radialGradient(Gradient(colors: [gold.opacity(0.45), gold.opacity(0)]), center: p, startRadius: 0, endRadius: glow))
                if v.last.spotter {
                    var d = Path(); d.move(to: CGPoint(x: p.x, y: p.y - 6)); d.addLine(to: CGPoint(x: p.x + 6, y: p.y)); d.addLine(to: CGPoint(x: p.x, y: p.y + 6)); d.addLine(to: CGPoint(x: p.x - 6, y: p.y)); d.closeSubpath()
                    ctx.fill(d, with: .color(gold))
                } else {
                    ctx.draw(icon, in: CGRect(x: p.x - 9, y: p.y - 9, width: 18, height: 18))
                }
            }
            // Landing pings: sightings within the last ~1.1 s of real time.
            let pingSpan = 1.1 * model.rate
            var i = shown - 1
            while i >= 0, i < model.sightings.count, t.timeIntervalSince(model.sightings[i].t) < pingSpan {
                let s = model.sightings[i]
                if let p = projection.point(s.coordinate) {
                    let age = t.timeIntervalSince(s.t) / pingSpan
                    let r = 6 + 22 * age
                    ctx.stroke(Path(ellipseIn: CGRect(x: p.x - r, y: p.y - r, width: r * 2, height: r * 2)), with: .color(gold.opacity(1 - age)), lineWidth: 2)
                }
                i -= 1
            }
        }
        .accessibilityHidden(true)
    }
}
