import SwiftUI

/// A public rider profile (the website's /rider/<handle>, js/rider.js): only
/// riders who opted in and chose a username have one. Anything else, an
/// unknown handle included, shows the same "not available" state, so whether
/// an account exists is never revealed. Ride figures are counts and city
/// names only, as the server sends them.
struct RiderProfileView: View {
    let route: RiderRoute
    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router
    @State private var profile: RiderProfile?
    @State private var state: State = .loading
    enum State { case loading, loaded, notAvailable, failed }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                switch state {
                case .loading: PanelSkeleton(height: 220)
                case .notAvailable:
                    EmptyStateCard(title: "This profile is private", text: "This spotter hasn't made their profile public.")
                        .accessibilityIdentifier("riderPrivate")
                case .failed:
                    EmptyStateCard(title: "We couldn't load this profile", text: "Please try again in a moment.")
                case .loaded:
                    if let profile { content(profile) }
                }
            }
            .padding(16)
        }
        .appBackground()
        .navigationTitle("@\(route.handle)")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                ShareLink(item: AppConfig.webURL("/rider/\(route.handle)")) { Image(systemName: "square.and.arrow.up") }
                    .accessibilityLabel("Share this profile")
            }
        }
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        do {
            profile = try await session.api.get("/api/riders/\(route.handle)")
            state = .loaded
        } catch is CancellationError {
        } catch APIError.http(let status, _) where status == 404 {
            state = .notAvailable
        } catch {
            state = profile == nil ? .failed : .loaded
        }
    }

    @ViewBuilder private func content(_ p: RiderProfile) -> some View {
        HStack(spacing: 14) {
            PersonAvatar(name: p.rider.name, url: SocialAuthor.avatarURL(p.rider.avatarUrl, size: 512), size: 72)
            VStack(alignment: .leading, spacing: 3) {
                Text(p.rider.name).font(.inter(22, .bold)).foregroundStyle(Color.chInk).accessibilityIdentifier("riderName")
                Text("@\(p.rider.handle)").font(.inter(14, .semibold)).foregroundStyle(Color.brandGold)
                if let joined = p.rider.joined, let date = Format.calendarDate(joined + "-01") {
                    Text("Joined \(date.formatted(Date.FormatStyle(timeZone: TimeZone(identifier: "UTC")!).month(.wide).year()))")
                        .font(.inter(12.5)).foregroundStyle(Color.chFog)
                }
            }
        }
        Text(p.rider.bio ?? "No bio yet.").font(.inter(14)).foregroundStyle(p.rider.bio == nil ? Color.chCaption : Color.chMist)
            .fixedSize(horizontal: false, vertical: true)

        MetricGrid(columns: 3) {
            Metric(label: "Rides", value: Format.int(p.rides.count))
            Metric(label: "Vehicles ridden", value: Format.int(p.rides.vehicles))
            Metric(label: "Cities", value: Format.int(p.rides.cities.count))
            Metric(label: "Discovered", value: Format.int(p.discovered.count))
            Metric(label: "Reviews", value: Format.int(p.reviews.count))
            Metric(label: "Avg rating", value: p.reviews.average.map { String(format: "%.1f ★", $0) } ?? "—")
        }
        .dataPanel()

        VStack(alignment: .leading, spacing: 12) {
            PanelHeading(city: nil, title: "Cities")
            if p.rides.cities.isEmpty { InlineMessage(text: "No rides with a city recorded yet.") }
            ForEach(p.rides.cities) { c in
                let pct = p.rides.count > 0 ? Double(c.rides) / Double(p.rides.count) : 0
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(c.name).font(.inter(14)).foregroundStyle(Color.chInk)
                        Spacer()
                        Text("\(Format.plural(c.rides, "ride", "rides")) · \(Int((pct * 100).rounded()))%").font(.inter(12)).monospacedDigit().foregroundStyle(Color.chFog)
                    }
                    GeometryReader { g in
                        Capsule().fill(Color.chInk.opacity(0.06))
                            .overlay(alignment: .leading) { Capsule().fill(Color.brandGold.opacity(0.8)).frame(width: g.size.width * pct) }
                    }
                    .frame(height: 6)
                }
            }
        }
        .dataPanel()

        VStack(alignment: .leading, spacing: 12) {
            PanelHeading(city: nil, title: "Ride reviews")
            if p.reviews.recent.isEmpty { InlineMessage(text: "No reviews yet.") }
            ForEach(p.reviews.recent) { r in
                Button { router.communityPath.append(PostRoute(id: r.id)) } label: {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            if let car = r.vehicle { LicensePlate(plate: car.licensePlate ?? "Cybercab", size: 12) } else { Text("Ride review").font(.inter(12, .semibold)).foregroundStyle(Color.brandGold) }
                            Spacer()
                            Text(SocialText.stars(r.rating)).foregroundStyle(Color.brandGold).accessibilityLabel("\(r.rating) out of 5 stars")
                        }
                        Text(r.body).font(.inter(14)).foregroundStyle(Color.chMist).multilineTextAlignment(.leading).lineLimit(6)
                        Text("\(Format.day(r.createdAt)) · \(Format.plural(r.likeCount, "like", "likes")) · \(Format.plural(r.commentCount, "comment", "comments"))")
                            .font(.inter(12)).foregroundStyle(Color.chCaption)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .dataPanel()

        VStack(alignment: .leading, spacing: 10) {
            PanelHeading(city: nil, title: "Discovered", badge: AnyView(Text(Format.int(p.discovered.count)).font(.inter(12, .bold)).foregroundStyle(Color.brandGold)))
            if p.discovered.vehicles.isEmpty { InlineMessage(text: "No public vehicles discovered yet.") }
            ForEach(p.discovered.vehicles) { v in
                NavigationLink(value: VehicleRoute(id: v.id, plate: v.licensePlate)) {
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            LicensePlate(plate: v.licensePlate ?? "Plate not listed", size: 12)
                            let detail = [v.model, v.color, v.serviceArea].compactMap { $0 }.joined(separator: " · ")
                            if !detail.isEmpty { Text(detail).font(.inter(11.5)).foregroundStyle(Color.chCaption) }
                        }
                        Spacer()
                        Image(systemName: "chevron.right").foregroundStyle(Color.chCaption)
                    }
                    .padding(10)
                    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.chInk.opacity(0.06)))
                }
                .buttonStyle(.plain)
            }
        }
        .dataPanel()
    }
}
