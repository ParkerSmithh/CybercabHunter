import SwiftUI

/// Sightings (the website's /sightings): every approved photo of a Cybercab,
/// with the stat cards, a city filter, the sort, and the Submit button.
struct SightingsView: View {
    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openSignIn) private var openSignIn
    @State private var model = SightingsModel()
    @State private var submitting = false
    @State private var viewing: PublicSighting?
    @State private var deleting: PublicSighting?

    private let columns = [GridItem(.flexible(), spacing: 10, alignment: .top), GridItem(.flexible(), spacing: 10, alignment: .top)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header
                statsGrid
                toolbar
                gallery
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 28)
        }
        .appBackground()
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    if session.user != nil { submitting = true } else { openSignIn() }
                } label: { Label("Submit a sighting", systemImage: "camera.badge.ellipsis") }
                .accessibilityIdentifier("submitSighting")
            }
        }
        .navigationDestination(for: VehicleRoute.self) { VehicleDetailView(route: $0) }
        .navigationDestination(for: ReplayRoute.self) { ReplayView(route: $0) }
        .refreshable { await model.reload(api: session.api) }
        .task { await model.start(api: session.api, signedIn: session.user != nil) }
        .task(id: session.user?.id) { await model.checkModerator(api: session.api, signedIn: session.user != nil) }
        // The site re-checks every minute while the page is visible.
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                if scenePhase == .active && router.selectedTab == .sightings { await model.poll(api: session.api) }
            }
        }
        .sheet(isPresented: $submitting) { SubmitSightingView() }
        // "Submit a sighting" from Siri or Shortcuts (AppRouter.requestSubmitSighting).
        .onChange(of: router.submitSightingRequested, initial: true) { handleSubmitRequest() }
        // Siri / Shortcuts asked for a city's sightings.
        .onChange(of: router.sightingsCity, initial: true) {
            guard let c = router.sightingsCity else { return }
            router.sightingsCity = nil
            Task { await model.select(city: c, api: session.api) }
        }
        .onChange(of: session.state) { handleSubmitRequest() }   // a cold launch: once the session is known
        .fullScreenCover(item: $viewing) { SightingViewer(sighting: $0) }
        .confirmationDialog("Delete this photo?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            Button("Delete photo", role: .destructive) { if let s = deleting { Task { await model.deletePhoto(s, api: session.api) } } }
        } message: { Text("It is removed permanently and can't be undone.") }
        .overlay(alignment: .top) { ToastHost(toast: $model.toast) }
    }

    /// The shortcut's request: the form when signed in, sign-in otherwise. While
    /// the stored session is still being checked (a cold launch), it waits.
    private func handleSubmitRequest() {
        guard router.submitSightingRequested else { return }
        if case .restoring = session.state { return }
        router.submitSightingRequested = false
        if session.user != nil { submitting = true } else { openSignIn() }
    }

    // MARK: Header

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Eyebrow(text: "Community spotted")
                Text("SIGHTINGS").displayTitle(30)
                Text("Every approved photo of a Cybercab out in the wild, newest first. The page checks for new ones every minute.")
                    .font(.inter(14)).foregroundStyle(Color.chFog).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            NavigationLink(value: ReplayRoute(city: model.city)) {
                Label("Replay Map", systemImage: "play.fill")
                    .font(.inter(12.5, .bold)).foregroundStyle(Color(hex: 0x1A1204))
                    .padding(.horizontal, 12).frame(minHeight: 36)
                    .background(Color.brandGold, in: .capsule)
            }
            .accessibilityIdentifier("sightingsReplay")
        }
        .padding(.top, 8)
    }

    // MARK: Stat cards (GET /api/sightings?stats=1)

    private var statsGrid: some View {
        let s = model.stats
        return LazyVGrid(columns: columns, spacing: 10) {
            StatTile(icon: "camera", label: "All time · all cities", value: Format.int(s?.sightingsAllTime), note: "Approved sightings", strong: true)
            StatTile(icon: "calendar", label: "Last 7 days", value: Format.int(s?.last7Days), note: "Seen in the last 7 days")
            StatTile(icon: "sun.max", label: "Today", value: Format.int(s?.today), note: s?.today == 1 ? "Cybercab spotted today" : "Cybercabs spotted today")
            StatTile(icon: "calendar.badge.clock", label: "This month", value: Format.int(s?.thisMonth), note: monthNote(s))
            StatTile(icon: "clock", label: "Peak hour", value: peakValue(s), note: peakNote(s), wrapValue: true)
            StatTile(icon: "trophy", label: "Best day", value: bestValue(s), note: s?.bestDay.map { Format.plural($0.count, "sighting", "sightings") } ?? "")
        }
        .accessibilityIdentifier("sightingStats")
    }

    private func monthNote(_ s: SightingStats?) -> String {
        let zone = TimeZone(identifier: s?.timeZone ?? "America/Chicago") ?? Format.central
        return "Sightings in \(Date.now.formatted(Date.FormatStyle(timeZone: zone).month(.wide)))"
    }
    private func peakValue(_ s: SightingStats?) -> String {
        guard let s else { return "—" }
        if let p = s.peakHour { return "\(Format.hourLabel(p.hour)) - \(Format.hourLabel(p.hour + 1))" }
        return s.total == 0 ? "None yet" : "NOT ENOUGH DATA YET"
    }
    private func peakNote(_ s: SightingStats?) -> String {
        guard let s, let p = s.peakHour else { return "" }
        let since = s.firstDay.map { " since \(Format.day($0, year: false))" } ?? ""
        return "All time · \(Format.int(p.count)) of \(Format.plural(s.total, "sighting", "sightings"))\(since)"
    }
    private func bestValue(_ s: SightingStats?) -> String {
        guard let s else { return "—" }
        if let b = s.bestDay { return Format.day(b.date) }
        return s.total == 0 ? "None yet" : "—"
    }

    // MARK: Toolbar: city, count, sort

    private var toolbar: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                CityPicker(cities: model.areas, selection: Binding(get: { model.city }, set: { c in Task { await model.select(city: c, api: session.api) } }))
                if let total = model.stats?.total, total > 0 {
                    Text("\(Format.plural(total, "sighting", "sightings")) in \(model.cityName)").font(.inter(12)).foregroundStyle(Color.chFog)
                        .accessibilityIdentifier("feedCount")
                }
            }
            HStack(spacing: 8) {
                ForEach(SightingsModel.Order.allCases) { o in
                    PillToggle(title: o.title, selected: model.order == o, compact: true) { Task { await model.select(order: o, api: session.api) } }
                        .accessibilityIdentifier("order-\(o.rawValue)")
                }
            }
        }
    }

    // MARK: Gallery

    @ViewBuilder private var gallery: some View {
        switch model.phase {
        case .idle, .loading:
            LazyVGrid(columns: columns, spacing: 10) {
                ForEach(0..<4, id: \.self) { _ in RoundedRectangle(cornerRadius: 14).fill(Color.chSurface).aspectRatio(0.78, contentMode: .fit) }
            }
            .accessibilityLabel("Loading sightings")
        case .failed:
            VStack(spacing: 12) {
                EmptyStateCard(title: "We couldn't load sightings", text: "Something went wrong reaching the server. Try again in a moment.")
                Button("Try again") { Task { await model.reload(api: session.api) } }.buttonStyle(GoldButtonStyle())
            }
            .accessibilityIdentifier("sightingsError")
        case .loaded:
            if model.items.isEmpty {
                EmptyStateCard(title: "No sightings yet", text: "No approved sightings in \(model.cityName) yet. Spotted one? Submit it for review.")
                    .accessibilityIdentifier("sightingsEmpty")
            }
            LazyVGrid(columns: columns, spacing: 10) {
                ForEach(model.items) { s in
                    SightingCard(sighting: s, filteredCity: model.cityName, isModerator: model.isModerator,
                                 open: { viewing = s }, delete: { deleting = s }, failed: { model.drop(s.id) })
                        .onAppear { if s.id == model.items.last?.id { Task { await model.loadMore(api: session.api) } } }
                }
            }
            if model.loadingMore {
                ProgressView().tint(Color.chFog).frame(maxWidth: .infinity).padding(8)
            } else if model.nextCursor != nil {
                Button("Load more") { Task { await model.loadMore(api: session.api) } }
                    .font(.inter(14, .semibold)).foregroundStyle(Color.chMist)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.chHair2))
            }
        }
    }
}

