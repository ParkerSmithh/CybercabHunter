import SwiftUI

/// Cars: the public vehicle registry (the website's /vehicles).
struct RegistryView: View {
    @Environment(SessionStore.self) private var session
    @State private var model = RegistryModel()
    @State private var areas: [ServiceArea] = [ServiceArea(key: "austin", name: "Austin"), ServiceArea(key: "dallas", name: "Dallas")]
    @State private var searchTask: Task<Void, Never>?
    /// The search field (in the header) and its floating Liquid Glass copy, shown
    /// once the header's field has scrolled away; both edit the same query.
    enum SearchField: Hashable { case inline, floating }
    @FocusState private var focus: SearchField?
    @State private var floatingSearch = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let columns = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 6) {
                    Eyebrow(text: "Vehicles")
                    Text("CYBERCABS").displayTitle(30)
                    Text("Every Cybercab riders and spotters have reported, with the rides and sightings recorded for each.")
                        .font(.inter(14)).foregroundStyle(Color.chFog)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
                .onTapGesture { focus = nil }   // a tap on the header puts the keyboard away
                searchField(.inline)
                    // Hidden from the floating copy's view until this one leaves the screen.
                    .onScrollVisibilityChange(threshold: 0.6) { visible in
                        withAnimation(reduceMotion ? nil : .snappy(duration: 0.25)) { floatingSearch = !visible }
                    }
                HStack(alignment: .center) {
                    CityPicker(cities: areas, selection: $model.city)
                    Spacer(minLength: 8)
                    if model.phase == .loaded {
                        Text("\(Format.int(model.total)) \(model.total == 1 ? "VEHICLE" : "VEHICLES")")
                            .font(.inter(11, .semibold)).tracking(1.4).foregroundStyle(Color.chCaption)
                            .accessibilityIdentifier("registryCount")
                    }
                }
                content
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 24)
            // A tap on empty space (not a card or a control) puts the keyboard away.
            .background { Color.clear.contentShape(Rectangle()).onTapGesture { focus = nil } }
        }
        .appBackground()
        .navigationBarTitleDisplayMode(.inline)
        // While scrolled down: the same search, floating in Liquid Glass under the bar.
        .overlay(alignment: .top) {
            if floatingSearch {
                searchField(.floating)
                    .padding(.horizontal, 16).padding(.top, 4)
                    .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
            }
        }
        // The keyboard goes away when the list scrolls, on Search / Done, on a tap
        // outside the field, when a car opens or the tab changes, and when the
        // filter menu opens. Focus is never handed from one copy to the other
        // (that re-opened the keyboard as the copies swapped while scrolling).
        .scrollDismissesKeyboard(.immediately)
        .onChange(of: floatingSearch) { _, floating in
            if !floating, focus == .floating { focus = nil }
        }
        .onDisappear { focus = nil }
        .onAppear { focus = nil }   // nothing focuses on its own when Cars comes back
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { focus = nil }.fontWeight(.semibold).accessibilityIdentifier("registryKeyboardDone")
            }
        }
        .toolbar { ToolbarItem(placement: .topBarTrailing) { filterMenu } }
        .navigationDestination(for: VehicleRoute.self) { route in VehicleDetailView(route: route) }
        .task { await model.reload(using: session.api) }
        .refreshable { await model.reload(using: session.api) }
        .onChange(of: model.city) { reloadSoon(delay: 0) }
        .onChange(of: model.sort) { reloadSoon(delay: 0) }
        .onChange(of: model.query) { reloadSoon(delay: 0.3) }   // debounce typing
        .task {
            if let list: ServiceAreasResponse = try? await session.api.get("/api/service-areas") { areas = list.areas }
        }
    }

    /// Plate or VIN search (the registry's own `q`), in the header or floating.
    private func searchField(_ kind: SearchField) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").font(.system(size: 15, weight: .medium)).foregroundStyle(Color.chFog)
            TextField("Plate or VIN", text: $model.query)
                .font(.inter(15))
                .foregroundStyle(Color.chInk)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .onSubmit { focus = nil }
                .focused($focus, equals: kind)
                .accessibilityIdentifier(kind == .inline ? "registrySearch" : "registryFloatingSearch")
            if !model.query.isEmpty {
                Button { model.query = "" } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(Color.chFog).frame(width: 30, height: 30)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.leading, 14).padding(.trailing, 8)
        .frame(height: 44)
        .modifier(SearchChrome(floating: kind == .floating))
    }

    /// Sort and city, the registry's supported options (GET /api/robotaxi-vehicles
    /// sort= and city=), in a round Liquid Glass button in the bar. A UIKit menu
    /// button: it reports the moment the menu opens, so the keyboard goes away.
    private var filterMenu: some View {
        FilterMenuButton(
            sort: model.sort, city: model.city, areas: areas,
            onOpen: { focus = nil },
            setSort: { model.sort = $0 }, setCity: { model.city = $0 }
        )
        .frame(width: 44, height: 44)
        .accessibilityLabel("Sort and filter, \(model.sort.title), \(areas.first { $0.key == model.city }?.name ?? model.city)")
        .accessibilityIdentifier("registryFilter")
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case .idle, .loading:
            LazyVGrid(columns: columns, spacing: 12) { ForEach(0..<6, id: \.self) { _ in PanelSkeleton(height: 210) } }
        case .failed(let message):
            VStack(alignment: .leading, spacing: 10) {
                InlineMessage(text: message, systemImage: "wifi.exclamationmark")
                Button("Try again") { reloadSoon(delay: 0) }.foregroundStyle(Color.brandGold)
            }
            .glassCard()
        case .loaded:
            if model.vehicles.isEmpty {
                InlineMessage(text: model.query.isEmpty ? "No public vehicles in this city yet." : "No vehicles match “\(model.query)”.")
                    .glassCard()
            } else {
                LazyVGrid(columns: columns, spacing: 12) {
                    ForEach(model.vehicles) { v in
                        NavigationLink(value: VehicleRoute(id: v.id, plate: v.licensePlate)) { VehicleCard(vehicle: v) }
                            .buttonStyle(.plain)
                            // Resign before the push, so going back doesn't restore the keyboard.
                            .simultaneousGesture(TapGesture().onEnded { focus = nil })
                            .accessibilityIdentifier("vehicleCard")
                            .onAppear { if v.id == model.vehicles.last?.id { Task { await model.loadMore(using: session.api) } } }
                    }
                }
                if model.loadingMore { ProgressView().tint(Color.chFog).frame(maxWidth: .infinity) }
            }
        }
    }

    private func reloadSoon(delay: Double) {
        searchTask?.cancel()
        searchTask = Task {
            if delay > 0 { try? await Task.sleep(for: .seconds(delay)) }
            guard !Task.isCancelled else { return }
            await model.reload(using: session.api)
        }
    }
}

