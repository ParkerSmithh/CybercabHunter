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
}
