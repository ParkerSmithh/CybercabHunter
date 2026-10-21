import SwiftUI
import Observation

/// Which tab is showing, app-wide, so a screen can send the rider to another
/// tab ("See all" on Home opens Cars or Sightings).
@MainActor
@Observable
final class AppRouter {
    var selectedTab: AppTab = DebugLaunch.initialTab ?? .home
    /// A city for Zones to open on (Home's minimaps set it).
    var zonesCity: String?
    /// The Community tab's navigation history, so notifications and the site's
    /// own links (a post, a rider, a vehicle) open native screens there.
    var communityPath = NavigationPath()
    /// The Community section to show (Home's links choose one).
    var communitySection: CommunitySection?

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

    func openCommunity(_ section: CommunitySection) {
        communitySection = section
        communityPath = NavigationPath()
        selectedTab = .community
    }
}
