import Foundation
import Observation

/// The Sightings gallery (public/js/sightings.js): approved photo sightings
/// for one service area, most or least recent first (remembered on this
/// device), 24 a page, re-checked every minute while it's on screen. Every
/// number is the server's; a stat it didn't send stays "—".
@MainActor
@Observable
final class SightingsModel {
    enum Order: String, CaseIterable, Identifiable, Sendable {
        case desc, asc
        var id: String { rawValue }
        var title: String { self == .desc ? "Most recent" : "Least recent" }
    }
    enum Phase: Equatable { case idle, loading, loaded, failed }

    static let pageSize = 24
    private static let orderKey = "sightingsOrder"

    private(set) var areas: [ServiceArea] = [ServiceArea(key: "austin", name: "Austin"), ServiceArea(key: "dallas", name: "Dallas")]
    private(set) var city = "austin"
    private(set) var order: Order = Order(rawValue: UserDefaults.standard.string(forKey: SightingsModel.orderKey) ?? "") ?? .desc
    private(set) var items: [PublicSighting] = []
    private(set) var nextCursor: String?
    private(set) var phase: Phase = .idle
    private(set) var loadingMore = false
    private(set) var stats: SightingStats?
    /// Moderators (the server's answer) get a Delete on each photo.
    private(set) var isModerator = false
    var toast: SocialFeedModel.Toast?

    private var generation = 0

    var cityName: String { areas.first { $0.key == city }?.name ?? city.capitalized }

    func start(api: APIClient, signedIn: Bool) async {
        if let list: ServiceAreasResponse = try? await api.get("/api/service-areas"), !list.areas.isEmpty {
            areas = list.areas
            if !areas.contains(where: { $0.key == city }) { city = areas[0].key }
        }
        async let r: Void = reload(api: api)
        async let m: Void = checkModerator(api: api, signedIn: signedIn)
        _ = await (r, m)
    }

    func checkModerator(api: APIClient, signedIn: Bool) async {
        guard signedIn else { isModerator = false; return }
        let access: ModerationAccess? = try? await api.get("/api/moderation/access", authenticated: true)
        isModerator = access?.moderator == true
    }

    func select(city next: String, api: APIClient) async {
        guard next != city else { return }
        city = next
        await reload(api: api)
    }

    func select(order next: Order, api: APIClient) async {
        guard next != order else { return }
        order = next
        UserDefaults.standard.set(next.rawValue, forKey: Self.orderKey)
        await reload(api: api)
    }

    private func query(cursor: String?, stats: Bool) -> [URLQueryItem] {
        var q = [URLQueryItem(name: "city", value: city), URLQueryItem(name: "order", value: order.rawValue), URLQueryItem(name: "limit", value: String(Self.pageSize))]
        if stats { q.append(URLQueryItem(name: "stats", value: "1")) }
        if let cursor { q.append(URLQueryItem(name: "cursor", value: cursor)) }
        return q
    }

    /// Page 1 and the stats (a newer request supersedes an older one).
    func reload(api: APIClient) async {
        generation += 1
        let gen = generation
        phase = items.isEmpty ? .loading : phase
        do {
            let page: PublicSightingsPage = try await api.get("/api/sightings", query: query(cursor: nil, stats: true))
            guard gen == generation else { return }
            items = page.sightings
            nextCursor = page.nextCursor
            stats = page.stats
            phase = .loaded
        } catch is CancellationError {
            if gen == generation, phase == .loading { phase = .idle }
        } catch {
            guard gen == generation else { return }
            items = []; nextCursor = nil; stats = nil; phase = .failed
        }
    }

    func loadMore(api: APIClient) async {
        guard let cursor = nextCursor, !loadingMore, phase == .loaded else { return }
        let gen = generation
        loadingMore = true
        defer { loadingMore = false }
        guard let page: PublicSightingsPage = try? await api.get("/api/sightings", query: query(cursor: cursor, stats: false)), gen == generation else { return }
        let known = Set(items.map(\.id))
        items += page.sightings.filter { !known.contains($0.id) }
        nextCursor = page.nextCursor
    }

    /// The minute check (the site's poll): new sightings join the top, stats refresh.
    func poll(api: APIClient) async {
        guard phase == .loaded else { return }
        let gen = generation
        guard let page: PublicSightingsPage = try? await api.get("/api/sightings", query: query(cursor: nil, stats: true)), gen == generation else { return }
        stats = page.stats
        guard order == .desc else { return }
        let known = Set(items.map(\.id))
        let fresh = page.sightings.prefix { !known.contains($0.id) }
        if !fresh.isEmpty { items.insert(contentsOf: fresh, at: 0) }
    }

    /// A photo that can no longer be loaded (it just expired) is dropped, never shown broken.
    func drop(_ id: String) { items.removeAll { $0.id == id } }

    /// Moderators: delete one public photo (permanent; the server checks the role).
    func deletePhoto(_ s: PublicSighting, api: APIClient) async {
        do {
            let _: SocialOK = try await api.send("/api/moderation/sightings/\(s.id)/photo", method: "DELETE")
            drop(s.id)
            toast = .init(text: "Photo deleted.")
        } catch APIError.http(let status, _) where status == 403 {
            isModerator = false
            toast = .init(text: "Only moderators can delete photos.", isError: true)
        } catch APIError.unauthorized {
            toast = .init(text: "Only moderators can delete photos.", isError: true)
        } catch {
            toast = .init(text: "Couldn't delete the photo. Please try again.", isError: true)
        }
    }

    /// The registry vehicle with exactly this plate (the sighting API has no
    /// vehicle id), or nil when the public registry has none or several.
    static func vehicle(for plate: String, api: APIClient) async -> VehicleRoute? {
        let target = normalized(plate)
        guard !target.isEmpty,
              let list: VehicleList = try? await api.get("/api/robotaxi-vehicles", query: [URLQueryItem(name: "q", value: plate), URLQueryItem(name: "limit", value: "10")]) else { return nil }
        let matches = list.vehicles.filter { normalized($0.licensePlate ?? "") == target }
        guard matches.count == 1, let v = matches.first else { return nil }
        return VehicleRoute(id: v.id, plate: v.licensePlate)
    }

    /// Letters and digits only, upper case (worker/plate.js normalizePlate).
    nonisolated static func normalized(_ plate: String) -> String {
        String(plate.uppercased().unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) && $0.isASCII })
    }

    /// "just now", "12m ago", "5h ago", "3d ago", then "Sep 30" (the site's ago()).
    nonisolated static func ago(_ date: Date?, now: Date = .now) -> String {
        guard let date else { return "" }
        let s = max(0, Int(now.timeIntervalSince(date).rounded()))
        if s < 60 { return "just now" }
        if s < 3600 { return "\(s / 60)m ago" }
        if s < 86400 { return "\(s / 3600)h ago" }
        if s < 30 * 86400 { return "\(s / 86400)d ago" }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }
}
