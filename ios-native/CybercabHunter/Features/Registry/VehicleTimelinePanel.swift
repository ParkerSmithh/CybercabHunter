import SwiftUI

struct VehicleTimelineResponse: Decodable, Sendable {
    struct Event: Decodable, Sendable {
        struct Photo: Decodable, Sendable { let id: String }
        let kind: String
        let date: String?
        let dateKind: String?
        let photo: Photo?
        // approved
        let basis: String?
        // sighting
        let type: String?
        let camera: String?
        let city: String?
        // rides: AGGREGATES ONLY (owner decision): a count, first/last ride dates and
        // the total distance. The API publishes no individual rides or fares.
        let count: Int?
        let first: String?
        let last: String?
        let totalDistance: Double?
    }
    let events: [Event]
    let hasMore: Bool
    let updatedOn: String?
}

struct VehicleTimelinePanel: View {
    let vehicleID: String
    @Environment(SessionStore.self) private var session
    @State private var events: [VehicleTimelineResponse.Event] = []
    @State private var nextPage = 1
    @State private var hasMore = false
    @State private var loading = false
    @State private var unavailable = false
    @State private var updatedOn: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Eyebrow(text: "Vehicle timeline")
            if let updatedOn { Text("Updated " + Format.day(updatedOn)).font(.inter(11)).foregroundStyle(Color.chCaption) }
            if unavailable { Text("Timeline data is unavailable.").font(.inter(13)).foregroundStyle(Color.chFog) }
            else if events.isEmpty && !loading { Text("No public timeline events yet.").font(.inter(13)).foregroundStyle(Color.chFog) }
            LazyVStack(alignment: .leading, spacing: 10) {
                ForEach(Array(events.enumerated()), id: \.offset) { _, event in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(Self.title(event)).font(.inter(14, .medium)).foregroundStyle(Color.chInk)
                            Text(Self.meta(event)).font(.inter(13)).foregroundStyle(Color.chFog)
                            if let note = Self.note(event) { Text(note).font(.inter(11)).foregroundStyle(Color.chCaption) }
                        }
                        .accessibilityElement(children: .combine)
                        Spacer()
                        if let id = event.photo?.id, id.count == 32, id.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) {
                            AsyncImage(url: AppConfig.webURL("/api/sightings/\(id)/photo")) { image in
                                image.resizable().scaledToFill()
                            } placeholder: {
                                Color.chSurface2
                            }
                            .frame(width: 64, height: 42).clipShape(.rect(cornerRadius: 6))
                            .accessibilityLabel("Approved sighting photo")
                        }
                    }
                }
            }
            if loading { ProgressView() }
            if hasMore { Button("Load more") { Task { await load() } }.disabled(loading) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard()
        .task(id: vehicleID) { await load() }
    }

    // The website's wording (public/js/vehicle-timeline.js), item for item.
    nonisolated static func title(_ e: VehicleTimelineResponse.Event) -> String {
        switch e.kind {
        case "first_seen": "First seen"
        case "added": "Added to the registry"
        case "approved": e.basis == "vin-verified" ? "Approved as a Cybercab (VIN verified)" : "Approved as a Cybercab (manual review)"
        case "sighting": e.type == "image" ? "Image sighting" : "Vehicle sighting"
        case "rides": "\(Format.int(e.count ?? 0)) recorded ride\(e.count == 1 ? "" : "s")"
        default: e.kind
        }
    }

    nonisolated static func meta(_ e: VehicleTimelineResponse.Event) -> String {
        if e.kind == "rides" {
            let span: String
            if let first = e.first, let last = e.last, first != last { span = "\(Format.day(first)) – \(Format.day(last))" }
            else { span = e.last.map { Format.day($0) } ?? "" }
            let distance = e.totalDistance.map { "\(Format.one($0)) mi total" }
            return [span.isEmpty ? nil : span, distance].compactMap { $0 }.joined(separator: " · ")
        }
        let when = e.date == nil ? "Date not recorded" : e.dateKind == "submitted" ? "Submitted \(Format.day(e.date))" : Format.day(e.date)
        if e.kind == "sighting" {
            return [when, e.camera.map { "Camera: \($0)" }, e.city].compactMap { $0 }.joined(separator: " · ")
        }
        return when
    }

    nonisolated static func note(_ e: VehicleTimelineResponse.Event) -> String? {
        if e.kind == "rides" { return "Ride totals only; individual rides are not published." }
        if e.kind == "sighting", e.type == "image", e.photo == nil { return "Photo no longer stored (photos are kept 30 days)." }
        return nil
    }

    private func load() async {
        guard !loading, UUID(uuidString: vehicleID) != nil else { return }
        loading = true
        defer { loading = false }
        do {
            let page: VehicleTimelineResponse = try await session.api.get(
                "/api/robotaxi-vehicles/\(vehicleID)/timeline",
                query: [URLQueryItem(name: "page", value: String(nextPage))])
            // Every published kind, as on the website, including the rides AGGREGATE
            // (count, first/last date, total distance; never individual rides).
            events += page.events.filter { ["first_seen", "added", "approved", "sighting", "rides"].contains($0.kind) }
            hasMore = page.hasMore
            updatedOn = page.updatedOn
            nextPage += 1
            unavailable = false
        } catch is CancellationError {
        } catch { unavailable = true }
    }
}
