import SwiftUI

struct VehicleTimelineResponse: Decodable, Sendable {
    struct Event: Decodable, Sendable {
        struct Photo: Decodable, Sendable { let id: String }
        let kind: String
        let date: String?
        let photo: Photo?
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
            Text("Vehicle timeline").font(.headline)
            if let updatedOn { Text("Updated " + String(updatedOn.prefix(10))).font(.caption).foregroundStyle(.secondary) }
            if unavailable { Text("Timeline data is unavailable.").font(.footnote) }
            else if events.isEmpty && !loading { Text("No public timeline events yet.").font(.footnote) }
            LazyVStack(alignment: .leading, spacing: 10) {
                ForEach(Array(events.enumerated()), id: \.offset) { _, event in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(label(event.kind)).font(.subheadline.weight(.semibold))
                            if let day = event.date { Text(String(day.prefix(10))).font(.caption).foregroundStyle(.secondary) }
                        }
                        Spacer()
                        if let id = event.photo?.id, id.count == 32, id.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) {
                            AsyncImage(url: AppConfig.webURL("/api/sightings/\(id)/photo")) { image in
                                image.resizable().scaledToFill()
                            } placeholder: {
                                Color.secondary.opacity(0.15)
                            }
                            .frame(width: 64, height: 42).clipped()
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

    private func label(_ kind: String) -> String {
        switch kind {
        case "first_seen": "First seen"
        case "added": "Registry entry added"
        case "approved": "Approved for the public registry"
        case "sighting": "Approved sighting"
        default: "Registry update"
        }
    }

    private func load() async {
        guard !loading, UUID(uuidString: vehicleID) != nil else { return }
        loading = true
        defer { loading = false }
        do {
            let page: VehicleTimelineResponse = try await session.api.get(
                "/api/robotaxi-vehicles/\(vehicleID)/timeline",
                query: [URLQueryItem(name: "page", value: String(nextPage))])
            // Published ride totals remain in the existing aggregate panel.
            events += page.events.filter { ["first_seen", "added", "approved", "sighting"].contains($0.kind) }
            hasMore = page.hasMore
            updatedOn = page.updatedOn
            nextPage += 1
            unavailable = false
        } catch is CancellationError {
        } catch { unavailable = true }
    }
}
