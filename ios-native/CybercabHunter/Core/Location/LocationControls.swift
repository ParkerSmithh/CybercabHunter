import SwiftUI

struct LocationFeedback: View {
    let service: LocationService
    @Environment(\.openURL) private var openURL
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if service.requesting { ProgressView("Finding location…").tint(Color.brandGold) }
            if let message = service.message {
                Text(message)
                if service.canOpenSettings {
                    Button("Open Settings") { if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) } }
                } else { Button("Retry location") { service.request() } }
            }
            if service.location != nil { Text(service.accuracyText) }
        }
        .font(.footnote).foregroundStyle(Color.chMist)
        .accessibilityElement(children: .contain)
    }
}
