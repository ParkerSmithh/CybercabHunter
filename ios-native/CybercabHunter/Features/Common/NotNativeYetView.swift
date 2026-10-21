import SwiftUI

/// A tab whose native screen is still being built: it says so, and opens the
/// same page of the website meanwhile. Never a mock-up of the real feature.
struct NotNativeYetView: View {
    let tab: AppTab
    @State private var showingWeb = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Eyebrow(text: "Coming in phase \(tab.nativePhase)")
                Text("The native \(tab.title) screen is on its way.")
                    .font(.title2.weight(.bold))
                Text("Until then, \(tab.title) opens the same page of cybercabhunter.com, with the same data.")
                    .foregroundStyle(Color.secondaryText)
                Button {
                    showingWeb = true
                } label: {
                    Label("Open \(tab.title) on the website", systemImage: "safari")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .foregroundStyle(Color.appBackground)
            }
            .card(padding: 20)
            .padding()
        }
        .appBackground()
        .navigationTitle(tab.title)
        .fullScreenCover(isPresented: $showingWeb) {
            SafariView(url: AppConfig.webURL(tab.webPath)).ignoresSafeArea()
        }
    }
}
