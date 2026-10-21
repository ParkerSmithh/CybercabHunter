import Foundation

/// The bottom tabs: the website's mobile navigation (Cars, Zones, Sightings,
/// Community) with Home first. News, Simulation and the rest are reached from
/// Home, as iPhone tab bars hold five tabs.
enum AppTab: String, CaseIterable, Identifiable, Hashable {
    case home, zones, registry, sightings, community

    var id: String { rawValue }

    var title: String {
        switch self {
        case .home: "Home"
        case .zones: "Zones"
        case .registry: "Cars"
        case .sightings: "Sightings"
        case .community: "Community"
        }
    }

    /// SF Symbols matching the website's nav icons.
    var systemImage: String {
        switch self {
        case .home: "house.fill"
        case .zones: "map.fill"
        case .registry: "car.fill"
        case .sightings: "camera.fill"
        case .community: "person.2.fill"
        }
    }

    /// The website page each tab opens until its native screen ships.
    var webPath: String {
        switch self {
        case .home: "/"
        case .zones: "/infrastructure"
        case .registry: "/vehicles"
        case .sightings: "/sightings"
        case .community: "/community"
        }
    }

    /// The migration phase that makes the tab native (ios-native/PLAN.md).
    var nativePhase: Int {
        switch self {
        case .home, .registry: 2
        case .zones: 3
        case .sightings: 3
        case .community: 4
        }
    }
}
