import SwiftUI

struct SightingLocationSheet: View {
    let submission: SubmitSightingModel
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
                    Text("Find nearby place sends your current location to Apple Maps to find nearby places, with a street lookup as a fallback. Place or street names and your selected city are then searched with Cybercab Hunter's existing verified-place service. GPS coordinates aren't sent to Cybercab Hunter or added to your sighting.")
                        .font(.subheadline).foregroundStyle(Color.chMist)
                        .accessibilityIdentifier("sightingLocationPrivacy")
                    Text("Choose where the sighting happened. Your phone's current location may differ from an earlier photo's location.")
                        .font(.footnote).foregroundStyle(Color.chMist)
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
                                        Text("Approximately \(String(format: "%.1f", candidate.meters / 1609.344)) miles from your recorded location")
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
                        Button(model.phase == .failed ? "Retry nearby lookup" : "Find nearby place") { start() }
                            .buttonStyle(GoldButtonStyle()).disabled(submission.area == nil)
                            .accessibilityIdentifier("findNearbySightingPlace")
                    }
                    Button("Search manually instead") { dismiss() }.tint(Color.brandGold)
                        .accessibilityIdentifier("manualSightingLocation")
                }.padding(20)
            }.appBackground().navigationTitle("Use Current Location")
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
        location.request()
        finishLocationRequest()
    }
    private func finishLocationRequest() {
        guard model.phase == .locating, !location.requesting, lookupTask == nil else { return }
        guard let area = submission.area else { return }
        lookupTask = Task { await model.resolveLocation(using: location, area: area, api: session.api) }
    }
    private func stop() {
        lookupTask?.cancel(); lookupTask = nil
        location.cancel(); model.cancel(); selected = nil
    }
}