/// Where a vehicle link goes (the website's /vehicle/:id).
struct VehicleRoute: Hashable, Sendable {
    let id: String
    var plate: String? = nil
}

/// A registry card, as on the website: CYBERCAB badge and the generic render
/// (approved Cybercabs only), the plate, the city, rides, distance, first and
/// last seen. The render is the same image for every car, never this car.
struct VehicleCard: View {
    let vehicle: RegistryVehicle

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Badge and plate on the left, the Cybercab wholly inside the card on the right.
            HStack(alignment: .top, spacing: 6) {
                VStack(alignment: .leading, spacing: 6) {
                    if vehicle.isApprovedCybercab { CybercabBadge() }
                    LicensePlate(plate: vehicle.licensePlate, size: 12.5)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .layoutPriority(1)
                if vehicle.isApprovedCybercab {
                    Image("CybercabRender").resizable().aspectRatio(contentMode: .fit).frame(width: 56)
                        .padding(.top, 2)
                        .accessibilityHidden(true)
                }
            }
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(vehicle.city ?? "City not recorded").font(.inter(11)).foregroundStyle(Color.chFog).lineLimit(1)
                Spacer(minLength: 4)
                Text(Format.int(vehicle.tripCount ?? 0)).statNumber(19)
                Text(vehicle.tripCount == 1 ? "ride" : "rides").font(.inter(11)).foregroundStyle(Color.chFog)
            }
            Rectangle().fill(Color.chInk.opacity(0.08)).frame(height: 1)
            VStack(alignment: .leading, spacing: 5) {
                fact("figure.walk", "Distance", vehicle.totalDistance.map { "\(Format.one($0)) mi" } ?? "—")
                fact("flag.fill", "First", Format.day(vehicle.firstRideDate))
                fact("clock", "Last", Format.day(vehicle.lastRideDate))
            }
        }
        .padding(11)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background {
            RoundedRectangle(cornerRadius: 14).fill(Color.chSurface)
                .overlay(RoundedRectangle(cornerRadius: 14).fill(LinearGradient(colors: [Color.brandGold.opacity(vehicle.isApprovedCybercab ? 0.07 : 0.02), .clear], startPoint: .topLeading, endPoint: .bottomTrailing)))
        }
        .clipShape(.rect(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(vehicle.isApprovedCybercab ? Color.brandGold.opacity(0.35) : Color.chLine))
        .contentShape(.rect(cornerRadius: 14))
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens the vehicle's details")
    }

    /// One line per fact (icon, short label, value); two lines only if it can't fit.
    private func fact(_ icon: String, _ label: String, _ value: String) -> some View {
        let tag = Label(label.uppercased(), systemImage: icon).font(.inter(8.5, .semibold)).tracking(0.4).foregroundStyle(Color.brandGold.opacity(0.85))
        let val = Text(value).font(.inter(12, .semibold)).foregroundStyle(Color.chInk).monospacedDigit()
        return ViewThatFits(in: .horizontal) {
            HStack(spacing: 6) { tag.fixedSize(); Spacer(minLength: 2); val.fixedSize() }
            VStack(alignment: .leading, spacing: 1) { tag; val }
        }
        .accessibilityElement(children: .combine)
    }
}

