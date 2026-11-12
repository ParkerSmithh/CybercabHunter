import SwiftUI
import AppIntents

@main
struct CybercabHunterApp: App {
    @UIApplicationDelegateAdaptor(PushAppDelegate.self) private var pushDelegate
    @Environment(\.scenePhase) private var scenePhase
    @State private var session = SessionStore()
    @State private var router = AppRouter.shared
    @State private var intro = StartupIntro.shared

    init() {
        // Refresh the finite Siri phrase choices after app updates; no API calls.
        SiriStartupDiagnostics.start()
        // Zones' city is per session now: drop the value earlier builds saved.
        UserDefaults.standard.removeObject(forKey: ZonesModel.legacyCityKey)
        // Photos and API responses honour the Worker's Cache-Control; a larger
        // cache keeps sighting photos and car renders from re-downloading.
        URLCache.shared = URLCache(memoryCapacity: 32 << 20, diskCapacity: 200 << 20)
        // UI tests: `-resetSiriState` starts with Activity Alerts at their default (off).
        if DebugLaunch.resetsSiriState { UserDefaults.standard.removeObject(forKey: ActivityAlertSettings.key) }
        // UI tests: `-resetLiveActivity` starts with the Live Activity switch at its default (off).
        if DebugLaunch.resetsLiveActivity { UserDefaults.standard.removeObject(forKey: ServiceLiveActivityController.enabledKey) }
        // UI tests: `-seedSharedSighting` leaves a test photo where the Share extension would.
        if DebugLaunch.seedsSharedSighting {
            let photo = UIGraphicsImageRenderer(size: CGSize(width: 1200, height: 800)).pngData { ctx in
                UIColor(red: 250 / 255, green: 224 / 255, blue: 48 / 255, alpha: 1).setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 1200, height: 800))
                UIColor.black.setFill(); ctx.fill(CGRect(x: 200, y: 300, width: 800, height: 220))
            }
            _ = try? SightingShareInbox.save(photo)
        }
        // UI tests: `-seedSharedReceipt text|pdf|image` leaves a sanitized receipt where the Share extension would.
        #if DEBUG
        // UI tests (-apiBase) start with no shared receipt left by an earlier test,
        // unless a test seeds one or keeps one (-keepSharedReceipts) on purpose.
        if DebugLaunch.usesTestSession && DebugLaunch.seedsSharedReceipt == nil && !ProcessInfo.processInfo.arguments.contains("-keepSharedReceipts") {
            ReceiptShareInbox.pending().forEach { ReceiptShareInbox.discard($0.id) }
        }
        if let kind = DebugLaunch.seedsSharedReceipt { _ = try? ReceiptShareInbox.save(TestReceipt.data(kind)) }
        #endif
        // Inter in the navigation bars, as on the website.
        let inline = UIFont(name: "Inter", size: 17).map { UIFontMetrics(forTextStyle: .headline).scaledFont(for: $0.withWeight(.semibold)) }
        let large = UIFont(name: "Inter", size: 32).map { UIFontMetrics(forTextStyle: .largeTitle).scaledFont(for: $0.withWeight(.bold)) }
        let appearance = UINavigationBar.appearance()
        if let inline { appearance.titleTextAttributes = [.font: inline] }
        if let large { appearance.largeTitleTextAttributes = [.font: large] }
    }

    var body: some Scene {
        WindowGroup {
            // The opening animation sits over the app, which loads beneath it,
            // and crossfades away into Home (Features/Startup/StartupIntro.swift).
            ZStack {
                RootView()
                    .environment(session)
                    .environment(router)
                    .font(.inter(16))
                    .tint(.brandGold)
                if intro.isShowing {
                    StartupIntroView(intro: intro)
                        .transition(.opacity)
                        .zIndex(1)
                }
            }
                .statusBarHidden(intro.isShowing)
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
