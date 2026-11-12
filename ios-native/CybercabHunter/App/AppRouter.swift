import SwiftUI
import Observation

/// Which tab is showing, app-wide, so a screen can send the rider to another
/// tab ("See all" on Home opens Cars or Sightings).
@MainActor
@Observable
final class AppRouter {
    /// The one router of the app: the scene uses it, and so do App Intents
    /// (Siri, Shortcuts, Spotlight), which run outside the view tree.
    static let shared: AppRouter = {
        let router = AppRouter()
        router.connectQuickActions()
        return router
    }()

    /// Control Center, Lock Screen, Action Button and Shortcuts requests
    /// (Shared/QuickActions.swift) all arrive here, including one made before
    /// the app finished launching.
    func connectQuickActions() {
        QuickActionCenter.connect { [weak self] in self?.perform($0) }
    }

    var selectedTab: AppTab = DebugLaunch.initialTab ?? .home
    /// A city for Zones to open on (Home's minimaps set it).
    var zonesCity: String?
    /// The Community tab's navigation history, so notifications and the site's
    /// own links (a post, a rider, a vehicle) open native screens there.
    var communityPath = NavigationPath()
    /// The Sightings tab's history (a sighting's plate opens its vehicle).
    var sightingsPath = NavigationPath()
    /// The Community section to show (Home's links choose one).
    var communitySection: CommunitySection?
    /// The Cars tab's history (Siri / Spotlight open a vehicle there).
    var registryPath = NavigationPath()
    /// Set by the "Submit a sighting" shortcut: Sightings opens its form.
    var submitSightingRequested = false
    /// With it: the form opens Apple's camera first (the New Sighting control).
    var submitSightingWithCamera = false
    /// A signed-out rider asked for the sighting form: it opens once they sign
    /// in (within ten minutes), and is forgotten if they close sign-in.
    var resumeSightingAfterSignIn: (camera: Bool, at: Date)?
    /// Whether the open sighting form holds the rider's work (a photo, a
    /// plate or notes): a system control never closes it then.
    var sightingFormHasDraft = false
    /// A control asked for another screen while the form holds a draft: the
    /// form asks "Leave this sighting?" before anything is lost.
    var draftConflict: QuickAction?

    // MARK: System controls (Control Center, Lock Screen, Action Button, Shortcuts)

    /// The last request and when, so a double tap or a request delivered twice
    /// (an intent and its link) navigates once.
    private(set) var lastQuickAction: (action: QuickAction, at: Date)?
    /// Bumped by each request: RootView closes the Account and notification
    /// sheets, and Sightings closes an empty form, so the destination shows.
    private(set) var presentationReset = 0
    /// When RootView last closed a sheet for a request: a new sheet waits for
    /// that animation instead of failing to present.
    var sheetsClosedAt: Date?
    /// Sightings asks RootView to close the account sheet once sign-in is done.
    var closeAccountSheetRequest = 0

    /// The one way a system control or shortcut navigates. Returns false for a
    /// duplicate (the same action within a second).
    @discardableResult
    func perform(_ action: QuickAction, now: Date = .now, leavingDraft: Bool = false) -> Bool {
        StartupIntro.shared.skip()   // a launch with a destination goes straight there
        if let last = lastQuickAction, last.action == action, now.timeIntervalSince(last.at) < 1 { return false }
        // The sighting form holds the rider's photo or notes, and going
        // elsewhere would close it: the form asks first (SubmitSightingView).
        if sightingFormHasDraft && !action.opensSightingForm && !leavingDraft {
            draftConflict = action
            return false
        }
        lastQuickAction = (action, now)
        presentationReset &+= 1
        switch action {
        case .open: break
        case .fleet: open(AppDestination.home)
        case .map: open(AppDestination.map)
        case .community: open(AppDestination.community)
        case .camera: requestSubmitSighting(camera: true)
        case .newSighting: requestSubmitSighting(camera: false)
        }
        return true
    }
    /// A photo shared from the Share Sheet (SightingShareInbox), for the form to attach.
    var sharedSighting: SightingShareInbox.Share?
    /// Home's history (Siri opens the Texas DMV tracker there).
    var homePath = NavigationPath()
    /// A city for Sightings to show (Siri: "show Cybercab sightings in Dallas").
    var sightingsCity: String?
    /// An Account screen to open (Siri: Activity Alerts, Siri & Shortcuts).
    var accountRequest: AccountRoute?

    func openZones(_ city: String) {
        zonesCity = city
        selectedTab = .zones
    }

