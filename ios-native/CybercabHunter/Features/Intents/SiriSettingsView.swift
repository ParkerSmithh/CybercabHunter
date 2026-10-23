import SwiftUI
import AppIntents
import CoreLocation

/// Account › Siri & Shortcuts: what you can ask, the Shortcuts app, location
/// for "near me", what's in Spotlight, and Activity Alerts' status.
struct SiriSettingsView: View {
    @State private var location = LocationPermission()
    @State private var recents = SpotlightRecents.items().count

    /// Each action, with a phrase Siri understands (it matches loosely, not word for word).
    static let actions: [(title: String, phrase: String, symbol: String)] = [
        ("Daily Briefing", "Give me my Cybercab briefing in Cybercab Hunter", "newspaper"),
        ("Quick Status", "Give me a quick Cybercab status in Cybercab Hunter", "waveform"),
        ("Check Fleet", "How many Cybercabs are tracked in Cybercab Hunter", "chart.bar.fill"),
        ("DMV Updates", "Check Cybercab DMV updates in Cybercab Hunter", "doc.text.magnifyingglass"),
        ("Fleet Growth", "How much has the Cybercab fleet grown in Cybercab Hunter", "chart.line.uptrend.xyaxis"),
        ("Recent Sightings", "Check Cybercab sightings in Dallas in Cybercab Hunter", "camera.viewfinder"),
        ("Nearby Sightings", "Find Cybercab sightings near me in Cybercab Hunter", "location.circle"),
        ("Find a Cybercab", "Find XVF1524 in Cybercab Hunter", "magnifyingglass"),
        ("Vehicle History", "Show the history of XVF1524 in Cybercab Hunter", "clock.arrow.circlepath"),
        ("Service Zone", "How big is the Austin Cybercab service area in Cybercab Hunter", "map"),
        ("Open a Screen", "Open DMV Tracker in Cybercab Hunter", "rectangle.stack")
    ]

    var body: some View {
        List {
            Section {
                SiriTipView(intent: DailyBriefingIntent())
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }
            Section {
                ForEach(Self.actions, id: \.title) { a in
                    VStack(alignment: .leading, spacing: 3) {
                        Label(a.title, systemImage: a.symbol).font(.inter(15, .semibold))
                        Text("“\(a.phrase)”").font(.inter(12.5)).foregroundStyle(Color.chMist)
                    }
                    .padding(.vertical, 2)
                }
            } header: { Text("Ask Siri") } footer: {
                Text("Siri answers from Cybercab Hunter's public data and offers to open the screen. Siri matches phrases loosely, so similar wording usually works.")
            }
            .accessibilityIdentifier("siriActions")

            Section {
                ShortcutsLink()
                    .shortcutsLinkStyle(.automaticOutline)
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
            } footer: {
                Text("Every action is in the Shortcuts app, including ones without a Siri phrase (Quick Status, a city's Sightings, Submit a Sighting). Use Shortcuts automations for a scheduled briefing; the app never runs one on its own.")
            }

            Section {
                LabeledContent("Location") { Text(location.statusText).foregroundStyle(Color.chFog) }
                    .accessibilityIdentifier("siriLocationStatus")
                switch location.status {
                case .notDetermined:
                    Button("Allow location for nearby sightings") { location.request() }
                        .accessibilityIdentifier("siriAllowLocation")
                case .denied, .restricted:
                    Button("Open Settings") { if let u = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(u) } }
                default:
                    EmptyView()
                }
            } header: { Text("Nearby sightings") } footer: {
                Text("Used once each time you ask, only while you use it; approximate location works. Never stored, never tracked, never sent anywhere but the camera search.")
            }

            Section {
                LabeledContent("Recently viewed Cybercabs") { Text("\(recents)").foregroundStyle(Color.chFog) }
                Button("Clear from Spotlight", role: .destructive) {
                    Task { await SpotlightRecents.clear(); recents = 0 }
                }
                .disabled(recents == 0)
                .accessibilityIdentifier("siriClearSpotlight")
            } header: { Text("Spotlight") } footer: {
                Text("Only public vehicles you opened are added to Spotlight, on this iPhone.")
            }

            Section {
                Text("Every action works with Siri on iOS 18 and later. With Apple Intelligence on, a vehicle's page tells Siri which Cybercab is on screen, so requests about “this Cybercab” can use it where your iOS version and region support it.")
                    .font(.inter(13)).foregroundStyle(Color.chMist)
            } header: { Text("Apple Intelligence") }

            Section {
                NavigationLink(value: AccountRoute.alerts) {
                    LabeledContent { Text(ActivityAlertSettings.load().enabled ? "On" : "Off") } label: { Label("Activity Alerts", systemImage: "bell.badge") }
                }
            } footer: { Text("Off unless you turn it on. Delivery isn't available yet.") }
        }
        .font(.inter(15))
        .appBackground()
        .navigationTitle("Siri & Shortcuts")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// The "While Using" location permission, asked only from this button.
@MainActor
@Observable
final class LocationPermission: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private(set) var status: CLAuthorizationStatus

    override init() {
        status = manager.authorizationStatus
        super.init()
        manager.delegate = self
    }

    func request() { manager.requestWhenInUseAuthorization() }

    var statusText: String {
        switch status {
        case .authorizedWhenInUse, .authorizedAlways: manager.accuracyAuthorization == .fullAccuracy ? "Allowed" : "Allowed (approximate)"
        case .denied, .restricted: "Not allowed"
        default: "Not asked"
        }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let s = manager.authorizationStatus
        Task { @MainActor in self.status = s }
    }
}
