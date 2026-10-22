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
        let city = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "city" }?.value
        switch host {
        case "zones": openZones(city == "dallas" ? "dallas" : "austin")
        case "sightings": selectedTab = .sightings
        case "registry": selectedTab = .registry
        case "community": selectedTab = .community
        default: selectedTab = .home
        }
        return true
    }

    func openCommunity(_ section: CommunitySection) {
        communitySection = section
        communityPath = NavigationPath()
        selectedTab = .community
    }
}