    /// Opens a cybercabhunter.com link natively in the Community tab.
    func open(_ link: CommunityLink) {
        StartupIntro.shared.skip()   // a launch with a destination goes straight there
        selectedTab = .community
        switch link {
        case .post(let route): communityPath.append(route)
        case .rider(let route): communityPath.append(route)
        case .vehicle(let route): communityPath.append(route)
        case .community: break
        }
    }

    /// A vehicle's page in the Cars tab (from Siri, Shortcuts or Spotlight).
    func openVehicle(id: String, plate: String?) {
        StartupIntro.shared.skip()   // a launch with a destination goes straight there
        registryPath = NavigationPath()
        registryPath.append(VehicleRoute(id: id, plate: plate))
        selectedTab = .registry
    }

    /// The Sightings tab with its "Submit a sighting" form (`camera`: opening
    /// Apple's camera first).
    func requestSubmitSighting(camera: Bool = false) {
        selectedTab = .sightings
        submitSightingWithCamera = camera
        submitSightingRequested = true
    }

    /// A photo shared to Cybercab Hunter is waiting: the form opens with it
    /// (after signing in, when signed out). Each share is offered once.
    func openSharedSighting(now: Date = .now) {
        guard sharedSighting == nil, let share = SightingShareInbox.pending(now: now).first else { return }
        StartupIntro.shared.skip()
        sharedSighting = share
        requestSubmitSighting()
    }

    /// A receipt shared to Cybercab Hunter (ReceiptShareInbox) is waiting: the
    /// Import Receipt screen opens with it. Offered once per app session; it
    /// stays in the inbox until imported or discarded (three days at most).
    var sharedReceipt: ReceiptShareInbox.Share?
    private var offeredReceipts = Set<UUID>()
    func openSharedReceipt(now: Date = .now, force: Bool = false) {
        guard sharedReceipt == nil, let share = ReceiptShareInbox.pending(now: now).first(where: { force || !offeredReceipts.contains($0.id) }) else { return }
        offeredReceipts.insert(share.id)
        StartupIntro.shared.skip()
        sharedReceipt = share
    }

    /// A widget's link (`cybercabhunter-widget://<tab>[?city=…]`): opens that tab.
    /// Returns false for any other URL.
    @discardableResult
    func open(widgetURL url: URL) -> Bool {
        guard url.scheme == WidgetLink.scheme, let host = url.host() else { return false }
        StartupIntro.shared.skip()
        // A system-control request as a link (cybercabhunter-widget://action?do=map).
        if host == "action" {
            if let action = QuickAction(url: url) { perform(action) } else { selectedTab = .home }
            return true
        }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let city = items.first { $0.name == "city" }?.value
        switch host {
        case "post":
            // Community Activity: one post, natively.
            guard let id = items.first(where: { $0.name == "id" })?.value, !id.isEmpty else { selectedTab = .community; return true }
            communityPath = NavigationPath()
            open(.post(PostRoute(id: id)))
            return true
        case "community":
            // Leaderboard, My Spotting Progress, Community Activity: their section.
            communityPath = NavigationPath()
            communitySection = items.first { $0.name == "section" }?.value.flatMap(CommunitySection.init(rawValue:))
            selectedTab = .community
            return true
        case "zones": openZones(city == "dallas" ? "dallas" : "austin")
        case "sightings": selectedTab = .sightings
        case "registry": selectedTab = .registry
        default: selectedTab = .home
        }
        return true
    }

    /// The Texas DMV tracker, pushed on Home (from Siri, Shortcuts or Spotlight).
    func openDMVTracker() {
        homePath = NavigationPath()
        homePath.append(ExploreRoute.dmv)
        selectedTab = .home
    }

    /// The Sightings tab, on a city when one is given.
    func openSightings(city: String?) {
        if let city { sightingsCity = city }
        sightingsPath = NavigationPath()
        selectedTab = .sightings
    }

    /// One of the app's main screens (Siri: "Open … in Cybercab Hunter").
    func open(_ destination: AppDestination) {
        StartupIntro.shared.skip()   // a launch with a destination goes straight there
        switch destination {
        case .home: homePath = NavigationPath(); selectedTab = .home
        // Zones remembers the rider's city itself (ZonesModel), so the map
        // opens where they left it unless a city was asked for.
        case .map: if let c = zonesCity { openZones(c) } else { selectedTab = .zones }
        case .cars: registryPath = NavigationPath(); selectedTab = .registry
        case .sightings: openSightings(city: nil)
        case .community: communityPath = NavigationPath(); selectedTab = .community
        case .dmvTracker: openDMVTracker()
        case .alertSettings: accountRequest = .alerts
        case .siriSettings: accountRequest = .siri
        }
    }

    func openCommunity(_ section: CommunitySection) {
        communitySection = section
        communityPath = NavigationPath()
        selectedTab = .community
    }
}