/// A stat card (the gold-tinted tiles on the website's Sightings page).
struct StatTile: View {
    let icon: String
    let label: String
    let value: String
    let note: String
    var strong = false
    var wrapValue = false
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(label.uppercased(), systemImage: icon)
                .font(.inter(10, .semibold)).tracking(0.4).foregroundStyle(Color.brandGold.opacity(0.9))
                .lineLimit(1).minimumScaleFactor(0.8)
            Text(value).statNumber(value.count > 8 ? 17 : 24)
                .lineLimit(wrapValue ? nil : 1).minimumScaleFactor(wrapValue ? 1 : 0.6)
                .fixedSize(horizontal: false, vertical: wrapValue)
            Text(note).font(.inter(11)).foregroundStyle(Color.chCaption).lineLimit(2).fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(maxWidth: .infinity, minHeight: 104, alignment: .topLeading)
        .background(LinearGradient(colors: [Color.brandGold.opacity(strong ? 0.14 : 0.07), .clear], startPoint: .topLeading, endPoint: .bottomTrailing), in: .rect(cornerRadius: 14))
        .background(Color.chSurface, in: .rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.brandGold.opacity(strong ? 0.45 : 0.22)))
        .accessibilityElement(children: .combine)
    }
}

/// One sighting (the website's card): photo, then city (when it isn't the
/// filtered one), CYBERCAB, how long ago, the plate, the place and the time.
struct SightingCard: View {
    let sighting: PublicSighting
    let filteredCity: String
    let isModerator: Bool
    let open: () -> Void
    let delete: () -> Void
    let failed: () -> Void
    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router
    @State private var resolving = false
    @State private var notInRegistry = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: open) {
                Color.clear.aspectRatio(4 / 3, contentMode: .fit)
                    .overlay { SightingPhoto(url: sighting.imageURL, failed: failed) }
                    .clipped()
            }
            .buttonStyle(.plain)
            .accessibilityLabel(sighting.city.map { "View larger photo: Cybercab spotted in \($0)" } ?? "View larger photo")
            .accessibilityIdentifier("sightingPhoto")
            .overlay(alignment: .topTrailing) {
                if isModerator {
                    Menu {
                        Button("Delete photo", systemImage: "trash", role: .destructive, action: delete)
                    } label: {
                        Image(systemName: "ellipsis").font(.system(size: 13, weight: .bold)).foregroundStyle(.white)
                            .frame(width: 30, height: 30).background(.black.opacity(0.55), in: Circle())
                    }
                    .padding(6)
                    .accessibilityLabel("Moderator options")
                    .accessibilityIdentifier("moderatorPhotoMenu")
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 5) {
                    if let city = sighting.city, city.lowercased() != filteredCity.lowercased() {
                        Text(city).font(.inter(10.5, .semibold)).foregroundStyle(Color.chMist)
                            .padding(.horizontal, 6).padding(.vertical, 2).overlay(Capsule().strokeBorder(Color.chHair2))
                    }
                    if sighting.cybercab { CybercabBadge() }
                    Spacer(minLength: 0)
                    Label(SightingsModel.ago(sighting.spotted), systemImage: "clock").font(.inter(10.5, .medium)).foregroundStyle(Color.chFog)
                        .labelStyle(.titleAndIcon).lineLimit(1)
                }
                if let plate = sighting.plate {
                    Button { Task { await openVehicle(plate) } } label: {
                        HStack(spacing: 4) {
                            LicensePlate(plate: plate, size: 11)
                            if resolving { ProgressView().controlSize(.mini) }
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Opens this vehicle in the registry")
                    .accessibilityIdentifier("sightingPlate")
                    if notInRegistry { Text("Not in the public registry.").font(.inter(10.5)).foregroundStyle(Color.chCaption) }
                }
                if let place = sighting.location {
                    Label { Text(place).font(.inter(11)).foregroundStyle(Color.chMist).lineLimit(3) } icon: {
                        Image(systemName: "mappin").font(.system(size: 10)).foregroundStyle(Color.brandGold)
                    }
                }
                Text(sighting.spottedText).font(.inter(10)).foregroundStyle(Color.chCaption).fixedSize(horizontal: false, vertical: true)
            }
            .padding(10)
        }
        .background(LinearGradient(colors: [Color.brandGold.opacity(0.08), .clear], startPoint: .topLeading, endPoint: UnitPoint(x: 0.6, y: 0.6)), in: .rect(cornerRadius: 14))
        .background(Color.chSurface.opacity(0.82), in: .rect(cornerRadius: 14))
        .clipShape(.rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.brandGold.opacity(0.3)))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("sightingCard")
    }

    private func openVehicle(_ plate: String) async {
        resolving = true
        defer { resolving = false }
        if let route = await SightingsModel.vehicle(for: plate, api: session.api) { router.sightingsPath.append(route) } else { notInRegistry = true }
    }
}

