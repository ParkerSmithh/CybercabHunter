import SwiftUI

struct TrackerExplorePanel: View {
    @AppStorage(TrackerCity.storageKey) private var city = TrackerCity.austin
    @Environment(SessionStore.self) private var session
    @State private var snapshot: PublicSnapshot<TrackerCityList>?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Picker("Tracker city", selection: $city) {
                ForEach(TrackerCity.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented)
            if let snapshot, let selected = snapshot.value.cities.first(where: { $0.key == city.rawValue }) {
                Text(selected.name).font(.headline)
                Text("\(selected.zone.squareMiles) mi² · \(selected.zone.hours.allDay ? "24/7" : selected.zone.hours.open + "–" + selected.zone.hours.close)")
                    .font(.subheadline)
                Text("Robotaxi service since \(selected.zone.inServiceSince)").font(.footnote)
                if let since = selected.stats?.cybercabSince ?? selected.cybercabSince {
                    Text("First documented Cybercab · \(since)").font(.footnote)
                }
                if let count = selected.stats?.registry {
                    Text("\(count) public registry vehicles").font(.footnote)
                }
                if snapshot.cached { Text("Saved city facts · " + snapshot.fetchedAt.formatted(date: .abbreviated, time: .shortened)).font(.caption) }
            }
            ForEach(TrackerHistoryKind.allCases) { kind in
                NavigationLink { TrackerHistoryView(kind: kind) } label: {
                    Label(kind.title, systemImage: kind == .fleet ? "chart.xyaxis.line" : "dollarsign.circle")
                }
            }
        }
        .glassCard()
        .task {
            snapshot = try? await PublicSnapshotCache.shared.load("/api/cities", source: .cities, api: session.api)
        }
    }
}
