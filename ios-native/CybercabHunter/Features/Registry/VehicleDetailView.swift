import SwiftUI
import AppIntents

/// One registry vehicle (the website's /vehicle/:id): the plate card, the
/// recorded ride history, and the approved sightings of it.
struct VehicleDetailView: View {
    let route: VehicleRoute
    @Environment(SessionStore.self) private var session
    @State private var detail: VehicleDetail?
    @State private var sightings: [VehicleSightings.Entry]?
    @State private var failure: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let detail {
                    heroCard(detail)
                    rideHistory(detail.history)
                    sightingsPanel
                } else if let failure {
                    InlineMessage(text: failure, systemImage: "exclamationmark.triangle").glassCard()
                } else {
                    PanelSkeleton(height: 200)
                    PanelSkeleton(height: 180)
                }
            }
            .padding(16)
        }
        .appBackground()
        .navigationTitle(route.plate ?? "Vehicle")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                ShareLink(item: AppConfig.webURL("/vehicle/\(route.id)")) { Image(systemName: "square.and.arrow.up") }
                    .accessibilityLabel("Share this vehicle")
            }
        }
        .task { await load() }
        .refreshable { await load() }
        // Siri and Apple Intelligence: this screen shows this Cybercab ("this car").
        .modifier(OnscreenVehicle(id: route.id))
    }

    private func load() async {
        do {
            async let d: VehicleDetail = session.api.get("/api/robotaxi-vehicles/\(route.id)")
            async let s: VehicleSightings = session.api.get("/api/robotaxi-vehicles/\(route.id)/sightings", query: [URLQueryItem(name: "limit", value: "20")])
            let loaded = try await d
            detail = loaded
            sightings = (try? await s)?.sightings
            failure = nil
            await SpotlightRecents.record(VehicleEntity(loaded))   // Spotlight: vehicles you opened
        } catch is CancellationError {
        } catch APIError.http(let status, _) where status == 404 {
            failure = "This vehicle isn't in the public registry (or no longer is)."
        } catch {
            failure = (error as? LocalizedError)?.errorDescription ?? "Couldn't load this vehicle."
        }
    }

    private func heroCard(_ d: VehicleDetail) -> some View {
        let v = d.vehicle
        let city = v.serviceArea ?? d.history.cities.first
        let summary = [city.map { "Operating in \($0)" } ?? (d.history.cities.isEmpty ? nil : "Rides in \(d.history.cities.joined(separator: ", "))"),
                       v.color.map { "\($0) exterior" }].compactMap { $0 }.joined(separator: " · ")
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                Circle().fill(Color.brandGold).frame(width: 7, height: 7)
                Text((city ?? "Vehicle").uppercased()).font(.inter(11, .semibold)).tracking(1.9).foregroundStyle(Color.brandGold)
            }
            LicensePlate(plate: v.licensePlate, size: 20)
            if v.isApprovedCybercab { CybercabBadge() }
            // Kept clear of the car render on the right, as on the website.
            if !summary.isEmpty { Text(summary).font(.inter(14)).foregroundStyle(Color.chMist).padding(.trailing, v.isApprovedCybercab ? 120 : 0) }
            if let vin = v.vin {
                HStack(spacing: 6) {
                    Text("VIN").font(.inter(11, .semibold)).foregroundStyle(Color.chFog)
                    Text(vin).font(.geistMono(13)).foregroundStyle(Color.chInk).textSelection(.enabled)
                }
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(alignment: .bottomTrailing) {
            if v.isApprovedCybercab { Image("CybercabRender").resizable().scaledToFit().frame(width: 150).offset(x: 22, y: -34).accessibilityHidden(true) }
        }
        .background {
            RoundedRectangle(cornerRadius: 16).fill(Color.chSurface)
                .overlay(RoundedRectangle(cornerRadius: 16).fill(LinearGradient(colors: [Color.brandGold.opacity(0.1), .clear], startPoint: .topLeading, endPoint: .bottomTrailing)))
        }
        .clipShape(.rect(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.brandGold.opacity(v.isApprovedCybercab ? 0.45 : 0.15)))
        .accessibilityElement(children: .combine)
    }

    private func rideHistory(_ h: VehicleDetail.History) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Eyebrow(text: "Rides · distance · dates")
            Text("RECORDED RIDE HISTORY").displayTitle(18).accessibilityIdentifier("rideHistoryTitle")
            Text("Based on rides and vehicle sightings recorded by Cybercab Hunter, not necessarily this vehicle's complete history, and \"last seen\" does not mean it is currently operating.")
                .font(.inter(12)).foregroundStyle(Color.chFog)
            MetricGrid(columns: 2) {
                Metric(label: "Rides", value: Format.int(h.tripCount ?? 0))
                Metric(label: "Distance", value: h.totalDistance.map { Format.one($0) } ?? "—", unit: h.totalDistance != nil ? "mi" : nil)
                Metric(label: "First ride", value: Format.day(h.firstRideDate), size: 17)
                Metric(label: "Latest ride", value: Format.day(h.lastRideDate), size: 17)
            }
            Rectangle().fill(Color.chInk.opacity(0.08)).frame(height: 1)
            Text(h.cities.isEmpty ? "No service area recorded for these rides yet." : "Recorded in: \(h.cities.joined(separator: ", ")).")
                .font(.inter(12)).foregroundStyle(Color.chFog)
        }
        .dataPanel()
    }

    private var sightingsPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            Eyebrow(text: "Community")
            Text("VERIFIED SIGHTINGS").displayTitle(18)
            if let sightings {
                if sightings.isEmpty {
                    Text("No approved sightings of this vehicle yet.").font(.inter(13)).foregroundStyle(Color.chFog)
                } else {
                    ForEach(sightings, id: \.self) { s in
                        HStack {
                            Image(systemName: "eye.fill").font(.caption).foregroundStyle(Color.brandGold)
                            Text(Format.day(s.date)).font(.inter(14, .medium)).foregroundStyle(Color.chInk)
                            Spacer()
                            Text(s.serviceArea ?? "Area not specified").font(.inter(13)).foregroundStyle(Color.chFog)
                        }
                        .padding(.vertical, 4)
                    }
                    Footnote(text: "One entry per day and area, from approved community sightings.")
                }
            } else {
                Text("Sightings couldn't be loaded.").font(.inter(13)).foregroundStyle(Color.chFog)
            }
        }
        .dataPanel()
    }
}

/// Tells the system which Cybercab is on screen (Apple's onscreen-entity API),
/// so Siri with Apple Intelligence can resolve "this Cybercab" to it. iOS 18.4+
/// annotates the view; 18.2–18.3 the screen's user activity. Earlier: nothing.
private struct OnscreenVehicle: ViewModifier {
    let id: String
    func body(content: Content) -> some View {
        if #available(iOS 18.4, *) {
            content.appEntityIdentifier(EntityIdentifier(for: VehicleEntity.self, identifier: id))
        } else {
            content.userActivity("com.cybercabhunter.native.vehicle") { activity in
                activity.title = "Cybercab"
                if #available(iOS 18.2, *) { activity.appEntityIdentifier = EntityIdentifier(for: VehicleEntity.self, identifier: id) }
            }
        }
    }
}