/// A public sighting photo; one that can't load is reported so the card is dropped.
private struct SightingPhoto: View {
    let url: URL
    let failed: () -> Void
    @Environment(\.displayScale) private var scale
    @State private var image: UIImage?
    var body: some View {
        ZStack {
            if let image { Image(uiImage: image).resizable().scaledToFill() } else { Rectangle().fill(Color.chLine.opacity(0.6)) }
        }
        .task(id: url) {
            image = await ImagePipeline.shared.image(url, maxPixel: Int(260 * scale))
            if image == nil { failed() }
        }
    }
}

/// The expanded photo with its caption (city · place · plate · time).
struct SightingViewer: View {
    let sighting: PublicSighting
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            VStack(spacing: 14) {
                Spacer()
                RemoteImage(url: sighting.imageURL, points: 1400, contentMode: .fit)
                    .accessibilityLabel(sighting.city.map { "Cybercab spotted in \($0)" } ?? "Cybercab sighting")
                Text([sighting.city, sighting.location, sighting.plate, sighting.spottedText].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.inter(13)).foregroundStyle(.white.opacity(0.85)).multilineTextAlignment(.center).padding(.horizontal, 20)
                Spacer()
            }
            Button { dismiss() } label: {
                Image(systemName: "xmark").font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
                    .frame(width: 44, height: 44).background(.white.opacity(0.14), in: Circle())
            }
            .padding(16)
            .accessibilityLabel("Close")
            .accessibilityIdentifier("closeViewer")
        }
    }
}
