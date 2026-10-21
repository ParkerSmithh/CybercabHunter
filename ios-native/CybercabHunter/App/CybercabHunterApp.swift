import SwiftUI

@main
struct CybercabHunterApp: App {
    @State private var session = SessionStore()
    @State private var router = AppRouter()

    init() {
        // Photos and API responses honour the Worker's Cache-Control; a larger
        // cache keeps sighting photos and car renders from re-downloading.
        URLCache.shared = URLCache(memoryCapacity: 32 << 20, diskCapacity: 200 << 20)
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
