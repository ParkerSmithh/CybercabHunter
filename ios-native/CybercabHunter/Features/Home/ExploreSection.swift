import SwiftUI

/// The website's other pages, reached from Home (the five tabs stay as they
/// are): Simulation, News and the Texas DMV roster, each a native screen
/// pushed in Home's own navigation stack.
enum ExploreRoute: Hashable {
    case simulation(SimulationModel.View)
    case news
    case dmv
}

/// Native destinations pushed from Home's hero and DMV panel.
struct ExploreDestination: View {
    let route: ExploreRoute
    var body: some View {
        switch route {
        case .simulation(let view): SimulationView(initialView: view)
        case .news: NewsView()
        case .dmv: DMVRosterView()
        }
    }
}
