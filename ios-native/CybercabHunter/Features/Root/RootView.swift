import SwiftUI

/// The app shell: the system tab bar (Liquid Glass on iOS 26 and later, the
/// standard translucent bar before) with one navigation stack per tab, so each
/// tab keeps its own history.
struct RootView: View {
    @Environment(AppRouter.self) private var router
    @Environment(SessionStore.self) private var session
    @State private var pushCoordinator = PushCoordinator.shared
    @State private var pushDestination: PushDestination?
    @State private var showingAccount = false
    @State private var paths: [AppTab: NavigationPath] = [:]
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        @Bindable var router = router
        TabView(selection: $router.selectedTab) {
            ForEach(AppTab.allCases) { tab in
                Tab(tab.title, systemImage: tab.systemImage, value: tab) {
                    NavigationStack(path: path(for: tab)) {
                        screen(for: tab)
                            .toolbar { AccountToolbarItem(showingAccount: $showingAccount) }
                            .modifier(TopBarStyle(tab: tab))
                    }
                    // Pages fade softly under the bar as they scroll (iOS 26's scroll edge effect);
                    // the Zones map runs full screen with no edge effect at all.
                    .modifier(SoftTopEdge(enabled: tab != .zones))
                }
            }
        }
        .modifier(ExpandedTabBar())
        // Any screen can ask for sign-in (the account sheet holds Google sign-in).
        .environment(\.openSignIn, { [show = $showingAccount] in show.wrappedValue = true })
        .task {
            if ProcessInfo.processInfo.arguments.contains("-pushSettings") { router.accountRequest = .notifications }
            if DebugLaunch.opensAccount { showingAccount = true }
            if DebugLaunch.requestsSubmitSighting { router.requestSubmitSighting() }
            if let d = DebugLaunch.destination { router.open(d) }
            if DebugLaunch.enablesLiveActivity { await ServiceLiveActivityController.shared.setEnabled(true) }
        }
        // Siri / Shortcuts asked for an Account screen (Activity Alerts, Siri & Shortcuts),
        // also on a cold launch.
        .onChange(of: router.accountRequest, initial: true) { if router.accountRequest != nil { showingAccount = true } }
        .sensoryFeedback(.selection, trigger: router.selectedTab)
        // The Live Activity follows the switch and the service day each time the app is opened.
        .onChange(of: scenePhase, initial: true) { if scenePhase == .active { Task { await ServiceLiveActivityController.shared.reconcile() } } }
        // Changing tabs always puts the keyboard away (a tab left behind stays alive,
        // so its own field can't do it).
        .onChange(of: router.selectedTab) {
            UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        }
        // A cybercabhunter.com link handed to the app opens its native screen.
        .onOpenURL { url in
            if router.open(widgetURL: url) { return }   // a Home Screen / Lock Screen widget
            if let link = CommunityLink(url: url) { router.open(link) }
        }
        // A saved name or photo: the signed-in account (the Account button) is fetched again.
        .onReceive(NotificationCenter.default.publisher(for: .profileChanged)) { _ in Task { await session.refreshAccount() } }
        .onChange(of: pushCoordinator.pendingURL, initial: true) {
            guard let url = pushCoordinator.pendingURL else { return }
            pushCoordinator.pendingURL = nil
            if url.path == "/community", let link = CommunityLink(url: url) { router.open(link) }
            else if url.path.hasPrefix("/vehicles/") { router.openVehicle(id: String(url.path.dropFirst("/vehicles/".count)), plate: nil) }
            else { pushDestination = PushDestination(url: url) }
        }
        .sheet(item: $pushDestination) { destination in
            NavigationStack { PushDestinationView(destination: destination) }
        }
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
        case .sightings: SightingsView()
        case .community: CommunityView()
        }
    }

    /// Community keeps its history in the router (links push onto it); the
    /// other tabs keep their own.
    private func path(for tab: AppTab) -> Binding<NavigationPath> {
        if tab == .community { return Binding(get: { router.communityPath }, set: { router.communityPath = $0 }) }
        if tab == .sightings { return Binding(get: { router.sightingsPath }, set: { router.sightingsPath = $0 }) }
        if tab == .registry { return Binding(get: { router.registryPath }, set: { router.registryPath = $0 }) }
        if tab == .home { return Binding(get: { router.homePath }, set: { router.homePath = $0 }) }
        return Binding(get: { paths[tab] ?? NavigationPath() }, set: { paths[tab] = $0 })
    }
}

