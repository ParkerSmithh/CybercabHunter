import SwiftUI
import Observation

/// Which tab is showing, app-wide, so a screen can send the rider to another
/// tab ("See all" on Home opens Cars or Sightings).
@MainActor
@Observable
final class AppRouter {
    /// The one router of the app: the scene uses it, and so do App Intents
    /// (Siri, Shortcuts, Spotlight), which run outside the view tree.
    static let shared = AppRouter()

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
        registryPath = NavigationPath()
        registryPath.append(VehicleRoute(id: id, plate: plate))
        selectedTab = .registry
    }

    /// The Sightings tab with its "Submit a sighting" form.
    func requestSubmitSighting() {
        selectedTab = .sightings
        submitSightingRequested = true
    }

    /// A widget's link (`cybercabhunter-widget://<tab>[?city=…]`): opens that tab.
    /// Returns false for any other URL.
    @discardableResult
    func open(widgetURL url: URL) -> Bool {
        guard url.scheme == WidgetLink.scheme, let host = url.host() else { return false }
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
        switch destination {
        case .home: homePath = NavigationPath(); selectedTab = .home
        case .map: openZones(zonesCity ?? "austin")
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
