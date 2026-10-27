import SwiftUI
import AppIntents

@main
struct CybercabHunterApp: App {
    @UIApplicationDelegateAdaptor(PushAppDelegate.self) private var pushDelegate
    @Environment(\.scenePhase) private var scenePhase
    @State private var session = SessionStore()
    @State private var router = AppRouter.shared

    init() {
        // Refresh the finite Siri phrase choices after app updates; no API calls.
        SiriStartupDiagnostics.start()
        // Photos and API responses honour the Worker's Cache-Control; a larger
        // cache keeps sighting photos and car renders from re-downloading.
        URLCache.shared = URLCache(memoryCapacity: 32 << 20, diskCapacity: 200 << 20)
        // UI tests: `-resetSiriState` starts with Activity Alerts at their default (off).
        if DebugLaunch.resetsSiriState { UserDefaults.standard.removeObject(forKey: ActivityAlertSettings.key) }
        // UI tests: `-resetLiveActivity` starts with the Live Activity switch at its default (off).
        if DebugLaunch.resetsLiveActivity { UserDefaults.standard.removeObject(forKey: ServiceLiveActivityController.enabledKey) }
        // Inter in the navigation bars, as on the website.
        let inline = UIFont(name: "Inter", size: 17).map { UIFontMetrics(forTextStyle: .headline).scaledFont(for: $0.withWeight(.semibold)) }
        let large = UIFont(name: "Inter", size: 32).map { UIFontMetrics(forTextStyle: .largeTitle).scaledFont(for: $0.withWeight(.bold)) }
        let appearance = UINavigationBar.appearance()
        if let inline { appearance.titleTextAttributes = [.font: inline] }
        if let large { appearance.largeTitleTextAttributes = [.font: large] }
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(session)
                .environment(router)
                .font(.inter(16))
                .tint(.brandGold)
                .preferredColorScheme(.dark)
                .task { await session.restore() }
                .task(id: session.user?.id) { await PushCoordinator.shared.connect(api: session.api, user: session.user?.id) }
                .onChange(of: scenePhase) { if scenePhase == .active { Task { await PushCoordinator.shared.connect(api: session.api, user: session.user?.id) } } }
                // Spotlight holds only the vehicles you open (SpotlightRecents); this
                // removes the whole-registry index earlier versions made, once.
                .task(priority: .background) { if !DebugLaunch.usesTestSession { await VehicleDirectory.retireFullRegistryIndex() } }
        }
    }
}

private extension UIFont {
    /// A weight of a variable font (Inter's wght axis).
    func withWeight(_ weight: UIFont.Weight) -> UIFont {
        let descriptor = fontDescriptor.addingAttributes([.traits: [UIFontDescriptor.TraitKey.weight: weight]])
        return UIFont(descriptor: descriptor, size: pointSize)
    }
}
