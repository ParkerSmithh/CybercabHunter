import SwiftUI

/// Cars: the public vehicle registry (the website's /vehicles).
struct RegistryView: View {
    @Environment(SessionStore.self) private var session
    @State private var model = RegistryModel()
    @State private var areas: [ServiceArea] = [ServiceArea(key: "austin", name: "Austin"), ServiceArea(key: "dallas", name: "Dallas")]
    @State private var searchTask: Task<Void, Never>?

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
                HStack {
                    CityPicker(cities: areas, selection: $model.city)
                    Spacer()
                    sortMenu
                }
                content
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 24)
        }
        .appBackground()
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $model.query, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Plate or VIN")
        .textInputAutocapitalization(.characters)
        .autocorrectionDisabled()
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

    private var sortMenu: some View {
        Menu {
            Picker("Order", selection: $model.sort) {
                ForEach(RegistrySort.allCases) { Text($0.title).tag($0) }
            }
        } label: {
            HStack(spacing: 6) { Text(model.sort.title); Image(systemName: "chevron.up.chevron.down").font(.caption2) }
                .font(.inter(13, .medium)).foregroundStyle(Color.chMist)
                .padding(.horizontal, 12).frame(minHeight: 40)
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.chHair2))
        }
        .accessibilityLabel("Order: \(model.sort.title)")
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
            Text("\(Format.int(model.total)) \(model.total == 1 ? "VEHICLE" : "VEHICLES")")
                .font(.inter(11, .semibold)).tracking(1.4).foregroundStyle(Color.chCaption)
                .accessibilityIdentifier("registryCount")
            if model.vehicles.isEmpty {
                InlineMessage(text: model.query.isEmpty ? "No public vehicles in this city yet." : "No vehicles match “\(model.query)”.")
                    .glassCard()
            } else {
                LazyVGrid(columns: columns, spacing: 12) {
                    ForEach(model.vehicles) { v in
                        NavigationLink(value: VehicleRoute(id: v.id, plate: v.licensePlate)) { VehicleCard(vehicle: v) }
                            .buttonStyle(.plain)
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
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 8) {
                if vehicle.isApprovedCybercab { CybercabBadge() } else { Color.clear.frame(height: 20) }
                LicensePlate(plate: vehicle.licensePlate, size: 13)
                Text(vehicle.city ?? "City not recorded").font(.inter(11)).foregroundStyle(Color.chFog)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text("RIDES").font(.inter(9, .semibold)).tracking(0.6).foregroundStyle(Color.chCaption)
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(Format.int(vehicle.tripCount ?? 0)).statNumber(24)
                    Text(vehicle.tripCount == 1 ? "ride" : "rides").font(.inter(11)).foregroundStyle(Color.chFog)
                }
            }
            Rectangle().fill(Color.chInk.opacity(0.08)).frame(height: 1)
            fact("figure.walk", "Distance", vehicle.totalDistance.map { "\(Format.one($0)) mi" } ?? "—")
            fact("flag.fill", "First seen", Format.day(vehicle.firstRideDate))
            fact("clock", "Last seen", Format.day(vehicle.lastRideDate))
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(alignment: .topTrailing) {
            if vehicle.isApprovedCybercab {
                Image("CybercabRender").resizable().scaledToFit().frame(width: 100).offset(x: 18, y: 4).accessibilityHidden(true)
            }
        }
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

    private func fact(_ icon: String, _ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Label(label.uppercased(), systemImage: icon).font(.inter(9, .semibold)).tracking(0.5).foregroundStyle(Color.brandGold.opacity(0.85))
            Text(value).font(.inter(13, .semibold)).foregroundStyle(Color.chInk)
        }
    }
}
