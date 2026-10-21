import SwiftUI

/// The app shell: the system tab bar (Liquid Glass on iOS 26 and later, the
/// standard translucent bar before) with one navigation stack per tab, so each
/// tab keeps its own history.
struct RootView: View {
    @Environment(AppRouter.self) private var router
    @State private var showingAccount = false
    @State private var paths: [AppTab: NavigationPath] = [:]

    var body: some View {
        @Bindable var router = router
        TabView(selection: $router.selectedTab) {
            ForEach(AppTab.allCases) { tab in
                Tab(tab.title, systemImage: tab.systemImage, value: tab) {
                    NavigationStack(path: path(for: tab)) {
                        screen(for: tab)
                            .toolbar { AccountToolbarItem(showingAccount: $showingAccount) }
                            // The website's header: a solid dark bar under the status bar,
                            // so page content never shows behind it while scrolling.
                            .toolbarBackground(Color.chBackground, for: .navigationBar)
                            .toolbarBackgroundVisibility(.visible, for: .navigationBar)
                    }
                }
            }
        }
        .modifier(MinimizingTabBar())
        // Any screen can ask for sign-in (the account sheet holds Google sign-in).
        .environment(\.openSignIn, { [show = $showingAccount] in show.wrappedValue = true })
        .task { if DebugLaunch.opensAccount { showingAccount = true } }
        .sensoryFeedback(.selection, trigger: router.selectedTab)
        // A cybercabhunter.com link handed to the app opens its native screen.
        .onOpenURL { url in if let link = CommunityLink(url: url) { router.open(link) } }
        .sheet(isPresented: $showingAccount) {
            AccountView()
                .presentationDragIndicator(.visible)
        }
    }

    @ViewBuilder
    private func screen(for tab: AppTab) -> some View {
        switch tab {
        case .home: HomeView()
        case .registry: RegistryView()
        case .zones: ZonesView()
        case .community: CommunityView()
        default: NotNativeYetView(tab: tab)
        }
    }

    /// Community keeps its history in the router (links push onto it); the
    /// other tabs keep their own.
    private func path(for tab: AppTab) -> Binding<NavigationPath> {
        if tab == .community { return Binding(get: { router.communityPath }, set: { router.communityPath = $0 }) }
        return Binding(get: { paths[tab] ?? NavigationPath() }, set: { paths[tab] = $0 })
    }
}

/// On iOS 26+, the Liquid Glass tab bar shrinks while scrolling down, as in
/// Apple's apps. Earlier systems keep the standard bar.
private struct MinimizingTabBar: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.tabBarMinimizeBehavior(.onScrollDown)
        } else {
            content
        }
    }
}

/// The account button at the top right of every tab: the rider's avatar when
/// signed in, a person icon otherwise.
struct AccountToolbarItem: ToolbarContent {
    @Binding var showingAccount: Bool
    @Environment(SessionStore.self) private var session

    var body: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Button { showingAccount = true } label: {
                if let user = session.user {
                    AvatarView(user: user, size: 30)
                } else {
                    Image(systemName: "person.crop.circle")
                }
            }
            .accessibilityLabel(session.user == nil ? "Sign in" : "Account")
        }
    }
}

/// Debug builds only: `-tab zones` or `-account` at launch open that screen,
/// so simulator screenshots can show every tab without tapping.
enum DebugLaunch {
    #if DEBUG
    static var initialTab: AppTab? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-tab"), i + 1 < args.count else { return nil }
        return AppTab(rawValue: args[i + 1])
    }
    static var opensAccount: Bool { ProcessInfo.processInfo.arguments.contains("-account") }
    /// `-apiBase http://127.0.0.1:8799`: the UI tests' local Worker
    /// (scripts/community-test-server.mjs), never production data.
    static var apiBase: URL? { value("-apiBase").flatMap(URL.init(string:)) }
    /// `-session s-alice`: a test rider's session on that local Worker, kept in
    /// its own Keychain item so the real session is never touched.
    static var session: String? { value("-session") }
    static var usesTestSession: Bool { apiBase != nil }
    private static func value(_ flag: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
        return args[i + 1]
    }
    #else
    static let initialTab: AppTab? = nil
    static let opensAccount = false
    static let apiBase: URL? = nil
    static let session: String? = nil
    static let usesTestSession = false
    #endif
}