/// The header field: a dark rounded box. The floating one: Liquid Glass (iOS 26)
/// or a frosted capsule before.
private struct SearchChrome: ViewModifier {
    let floating: Bool
    func body(content: Content) -> some View {
        if floating {
            content.modifier(GlassBackground(shape: Capsule(), interactive: true))
                .shadow(color: .black.opacity(0.35), radius: 10, y: 4)
        } else {
            content.background(Color.chSurface, in: .rect(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.chHair2))
        }
    }
}

/// The ↑↓ button and its menu: Sort by (the four registry orders) and City,
/// each with a checkmark on the current choice.
private struct FilterMenuButton: UIViewRepresentable {
    let sort: RegistrySort
    let city: String
    let areas: [ServiceArea]
    let onOpen: () -> Void
    let setSort: (RegistrySort) -> Void
    let setCity: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UIButton {
        var config = UIButton.Configuration.plain()
        config.image = UIImage(systemName: "arrow.up.arrow.down", withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold))
        let button = UIButton(configuration: config)
        button.showsMenuAsPrimaryAction = true
        button.tintColor = .label
        button.addAction(UIAction { _ in context.coordinator.onOpen() }, for: .menuActionTriggered)
        return button
    }

    func updateUIView(_ button: UIButton, context: Context) {
        context.coordinator.onOpen = onOpen
        let sorts = RegistrySort.allCases.map { s in
            UIAction(title: s.title, image: UIImage(systemName: s.symbol), state: s == sort ? .on : .off) { _ in setSort(s) }
        }
        let cities = areas.map { a in
            UIAction(title: a.name, state: a.key == city ? .on : .off) { _ in setCity(a.key) }
        }
        button.menu = UIMenu(children: [
            UIMenu(title: "Sort by", options: .displayInline, children: sorts),
            UIMenu(title: "City", options: .displayInline, children: cities)
        ])
    }

    @MainActor final class Coordinator { var onOpen: () -> Void = {} }
}