/// On iOS 26+, the Liquid Glass tab bar shrinks while scrolling down, as in
/// Apple's apps. Earlier systems keep the standard bar.
/// All five tabs stay visible: the Liquid Glass bar never collapses to one
/// icon on scroll (iOS 26's minimize behaviour, set explicitly to never).
private struct ExpandedTabBar: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.tabBarMinimizeBehavior(.never)
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
        // iOS 26 puts every toolbar item on a shared Liquid Glass bubble: hidden
        // here, so the round picture itself is the button (other items keep theirs).
        if #available(iOS 26.0, *) {
            item.sharedBackgroundVisibility(.hidden)
        } else {
            item
        }
    }

    private var item: ToolbarItem<Void, some View> {
        ToolbarItem(placement: .topBarTrailing) {
            Button { showingAccount = true } label: {
                Group {
                    if let user = session.user {
                        AvatarView(user: user, size: 30)
                    } else {
                        Image(systemName: "person.crop.circle").font(.system(size: 22))
                    }
                }
                // The visible picture stays 30 pt; the tap target is 44 pt.
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(session.user == nil ? "Sign in" : "Account")
            .accessibilityIdentifier("accountButton")
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
    /// `-open dmvTracker`: what a Siri / Shortcuts "Open …" does (UI tests can't drive Siri).
    static var destination: AppDestination? { value("-open").flatMap(AppDestination.init(rawValue:)) }
    static var resetsSiriState: Bool { ProcessInfo.processInfo.arguments.contains("-resetSiriState") }
    static var resetsLiveActivity: Bool { ProcessInfo.processInfo.arguments.contains("-resetLiveActivity") }
    /// `-enableLiveActivity`: what turning the Live now switch on does (simulator checks without UI taps).
    static var enablesLiveActivity: Bool { ProcessInfo.processInfo.arguments.contains("-enableLiveActivity") }
    /// `-requestSubmitSighting`: what the Siri / Shortcuts "Submit a sighting" intent does (UI tests can't drive Siri).
    static var requestsSubmitSighting: Bool { ProcessInfo.processInfo.arguments.contains("-requestSubmitSighting") }
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
    static let requestsSubmitSighting = false
    static let destination: AppDestination? = nil
    static let resetsSiriState = false
    static let resetsLiveActivity = false
    static let enablesLiveActivity = false
    static let apiBase: URL? = nil
    static let session: String? = nil
    static let usesTestSession = false
    #endif
}

/// The bar over each tab. iOS 26: no painted bar, so content fades softly under
/// it (`SoftTopEdge`); the controls float in Liquid Glass. Earlier systems keep the
/// website's solid dark header (content never shows behind it). Zones is always
/// see-through: its map runs full screen.
private struct TopBarStyle: ViewModifier {
    let tab: AppTab
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.toolbarBackgroundVisibility(.hidden, for: .navigationBar)
        } else {
            content
                .toolbarBackground(Color.chBackground, for: .navigationBar)
                .toolbarBackgroundVisibility(tab == .zones ? .hidden : .visible, for: .navigationBar)
        }
    }
}

/// A soft fade at the top edge of every scrolling page in the stack (pushed
/// screens too): content dissolves into the background under the bar instead of
/// being cut off. Fixed controls (the bar's buttons, a floating search, the tab
/// bar) aren't part of the scroll content, so they never fade. The Zones map isn't
/// a scroll view, so it is unaffected.
private struct SoftTopEdge: ViewModifier {
    var enabled = true
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            if enabled {
                content.scrollEdgeEffectStyle(.soft, for: .top)
            } else {
                // The map isn't scrolling content: no dimmed band under the bar.
                content.scrollEdgeEffectHidden(true, for: .top)
            }
        } else {
            content
        }
    }
}
