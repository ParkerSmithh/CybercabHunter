import SwiftUI
import MapKit

/// Suggest a nearby verified place: from the phone's current location, or
/// (`photo`) from the location saved in the sighting's photo. Either way the
/// rider picks and confirms a real verified place; coordinates never reach the
/// submission or CybercabHunter's server.
struct SightingLocationSheet: View {
    let submission: SubmitSightingModel
    /// The photo's saved location (PhotoLocation): no location permission needed.
    var photo: PhotoLocation? = nil
    @Environment(SessionStore.self) private var session
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @State private var location = LocationService.shared
    @State private var model = SightingLocationModel()
    @State private var lookupTask: Task<Void, Never>?
    @State private var selected: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Suggest a nearby place").font(.inter(22, .bold)).foregroundStyle(Color.chInk)
                    if let photo {
                        photoHeader(photo)
                    } else {
                        Text("Find nearby place sends your current location to Apple Maps to find nearby places, with a street lookup as a fallback. Place or street names and your selected city are then searched with Cybercab Hunter's existing verified-place service. GPS coordinates aren't sent to Cybercab Hunter or added to your sighting.")
                            .font(.subheadline).foregroundStyle(Color.chMist)
                            .accessibilityIdentifier("sightingLocationPrivacy")
                        Text("Choose where the sighting happened. Your phone's current location may differ from an earlier photo's location.")
                            .font(.footnote).foregroundStyle(Color.chMist)
                    }
                    if model.phase == .locating || model.phase == .lookingUp {
                        ProgressView(model.phase == .locating ? "Finding location…" : "Finding verified places…").tint(Color.brandGold)
                    }
                    if model.phase == .failed && location.canOpenSettings {
                        Button("Open Settings") {
                            if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                        }.tint(Color.brandGold)
                    }
                    Text("Selected city: \(submission.area?.name ?? "Choose a city")").font(.footnote).foregroundStyle(Color.chMist)
                    if let failure = model.failure {
                        Text(failure.title).font(.headline).foregroundStyle(Color.brandGold)
                            .accessibilityIdentifier("sightingLookupFailure")
                    }
                    if let message = model.message { Text(message).font(.callout).foregroundStyle(Color.chMist) }
                    if model.phase == .failed {
                        DisclosureGroup("Lookup details") {
                            VStack(alignment: .leading, spacing: 5) {
                                Text("Location accepted: \(model.diagnostics.locationAccepted ? "Yes" : "No")")
                                Text("Apple searches: \(model.diagnostics.appleRequests) · places returned: \(model.diagnostics.appleCandidates)")
                                Text("Apple no-match responses: \(model.diagnostics.appleNoMatches) · street fallback: \(model.diagnostics.streetFallback ? "Yes" : "No")")
                                Text("Verified searches: \(model.diagnostics.queryAttempts) · places returned: \(model.diagnostics.verifiedCandidates)")
                                Text("Unmatched verified places: \(model.diagnostics.unmatchedIDs) · outside nearby area: \(model.diagnostics.outsideRegion)")
                                if let code = model.diagnostics.appleErrorCode { Text("Apple lookup error code: \(code)") }
                                if let status = model.diagnostics.verifiedHTTPStatus { Text("Place-service HTTP status: \(status)") }
                            }.font(.caption).foregroundStyle(Color.chMist)
                        }.tint(Color.brandGold).accessibilityIdentifier("sightingLookupDetails")
                    }
                    if let accuracy = model.accuracy {
                        Text("Approximate location accuracy: ±\(Int(accuracy.rounded(.up))) m.").font(.footnote).foregroundStyle(Color.chMist)
                    }
                    if model.phase == .choosing {
                        ForEach(model.suggestions) { candidate in
                            Button { selected = candidate.id } label: {
                                HStack(alignment: .top) {
                                    Image(systemName: selected == candidate.id ? "checkmark.circle.fill" : "circle")
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(candidate.place.label)
                                        Text("Approximately \(String(format: "%.1f", candidate.meters / 1609.344)) miles from \(photo == nil ? "your recorded location" : "the photo's location")")
                                            .font(.footnote).foregroundStyle(Color.chMist)
                                    }
                                }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 8)
                            }.buttonStyle(.plain).foregroundStyle(Color.brandGold)
                            .accessibilityIdentifier("nearbyVerifiedPlace")
                        }
                        Button("Use selected place") {
                            if let selected, model.confirm(selected, in: submission) { dismiss() }
                        }.buttonStyle(GoldButtonStyle()).disabled(selected == nil)
                        .accessibilityIdentifier("confirmSightingPlace")
                    }
                    if model.phase == .disclosure || model.phase == .failed {
                        Button(model.phase == .failed ? "Retry nearby lookup" : (photo == nil ? "Find nearby place" : "Find places near the photo")) { start() }
                            .buttonStyle(GoldButtonStyle()).disabled(submission.area == nil)
                            .accessibilityIdentifier("findNearbySightingPlace")
                    }
                    Button("Search manually instead") { dismiss() }.tint(Color.brandGold)
                        .accessibilityIdentifier("manualSightingLocation")
                }.padding(20)
            }.appBackground().navigationTitle(photo == nil ? "Use Current Location" : "Location from Photo")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .onChange(of: location.requesting) { finishLocationRequest() }
        .onChange(of: scenePhase) { if scenePhase == .background { stop() } }
        .onDisappear { stop() }
    }

    private func start() {
        guard let area = submission.area else { return }
        lookupTask?.cancel(); lookupTask = nil; selected = nil
        model.begin(area: area)
        if let photo {
            // The photo's own location: no location request, no permission.
            lookupTask = Task { await model.lookup(photo.fix, area: area, api: session.api, fromPhoto: true) }
            return
        }
        location.request()
        finishLocationRequest()
    }
    private func finishLocationRequest() {
        guard photo == nil, model.phase == .locating, !location.requesting, lookupTask == nil else { return }
        guard let area = submission.area else { return }
        lookupTask = Task { await model.resolveLocation(using: location, area: area, api: session.api) }
    }
    private func stop() {
        lookupTask?.cancel(); lookupTask = nil
        if photo == nil { location.cancel() }
        model.cancel(); selected = nil
    }

    /// Photo mode: where the suggestion comes from, a small map of the photo's
    /// location (drawn on the phone; nothing is sent), and its city.
    @ViewBuilder private func photoHeader(_ photo: PhotoLocation) -> some View {
        Label("Location found in photo", systemImage: "photo.badge.checkmark")
            .font(.inter(14, .semibold)).foregroundStyle(Color.brandGold)
        Text("Uses the location saved in your photo to find nearby places with Apple Maps, then matches them to CybercabHunter's verified places. The photo's coordinates aren't sent to CybercabHunter or added to your sighting.")
            .font(.subheadline).foregroundStyle(Color.chMist)
            .accessibilityIdentifier("sightingLocationPrivacy")
        Text("A photo's location is where the camera was, which may not be exactly where the Cybercab was. Check the place before you use it.")
            .font(.footnote).foregroundStyle(Color.chMist)
        Map(initialPosition: .region(MKCoordinateRegion(center: photo.coordinate, latitudinalMeters: 900, longitudinalMeters: 900)), interactionModes: []) {
            Marker("Photo location", systemImage: "camera.fill", coordinate: photo.coordinate).tint(Color.brandGold)
        }
        .mapStyle(.standard(pointsOfInterest: .excludingAll))
        .frame(height: 150)
        .clipShape(.rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.brandGold.opacity(0.35)))
        .accessibilityLabel("Map of the photo's location")
        .accessibilityIdentifier("photoLocationMap")
        let photoArea = photo.area(in: submission.areas)
        if let photoArea {
            if submission.area == nil {
                Button("Use \(photoArea.name), where the photo was taken") { submission.cityName = photoArea.name }
                    .buttonStyle(GoldButtonStyle(small: true))
                    .accessibilityIdentifier("usePhotoCity")
            } else if submission.area?.key != photoArea.key {
                Text("This photo was taken in the \(photoArea.name) area, but your sighting's city is \(submission.area?.name ?? "").")
                    .font(.footnote).foregroundStyle(Color.brandGold)
                Button("Switch to \(photoArea.name)") { submission.cityName = photoArea.name; model.cancel(); selected = nil }
                    .buttonStyle(GoldButtonStyle(small: true))
                    .accessibilityIdentifier("usePhotoCity")
            }
        } else {
            Text("This photo was taken outside Austin and Dallas. Search manually if the sighting was in a service area.")
                .font(.footnote).foregroundStyle(Color.brandGold)
                .accessibilityIdentifier("photoOutsideAreas")
        }
    }
}
