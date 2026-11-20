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

/// A sighting photo opened full screen from the History panel.
struct TimelinePhoto: Identifiable, Hashable {
    let id: String
    let url: URL
    let caption: String
}

/// The vehicle's History (the website's vehicle page, public/vehicle.html #vTimeline):
/// first seen, approvals, additions, sightings with their photos, and the rides
/// AGGREGATE. Headed "History", with no "Record" heading above it, as on the web.
struct VehicleTimelinePanel: View {
    let vehicleID: String
    @Environment(SessionStore.self) private var session
    @State private var events: [VehicleTimelineResponse.Event] = []
    @State private var nextPage = 1
    @State private var hasMore = false
    @State private var loading = false
    @State private var loaded = false
    @State private var unavailable = false
    @State private var updatedOn: String?
    @State private var viewing: TimelinePhoto?

    var body: some View {
        let photos = events.compactMap(Self.photo)
        VStack(alignment: .leading, spacing: 12) {
            Text("HISTORY").displayTitle(18).accessibilityIdentifier("vehicleHistoryTitle").accessibilityAddTraits(.isHeader)
            if unavailable {
                Text("History couldn't be loaded.").font(.inter(13)).foregroundStyle(Color.chFog)
            } else if loaded {
                // The sighting photos first, larger, each opening full screen.
                VStack(alignment: .leading, spacing: 8) {
                    Text("Sighting photos").font(.inter(12, .semibold)).foregroundStyle(Color.chFog)
                    if photos.isEmpty {
                        Text(hasMore ? "No sighting photos in the newest events." : "No sighting photos yet.")
                            .font(.inter(13)).foregroundStyle(Color.chFog).accessibilityIdentifier("historyNoPhotos")
                    } else {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(photos) { photo in
                                    Button { viewing = photo } label: {
                                        RemoteImage(url: photo.url, points: 240).frame(width: 120, height: 80).clipShape(.rect(cornerRadius: 8))
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityLabel("Sighting photo, \(photo.caption)")
                                    .accessibilityHint("Opens the photo")
                                    .accessibilityIdentifier("historyPhoto")
                                }
                            }
                        }
                    }
                }
                Rectangle().fill(Color.chInk.opacity(0.08)).frame(height: 1)
                if events.isEmpty {
                    Text("Nothing recorded for this vehicle yet.").font(.inter(13)).foregroundStyle(Color.chFog).accessibilityIdentifier("historyEmpty")
                }
            }
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
                        if let photo = Self.photo(event) {
                            Button { viewing = photo } label: {
                                RemoteImage(url: photo.url, points: 160).frame(width: 72, height: 48).clipShape(.rect(cornerRadius: 6))
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Approved sighting photo")
                            .accessibilityHint("Opens the photo")
                        }
                    }
                    .accessibilityIdentifier("historyEvent")
                }
            }
            if loading { ProgressView() }
            if hasMore { Button("Show more") { Task { await load() } }.disabled(loading) }
            if let updatedOn {
                Footnote(text: "Updated daily from approved, public records · last update \(Format.day(updatedOn)). In- and out-of-service changes are not recorded by the site.")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard()
        .task(id: vehicleID) { await load() }
        .fullScreenCover(item: $viewing) { TimelinePhotoViewer(photo: $0) }
    }

    /// A sighting's photo, if it still has one: the site's photo path for the
    /// sighting (/api/sightings/<32 hex>/photo, the API's image_url), on the website's origin.
    nonisolated static func photo(_ e: VehicleTimelineResponse.Event) -> TimelinePhoto? {
        guard e.kind == "sighting", let id = e.photo?.id, id.count == 32,
              id.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { return nil }
        return TimelinePhoto(id: id, url: AppConfig.webURL("/api/sightings/\(id)/photo"), caption: meta(e))
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
            loaded = true
        } catch is CancellationError {
        } catch { unavailable = true }
    }
}

/// A History photo, full screen (as the Sightings tab's viewer).
struct TimelinePhotoViewer: View {
    let photo: TimelinePhoto
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            VStack(spacing: 14) {
                Spacer()
                RemoteImage(url: photo.url, points: 1400, contentMode: .fit).accessibilityLabel("Sighting photo")
                Text(photo.caption).font(.inter(13)).foregroundStyle(.white.opacity(0.85)).multilineTextAlignment(.center).padding(.horizontal, 20)
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
